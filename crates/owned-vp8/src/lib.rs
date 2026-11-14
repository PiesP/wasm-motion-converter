// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental keyframe-only VP8 writer. Format and coding rules: RFC 6386.
// Includes a bounded DC-only residual experiment; preset fidelity is unqualified.

mod coeff_update_probs;
mod dc_quant;
mod default_coeff_probs;
mod textured;

use coeff_update_probs::COEFF_UPDATE_PROBS;
use std::sync::Mutex;

pub const ABI_VERSION: u32 = 1;
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
}

impl BoolWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            range: 255,
            bottom: 0,
            bit_count: 24,
        }
    }

    fn propagate_carry(&mut self) {
        // RFC 6386 guarantees a carry never runs past the partition start.
        for value in self.bytes.iter_mut().rev() {
            if *value == 255 {
                *value = 0;
            } else {
                *value += 1;
                return;
            }
        }
        // If the guarantee is violated, do not silently publish a broken frame.
        panic!("VP8 arithmetic carry before partition start");
    }

    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        let split = 1 + (((self.range - 1) * u32::from(probability_of_zero)) >> 8);
        if bit {
            self.bottom = self.bottom.wrapping_add(split);
            self.range -= split;
        } else {
            self.range = split;
        }
        while self.range < 128 {
            self.range <<= 1;
            if self.bottom & (1 << 31) != 0 {
                self.propagate_carry();
            }
            self.bottom <<= 1;
            self.bit_count -= 1;
            if self.bit_count == 0 {
                if self.bytes.len() >= MAX_OUTPUT_BYTES {
                    return Err(EncodeError::OutputLimit);
                }
                self.bytes
                    .try_reserve(1)
                    .map_err(|_| EncodeError::OutputLimit)?;
                self.bytes.push((self.bottom >> 24) as u8);
                self.bottom &= (1 << 24) - 1;
                self.bit_count = 8;
            }
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

    fn finish(mut self) -> Result<Vec<u8>, EncodeError> {
        let mut count = self.bit_count;
        let mut value = self.bottom;
        if value & (1 << (32 - count)) != 0 {
            self.propagate_carry();
        }
        value <<= count & 7;
        count >>= 3;
        while count > 1 {
            value <<= 8;
            count -= 1;
        }
        if self
            .bytes
            .len()
            .checked_add(3)
            .ok_or(EncodeError::OutputLimit)?
            > MAX_OUTPUT_BYTES
        {
            return Err(EncodeError::OutputLimit);
        }
        self.bytes
            .try_reserve(3)
            .map_err(|_| EncodeError::OutputLimit)?;
        for _ in 0..3 {
            self.bytes.push((value >> 24) as u8);
            value <<= 8;
        }
        Ok(self.bytes)
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
        for pixel in pixels[row * stride..row * stride + row_bytes].chunks_exact(4) {
            if pixel != [128, 128, 128, 255] {
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

/// Encode any checked opaque RGBA/BGRA input with the experimental DC-only
/// texture path. This does not yet satisfy product quality or preset parity.
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
    let mut neutral = true;
    for row in 0..height as usize {
        for pixel in
            pixels[row * stride as usize..row * stride as usize + row_bytes].chunks_exact(4)
        {
            if pixel[3] != 255 {
                return Err(EncodeError::UnsupportedPixels);
            }
            if pixel != [128, 128, 128, 255] {
                neutral = false;
            }
        }
    }
    if neutral {
        encode_neutral_keyframe(&pixels[..input_end], width, height, stride, format, quality)
    } else {
        textured::encode_textured(&pixels[..input_end], width, height, stride, format, quality)
    }
}

#[derive(Default)]
struct State {
    input: Vec<u8>,
    output: Vec<u8>,
}
static STATE: Mutex<State> = Mutex::new(State {
    input: Vec::new(),
    output: Vec::new(),
});

#[no_mangle]
pub extern "C" fn vp8_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn vp8_reserve_input(length: u32) -> u32 {
    let Ok(mut state) = STATE.lock() else {
        return 0;
    };
    state.output.clear();
    if length == 0 || length as usize > MAX_INPUT_BYTES {
        return 0;
    }
    let length = length as usize;
    let extra = length.saturating_sub(state.input.len());
    if state.input.try_reserve_exact(extra).is_err() {
        return 0;
    }
    state.input.resize(length, 0);
    state.input.as_mut_ptr() as u32
}

#[no_mangle]
pub extern "C" fn vp8_encode(
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
    length: u32,
) -> u32 {
    let Ok(mut state) = STATE.lock() else {
        return 1;
    };
    state.output.clear();
    if state.input.len() != length as usize {
        return 1;
    }
    match encode_opaque_keyframe(&state.input, width, height, stride, format, quality) {
        Ok(output) => {
            state.output = output;
            0
        }
        Err(EncodeError::InvalidInput) => 1,
        Err(EncodeError::UnsupportedPixels) => 2,
        Err(EncodeError::OutputLimit) => 3,
    }
}

#[no_mangle]
pub extern "C" fn vp8_output_ptr() -> u32 {
    STATE.lock().map_or(0, |state| state.output.as_ptr() as u32)
}
#[no_mangle]
pub extern "C" fn vp8_output_len() -> u32 {
    STATE.lock().map_or(0, |state| state.output.len() as u32)
}
#[no_mangle]
pub extern "C" fn vp8_reset() {
    if let Ok(mut state) = STATE.lock() {
        state.input.clear();
        state.output.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checked_input_and_repeated_keyframes() {
        let pixels = vec![128, 128, 128, 255].repeat(16 * 16);
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
