// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental keyframe-only VP8 writer. Format and coding rules: RFC 6386.
// Complete residual engineering path; product/preset qualification is unfinished.

mod abi;
mod ac_quant;
mod bmode_probs;
mod coeff_update_probs;
mod color;
mod dc_quant;
mod default_coeff_probs;
mod display_rgb;
mod filter;
mod limits;
mod prediction;
mod presets;
mod probability;
mod rate;
mod residual;
mod segmentation;
mod textured;
mod transform;

use coeff_update_probs::COEFF_UPDATE_PROBS;

pub const MAX_DIMENSION: u32 = 2048;
pub const MAX_PIXELS: u32 = 4_194_304;
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError {
    InvalidInput,
    UnsupportedPixels,
    OutputLimit,
}

struct BoolWriter {
    bytes: Vec<u8>,
    range: u32,
    bottom: u32,
    bit_count: u32,
    limit: usize,
    symbol_pending: bool,
    shift_pending: bool,
    carry_cursor: Option<usize>,
    finish_started: bool,
    finished: bool,
}

impl BoolWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            range: 255,
            bottom: 0,
            bit_count: 24,
            limit: MAX_OUTPUT_BYTES,
            symbol_pending: false,
            shift_pending: false,
            carry_cursor: None,
            finish_started: false,
            finished: false,
        }
    }

    fn with_capacity(bytes: usize) -> Result<Self, EncodeError> {
        let mut writer = Self::new();
        writer
            .bytes
            .try_reserve_exact(bytes)
            .map_err(|_| EncodeError::OutputLimit)?;
        writer.limit = bytes;
        Ok(writer)
    }

    fn resume_carry(&mut self, budget: &mut usize) -> bool {
        while let Some(cursor) = self.carry_cursor {
            if *budget == 0 {
                return false;
            }
            // RFC 6386 guarantees a carry never runs past the partition start.
            assert!(cursor > 0, "VP8 arithmetic carry before partition start");
            let index = cursor - 1;
            *budget -= 1;
            if self.bytes[index] == 255 {
                self.bytes[index] = 0;
                self.carry_cursor = Some(index);
            } else {
                self.bytes[index] += 1;
                self.carry_cursor = None;
            }
        }
        true
    }

    /// Returns false when a carry crosses the byte budget. The caller must
    /// retry the same symbol: the split is applied exactly once.
    fn write_step(
        &mut self,
        probability_of_zero: u8,
        bit: bool,
        carry_byte_budget: &mut usize,
    ) -> Result<bool, EncodeError> {
        if self.finish_started {
            return Err(EncodeError::InvalidInput);
        }
        if !self.symbol_pending {
            let split = 1 + (((self.range - 1) * u32::from(probability_of_zero)) >> 8);
            if bit {
                self.bottom = self.bottom.wrapping_add(split);
                self.range -= split;
            } else {
                self.range = split;
            }
            self.symbol_pending = true;
        }
        while self.range < 128 || self.shift_pending {
            if !self.shift_pending {
                self.range <<= 1;
                self.shift_pending = true;
                if self.bottom & (1 << 31) != 0 {
                    self.carry_cursor = Some(self.bytes.len());
                }
            }
            if !self.resume_carry(carry_byte_budget) {
                return Ok(false);
            }
            self.bottom <<= 1;
            self.bit_count -= 1;
            if self.bit_count == 0 {
                if self.bytes.len() >= self.limit {
                    return Err(EncodeError::OutputLimit);
                }
                if self.bytes.len() == self.bytes.capacity() {
                    self.bytes
                        .try_reserve(1)
                        .map_err(|_| EncodeError::OutputLimit)?;
                }
                self.bytes.push((self.bottom >> 24) as u8);
                self.bottom &= (1 << 24) - 1;
                self.bit_count = 8;
            }
            self.shift_pending = false;
        }
        self.symbol_pending = false;
        Ok(true)
    }

    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        let mut budget = usize::MAX;
        while !self.write_step(probability_of_zero, bit, &mut budget)? {
            budget = usize::MAX;
        }
        Ok(())
    }

    fn bit(&mut self, bit: bool) -> Result<(), EncodeError> {
        self.write(128, bit)
    }

    fn literal(&mut self, value: u32, bits: u32) -> Result<(), EncodeError> {
        for shift in (0..bits).rev() {
            self.bit(value & (1 << shift) != 0)?;
        }
        Ok(())
    }

    fn finish_step(&mut self, carry_byte_budget: &mut usize) -> Result<bool, EncodeError> {
        if self.finished {
            return Ok(true);
        }
        if self.symbol_pending {
            return Err(EncodeError::InvalidInput);
        }
        if !self.finish_started {
            self.finish_started = true;
            if self.bottom & (1 << (32 - self.bit_count)) != 0 {
                self.carry_cursor = Some(self.bytes.len());
            }
        }
        if !self.resume_carry(carry_byte_budget) {
            return Ok(false);
        }
        let mut count = self.bit_count;
        let mut value = self.bottom;
        value <<= count & 7;
        count >>= 3;
        while count > 0 {
            value <<= 8;
            count -= 1;
        }
        if self
            .bytes
            .len()
            .checked_add(4)
            .ok_or(EncodeError::OutputLimit)?
            > self.limit
        {
            return Err(EncodeError::OutputLimit);
        }
        if self.bytes.capacity() - self.bytes.len() < 4 {
            self.bytes
                .try_reserve(4)
                .map_err(|_| EncodeError::OutputLimit)?;
        }
        for _ in 0..4 {
            self.bytes.push((value >> 24) as u8);
            value <<= 8;
        }
        self.finished = true;
        Ok(true)
    }

    fn take_finished(&mut self) -> Option<Vec<u8>> {
        self.finished.then(|| std::mem::take(&mut self.bytes))
    }

    fn finish(mut self) -> Result<Vec<u8>, EncodeError> {
        let mut budget = usize::MAX;
        while !self.finish_step(&mut budget)? {
            budget = usize::MAX;
        }
        Ok(self.take_finished().expect("finished arithmetic writer"))
    }
}

fn validate_shape(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<usize, EncodeError> {
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || width.checked_mul(height).ok_or(EncodeError::InvalidInput)? > MAX_PIXELS
        || !matches!(format, 0 | 1)
        || !matches!(quality, 60 | 75 | 85)
    {
        return Err(EncodeError::InvalidInput);
    }
    let row_bytes = usize::try_from(width)
        .map_err(|_| EncodeError::InvalidInput)?
        .checked_mul(4)
        .ok_or(EncodeError::InvalidInput)?;
    let stride = usize::try_from(stride).map_err(|_| EncodeError::InvalidInput)?;
    let height = usize::try_from(height).map_err(|_| EncodeError::InvalidInput)?;
    if stride < row_bytes {
        return Err(EncodeError::InvalidInput);
    }
    let last_end = height
        .checked_sub(1)
        .and_then(|n| n.checked_mul(stride))
        .and_then(|n| n.checked_add(row_bytes))
        .ok_or(EncodeError::InvalidInput)?;
    if last_end > pixels.len() || last_end > MAX_INPUT_BYTES {
        return Err(EncodeError::InvalidInput);
    }
    Ok(last_end)
}

fn validate_input(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<usize, EncodeError> {
    let last_end = validate_shape(pixels, width, height, stride, format, quality)?;
    let row_bytes = width as usize * 4;
    let stride = stride as usize;
    let height = height as usize;
    // Neutral grey is the only source color for which skipped DC-predicted
    // macroblocks preserve the input. Other pixels require a real residual coder.
    for row in 0..height {
        for pixel in pixels[row * stride..row * stride + row_bytes]
            .as_chunks::<4>()
            .0
        {
            if *pixel != [128, 128, 128, 255] {
                return Err(EncodeError::UnsupportedPixels);
            }
        }
    }
    Ok(last_end)
}

/// A deliberately narrow, independently decodable VP8 keyframe experiment.
/// `format`: 0=RGBA, 1=BGRA. The neutral input is identical in both layouts.
pub fn encode_neutral_keyframe(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<Vec<u8>, EncodeError> {
    let _input_bytes = validate_input(pixels, width, height, stride, format, quality)?;
    let blocks_x = width.div_ceil(16);
    let blocks_y = height.div_ceil(16);
    let block_count = blocks_x
        .checked_mul(blocks_y)
        .ok_or(EncodeError::InvalidInput)?;
    let mut part = BoolWriter::new();
    part.bit(false)?; // YUV color space.
    part.bit(false)?; // Reconstructed pixels may need clamping.
    part.bit(false)?; // Segmentation disabled.
    part.bit(false)?; // Normal loop filter.
    part.literal(0, 6)?; // Filter level.
    part.literal(0, 3)?; // Filter sharpness.
    part.bit(false)?; // Macroblock filter deltas disabled.
    part.literal(0, 2)?; // One coefficient partition.
    part.literal(0, 7)?; // Baseline quantizer; unused for skipped blocks.
    for _ in 0..5 {
        part.bit(false)?;
    } // No quantizer deltas.
    part.bit(false)?; // Do not retain entropy updates after this frame.
    for probability in COEFF_UPDATE_PROBS {
        part.write(probability, false)?;
    }
    part.bit(true)?; // mb_no_skip_coeff is enabled.
    part.literal(128, 8)?; // Probability of a non-skipped macroblock.
    for _ in 0..block_count {
        part.write(128, true)?; // Skip all residual coefficients.
        part.write(145, true)?; // Keyframe Y mode tree: DC_PRED = 100.
        part.write(156, false)?;
        part.write(163, false)?;
        part.write(142, false)?; // UV DC_PRED = 0.
    }
    let first_partition = part.finish()?;
    if first_partition.len() > 0x7ffff {
        return Err(EncodeError::OutputLimit);
    }
    // A skipped frame still carries one nonempty token partition. Its bytes are
    // never read for residual coefficients; padding keeps strict decoders happy.
    let total = 10usize
        .checked_add(first_partition.len())
        .and_then(|n| n.checked_add(4))
        .ok_or(EncodeError::OutputLimit)?;
    if total > MAX_OUTPUT_BYTES {
        return Err(EncodeError::OutputLimit);
    }
    let mut output = Vec::new();
    output
        .try_reserve_exact(total)
        .map_err(|_| EncodeError::OutputLimit)?;
    let tag = ((first_partition.len() as u32) << 5) | 0x10; // key frame, version 0, displayed.
    output.extend_from_slice(&tag.to_le_bytes()[..3]);
    output.extend_from_slice(&[0x9d, 0x01, 0x2a]);
    output.extend_from_slice(&(width as u16).to_le_bytes());
    output.extend_from_slice(&(height as u16).to_le_bytes());
    output.extend_from_slice(&first_partition);
    output.extend_from_slice(&[0, 0, 0, 0]);
    Ok(output)
}

/// Encode checked opaque RGBA/BGRA input with the experimental full-residual
/// intra-mode search. This does not yet satisfy product quality or preset parity.
pub fn encode_opaque_keyframe(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<Vec<u8>, EncodeError> {
    let input_end = validate_shape(pixels, width, height, stride, format, quality)?;
    let row_bytes = width as usize * 4;
    for row in 0..height as usize {
        for pixel in pixels[row * stride as usize..row * stride as usize + row_bytes]
            .as_chunks::<4>()
            .0
        {
            if pixel[3] != 255 {
                return Err(EncodeError::UnsupportedPixels);
            }
        }
    }
    textured::encode_textured(&pixels[..input_end], width, height, stride, format, quality)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_pixels_use_the_same_color_contract_as_other_grays() {
        for gray in [127, 128, 129] {
            let input = [gray, gray, gray, 255].repeat(17 * 13);
            for quality in [60, 75, 85] {
                assert_eq!(
                    encode_opaque_keyframe(&input, 17, 13, 68, 0, quality).unwrap(),
                    textured::encode_textured(&input, 17, 13, 68, 0, quality).unwrap()
                );
            }
        }
    }

    #[test]
    fn arithmetic_finalization_known_answer() {
        // RFC 6386 section 7.3: a single one at probability 64/256.
        let mut writer = BoolWriter::new();
        writer.write(64, true).unwrap();
        assert_eq!(writer.finish().unwrap(), [64, 0, 0, 0]);
    }

    #[test]
    fn arithmetic_extremes_and_carry_sequences() {
        for length in [1, 7, 8, 23, 24, 25, 255, 4096, 65536] {
            let mut seed = 0x501u32;
            let mut symbols = Vec::new();
            let mut writer = BoolWriter::new();
            for index in 0..length {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let probability = [0, 1, 64, 128, 254, 255, (seed >> 16) as u8][index % 7];
                let bit = seed & 0x80000000 != 0;
                symbols.push((probability, bit));
                writer.write(probability, bit).unwrap();
            }
            let bytes = writer.finish().unwrap();
            // Independent 16-bit-window decoder, following RFC 6386 section 7.3.
            let mut value = (u32::from(bytes[0]) << 8) | u32::from(bytes[1]);
            let mut offset = 2;
            let mut range = 255;
            let mut count = 0;
            for (probability, expected) in symbols {
                let split = 1 + (((range - 1) * u32::from(probability)) >> 8);
                let actual = value >= split << 8;
                assert_eq!(actual, expected, "length={length} offset={offset}");
                if actual {
                    value -= split << 8;
                    range -= split;
                } else {
                    range = split;
                }
                while range < 128 {
                    range <<= 1;
                    value <<= 1;
                    count += 1;
                    if count == 8 {
                        count = 0;
                        value |= u32::from(bytes[offset]);
                        offset += 1;
                    }
                }
            }
        }
        let mut writer = BoolWriter::new();
        writer.bytes = vec![4, 255, 255, 255, 255, 255, 255, 255, 255];
        writer.carry_cursor = Some(writer.bytes.len());
        let mut budget = usize::MAX;
        assert!(writer.resume_carry(&mut budget));
        assert_eq!(writer.bytes, [5, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn long_carry_pauses_and_resumes_during_write_and_finish() {
        const TAIL: usize = 131_072;
        let mut paused = BoolWriter::new();
        paused.bytes = vec![255; TAIL + 1];
        paused.bytes[0] = 7;
        paused.limit = TAIL + 16;
        paused.range = 1;
        paused.bottom = 1 << 31;
        let mut reference = BoolWriter::new();
        reference.bytes = paused.bytes.clone();
        reference.limit = paused.limit;
        reference.range = paused.range;
        reference.bottom = paused.bottom;
        reference.write(128, false).unwrap();
        let mut calls = 0;
        loop {
            let mut budget = 1_024;
            calls += 1;
            if paused.write_step(128, false, &mut budget).unwrap() {
                break;
            }
            assert_eq!(budget, 0);
            assert!(calls < 200);
        }
        assert!(calls > 100);
        assert_eq!(paused.bytes, reference.bytes);
        assert_eq!(paused.range, reference.range);
        assert_eq!(paused.bottom, reference.bottom);
        assert_eq!(paused.bit_count, reference.bit_count);

        let mut paused = BoolWriter::new();
        paused.bytes = vec![255; TAIL + 1];
        paused.bytes[0] = 7;
        paused.limit = TAIL + 16;
        paused.bottom = 1 << 8;
        let reference = BoolWriter {
            bytes: paused.bytes.clone(),
            ..BoolWriter::new()
        };
        let mut reference = reference;
        reference.limit = paused.limit;
        reference.bottom = paused.bottom;
        let expected = reference.finish().unwrap();
        let mut calls = 0;
        loop {
            let mut budget = 1_024;
            calls += 1;
            if paused.finish_step(&mut budget).unwrap() {
                break;
            }
            assert_eq!(budget, 0);
            assert!(calls < 200);
        }
        assert!(calls > 100);
        assert_eq!(paused.take_finished().unwrap(), expected);
    }

    #[test]
    fn incremental_writer_matches_extreme_probability_streams() {
        for length in [1, 7, 8, 23, 24, 25, 255, 4096, 65_536] {
            let mut seed = 0x501u32;
            let mut reference = BoolWriter::new();
            let mut incremental = BoolWriter::new();
            for index in 0..length {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let probability = [0, 1, 64, 128, 254, 255, (seed >> 16) as u8][index % 7];
                let bit = seed & 0x8000_0000 != 0;
                reference.write(probability, bit).unwrap();
                loop {
                    let mut budget = 3;
                    if incremental
                        .write_step(probability, bit, &mut budget)
                        .unwrap()
                    {
                        break;
                    }
                }
            }
            let expected = reference.finish().unwrap();
            loop {
                let mut budget = 3;
                if incremental.finish_step(&mut budget).unwrap() {
                    break;
                }
            }
            assert_eq!(
                incremental.take_finished().unwrap(),
                expected,
                "length={length}"
            );
        }
    }
    #[test]
    fn checked_input_and_repeated_keyframes() {
        let pixels = [128, 128, 128, 255].repeat(16 * 16);
        let output = encode_neutral_keyframe(&pixels, 16, 16, 64, 0, 75).unwrap();
        assert_eq!(&output[3..6], &[0x9d, 0x01, 0x2a]);
        assert_eq!(
            output,
            encode_neutral_keyframe(&pixels, 16, 16, 64, 0, 75).unwrap()
        );
        assert_eq!(
            encode_neutral_keyframe(&pixels[..pixels.len() - 1], 16, 16, 64, 0, 75),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(
            encode_neutral_keyframe(&pixels, 0, 16, 64, 0, 75),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(
            encode_neutral_keyframe(&pixels, 16, 16, 63, 0, 75),
            Err(EncodeError::InvalidInput)
        );
        let mut non_neutral = pixels;
        non_neutral[0] = 127;
        assert_eq!(
            encode_neutral_keyframe(&non_neutral, 16, 16, 64, 0, 75),
            Err(EncodeError::UnsupportedPixels)
        );
    }
}
