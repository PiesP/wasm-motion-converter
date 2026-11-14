// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Minimal bounded EBML structure parsing for selected local video tracks.

use crate::{codec_metadata, Error, Track};

pub const EBML: u64 = 0x1a45_dfa3;
pub const SEGMENT: u64 = 0x1853_8067;
pub const INFO: u64 = 0x1549_a966;
pub const TRACKS: u64 = 0x1654_ae6b;
pub const TRACK_ENTRY: u64 = 0xae;
pub const CLUSTER: u64 = 0x1f43_b675;
pub const TIMECODE: u64 = 0xe7;
pub const SIMPLE_BLOCK: u64 = 0xa3;
pub const BLOCK_GROUP: u64 = 0xa0;
pub const BLOCK: u64 = 0xa1;
pub const BLOCK_DURATION: u64 = 0x9b;
pub const REFERENCE_BLOCK: u64 = 0xfb;

pub fn vint(input: &[u8], offset: usize, keep_marker: bool) -> Result<(u64, usize), Error> {
    let first = *input.get(offset).ok_or(Error::Truncated)?;
    if first == 0 {
        return Err(Error::Invalid);
    }
    let count = first.leading_zeros() as usize + 1;
    if count > 8 || offset.checked_add(count).ok_or(Error::Overflow)? > input.len() {
        return Err(Error::Truncated);
    }
    let mut value = if keep_marker {
        first as u64
    } else {
        (first & ((1u16 << (8 - count)) as u8 - 1)) as u64
    };
    for byte in &input[offset + 1..offset + count] {
        value = (value << 8) | *byte as u64;
    }
    Ok((value, count))
}

pub fn header(input: &[u8], offset: usize) -> Result<(u64, u64, usize), Error> {
    let (id, id_len) = vint(input, offset, true)?;
    let (size, size_len) = vint(input, offset + id_len, false)?;
    let unknown = size == ((1u64 << (7 * size_len)) - 1);
    Ok((id, if unknown { u64::MAX } else { size }, id_len + size_len))
}

pub fn children(mut data: &[u8], max_items: usize) -> Result<Vec<(u64, &[u8])>, Error> {
    let mut out = Vec::new();
    while !data.is_empty() {
        if out.len() >= max_items {
            return Err(Error::ResourceLimit);
        }
        let (id, size, head) = header(data, 0)?;
        let size = usize::try_from(size).map_err(|_| Error::ResourceLimit)?;
        let end = head.checked_add(size).ok_or(Error::Overflow)?;
        if end > data.len() {
            return Err(Error::Truncated);
        }
        out.push((id, &data[head..end]));
        data = &data[end..];
    }
    Ok(out)
}

pub fn unsigned(bytes: &[u8]) -> Result<u64, Error> {
    if bytes.is_empty() || bytes.len() > 8 {
        return Err(Error::Invalid);
    }
    let mut n = 0u64;
    for byte in bytes {
        n = (n << 8) | *byte as u64;
    }
    Ok(n)
}

fn float(bytes: &[u8]) -> Result<f64, Error> {
    let value = match bytes.len() {
        4 => f32::from_bits(u32::from_be_bytes(bytes.try_into().unwrap())) as f64,
        8 => f64::from_bits(u64::from_be_bytes(bytes.try_into().unwrap())),
        _ => return Err(Error::Invalid),
    };
    if !value.is_finite() || value < 0.0 {
        return Err(Error::Invalid);
    }
    Ok(value)
}

pub fn parse_info(data: &[u8]) -> Result<(u64, u64), Error> {
    let mut scale = 1_000_000u64;
    let mut duration = 0.0f64;
    for (id, body) in children(data, 512)? {
        if id == 0x2ad7b1 {
            scale = unsigned(body)?;
        }
        if id == 0x4489 {
            duration = float(body)?;
        }
    }
    if scale == 0 || scale > 1_000_000_000 {
        return Err(Error::Invalid);
    }
    let ns = duration * scale as f64;
    if ns > u64::MAX as f64 {
        return Err(Error::Overflow);
    }
    Ok((scale, ns as u64))
}

/** Round a presentation end to the Segment TimecodeScale without changing packet timing. */
pub fn round_duration_to_scale(duration_ns: u64, scale_ns: u64) -> Result<u64, Error> {
    if scale_ns == 0 {
        return Err(Error::Invalid);
    }
    duration_ns
        .checked_add(scale_ns / 2)
        .ok_or(Error::Overflow)?
        .checked_div(scale_ns)
        .ok_or(Error::Invalid)?
        .checked_mul(scale_ns)
        .ok_or(Error::Overflow)
}

fn find(data: &[u8], id: u64) -> Result<Option<&[u8]>, Error> {
    Ok(children(data, 1024)?
        .into_iter()
        .find(|(kind, _)| *kind == id)
        .map(|(_, body)| body))
}

type VideoSize = (u32, u32, u32, u32, u16, u16, u16, i8);

fn video_size(data: &[u8]) -> Result<VideoSize, Error> {
    let width = find(data, 0xb0)?
        .ok_or(Error::Unsupported)
        .and_then(unsigned)?;
    let height = find(data, 0xba)?
        .ok_or(Error::Unsupported)
        .and_then(unsigned)?;
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err(Error::ResourceLimit);
    }
    let display_width = find(data, 0x54b0)?
        .map(unsigned)
        .transpose()?
        .unwrap_or(width);
    let display_height = find(data, 0x54ba)?
        .map(unsigned)
        .transpose()?
        .unwrap_or(height);
    let display_width = u32::try_from(display_width).map_err(|_| Error::ResourceLimit)?;
    let display_height = u32::try_from(display_height).map_err(|_| Error::ResourceLimit)?;
    if display_width == 0 || display_height == 0 {
        return Err(Error::Invalid);
    }
    let color = find(data, 0x55b0)?;
    let field = |id: u64| -> Result<u16, Error> {
        let value = match color {
            Some(body) => find(body, id)?.map(unsigned).transpose()?,
            None => None,
        };
        value.map_or(Ok(u16::MAX), |n| {
            u16::try_from(n).map_err(|_| Error::ResourceLimit)
        })
    };
    let range = color
        .map(|body| find(body, 0x55b9))
        .transpose()?
        .flatten()
        .map(unsigned)
        .transpose()?
        .unwrap_or(0);
    let full_range = match range {
        1 => 0,
        2 => 1,
        _ => -1,
    };
    Ok((
        width as u32,
        height as u32,
        display_width,
        display_height,
        field(0x55bb)?,
        field(0x55ba)?,
        field(0x55b1)?,
        full_range,
    ))
}

pub fn parse_tracks(data: &[u8], scale: u64, duration: u64) -> Result<(Track, u64, bool), Error> {
    for (id, entry) in children(data, 256)? {
        if id != TRACK_ENTRY {
            continue;
        }
        if find(entry, 0x83)?.map(unsigned).transpose()? != Some(1) {
            continue;
        }
        let number = find(entry, 0xd7)?
            .ok_or(Error::Unsupported)
            .and_then(unsigned)?;
        let number_u32 = u32::try_from(number).map_err(|_| Error::ResourceLimit)?;
        if number == 0 {
            return Err(Error::Invalid);
        }
        let codec_id = find(entry, 0x86)?.ok_or(Error::Unsupported)?;
        let codec = match codec_id {
            b"V_VP8" => *b"VP80",
            b"V_VP9" => *b"VP90",
            b"V_AV1" => *b"AV01",
            b"V_MPEG4/ISO/AVC" => *b"avc1",
            b"V_MPEGH/ISO/HEVC" => *b"hev1",
            _ => return Err(Error::Unsupported),
        };
        let video = find(entry, 0xe0)?.ok_or(Error::Unsupported)?;
        let display_explicit = find(video, 0x54b0)?.is_some() || find(video, 0x54ba)?.is_some();
        let (
            width,
            height,
            mut display_width,
            mut display_height,
            mut color_primaries,
            mut color_transfer,
            mut color_matrix,
            mut color_full_range,
        ) = video_size(video)?;
        let description_bytes = find(entry, 0x63a2)?.unwrap_or(&[]);
        if description_bytes.len() > 1024 * 1024 {
            return Err(Error::ResourceLimit);
        }
        let signal = codec_metadata::from_config(codec, description_bytes)?;
        let description = description_bytes.to_vec();
        if let Some(signal) = signal {
            if find(video, 0x54b0)?.is_none() && find(video, 0x54ba)?.is_none() {
                display_width = width.checked_mul(signal.sar_num).ok_or(Error::Overflow)?;
                display_height = height.checked_mul(signal.sar_den).ok_or(Error::Overflow)?;
            }
            if color_primaries == u16::MAX {
                color_primaries = signal.color_primaries;
            }
            if color_transfer == u16::MAX {
                color_transfer = signal.color_transfer;
            }
            if color_matrix == u16::MAX {
                color_matrix = signal.color_matrix;
            }
            if color_full_range == -1 {
                color_full_range = signal.color_full_range;
            }
        }
        let default_duration = find(entry, 0x23e383)?
            .map(unsigned)
            .transpose()?
            .unwrap_or(0);
        return Ok((
            Track {
                track_id: number_u32,
                codec,
                width,
                height,
                display_width,
                display_height,
                color_primaries,
                color_transfer,
                color_matrix,
                color_full_range,
                timescale: 1_000_000_000,
                duration,
                rotation: 0,
                description,
                packets: Vec::new(),
                fragment_default_duration: default_duration,
                fragment_default_size: 0,
                fragment_default_flags: 0,
                edit_shift: 0,
            },
            scale,
            display_explicit,
        ));
    }
    Err(Error::Unsupported)
}

pub fn block_header(data: &[u8]) -> Result<(u64, i16, u8, usize), Error> {
    let (track, width) = vint(data, 0, false)?;
    if data.len() < width + 3 {
        return Err(Error::Truncated);
    }
    let relative = i16::from_be_bytes([data[width], data[width + 1]]);
    let flags = data[width + 2];
    Ok((track, relative, flags, width + 3))
}

/// Returns source-relative offsets and lengths for each independently readable frame.
/// The caller must request enough of the small lace header, never the full media payload.
pub fn lace_ranges(
    header: &[u8],
    body_size: u64,
    flags: u8,
    prefix: usize,
) -> Result<Vec<(u64, u32)>, Error> {
    let mode = (flags >> 1) & 3;
    let mut at = prefix;
    let count = if mode == 0 {
        1
    } else {
        let value = *header.get(at).ok_or(Error::Truncated)? as usize + 1;
        at += 1;
        value
    };
    let mut sizes = Vec::with_capacity(count);
    match mode {
        0 => {}
        1 => {
            for _ in 0..count - 1 {
                let mut size = 0u64;
                loop {
                    let n = *header.get(at).ok_or(Error::Truncated)? as u64;
                    at += 1;
                    size = size.checked_add(n).ok_or(Error::Overflow)?;
                    if n != 255 {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
        2 => {}
        3 => {
            let (first, used) = vint(header, at, false)?;
            sizes.push(first);
            at += used;
            for _ in 1..count - 1 {
                let (coded, used) = vint(header, at, false)?;
                let bits = used * 7;
                let bias = (1i64 << (bits - 1)) - 1;
                let delta = (coded as i64) - bias;
                let next = (*sizes.last().unwrap() as i128) + (delta as i128);
                if next < 0 {
                    return Err(Error::Invalid);
                }
                sizes.push(u64::try_from(next).map_err(|_| Error::Overflow)?);
                at += used;
            }
        }
        _ => unreachable!(),
    }
    let payload = body_size.checked_sub(at as u64).ok_or(Error::Invalid)?;
    if mode == 2 {
        if payload % count as u64 != 0 {
            return Err(Error::Invalid);
        }
        sizes.resize(count, payload / count as u64);
    } else {
        let used = sizes
            .iter()
            .try_fold(0u64, |total, size| total.checked_add(*size))
            .ok_or(Error::Overflow)?;
        let last = payload.checked_sub(used).ok_or(Error::Invalid)?;
        sizes.push(last);
    }
    let mut out = Vec::with_capacity(count);
    let mut offset = at as u64;
    for size in sizes {
        if size == 0 || size > crate::PACKET_BUDGET as u64 {
            return Err(Error::ResourceLimit);
        }
        out.push((offset, size as u32));
        offset = offset.checked_add(size).ok_or(Error::Overflow)?;
    }
    if offset != body_size {
        return Err(Error::Invalid);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vint_bounds_and_unknown_size() {
        assert_eq!(vint(&[0x81], 0, false), Ok((1, 1)));
        assert_eq!(vint(&[0x40, 0x7f], 0, false), Ok((127, 2)));
        assert_eq!(vint(&[0], 0, false), Err(Error::Invalid));
        assert_eq!(header(&[0xa3, 0xff], 0), Ok((SIMPLE_BLOCK, u64::MAX, 2)));
    }
    #[test]
    fn xiph_fixed_and_ebml_lace_ranges_are_bounded() {
        assert_eq!(
            lace_ranges(&[0x81, 0, 0, 0x02, 2, 5, 5], 22, 0x02, 4),
            Ok(vec![(7, 5), (12, 5), (17, 5)])
        );
        assert_eq!(
            lace_ranges(&[0x81, 0, 0, 0x04, 2], 20, 0x04, 4),
            Ok(vec![(5, 5), (10, 5), (15, 5)])
        );
        assert_eq!(
            lace_ranges(&[0x81, 0, 0, 0x06, 2, 0x85, 0xbf], 22, 0x06, 4),
            Ok(vec![(7, 5), (12, 5), (17, 5)])
        );
        assert_eq!(
            lace_ranges(&[0x81, 0, 0, 0x02, 2, 5], 22, 0x02, 4),
            Err(Error::Truncated)
        );
    }

    #[test]
    fn explicit_display_and_color_metadata_override_bitstream_defaults() {
        fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
            let mut bytes = id.to_vec();
            bytes.push(0x80 | body.len() as u8);
            bytes.extend_from_slice(body);
            bytes
        }
        let mut color = element(&[0x55, 0xb9], &[2]);
        color.extend(element(&[0x55, 0xbb], &[1]));
        color.extend(element(&[0x55, 0xba], &[13]));
        color.extend(element(&[0x55, 0xb1], &[6]));
        let mut video = element(&[0xb0], &[16]);
        video.extend(element(&[0xba], &[8]));
        video.extend(element(&[0x54, 0xb0], &[32]));
        video.extend(element(&[0x54, 0xba], &[8]));
        video.extend(element(&[0x55, 0xb0], &color));
        assert_eq!(video_size(&video), Ok((16, 8, 32, 8, 1, 13, 6, 1)));
    }

    #[test]
    fn absent_color_is_distinct_from_explicit_rgb_matrix() {
        let dimensions = [0xb0, 0x81, 16, 0xba, 0x81, 16];
        let absent = video_size(&dimensions).unwrap();
        assert_eq!(
            (absent.4, absent.5, absent.6),
            (u16::MAX, u16::MAX, u16::MAX)
        );
        let mut explicit = dimensions.to_vec();
        explicit.extend([0x55, 0xb0, 0x84, 0x55, 0xb1, 0x81, 0]);
        let parsed = video_size(&explicit).unwrap();
        assert_eq!((parsed.4, parsed.5, parsed.6), (u16::MAX, u16::MAX, 0));
    }

    #[test]
    fn default_duration_can_exceed_four_billion_nanoseconds() {
        fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
            let mut bytes = id.to_vec();
            bytes.push(0x80 | body.len() as u8);
            bytes.extend_from_slice(body);
            bytes
        }
        let mut video = element(&[0xb0], &[16]);
        video.extend(element(&[0xba], &[16]));
        let mut entry = element(&[0xd7], &[1]);
        entry.extend(element(&[0x83], &[1]));
        entry.extend(element(&[0x86], b"V_VP8"));
        entry.extend(element(&[0xe0], &video));
        entry.extend(element(
            &[0x23, 0xe3, 0x83],
            &5_000_000_000u64.to_be_bytes()[3..],
        ));
        let track = element(&[0xae], &entry);
        assert_eq!(
            parse_tracks(&track, 1_000_000, 0)
                .unwrap()
                .0
                .fragment_default_duration,
            5_000_000_000
        );
    }

    #[test]
    fn track_duration_rounds_to_segment_timecode_without_shortening_packets() {
        assert_eq!(
            round_duration_to_scale(1_999_666_666, 1_000_000),
            Ok(2_000_000_000)
        );
        assert_eq!(
            round_duration_to_scale(750_000_000, 1_000_000),
            Ok(750_000_000)
        );
        assert_eq!(
            round_duration_to_scale(5_000_000_000, 1_000_000),
            Ok(5_000_000_000)
        );
        assert_eq!(
            round_duration_to_scale(u64::MAX, 1_000_000),
            Err(Error::Overflow)
        );
    }
}
