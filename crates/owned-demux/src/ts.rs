// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Incremental MPEG-TS metadata and packet-range indexing (ITU-T H.222.0).
//! Compressed access units remain in the host file. A separate bounded lease
//! reconstructs one selected PES payload from TS source packets when requested.

use crate::{Error, Packet, Track, METADATA_BUDGET, PACKET_BUDGET};
use std::collections::BTreeMap;

const TS_BYTES: usize = 188;
const MAX_READ: usize = 64 * 1024;
const MAX_PSI: usize = 4096;
const MAX_SPS: usize = 1024 * 1024;
const MAX_INPUT: u64 = 500 * 1024 * 1024;
const INDEX_POLICY_BYTES: usize = 256; // Packet, source span, PTS tree and spare capacity.
const CLOCK_WRAP: i64 = 1i64 << 33;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TsPacketSource {
    pub start: u64,
    pub end: u64,
    pub pid: u16,
    pub stride: u16,
    pub prefix: u8,
}

#[derive(Debug)]
pub struct TsResult {
    pub track: Track,
    pub packet_sources: Vec<TsPacketSource>,
    /// WebCodecs codec string. TS uses Annex-B payloads, so Track.description stays empty.
    pub codec_string: String,
    pub video_info: VideoInfo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub color_primaries: u16,
    pub color_transfer: u16,
    pub color_matrix: u16,
    /// -1 means the bitstream does not specify range.
    pub color_full_range: i8,
}

struct Section {
    bytes: Vec<u8>,
    expected: Option<usize>,
}

impl Section {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            expected: None,
        }
    }
    fn clear(&mut self) {
        self.bytes.clear();
        self.expected = None;
    }
    fn push(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, Error> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or(Error::Overflow)?
            > MAX_PSI
        {
            return Err(Error::ResourceLimit);
        }
        self.bytes.extend_from_slice(bytes);
        if self.expected.is_none() && self.bytes.len() >= 3 {
            let size = (((self.bytes[1] & 0x0f) as usize) << 8) | self.bytes[2] as usize;
            if !(9..=MAX_PSI - 3).contains(&size) {
                return Err(Error::Invalid);
            }
            self.expected = Some(3 + size);
        }
        if let Some(size) = self.expected {
            if self.bytes.len() >= size {
                let result = self.bytes[..size].to_vec();
                self.clear();
                return Ok(Some(result));
            }
        }
        Ok(None)
    }
}

#[derive(Clone, Copy)]
struct TsPayload<'a> {
    pid: u16,
    start: bool,
    continuity: u8,
    discontinuity: bool,
    bytes: &'a [u8],
}

fn parse_transport(packet: &[u8]) -> Result<TsPayload<'_>, Error> {
    if packet.len() != TS_BYTES || packet[0] != 0x47 || packet[1] & 0x80 != 0 {
        return Err(Error::Invalid);
    }
    let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
    let adaptation = (packet[3] >> 4) & 3;
    if adaptation == 0 || packet[3] & 0xc0 != 0 {
        return Err(Error::Unsupported);
    }
    let mut at = 4;
    let mut discontinuity = false;
    if adaptation & 2 != 0 {
        let len = usize::from(packet[at]);
        if len > 183 || at + 1 + len > TS_BYTES {
            return Err(Error::Truncated);
        }
        discontinuity = len != 0 && (packet[at + 1] & 0x80 != 0);
        at += 1 + len;
    }
    Ok(TsPayload {
        pid,
        start: packet[1] & 0x40 != 0,
        continuity: packet[3] & 0x0f,
        discontinuity,
        bytes: if adaptation & 1 != 0 {
            &packet[at..]
        } else {
            &[]
        },
    })
}

fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc ^= u32::from(byte) << 24;
        for _ in 0..8 {
            crc = (crc << 1)
                ^ if crc & 0x8000_0000 != 0 {
                    0x04c1_1db7
                } else {
                    0
                };
        }
    }
    crc
}

fn table_with_pointer<'a>(
    payload: &'a [u8],
    new_section: bool,
    section: &mut Section,
) -> Result<Option<Vec<u8>>, Error> {
    if new_section {
        if payload.is_empty() {
            return Err(Error::Truncated);
        }
        let pointer = payload[0] as usize;
        if 1 + pointer > payload.len() {
            return Err(Error::Truncated);
        }
        if !section.bytes.is_empty() {
            let finished = section.push(&payload[1..1 + pointer])?;
            if finished.is_none() {
                return Err(Error::Truncated);
            }
        }
        section.clear();
        section.push(&payload[1 + pointer..])
    } else if section.bytes.is_empty() {
        Ok(None)
    } else {
        section.push(payload)
    }
}

fn pat_pid(bytes: &[u8]) -> Result<u16, Error> {
    if bytes.len() < 12 || bytes[0] != 0 || crc32_mpeg(bytes) != 0 {
        return Err(Error::Invalid);
    }
    let mut at = 8;
    let mut chosen = None;
    while at + 4 <= bytes.len() - 4 {
        let program = u16::from_be_bytes([bytes[at], bytes[at + 1]]);
        let pid = ((u16::from(bytes[at + 2]) & 0x1f) << 8) | u16::from(bytes[at + 3]);
        if program != 0 {
            chosen.get_or_insert(pid);
        }
        at += 4;
    }
    chosen.ok_or(Error::Unsupported)
}

fn pmt_video(bytes: &[u8]) -> Result<(u16, [u8; 4]), Error> {
    if bytes.len() < 16 || bytes[0] != 2 || crc32_mpeg(bytes) != 0 {
        return Err(Error::Invalid);
    }
    let program_info = ((usize::from(bytes[10] & 0x0f)) << 8) | usize::from(bytes[11]);
    let mut at = 12usize.checked_add(program_info).ok_or(Error::Overflow)?;
    if at > bytes.len() - 4 {
        return Err(Error::Truncated);
    }
    while at + 5 <= bytes.len() - 4 {
        let stream_type = bytes[at];
        let pid = ((u16::from(bytes[at + 1]) & 0x1f) << 8) | u16::from(bytes[at + 2]);
        let info_len = ((usize::from(bytes[at + 3] & 0x0f)) << 8) | usize::from(bytes[at + 4]);
        at = at.checked_add(5 + info_len).ok_or(Error::Overflow)?;
        if at > bytes.len() - 4 {
            return Err(Error::Truncated);
        }
        match stream_type {
            0x1b => return Ok((pid, *b"avc1")),
            0x24 => return Ok((pid, *b"hev1")),
            _ => {}
        }
    }
    Err(Error::Unsupported)
}

fn timestamp(data: &[u8], prefix: u8) -> Result<i64, Error> {
    if data.len() < 5
        || data[0] >> 4 != prefix
        || data[0] & 1 == 0
        || data[2] & 1 == 0
        || data[4] & 1 == 0
    {
        return Err(Error::Invalid);
    }
    Ok((i64::from((data[0] >> 1) & 7) << 30)
        | (i64::from(data[1]) << 22)
        | (i64::from(data[2] >> 1) << 15)
        | (i64::from(data[3]) << 7)
        | i64::from(data[4] >> 1))
}

fn unwrap_clock(raw: i64, previous: Option<i64>) -> Result<i64, Error> {
    let Some(last) = previous else {
        return Ok(raw);
    };
    let base = last.div_euclid(CLOCK_WRAP) * CLOCK_WRAP;
    let near = base.checked_add(raw).ok_or(Error::Overflow)?;
    let variants = [
        near.checked_sub(CLOCK_WRAP),
        Some(near),
        near.checked_add(CLOCK_WRAP),
    ];
    variants
        .into_iter()
        .flatten()
        .min_by_key(|v| v.abs_diff(last))
        .ok_or(Error::Overflow)
}

struct PesHeader {
    pts: i64,
    dts: i64,
    data_start: usize,
}

fn pes_prefix(
    data: &[u8],
    prior_pts: Option<i64>,
    prior_dts: Option<i64>,
) -> Result<PesHeader, Error> {
    if data.len() < 9
        || data[..3] != [0, 0, 1]
        || !(0xe0..=0xef).contains(&data[3])
        || data[6] & 0xc0 != 0x80
    {
        return Err(Error::Invalid);
    }
    let header_len = data[8] as usize;
    let data_start = 9usize.checked_add(header_len).ok_or(Error::Overflow)?;
    if data_start > data.len() {
        return Err(Error::Truncated);
    }
    let flags = (data[7] >> 6) & 3;
    if (flags == 2 && header_len < 5) || (flags == 3 && header_len < 10) {
        return Err(Error::Truncated);
    }
    let raw_pts = match flags {
        2 => timestamp(&data[9..], 2)?,
        3 => timestamp(&data[9..], 3)?,
        _ => return Err(Error::Unsupported),
    };
    let pts = unwrap_clock(raw_pts, prior_pts)?;
    let dts = if flags == 3 {
        unwrap_clock(timestamp(&data[14..], 1)?, prior_dts)?
    } else {
        pts
    };
    Ok(PesHeader {
        pts,
        dts,
        data_start,
    })
}

/// Watch Annex-B start codes across transport-packet boundaries. Retain at most
/// one bounded SPS while classifying key pictures; no full PES copy is needed.
struct NalScanner {
    codec: [u8; 4],
    zeros: usize,
    awaiting_header: bool,
    sps: Vec<u8>,
    capture_sps: bool,
    key: bool,
    video_info: Option<VideoInfo>,
    codec_string: Option<String>,
}

impl NalScanner {
    fn new(codec: [u8; 4]) -> Self {
        Self {
            codec,
            zeros: 0,
            awaiting_header: false,
            sps: Vec::new(),
            capture_sps: false,
            key: false,
            video_info: None,
            codec_string: None,
        }
    }
    fn complete_sps(&mut self) -> Result<(), Error> {
        if self.capture_sps && self.video_info.is_none() {
            if self.codec == *b"avc1" {
                self.video_info = Some(avc_video_info(&self.sps)?);
                if self.sps.len() < 4 {
                    return Err(Error::Truncated);
                }
                self.codec_string = Some(format!(
                    "avc1.{:02x}{:02x}{:02x}",
                    self.sps[1], self.sps[2], self.sps[3]
                ));
            } else {
                let (width, height) = hevc_dimensions(&self.sps)?;
                self.video_info = Some(VideoInfo {
                    width,
                    height,
                    display_width: width,
                    display_height: height,
                    color_primaries: 0,
                    color_transfer: 0,
                    color_matrix: 0,
                    color_full_range: -1,
                });
                self.codec_string = Some(hevc_codec_string(&self.sps)?);
            }
        }
        self.sps.clear();
        self.capture_sps = false;
        Ok(())
    }
    fn feed(&mut self, bytes: &[u8]) -> Result<(), Error> {
        for &byte in bytes {
            if byte == 0 {
                self.zeros = (self.zeros + 1).min(4);
                if self.capture_sps {
                    if self.sps.len() >= MAX_SPS {
                        return Err(Error::ResourceLimit);
                    }
                    self.sps.push(0);
                }
                continue;
            }
            if byte == 1 && self.zeros >= 2 {
                if self.capture_sps {
                    let trailing = self.zeros.min(self.sps.len());
                    self.sps.truncate(self.sps.len() - trailing);
                    self.complete_sps()?;
                }
                self.awaiting_header = true;
                self.zeros = 0;
                continue;
            }
            self.zeros = 0;
            if self.awaiting_header {
                self.awaiting_header = false;
                let kind = if self.codec == *b"avc1" {
                    byte & 0x1f
                } else {
                    (byte >> 1) & 0x3f
                };
                self.key |= if self.codec == *b"avc1" {
                    kind == 5
                } else {
                    matches!(kind, 16..=21)
                };
                self.capture_sps = self.video_info.is_none()
                    && if self.codec == *b"avc1" {
                        kind == 7
                    } else {
                        kind == 33
                    };
                if self.capture_sps {
                    self.sps.push(byte);
                }
            } else if self.capture_sps {
                if self.sps.len() >= MAX_SPS {
                    return Err(Error::ResourceLimit);
                }
                self.sps.push(byte);
            }
        }
        Ok(())
    }
    fn finish(mut self) -> Result<(bool, Option<VideoInfo>, Option<String>), Error> {
        self.complete_sps()?;
        Ok((self.key, self.video_info, self.codec_string))
    }
}

struct BitReader {
    bytes: Vec<u8>,
    bit: usize,
}
impl BitReader {
    fn from_nal(nal: &[u8]) -> Result<Self, Error> {
        let mut bytes = Vec::with_capacity(nal.len().min(4096));
        let mut zero = 0;
        for &byte in nal {
            if zero == 2 && byte == 3 {
                zero = 0;
                continue;
            }
            bytes.push(byte);
            zero = if byte == 0 { zero + 1 } else { 0 };
            if bytes.len() > MAX_SPS {
                return Err(Error::ResourceLimit);
            }
        }
        Ok(Self { bytes, bit: 0 })
    }
    fn bits(&mut self, count: usize) -> Result<u32, Error> {
        if count > 32 || self.bit.checked_add(count).ok_or(Error::Overflow)? > self.bytes.len() * 8
        {
            return Err(Error::Truncated);
        }
        let mut value = 0;
        for _ in 0..count {
            value = value << 1 | u32::from((self.bytes[self.bit / 8] >> (7 - self.bit % 8)) & 1);
            self.bit += 1;
        }
        Ok(value)
    }
    fn ue(&mut self) -> Result<u32, Error> {
        let mut zeros = 0;
        while self.bits(1)? == 0 {
            zeros += 1;
            if zeros > 30 {
                return Err(Error::Invalid);
            }
        }
        Ok((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
    fn se(&mut self) -> Result<i32, Error> {
        let value = self.ue()?;
        Ok(if value & 1 != 0 {
            (value as i32 + 1) / 2
        } else {
            -(value as i32 / 2)
        })
    }
}

fn avc_video_info(nal: &[u8]) -> Result<VideoInfo, Error> {
    if nal.is_empty() {
        return Err(Error::Truncated);
    }
    let mut b = BitReader::from_nal(&nal[1..])?;
    let profile = b.bits(8)?;
    b.bits(8)?;
    b.bits(8)?;
    b.ue()?;
    let mut chroma = 1;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma = b.ue()?;
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
                let mut scale = 8i32;
                for _ in 0..if i < 6 { 16 } else { 64 } {
                    scale = (scale + b.se()?).rem_euclid(256);
                }
            }
        }
    }
    b.ue()?;
    let poc_type = b.ue()?;
    if poc_type == 0 {
        b.ue()?;
    } else if poc_type == 1 {
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
    } else if poc_type != 2 {
        return Err(Error::Unsupported);
    }
    b.ue()?;
    b.bits(1)?;
    let width_mbs = b.ue()?.checked_add(1).ok_or(Error::Overflow)?;
    let height_map = b.ue()?.checked_add(1).ok_or(Error::Overflow)?;
    let frame_only = b.bits(1)?;
    if frame_only == 0 {
        b.bits(1)?;
    }
    b.bits(1)?;
    let crop = if b.bits(1)? != 0 {
        [b.ue()?, b.ue()?, b.ue()?, b.ue()?]
    } else {
        [0; 4]
    };
    let crop_x = crop[0]
        .checked_add(crop[1])
        .and_then(|x| x.checked_mul(if chroma == 0 || chroma == 3 { 1 } else { 2 }))
        .ok_or(Error::Overflow)?;
    let crop_y = crop[2]
        .checked_add(crop[3])
        .and_then(|x| {
            x.checked_mul(if chroma == 1 {
                2 * (2 - frame_only)
            } else {
                2 - frame_only
            })
        })
        .ok_or(Error::Overflow)?;
    let width = width_mbs
        .checked_mul(16)
        .and_then(|x| x.checked_sub(crop_x))
        .ok_or(Error::Invalid)?;
    let height = height_map
        .checked_mul(16 * (2 - frame_only))
        .and_then(|x| x.checked_sub(crop_y))
        .ok_or(Error::Invalid)?;
    if width == 0 || height == 0 {
        return Err(Error::Invalid);
    }
    let mut info = VideoInfo {
        width,
        height,
        display_width: width,
        display_height: height,
        color_primaries: 0,
        color_transfer: 0,
        color_matrix: 0,
        color_full_range: 0,
    };
    if b.bits(1)? == 0 {
        return Ok(info);
    }
    if b.bits(1)? != 0 {
        let idc = b.bits(8)?;
        let (num, den) = match idc {
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
        if num == 0 || den == 0 {
            return Err(Error::Invalid);
        }
        info.display_width = width.checked_mul(num).ok_or(Error::Overflow)?;
        info.display_height = height.checked_mul(den).ok_or(Error::Overflow)?;
    }
    if b.bits(1)? != 0 {
        b.bits(1)?;
    } // overscan_info_present_flag
    if b.bits(1)? != 0 {
        b.bits(3)?; // video_format
        info.color_full_range = b.bits(1)? as i8;
        if b.bits(1)? != 0 {
            info.color_primaries = b.bits(8)? as u16;
            info.color_transfer = b.bits(8)? as u16;
            info.color_matrix = b.bits(8)? as u16;
        }
    }
    Ok(info)
}

fn hevc_dimensions(nal: &[u8]) -> Result<(u32, u32), Error> {
    if nal.len() < 4 {
        return Err(Error::Truncated);
    }
    let mut b = BitReader::from_nal(&nal[2..])?;
    b.bits(4)?;
    let layers = b.bits(3)? as usize;
    b.bits(1)?;
    // profile_tier_level general profile and optional sublayer fields.
    b.bits(2)?;
    b.bits(1)?;
    b.bits(5)?;
    b.bits(32)?;
    b.bits(32)?;
    b.bits(16)?;
    b.bits(8)?;
    let mut profiles = Vec::with_capacity(layers);
    for _ in 0..layers {
        profiles.push((b.bits(1)?, b.bits(1)?));
    }
    if layers > 0 {
        for _ in layers..8 {
            b.bits(2)?;
        }
    }
    for (profile, level) in profiles {
        if profile != 0 {
            b.bits(32)?;
            b.bits(32)?;
            b.bits(24)?;
        }
        if level != 0 {
            b.bits(8)?;
        }
    }
    b.ue()?;
    let chroma = b.ue()?;
    if chroma == 3 {
        b.bits(1)?;
    }
    let width = b.ue()?;
    let height = b.ue()?;
    let window = if b.bits(1)? != 0 {
        [b.ue()?, b.ue()?, b.ue()?, b.ue()?]
    } else {
        [0; 4]
    };
    let cx = if chroma == 1 || chroma == 2 { 2 } else { 1 };
    let cy = if chroma == 1 { 2 } else { 1 };
    let crop_x = window[0]
        .checked_add(window[1])
        .and_then(|x| x.checked_mul(cx))
        .ok_or(Error::Overflow)?;
    let crop_y = window[2]
        .checked_add(window[3])
        .and_then(|x| x.checked_mul(cy))
        .ok_or(Error::Overflow)?;
    let width = width.checked_sub(crop_x).ok_or(Error::Invalid)?;
    let height = height.checked_sub(crop_y).ok_or(Error::Invalid)?;
    if width == 0 || height == 0 {
        return Err(Error::Invalid);
    }
    Ok((width, height))
}

fn hevc_codec_string(nal: &[u8]) -> Result<String, Error> {
    let rbsp = BitReader::from_nal(nal)?;
    let bytes = rbsp.bytes;
    if bytes.len() < 15 {
        return Err(Error::Truncated);
    }
    let ptl = bytes[3];
    let space = match ptl >> 6 {
        0 => "",
        1 => "A",
        2 => "B",
        _ => "C",
    };
    let tier = if ptl & 0x20 != 0 { "H" } else { "L" };
    let profile = ptl & 0x1f;
    let compatibility =
        u32::from_be_bytes(bytes[4..8].try_into().map_err(|_| Error::Truncated)?).reverse_bits();
    let constraints = &bytes[8..14];
    let end = constraints
        .iter()
        .rposition(|&x| x != 0)
        .map_or(0, |i| i + 1);
    let mut codec = format!(
        "hev1.{space}{profile}.{compatibility:X}.{tier}{}",
        bytes[14]
    );
    for byte in &constraints[..end] {
        codec.push_str(&format!(".{byte:02X}"));
    }
    if codec.len() > 128 {
        return Err(Error::ResourceLimit);
    }
    Ok(codec)
}

struct Pes {
    start: u64,
    header: Vec<u8>,
    pts: Option<i64>,
    dts: Option<i64>,
    declared_bytes: Option<usize>,
    raw_bytes: usize,
    payload_bytes: u32,
    scan: NalScanner,
}

impl Pes {
    fn new(start: u64, codec: [u8; 4]) -> Self {
        Self {
            start,
            header: Vec::with_capacity(264),
            pts: None,
            dts: None,
            declared_bytes: None,
            raw_bytes: 0,
            payload_bytes: 0,
            scan: NalScanner::new(codec),
        }
    }
    fn feed(
        &mut self,
        bytes: &[u8],
        prior_pts: Option<i64>,
        prior_dts: Option<i64>,
    ) -> Result<(), Error> {
        self.raw_bytes = self
            .raw_bytes
            .checked_add(bytes.len())
            .ok_or(Error::Overflow)?;
        if self.raw_bytes > PACKET_BUDGET as usize + 264 {
            return Err(Error::ResourceLimit);
        }
        let mut remaining = bytes;
        while self.pts.is_none() {
            let target = if self.header.len() < 9 {
                9
            } else {
                9 + self.header[8] as usize
            };
            let take = remaining.len().min(target - self.header.len());
            self.header.extend_from_slice(&remaining[..take]);
            remaining = &remaining[take..];
            if self.header.len() < target {
                return Ok(());
            }
            if target == 9 && self.header[8] != 0 {
                continue;
            }
            let prefix = pes_prefix(&self.header, prior_pts, prior_dts)?;
            self.pts = Some(prefix.pts);
            self.dts = Some(prefix.dts);
            let declared = u16::from_be_bytes([self.header[4], self.header[5]]);
            self.declared_bytes = (declared != 0).then_some(usize::from(declared) + 6);
        }
        let amount = u32::try_from(remaining.len()).map_err(|_| Error::Overflow)?;
        self.payload_bytes = self
            .payload_bytes
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        if self.payload_bytes > PACKET_BUDGET {
            return Err(Error::ResourceLimit);
        }
        self.scan.feed(remaining)
    }
}

pub struct TsParser {
    file_len: u64,
    next_offset: u64,
    carry: Vec<u8>,
    stride: Option<usize>,
    prefix: usize,
    pmt_pid: Option<u16>,
    video_pid: Option<u16>,
    codec: Option<[u8; 4]>,
    pat: Section,
    pmt: Section,
    continuity: [Option<u8>; 3],
    current: Option<Pes>,
    packets: Vec<Packet>,
    packet_sources: Vec<TsPacketSource>,
    presentation: BTreeMap<i64, usize>,
    last_pts: Option<i64>,
    last_dts: Option<i64>,
    video_info: Option<VideoInfo>,
    codec_string: Option<String>,
}

impl TsParser {
    pub fn new(file_len: u64) -> Result<Self, Error> {
        if file_len < TS_BYTES as u64 || file_len > MAX_INPUT {
            return Err(Error::ResourceLimit);
        }
        Ok(Self {
            file_len,
            next_offset: 0,
            carry: Vec::with_capacity(204),
            stride: None,
            prefix: 0,
            pmt_pid: None,
            video_pid: None,
            codec: None,
            pat: Section::new(),
            pmt: Section::new(),
            continuity: [None; 3],
            current: None,
            packets: Vec::new(),
            packet_sources: Vec::new(),
            presentation: BTreeMap::new(),
            last_pts: None,
            last_dts: None,
            video_info: None,
            codec_string: None,
        })
    }

    pub fn feed(&mut self, offset: u64, chunk: &[u8]) -> Result<(), Error> {
        if offset != self.next_offset
            || chunk.is_empty()
            || chunk.len() > MAX_READ
            || offset
                .checked_add(chunk.len() as u64)
                .ok_or(Error::Overflow)?
                > self.file_len
        {
            return Err(Error::Invalid);
        }
        self.next_offset += chunk.len() as u64;
        self.carry.extend_from_slice(chunk);
        if self.stride.is_none() {
            if self.carry.len() < 408 && self.next_offset != self.file_len {
                return Ok(());
            }
            let matched = [(188, 0), (192, 4), (204, 0)]
                .into_iter()
                .find(|&(stride, prefix)| {
                    self.carry.len() >= prefix + stride * 2 + 1
                        && self.carry[prefix] == 0x47
                        && self.carry[prefix + stride] == 0x47
                        && self.carry[prefix + stride * 2] == 0x47
                });
            let Some((stride, prefix)) = matched else {
                return Err(Error::Unsupported);
            };
            self.stride = Some(stride);
            self.prefix = prefix;
        }
        let stride = self.stride.unwrap();
        let full = self.carry.len() / stride * stride;
        let base = self.next_offset - self.carry.len() as u64;
        for at in (0..full).step_by(stride) {
            let start = at + self.prefix;
            if start + TS_BYTES > at + stride {
                return Err(Error::Invalid);
            }
            let mut packet = [0u8; TS_BYTES];
            packet.copy_from_slice(&self.carry[start..start + TS_BYTES]);
            self.feed_transport(base + at as u64, &packet)?;
        }
        self.carry.drain(..full);
        Ok(())
    }

    fn feed_transport(&mut self, source_offset: u64, packet: &[u8]) -> Result<(), Error> {
        let part = parse_transport(packet)?;
        let class = if part.pid == 0 {
            Some(0)
        } else if Some(part.pid) == self.pmt_pid {
            Some(1)
        } else if Some(part.pid) == self.video_pid {
            Some(2)
        } else {
            None
        };
        let Some(class) = class else {
            return Ok(());
        };
        if !part.bytes.is_empty() {
            if let Some(previous) = self.continuity[class] {
                if !part.discontinuity && part.continuity != (previous + 1) & 15 {
                    return Err(Error::Invalid);
                }
            }
            self.continuity[class] = Some(part.continuity);
        }
        if class == 0 || class == 1 {
            let complete = if class == 0 {
                table_with_pointer(part.bytes, part.start, &mut self.pat)?
            } else {
                table_with_pointer(part.bytes, part.start, &mut self.pmt)?
            };
            if let Some(bytes) = complete {
                if class == 0 {
                    let pid = pat_pid(&bytes)?;
                    if self.pmt_pid.is_some_and(|p| p != pid) {
                        return Err(Error::Unsupported);
                    }
                    self.pmt_pid = Some(pid);
                } else {
                    let (pid, codec) = pmt_video(&bytes)?;
                    if self.video_pid.is_some_and(|p| p != pid) {
                        return Err(Error::Unsupported);
                    }
                    self.video_pid = Some(pid);
                    self.codec = Some(codec);
                }
            }
            return Ok(());
        }
        if part.start {
            self.complete_pes(source_offset)?;
            self.current = Some(Pes::new(
                source_offset,
                self.codec.ok_or(Error::Unsupported)?,
            ));
        }
        if let Some(pes) = &mut self.current {
            pes.feed(part.bytes, self.last_pts, self.last_dts)?;
            if let (Some(pts), Some(dts)) = (pes.pts, pes.dts) {
                self.last_pts = Some(pts);
                self.last_dts = Some(dts);
            }
        }
        Ok(())
    }

    fn complete_pes(&mut self, source_end: u64) -> Result<(), Error> {
        let Some(pes) = self.current.take() else {
            return Ok(());
        };
        let pts = pes.pts.ok_or(Error::Truncated)?;
        let dts = pes.dts.ok_or(Error::Truncated)?;
        if pes.declared_bytes.is_some_and(|size| size != pes.raw_bytes) {
            return Err(Error::Invalid);
        }
        if pes.payload_bytes == 0 {
            return Err(Error::Invalid);
        }
        let (key, video_info, codec_string) = pes.scan.finish()?;
        if self.codec_string.is_none() {
            self.codec_string = codec_string;
        }
        if self.video_info.is_none() {
            self.video_info = video_info;
        }
        let index = self.packets.len();
        if (index + 1)
            .checked_mul(INDEX_POLICY_BYTES)
            .ok_or(Error::Overflow)?
            > METADATA_BUDGET
        {
            return Err(Error::ResourceLimit);
        }
        if pes.start >= source_end || source_end > self.file_len {
            return Err(Error::Invalid);
        }
        self.packets.push(Packet {
            offset: pes.start,
            size: pes.payload_bytes,
            dts,
            pts,
            duration: 0,
            key,
        });
        self.packet_sources.push(TsPacketSource {
            start: pes.start,
            end: source_end,
            pid: self.video_pid.unwrap(),
            stride: self.stride.unwrap() as u16,
            prefix: self.prefix as u8,
        });
        // Presentation-order durations are updated when neighboring PTS values
        // arrive; no unbounded final sort or decoded-frame assumption is needed.
        if let Some((&previous, &prev_index)) = self.presentation.range(..pts).next_back() {
            self.packets[prev_index].duration =
                u32::try_from(pts - previous).map_err(|_| Error::Overflow)?;
        }
        if let Some((&next, _)) = self.presentation.range(pts..).next() {
            self.packets[index].duration =
                u32::try_from(next - pts).map_err(|_| Error::Overflow)?;
        }
        self.presentation.insert(pts, index);
        Ok(())
    }

    pub fn finish(mut self) -> Result<TsResult, Error> {
        if self.next_offset != self.file_len || !self.carry.is_empty() {
            return Err(Error::Truncated);
        }
        self.complete_pes(self.file_len)?;
        let (&last_pts, &last_index) = self
            .presentation
            .last_key_value()
            .ok_or(Error::Unsupported)?;
        let duration = if let Some((&prev_pts, _)) = self.presentation.range(..last_pts).next_back()
        {
            u32::try_from(last_pts - prev_pts).map_err(|_| Error::Overflow)?
        } else {
            0
        };
        self.packets[last_index].duration = duration;
        let end = last_pts
            .checked_add(i64::from(duration))
            .ok_or(Error::Overflow)?;
        let video_info = self.video_info.ok_or(Error::Unsupported)?;
        let track = Track {
            track_id: u32::from(self.video_pid.ok_or(Error::Unsupported)?),
            codec: self.codec.ok_or(Error::Unsupported)?,
            width: video_info.width,
            height: video_info.height,
            display_width: video_info.display_width,
            display_height: video_info.display_height,
            color_primaries: video_info.color_primaries,
            color_transfer: video_info.color_transfer,
            color_matrix: video_info.color_matrix,
            color_full_range: video_info.color_full_range,
            timescale: 90_000,
            duration: u64::try_from(end).map_err(|_| Error::Overflow)?,
            rotation: 0,
            description: Vec::new(),
            packets: self.packets,
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        };
        Ok(TsResult {
            track,
            packet_sources: self.packet_sources,
            codec_string: self.codec_string.ok_or(Error::Unsupported)?,
            video_info,
        })
    }
}

/// A bounded lease for one reconstructed access unit. Feed at most 64 KiB of
/// the recorded source span at a time; the host admits the final output size.
pub struct PacketReassembler {
    source: TsPacketSource,
    expected_size: u32,
    next_offset: u64,
    carry: Vec<u8>,
    data: Vec<u8>,
    started: bool,
}

impl PacketReassembler {
    pub fn new(source: TsPacketSource, expected_size: u32) -> Result<Self, Error> {
        if source.start >= source.end
            || expected_size == 0
            || expected_size > PACKET_BUDGET
            || source.end - source.start > MAX_INPUT
            || !matches!(
                (source.stride, source.prefix),
                (188, 0) | (192, 4) | (204, 0)
            )
        {
            return Err(Error::ResourceLimit);
        }
        let mut data = Vec::new();
        data.try_reserve_exact(expected_size as usize + 264)
            .map_err(|_| Error::ResourceLimit)?;
        Ok(Self {
            source,
            expected_size,
            next_offset: source.start,
            carry: Vec::new(),
            data,
            started: false,
        })
    }
    pub fn feed(&mut self, offset: u64, chunk: &[u8]) -> Result<(), Error> {
        if offset != self.next_offset
            || chunk.is_empty()
            || chunk.len() > MAX_READ
            || offset
                .checked_add(chunk.len() as u64)
                .ok_or(Error::Overflow)?
                > self.source.end
        {
            return Err(Error::Invalid);
        }
        self.next_offset += chunk.len() as u64;
        self.carry.extend_from_slice(chunk);
        let stride = usize::from(self.source.stride);
        let full = self.carry.len() / stride * stride;
        for at in (0..full).step_by(stride) {
            let prefix = usize::from(self.source.prefix);
            let payload = parse_transport(&self.carry[at + prefix..at + prefix + TS_BYTES])?;
            if payload.pid != self.source.pid {
                continue;
            }
            if payload.start {
                if self.started {
                    return Err(Error::Invalid);
                }
                self.started = true;
            }
            if self.started {
                // PES header is at most 264 bytes; retain it with the payload
                // until all source packets are present, then strip it in place.
                let cap = self.expected_size as usize + 264;
                if self
                    .data
                    .len()
                    .checked_add(payload.bytes.len())
                    .ok_or(Error::Overflow)?
                    > cap
                {
                    return Err(Error::ResourceLimit);
                }
                self.data.extend_from_slice(payload.bytes);
            }
        }
        self.carry.drain(..full);
        Ok(())
    }
    pub fn finish(mut self) -> Result<Vec<u8>, Error> {
        if self.next_offset != self.source.end || !self.carry.is_empty() || !self.started {
            return Err(Error::Truncated);
        }
        let header = pes_prefix(&self.data, None, None)?;
        let declared = u16::from_be_bytes([self.data[4], self.data[5]]);
        if declared != 0 && usize::from(declared) + 6 != self.data.len() {
            return Err(Error::Invalid);
        }
        if self.data.len() - header.data_start != self.expected_size as usize {
            return Err(Error::Invalid);
        }
        self.data.copy_within(header.data_start.., 0);
        self.data.truncate(self.expected_size as usize);
        Ok(self.data)
    }
}

pub fn reconstruct_packet(
    source_bytes: &[u8],
    source: TsPacketSource,
    expected_size: u32,
) -> Result<Vec<u8>, Error> {
    if source_bytes.len() as u64 != source.end - source.start {
        return Err(Error::Invalid);
    }
    let mut lease = PacketReassembler::new(source, expected_size)?;
    for (index, chunk) in source_bytes.chunks(MAX_READ).enumerate() {
        lease.feed(source.start + (index * MAX_READ) as u64, chunk)?;
    }
    lease.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_and_clock_overflow_are_bounded() {
        assert_eq!(TsParser::new(0).err(), Some(Error::ResourceLimit));
        assert_eq!(timestamp(&[0; 5], 2).err(), Some(Error::Invalid));
        assert_eq!(parse_transport(&[0; TS_BYTES]).err(), Some(Error::Invalid));
        assert_eq!(
            unwrap_clock(CLOCK_WRAP - 1, Some(CLOCK_WRAP + 2)),
            Ok(CLOCK_WRAP - 1)
        );
        assert_eq!(unwrap_clock(1, Some(CLOCK_WRAP - 2)), Ok(CLOCK_WRAP + 1));
        let malformed_dts = [0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 5, 0x31, 0, 1, 0, 1];
        assert_eq!(
            pes_prefix(&malformed_dts, None, None).err(),
            Some(Error::Truncated)
        );
        assert_eq!(avc_video_info(&[]).err(), Some(Error::Truncated));
    }

    fn transport(pid: u16, start: bool, continuity: u8, payload: &[u8]) -> [u8; TS_BYTES] {
        assert!(payload.len() <= 184);
        let mut packet = [0xff; TS_BYTES];
        packet[0] = 0x47;
        packet[1] = ((pid >> 8) as u8 & 0x1f) | if start { 0x40 } else { 0 };
        packet[2] = pid as u8;
        packet[3] = if payload.len() == 184 { 0x10 } else { 0x30 } | continuity;
        let at = if payload.len() == 184 {
            4
        } else {
            let adaptation = 183 - payload.len();
            packet[4] = adaptation as u8;
            if adaptation != 0 {
                packet[5] = 0;
            }
            5 + adaptation
        };
        packet[at..at + payload.len()].copy_from_slice(payload);
        packet
    }

    fn pts90k(value: u64) -> [u8; 5] {
        [
            0x21 | (((value >> 30) as u8 & 7) << 1),
            (value >> 22) as u8,
            1 | (((value >> 15) as u8 & 0x7f) << 1),
            (value >> 7) as u8,
            1 | ((value as u8 & 0x7f) << 1),
        ]
    }

    fn small_owned_ts() -> ([u8; TS_BYTES * 4], Vec<u8>, Vec<u8>) {
        // PAT/PMT with independent CRC values from the owned FFmpeg testsrc2
        // generator; the frame bytes are an explicit two-AU synthetic control.
        let pat = hex_bytes("0000b00d0001c100000001f0002ab104b2");
        let pmt = hex_bytes("0002b0120001c10000e100f0001be100f00015bd4d56");
        let first = hex_bytes("0000016764000aacd94626c044000003000400000300303c4896580000016588");
        let second = hex_bytes("00000141aa");
        let mut pes1 = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5];
        pes1.extend_from_slice(&pts90k(156000));
        pes1.extend_from_slice(&first);
        let mut pes2 = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5];
        pes2.extend_from_slice(&pts90k(171000));
        pes2.extend_from_slice(&second);
        let mut file = [0u8; TS_BYTES * 4];
        for (i, packet) in [
            transport(0, true, 0, &pat),
            transport(0x1000, true, 0, &pmt),
            transport(0x100, true, 0, &pes1),
            transport(0x100, true, 1, &pes2),
        ]
        .into_iter()
        .enumerate()
        {
            file[i * TS_BYTES..(i + 1) * TS_BYTES].copy_from_slice(&packet);
        }
        (file, first, second)
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn avc_vui_preserves_sample_aspect_and_color() {
        let mut bits = Vec::new();
        let mut put = |value: u32, count: usize| {
            for shift in (0..count).rev() {
                bits.push(((value >> shift) & 1) as u8);
            }
        };
        put(66, 8);
        put(0, 8);
        put(30, 8); // Baseline SPS profile and level.
        for _ in 0..4 {
            put(1, 1);
        } // Four zero-valued Exp-Golomb fields.
        put(0b010, 3); // max_num_ref_frames = 1.
        put(0, 1); // gaps_in_frame_num_value_allowed_flag.
        put(1, 1);
        put(1, 1); // 16x16 picture in macroblocks.
        put(1, 1);
        put(1, 1);
        put(0, 1); // frame-only, direct inference, no crop.
        put(1, 1);
        put(1, 1);
        put(2, 8); // VUI, aspect present, 12:11.
        put(0, 1);
        put(1, 1);
        put(5, 3); // No overscan, video signal, format.
        put(1, 1);
        put(1, 1); // Full range, color description.
        put(1, 8);
        put(13, 8);
        put(6, 8); // Primaries, transfer, matrix.
        put(1, 1); // RBSP stop bit.
        let mut nal = vec![0x67];
        for chunk in bits.chunks(8) {
            let mut byte = 0u8;
            for &bit in chunk {
                byte = (byte << 1) | bit;
            }
            nal.push(byte << (8 - chunk.len()));
        }
        let info = avc_video_info(&nal).unwrap();
        assert_eq!((info.width, info.height), (16, 16));
        assert_eq!((info.display_width, info.display_height), (192, 176));
        assert_eq!(
            (
                info.color_primaries,
                info.color_transfer,
                info.color_matrix,
                info.color_full_range
            ),
            (1, 13, 6, 1)
        );
    }

    #[test]
    fn parses_checked_program_and_reconstructs_two_access_units() {
        let (file, first, second) = small_owned_ts();
        let mut parser = TsParser::new(file.len() as u64).unwrap();
        for (i, bytes) in file.chunks(61).enumerate() {
            parser.feed((i * 61) as u64, bytes).unwrap();
        }
        let result = parser.finish().unwrap();
        assert_eq!((result.track.width, result.track.height), (96, 64));
        assert_eq!(result.track.duration, 186000);
        assert_eq!(result.track.packets.len(), 2);
        assert!(result.track.packets[0].key);
        assert!(!result.track.packets[1].key);
        assert_eq!(
            (
                result.track.packets[0].pts,
                result.track.packets[0].duration
            ),
            (156000, 15000)
        );
        for (i, expected) in [first, second].into_iter().enumerate() {
            let source = result.packet_sources[i];
            let output = reconstruct_packet(
                &file[source.start as usize..source.end as usize],
                source,
                result.track.packets[i].size,
            )
            .unwrap();
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn fragmented_188_192_and_204_packet_strides_reassemble_identically() {
        let (plain, first, second) = small_owned_ts();
        for (stride, prefix) in [(188, 0), (192, 4), (204, 0)] {
            let mut file = Vec::new();
            for packet in plain.chunks_exact(TS_BYTES) {
                file.resize(file.len() + prefix, 0);
                file.extend_from_slice(packet);
                file.resize(file.len() + stride - prefix - TS_BYTES, 0);
            }
            let mut parser = TsParser::new(file.len() as u64).unwrap();
            for (i, chunk) in file.chunks(61).enumerate() {
                parser.feed((i * 61) as u64, chunk).unwrap();
            }
            let result = parser.finish().unwrap();
            for (index, expected) in [&first, &second].into_iter().enumerate() {
                let source = result.packet_sources[index];
                assert_eq!(
                    (source.stride, source.prefix),
                    (stride as u16, prefix as u8)
                );
                let mut lease =
                    PacketReassembler::new(source, result.track.packets[index].size).unwrap();
                for (i, chunk) in file[source.start as usize..source.end as usize]
                    .chunks(47)
                    .enumerate()
                {
                    lease.feed(source.start + (i * 47) as u64, chunk).unwrap();
                }
                assert_eq!(&lease.finish().unwrap(), expected);
            }
        }
    }

    #[test]
    fn malformed_program_and_discontinuous_video_fail() {
        let (mut file, _, _) = small_owned_ts();
        let pmt_payload = TS_BYTES + 5 + usize::from(file[TS_BYTES + 4]);
        file[pmt_payload + 10] ^= 1;
        let mut parser = TsParser::new(file.len() as u64).unwrap();
        assert_eq!(parser.feed(0, &file), Err(Error::Invalid));
        let (mut file, _, _) = small_owned_ts();
        file[3 * TS_BYTES + 3] = (file[3 * TS_BYTES + 3] & 0xf0) | 3;
        let mut parser = TsParser::new(file.len() as u64).unwrap();
        assert_eq!(parser.feed(0, &file), Err(Error::Invalid));
        let (file, _, _) = small_owned_ts();
        let mut parser = TsParser::new((file.len() - 1) as u64).unwrap();
        parser.feed(0, &file[..file.len() - 1]).unwrap();
        assert_eq!(parser.finish().err(), Some(Error::Truncated));
    }
}
