// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Bounded AVC/HEVC SPS video signal and sample-aspect metadata.
//! Container metadata retains precedence; this supplies only fields absent there.

use crate::Error;

const MAX_CONFIG: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodecMetadata {
    pub sar_num: u32,
    pub sar_den: u32,
    pub color_primaries: u16,
    pub color_transfer: u16,
    pub color_matrix: u16,
    /// -1 means the SPS does not specify a video range.
    pub color_full_range: i8,
}

impl Default for CodecMetadata {
    fn default() -> Self {
        Self {
            sar_num: 1,
            sar_den: 1,
            color_primaries: u16::MAX,
            color_transfer: u16::MAX,
            color_matrix: u16::MAX,
            color_full_range: -1,
        }
    }
}

/// Read the first SPS in an avcC or hvcC decoder configuration. Matroska
/// CodecPrivate for these codecs uses the same records as MP4.
pub fn from_config(codec: [u8; 4], description: &[u8]) -> Result<Option<CodecMetadata>, Error> {
    if !matches!(&codec, b"avc1" | b"avc3" | b"hvc1" | b"hev1") || description.is_empty() {
        return Ok(None);
    }
    if description.len() > MAX_CONFIG {
        return Err(Error::ResourceLimit);
    }
    if matches!(&codec, b"avc1" | b"avc3") {
        avcc_sps(description)?
            .map(|nal| from_sps(codec, nal))
            .transpose()
            .map(Option::flatten)
    } else {
        hvcc_sps(description)?
            .map(|nal| from_sps(codec, nal))
            .transpose()
            .map(Option::flatten)
    }
}

/// Parse one already isolated SPS NAL, including an Annex-B TS SPS.
pub fn from_sps(codec: [u8; 4], nal: &[u8]) -> Result<Option<CodecMetadata>, Error> {
    if nal.len() > MAX_CONFIG {
        return Err(Error::ResourceLimit);
    }
    match &codec {
        b"avc1" | b"avc3" => avc_sps(nal),
        b"hvc1" | b"hev1" => hevc_sps(nal),
        _ => Ok(None),
    }
}

fn take<'a>(data: &'a [u8], at: &mut usize, size: usize) -> Result<&'a [u8], Error> {
    let end = at.checked_add(size).ok_or(Error::Overflow)?;
    let part = data.get(*at..end).ok_or(Error::Truncated)?;
    *at = end;
    Ok(part)
}

fn be16(data: &[u8], at: &mut usize) -> Result<usize, Error> {
    let bytes = take(data, at, 2)?;
    Ok(usize::from(u16::from_be_bytes([bytes[0], bytes[1]])))
}

fn avcc_sps(data: &[u8]) -> Result<Option<&[u8]>, Error> {
    if data.len() < 7 {
        return Err(Error::Truncated);
    }
    if data[0] != 1 {
        return Err(Error::Invalid);
    }
    let mut at = 6;
    let mut first = None;
    for _ in 0..data[5] & 31 {
        let size = be16(data, &mut at)?;
        if size == 0 {
            return Err(Error::Invalid);
        }
        let nal = take(data, &mut at, size)?;
        first.get_or_insert(nal);
    }
    let pps_count = *take(data, &mut at, 1)?.first().ok_or(Error::Truncated)?;
    for _ in 0..pps_count {
        let size = be16(data, &mut at)?;
        if size == 0 {
            return Err(Error::Invalid);
        }
        take(data, &mut at, size)?;
    }
    Ok(first)
}

fn hvcc_sps(data: &[u8]) -> Result<Option<&[u8]>, Error> {
    if data.len() < 23 {
        return Err(Error::Truncated);
    }
    if data[0] != 1 {
        return Err(Error::Invalid);
    }
    let mut at = 23;
    let mut first = None;
    let mut units = 0usize;
    for _ in 0..data[22] {
        let header = take(data, &mut at, 1)?[0];
        let count = be16(data, &mut at)?;
        units = units.checked_add(count).ok_or(Error::Overflow)?;
        if units > 4096 {
            return Err(Error::ResourceLimit);
        }
        for _ in 0..count {
            let size = be16(data, &mut at)?;
            if size == 0 {
                return Err(Error::Invalid);
            }
            let nal = take(data, &mut at, size)?;
            if header & 0x3f == 33 {
                first.get_or_insert(nal);
            }
        }
    }
    Ok(first)
}

struct Bits {
    bytes: Vec<u8>,
    at: usize,
}
impl Bits {
    fn rbsp(nal: &[u8], header: usize) -> Result<Self, Error> {
        if nal.len() < header {
            return Err(Error::Truncated);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(nal.len() - header)
            .map_err(|_| Error::ResourceLimit)?;
        let mut zeros = 0;
        for &byte in &nal[header..] {
            if zeros == 2 && byte == 3 {
                zeros = 0;
                continue;
            }
            bytes.push(byte);
            zeros = if byte == 0 { (zeros + 1).min(2) } else { 0 };
        }
        Ok(Self { bytes, at: 0 })
    }
    fn bits(&mut self, count: usize) -> Result<u32, Error> {
        if count > 32 || self.at.checked_add(count).ok_or(Error::Overflow)? > self.bytes.len() * 8 {
            return Err(Error::Truncated);
        }
        let mut result = 0;
        for _ in 0..count {
            result = (result << 1) | u32::from((self.bytes[self.at / 8] >> (7 - self.at % 8)) & 1);
            self.at += 1;
        }
        Ok(result)
    }
    fn ue(&mut self) -> Result<u32, Error> {
        let mut zeros = 0;
        while self.bits(1)? == 0 {
            zeros += 1;
            if zeros > 30 {
                return Err(Error::ResourceLimit);
            }
        }
        Ok((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
    fn se(&mut self) -> Result<i32, Error> {
        let value = self.ue()?;
        Ok(if value & 1 != 0 {
            u64::from(value).div_ceil(2) as i32
        } else {
            -(value as i32 / 2)
        })
    }
}

fn sar(b: &mut Bits, metadata: &mut CodecMetadata) -> Result<(), Error> {
    if b.bits(1)? == 0 {
        return Ok(());
    }
    let ratio = match b.bits(8)? {
        0 | 1 => (1, 1),
        2 => (12, 11),
        3 => (10, 11),
        4 => (16, 11),
        5 => (40, 33),
        6 => (24, 11),
        7 => (20, 11),
        8 => (32, 11),
        9 => (80, 33),
        10 => (18, 11),
        11 => (15, 11),
        12 => (64, 33),
        13 => (160, 99),
        14 => (4, 3),
        15 => (3, 2),
        16 => (2, 1),
        255 => (b.bits(16)?, b.bits(16)?),
        _ => return Err(Error::Unsupported),
    };
    if ratio.0 == 0 || ratio.1 == 0 {
        return Err(Error::Invalid);
    }
    (metadata.sar_num, metadata.sar_den) = ratio;
    Ok(())
}

fn video_signal(b: &mut Bits, metadata: &mut CodecMetadata) -> Result<(), Error> {
    if b.bits(1)? == 0 {
        return Ok(());
    }
    b.bits(3)?; // video_format
    metadata.color_full_range = b.bits(1)? as i8;
    if b.bits(1)? != 0 {
        metadata.color_primaries = b.bits(8)? as u16;
        metadata.color_transfer = b.bits(8)? as u16;
        metadata.color_matrix = b.bits(8)? as u16;
    }
    Ok(())
}

fn vui_front(b: &mut Bits) -> Result<CodecMetadata, Error> {
    let mut metadata = CodecMetadata::default();
    sar(b, &mut metadata)?;
    if b.bits(1)? != 0 {
        b.bits(1)?;
    } // overscan
    video_signal(b, &mut metadata)?;
    Ok(metadata)
}

fn avc_sps(nal: &[u8]) -> Result<Option<CodecMetadata>, Error> {
    if nal.first().copied().ok_or(Error::Truncated)? & 0x1f != 7 {
        return Err(Error::Invalid);
    }
    let mut b = Bits::rbsp(nal, 1)?;
    let profile = b.bits(8)?;
    b.bits(8)?;
    b.bits(8)?;
    b.ue()?;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma = b.ue()?;
        if chroma > 3 {
            return Err(Error::Invalid);
        }
        if chroma == 3 {
            b.bits(1)?;
        }
        b.ue()?;
        b.ue()?;
        b.bits(1)?;
        if b.bits(1)? != 0 {
            for i in 0..if chroma == 3 { 12 } else { 8 } {
                if b.bits(1)? == 0 {
                    continue;
                }
                let mut last = 8i32;
                let mut next = 8i32;
                for _ in 0..if i < 6 { 16 } else { 64 } {
                    if next != 0 {
                        next = (last + b.se()?).rem_euclid(256);
                    }
                    last = if next == 0 { last } else { next };
                }
            }
        }
    }
    b.ue()?;
    match b.ue()? {
        0 => {
            b.ue()?;
        }
        1 => {
            b.bits(1)?;
            b.se()?;
            b.se()?;
            let cycles = b.ue()?;
            if cycles > 256 {
                return Err(Error::ResourceLimit);
            }
            for _ in 0..cycles {
                b.se()?;
            }
        }
        2 => {}
        _ => return Err(Error::Unsupported),
    }
    b.ue()?;
    b.bits(1)?;
    b.ue()?;
    b.ue()?;
    let frame_only = b.bits(1)?;
    if frame_only == 0 {
        b.bits(1)?;
    }
    b.bits(1)?;
    if b.bits(1)? != 0 {
        for _ in 0..4 {
            b.ue()?;
        }
    }
    if b.bits(1)? == 0 {
        return Ok(None);
    }
    Ok(Some(vui_front(&mut b)?))
}

fn skip_profile_tier_level(b: &mut Bits, layers: usize) -> Result<(), Error> {
    b.bits(2)?;
    b.bits(1)?;
    b.bits(5)?;
    b.bits(32)?;
    b.bits(32)?;
    b.bits(16)?;
    b.bits(8)?;
    let mut flags = [(false, false); 7];
    for pair in flags.iter_mut().take(layers) {
        *pair = (b.bits(1)? != 0, b.bits(1)? != 0);
    }
    if layers != 0 {
        for _ in layers..8 {
            b.bits(2)?;
        }
    }
    for &(profile, level) in flags.iter().take(layers) {
        if profile {
            b.bits(32)?;
            b.bits(32)?;
            b.bits(24)?;
        }
        if level {
            b.bits(8)?;
        }
    }
    Ok(())
}

fn skip_hevc_scaling_lists(b: &mut Bits) -> Result<(), Error> {
    for size_id in 0..4 {
        for _matrix in (0..6).step_by(if size_id == 3 { 3 } else { 1 }) {
            if b.bits(1)? == 0 {
                b.ue()?;
                continue;
            }
            if size_id > 1 {
                b.se()?;
            }
            for _ in 0..if size_id == 0 { 16 } else { 64 } {
                b.se()?;
            }
        }
    }
    Ok(())
}

fn skip_short_term_rps(b: &mut Bits, count: usize) -> Result<(), Error> {
    let mut delta_counts = [0usize; 64];
    for index in 0..count {
        let predicted = index > 0 && b.bits(1)? != 0;
        let deltas = if predicted {
            b.bits(1)?;
            b.ue()?; // delta_rps_sign, abs_delta_rps_minus1
            let mut used = 0;
            for _ in 0..=delta_counts[index - 1] {
                let in_picture = b.bits(1)? != 0;
                if in_picture || b.bits(1)? != 0 {
                    used += 1;
                }
            }
            used
        } else {
            let negatives = b.ue()? as usize;
            let positives = b.ue()? as usize;
            let total = negatives.checked_add(positives).ok_or(Error::Overflow)?;
            if total > 64 {
                return Err(Error::ResourceLimit);
            }
            for _ in 0..total {
                b.ue()?;
                b.bits(1)?;
            }
            total
        };
        if deltas > 64 {
            return Err(Error::ResourceLimit);
        }
        delta_counts[index] = deltas;
    }
    Ok(())
}

fn hevc_sps(nal: &[u8]) -> Result<Option<CodecMetadata>, Error> {
    if nal.len() < 3 {
        return Err(Error::Truncated);
    }
    if (nal[0] >> 1) & 0x3f != 33 {
        return Err(Error::Invalid);
    }
    let mut b = Bits::rbsp(nal, 2)?;
    b.bits(4)?;
    let layers = b.bits(3)? as usize;
    if layers > 6 {
        return Err(Error::Invalid);
    }
    b.bits(1)?;
    skip_profile_tier_level(&mut b, layers)?;
    b.ue()?;
    let chroma = b.ue()?;
    if chroma > 3 {
        return Err(Error::Invalid);
    }
    if chroma == 3 {
        b.bits(1)?;
    }
    b.ue()?;
    b.ue()?;
    if b.bits(1)? != 0 {
        for _ in 0..4 {
            b.ue()?;
        }
    }
    b.ue()?;
    b.ue()?;
    let poc_width = b.ue()?.checked_add(4).ok_or(Error::Overflow)?;
    if poc_width > 16 {
        return Err(Error::Unsupported);
    }
    let all_layers = b.bits(1)? != 0;
    for _ in (if all_layers { 0 } else { layers })..=layers {
        b.ue()?;
        b.ue()?;
        b.ue()?;
    }
    for _ in 0..6 {
        b.ue()?;
    }
    if b.bits(1)? != 0 && b.bits(1)? != 0 {
        skip_hevc_scaling_lists(&mut b)?;
    }
    b.bits(1)?;
    b.bits(1)?;
    if b.bits(1)? != 0 {
        b.bits(4)?;
        b.bits(4)?;
        b.ue()?;
        b.ue()?;
        b.bits(1)?;
    }
    let short_refs = b.ue()? as usize;
    if short_refs > 64 {
        return Err(Error::ResourceLimit);
    }
    skip_short_term_rps(&mut b, short_refs)?;
    if b.bits(1)? != 0 {
        let long_refs = b.ue()?;
        if long_refs > 32 {
            return Err(Error::ResourceLimit);
        }
        for _ in 0..long_refs {
            b.bits(poc_width as usize)?;
            b.bits(1)?;
        }
    }
    b.bits(1)?;
    b.bits(1)?;
    if b.bits(1)? == 0 {
        return Ok(None);
    }
    Ok(Some(vui_front(&mut b)?))
}

/// VP9's uncompressed keyframe header supplies the profile and color config
/// when a WebM track has no CodecPrivate. The host supplies a bounded prefix
/// of the selected first keyframe; inter frames cannot supply this metadata.
/// Syntax: WebM Project, VP9 Bitstream Specification v1.0, sections 4.1-4.5.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vp9Metadata {
    pub profile: u8,
    pub bit_depth: u8,
    pub color_space: u8,
    pub subsampling_x: u8,
    pub subsampling_y: u8,
    pub color_primaries: u8,
    pub color_transfer: u8,
    pub color_matrix: u8,
    pub full_range: bool,
    pub width: u32,
    pub height: u32,
    pub render_width: u32,
    pub render_height: u32,
}

impl Vp9Metadata {
    /// WebM has no level field. Preserve the current level-1 default (10).
    pub fn codec_string(&self) -> Result<String, Error> {
        let chroma = match (self.subsampling_x, self.subsampling_y) {
            (1, 1) => 1,
            (1, 0) => 2,
            (0, 0) => 3,
            // The VP codec string cannot represent VP9's 4:4:0 layout.
            _ => return Err(Error::Unsupported),
        };
        Ok(format!(
            "vp09.{:02}.10.{:02}.{chroma:02}.{:02}.{:02}.{:02}.{:02}",
            self.profile,
            self.bit_depth,
            self.color_primaries,
            self.color_transfer,
            self.color_matrix,
            u8::from(self.full_range)
        ))
    }
}

struct RawBits<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl RawBits<'_> {
    fn bits(&mut self, count: usize) -> Result<u32, Error> {
        if count > 32 || self.at.checked_add(count).ok_or(Error::Overflow)? > self.bytes.len() * 8 {
            return Err(Error::Truncated);
        }
        let mut value = 0;
        for _ in 0..count {
            value = value << 1 | u32::from((self.bytes[self.at / 8] >> (7 - self.at % 8)) & 1);
            self.at += 1;
        }
        Ok(value)
    }
}

pub fn vp9_from_keyframe(prefix: &[u8]) -> Result<Vp9Metadata, Error> {
    if prefix.len() > 4096 {
        return Err(Error::ResourceLimit);
    }
    let mut bits = RawBits {
        bytes: prefix,
        at: 0,
    };
    if bits.bits(2)? != 2 {
        return Err(Error::Invalid);
    } // FRAME_MARKER
    let profile = (bits.bits(1)? | bits.bits(1)? << 1) as u8;
    if profile == 3 && bits.bits(1)? != 0 {
        return Err(Error::Invalid);
    }
    if bits.bits(1)? != 0 {
        return Err(Error::Unsupported);
    } // show_existing_frame
    if bits.bits(1)? != 0 {
        return Err(Error::Unsupported);
    } // inter frame
    bits.bits(1)?; // show_frame
    bits.bits(1)?; // error_resilient_mode
    if bits.bits(24)? != 0x49_83_42 {
        return Err(Error::Invalid);
    }
    let bit_depth = if profile >= 2 {
        if bits.bits(1)? != 0 {
            12
        } else {
            10
        }
    } else {
        8
    };
    let color_space = bits.bits(3)? as u8;
    if color_space == 6 {
        return Err(Error::Invalid);
    }
    let (full_range, subsampling_x, subsampling_y) = if color_space == 7 {
        if profile != 1 && profile != 3 {
            return Err(Error::Invalid);
        }
        if bits.bits(1)? != 0 {
            return Err(Error::Invalid);
        }
        (true, 0, 0)
    } else {
        let range = bits.bits(1)? != 0;
        if profile == 1 || profile == 3 {
            let x = bits.bits(1)? as u8;
            let y = bits.bits(1)? as u8;
            if bits.bits(1)? != 0 {
                return Err(Error::Invalid);
            }
            if x == 1 && y == 1 {
                return Err(Error::Invalid);
            }
            (range, x, y)
        } else {
            (range, 1, 1)
        }
    };
    let (color_primaries, color_transfer, color_matrix) = match color_space {
        0 => (2, 2, 2),     // Bitstream does not identify a color space.
        1 | 3 => (6, 6, 6), // BT.601 / SMPTE 170M.
        2 => (1, 1, 1),     // BT.709.
        4 => (7, 7, 7),     // SMPTE 240M.
        5 => (
            9,
            match bit_depth {
                8 => 1,
                10 => 14,
                _ => 15,
            },
            9,
        ), // BT.2020 nonconstant.
        7 => (1, 13, 0),    // sRGB RGB matrix.
        _ => return Err(Error::Invalid),
    };
    let width = bits.bits(16)? + 1;
    let height = bits.bits(16)? + 1;
    let (render_width, render_height) = if bits.bits(1)? != 0 {
        (bits.bits(16)? + 1, bits.bits(16)? + 1)
    } else {
        (width, height)
    };
    Ok(Vp9Metadata {
        profile,
        bit_depth,
        color_space,
        subsampling_x,
        subsampling_y,
        color_primaries,
        color_transfer,
        color_matrix,
        full_range,
        width,
        height,
        render_width,
        render_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Writer {
        bits: Vec<u8>,
    }
    impl Writer {
        fn new() -> Self {
            Self { bits: Vec::new() }
        }
        fn bits(&mut self, value: u32, count: usize) {
            for shift in (0..count).rev() {
                self.bits.push(((value >> shift) & 1) as u8);
            }
        }
        fn ue(&mut self, value: u32) {
            let width = 32 - (value + 1).leading_zeros();
            self.bits(0, (width - 1) as usize);
            self.bits(value + 1, width as usize);
        }
        fn finish(mut self, header: &[u8]) -> Vec<u8> {
            self.bits(1, 1);
            let mut bytes = header.to_vec();
            for chunk in self.bits.chunks(8) {
                let mut byte = 0u8;
                for &bit in chunk {
                    byte = byte << 1 | bit;
                }
                bytes.push(byte << (8 - chunk.len()));
            }
            bytes
        }
    }

    fn vui(writer: &mut Writer) {
        writer.bits(1, 1);
        writer.bits(2, 8); // 12:11 sample aspect.
        writer.bits(0, 1); // No overscan.
        writer.bits(1, 1);
        writer.bits(5, 3); // Video signal and format.
        writer.bits(1, 1);
        writer.bits(1, 1); // Full range and color description.
        writer.bits(1, 8);
        writer.bits(13, 8);
        writer.bits(6, 8);
    }

    fn avc_nal() -> Vec<u8> {
        let mut w = Writer::new();
        w.bits(66, 8);
        w.bits(0, 8);
        w.bits(30, 8);
        for _ in 0..4 {
            w.ue(0);
        }
        w.ue(1);
        w.bits(0, 1);
        w.ue(0);
        w.ue(0);
        w.bits(1, 1);
        w.bits(1, 1);
        w.bits(0, 1);
        w.bits(1, 1);
        vui(&mut w);
        w.finish(&[0x67])
    }

    fn hevc_nal() -> Vec<u8> {
        let mut w = Writer::new();
        w.bits(0, 4);
        w.bits(0, 3);
        w.bits(1, 1);
        w.bits(0, 2);
        w.bits(0, 1);
        w.bits(1, 5);
        w.bits(0, 32);
        w.bits(0, 32);
        w.bits(0, 16);
        w.bits(30, 8);
        w.ue(0);
        w.ue(1);
        w.ue(96);
        w.ue(64);
        w.bits(0, 1);
        w.ue(0);
        w.ue(0);
        w.ue(0);
        w.bits(1, 1);
        for _ in 0..3 {
            w.ue(0);
        }
        for _ in 0..6 {
            w.ue(0);
        }
        w.bits(0, 1);
        w.bits(0, 1);
        w.bits(0, 1);
        w.bits(0, 1);
        w.ue(0);
        w.bits(0, 1);
        w.bits(0, 1);
        w.bits(0, 1);
        w.bits(1, 1);
        vui(&mut w);
        w.finish(&[0x42, 0x01])
    }

    fn expected() -> CodecMetadata {
        CodecMetadata {
            sar_num: 12,
            sar_den: 11,
            color_primaries: 1,
            color_transfer: 13,
            color_matrix: 6,
            color_full_range: 1,
        }
    }

    fn vp9_key(profile: u8, depth: u8, color: u8, range: bool, x: u8, y: u8) -> Vec<u8> {
        let mut w = Writer::new();
        w.bits(2, 2); // Frame marker.
        w.bits(u32::from(profile & 1), 1);
        w.bits(u32::from(profile >> 1), 1);
        if profile == 3 {
            w.bits(0, 1);
        }
        w.bits(0, 1);
        w.bits(0, 1); // Not show-existing; keyframe.
        w.bits(1, 1);
        w.bits(0, 1); // Show frame, no error resilience.
        w.bits(0x49_83_42, 24);
        if profile >= 2 {
            w.bits(u32::from(depth == 12), 1);
        }
        w.bits(u32::from(color), 3);
        if color == 7 {
            w.bits(0, 1);
        } else {
            w.bits(u32::from(range), 1);
            if profile == 1 || profile == 3 {
                w.bits(u32::from(x), 1);
                w.bits(u32::from(y), 1);
                w.bits(0, 1);
            }
        }
        w.bits(95, 16);
        w.bits(63, 16); // 96x64 coded frame.
        w.bits(1, 1);
        w.bits(191, 16);
        w.bits(63, 16); // 192x64 rendered.
        w.finish(&[])
    }

    #[test]
    fn vp9_keyframe_config_preserves_profile_depth_color_and_geometry() {
        let unknown = vp9_from_keyframe(&vp9_key(0, 8, 0, false, 1, 1)).unwrap();
        assert_eq!(
            (
                unknown.width,
                unknown.height,
                unknown.render_width,
                unknown.render_height
            ),
            (96, 64, 192, 64)
        );
        assert_eq!(
            unknown.codec_string().unwrap(),
            "vp09.00.10.08.01.02.02.02.00"
        );
        let bt2020 = vp9_from_keyframe(&vp9_key(2, 10, 5, true, 1, 1)).unwrap();
        assert_eq!(
            bt2020.codec_string().unwrap(),
            "vp09.02.10.10.01.09.14.09.01"
        );
        let rgb = vp9_from_keyframe(&vp9_key(3, 12, 7, true, 0, 0)).unwrap();
        assert_eq!(rgb.codec_string().unwrap(), "vp09.03.10.12.03.01.13.00.01");
        let yuv422 = vp9_from_keyframe(&vp9_key(1, 8, 2, false, 1, 0)).unwrap();
        assert_eq!(
            yuv422.codec_string().unwrap(),
            "vp09.01.10.08.02.01.01.01.00"
        );
        let chroma_440 = vp9_from_keyframe(&vp9_key(1, 8, 2, false, 0, 1)).unwrap();
        assert_eq!(chroma_440.codec_string(), Err(Error::Unsupported));
    }

    #[test]
    fn vp9_keyframe_rejects_invalid_and_unbounded_prefixes() {
        let key = vp9_key(0, 8, 0, false, 1, 1);
        assert_eq!(vp9_from_keyframe(&key[..1]), Err(Error::Truncated));
        assert_eq!(vp9_from_keyframe(&vec![0; 4097]), Err(Error::ResourceLimit));
        let mut invalid = key.clone();
        invalid[0] &= 0x3f;
        assert_eq!(vp9_from_keyframe(&invalid), Err(Error::Invalid));
        let mut inter = key.clone();
        inter[0] |= 0x04;
        assert_eq!(vp9_from_keyframe(&inter), Err(Error::Unsupported));
        let mut existing = key.clone();
        existing[0] |= 0x08;
        assert_eq!(vp9_from_keyframe(&existing), Err(Error::Unsupported));
        let mut sync = key.clone();
        sync[1] ^= 1;
        assert_eq!(vp9_from_keyframe(&sync), Err(Error::Invalid));
        let mut reserved = vp9_key(3, 10, 2, false, 1, 1);
        reserved[0] |= 0x08;
        assert_eq!(vp9_from_keyframe(&reserved), Err(Error::Invalid));
        assert_eq!(
            vp9_from_keyframe(&vp9_key(1, 8, 2, false, 1, 1)),
            Err(Error::Invalid)
        );
    }

    #[test]
    fn avcc_and_hvcc_extract_vui_without_container_assumptions() {
        let avc = avc_nal();
        let mut avcc = vec![1, 66, 0, 30, 0xff, 0xe1];
        avcc.extend_from_slice(&(avc.len() as u16).to_be_bytes());
        avcc.extend_from_slice(&avc);
        avcc.extend_from_slice(&[1, 0, 1, 0x68]);
        assert_eq!(from_config(*b"avc1", &avcc), Ok(Some(expected())));
        let hevc = hevc_nal();
        let mut hvcc = vec![0; 23];
        hvcc[0] = 1;
        hvcc[22] = 1;
        hvcc.extend_from_slice(&[0x80 | 33, 0, 1]);
        hvcc.extend_from_slice(&(hevc.len() as u16).to_be_bytes());
        hvcc.extend_from_slice(&hevc);
        assert_eq!(from_config(*b"hev1", &hvcc), Ok(Some(expected())));
        assert_eq!(from_sps(*b"hev1", &hevc), Ok(Some(expected())));
    }

    #[test]
    fn absent_and_malformed_configurations_are_bounded() {
        assert_eq!(from_config(*b"VP90", &[1]), Ok(None));
        assert_eq!(from_config(*b"avc1", &[]), Ok(None));
        assert_eq!(from_config(*b"avc1", &[1, 66]), Err(Error::Truncated));
        assert_eq!(
            from_config(*b"avc1", &[1, 66, 0, 30, 0xff, 0xe1, 0, 8, 0x67]),
            Err(Error::Truncated)
        );
        assert_eq!(from_config(*b"hvc1", &[0; 23]), Err(Error::Invalid));
        let mut truncated_hvcc = vec![0; 23];
        truncated_hvcc[0] = 1;
        truncated_hvcc[22] = 1;
        truncated_hvcc.extend_from_slice(&[33, 0, 1, 0, 8, 0x42]);
        assert_eq!(
            from_config(*b"hvc1", &truncated_hvcc),
            Err(Error::Truncated)
        );
        assert_eq!(
            from_config(*b"hev1", &vec![0; MAX_CONFIG + 1]),
            Err(Error::ResourceLimit)
        );
        assert_eq!(from_sps(*b"avc1", &[0x67, 0]), Err(Error::Truncated));
        assert_eq!(from_sps(*b"hev1", &[0x42, 0x01, 0]), Err(Error::Truncated));
    }
}
