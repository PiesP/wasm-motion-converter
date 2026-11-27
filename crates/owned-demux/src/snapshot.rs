// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Versioned logical packet index. The wire data contains no Rust heap pointers.

use crate::{
    ts::{rebase_presentation, TsPacketSource},
    Error, Format, Packet, Track, METADATA_BUDGET, PACKET_BUDGET,
};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const STEP_BYTES: usize = 8 * 1024;
const HEADER: usize = 64;
const TRACK: usize = 64;
const PACKET: usize = 40;
const SOURCE: usize = 16;
const MAGIC: &[u8; 8] = b"ODXIDX01";

fn crc32(mut crc: u32, bytes: &[u8]) -> u32 {
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    crc
}

fn format_byte(format: Format) -> Result<u8, Error> {
    match format {
        Format::Mp4 => Ok(1),
        Format::Ebml => Ok(2),
        Format::Ts => Ok(3),
        Format::Unknown => Err(Error::Invalid),
    }
}

fn parse_format(byte: u8) -> Result<Format, Error> {
    match byte {
        1 => Ok(Format::Mp4),
        2 => Ok(Format::Ebml),
        3 => Ok(Format::Ts),
        _ => Err(Error::Invalid),
    }
}

fn total_len(track: &Track, format: Format, codec: &str) -> Result<Option<usize>, Error> {
    if track.description.len() > 1024 * 1024 || codec.len() > 128 || track.packets.is_empty() {
        return Err(Error::ResourceLimit);
    }
    let source_width = if format == Format::Ts { SOURCE } else { 0 };
    let total = HEADER
        .checked_add(TRACK)
        .and_then(|n| n.checked_add(track.description.len()))
        .and_then(|n| n.checked_add(codec.len()))
        .and_then(|n| n.checked_add(track.packets.len().checked_mul(PACKET + source_width)?))
        .and_then(|n| n.checked_add(4))
        .ok_or(Error::Overflow)?;
    Ok((total <= MAX_BYTES).then_some(total))
}

fn header(track: &Track, format: Format, codec: &str, file_len: u64, total: usize) -> [u8; HEADER] {
    let mut out = [0; HEADER];
    out[..8].copy_from_slice(MAGIC);
    out[8..10].copy_from_slice(&1u16.to_le_bytes());
    out[10..12].copy_from_slice(&(crate::ABI_VERSION as u16).to_le_bytes());
    out[12] = format_byte(format).expect("complete session has a format");
    out[16..24].copy_from_slice(&file_len.to_le_bytes());
    out[24..28].copy_from_slice(&(track.packets.len() as u32).to_le_bytes());
    out[28..32].copy_from_slice(&(track.description.len() as u32).to_le_bytes());
    out[32..36].copy_from_slice(&(codec.len() as u32).to_le_bytes());
    out[36..38].copy_from_slice(&(PACKET as u16).to_le_bytes());
    out[38..40].copy_from_slice(
        &(if format == Format::Ts {
            SOURCE as u16
        } else {
            0
        })
        .to_le_bytes(),
    );
    out[40..44].copy_from_slice(&(total as u32).to_le_bytes());
    out
}

fn track_bytes(track: &Track) -> [u8; TRACK] {
    let mut out = [0; TRACK];
    out[0..4].copy_from_slice(&track.track_id.to_le_bytes());
    out[4..8].copy_from_slice(&track.codec);
    out[8..12].copy_from_slice(&track.width.to_le_bytes());
    out[12..16].copy_from_slice(&track.height.to_le_bytes());
    out[16..20].copy_from_slice(&track.display_width.to_le_bytes());
    out[20..24].copy_from_slice(&track.display_height.to_le_bytes());
    out[24..26].copy_from_slice(&track.color_primaries.to_le_bytes());
    out[26..28].copy_from_slice(&track.color_transfer.to_le_bytes());
    out[28..30].copy_from_slice(&track.color_matrix.to_le_bytes());
    out[30] = track.color_full_range as u8;
    out[32..36].copy_from_slice(&track.timescale.to_le_bytes());
    out[36..44].copy_from_slice(&track.duration.to_le_bytes());
    out[44..46].copy_from_slice(&track.rotation.to_le_bytes());
    out[48..56].copy_from_slice(&track.fragment_default_duration.to_le_bytes());
    out[56..60].copy_from_slice(&track.fragment_default_size.to_le_bytes());
    out[60..64].copy_from_slice(&track.fragment_default_flags.to_le_bytes());
    out
}

fn packet_bytes(packet: &Packet) -> [u8; PACKET] {
    let mut out = [0; PACKET];
    out[0..8].copy_from_slice(&packet.offset.to_le_bytes());
    out[8..12].copy_from_slice(&packet.size.to_le_bytes());
    out[12..20].copy_from_slice(&packet.dts.to_le_bytes());
    out[20..28].copy_from_slice(&packet.pts.to_le_bytes());
    out[28..36].copy_from_slice(&packet.duration.to_le_bytes());
    out[36] = u8::from(packet.key);
    out
}

fn source_bytes(source: TsPacketSource) -> [u8; SOURCE] {
    let mut out = [0; SOURCE];
    out[0..8].copy_from_slice(&source.end.to_le_bytes());
    out[8..10].copy_from_slice(&source.pid.to_le_bytes());
    out[10..12].copy_from_slice(&source.stride.to_le_bytes());
    out[12] = source.prefix;
    out
}

pub struct Export {
    total: usize,
    at: usize,
    crc: u32,
}

impl Export {
    pub fn new(
        track: &Track,
        format: Format,
        codec: &str,
        sources: &[TsPacketSource],
    ) -> Result<Option<Self>, Error> {
        format_byte(format)?;
        if (format == Format::Ts && sources.len() != track.packets.len())
            || (format != Format::Ts && !sources.is_empty())
        {
            return Err(Error::Invalid);
        }
        Ok(total_len(track, format, codec)?.map(|total| Self {
            total,
            at: 0,
            crc: !0,
        }))
    }

    pub fn total(&self) -> u32 {
        self.total as u32
    }
    pub fn finished(&self) -> bool {
        self.at == self.total
    }

    pub fn next(
        &mut self,
        dst: &mut [u8],
        track: &Track,
        format: Format,
        codec: &str,
        sources: &[TsPacketSource],
        file_len: u64,
    ) -> Result<usize, Error> {
        if self.at == self.total {
            return Ok(0);
        }
        if dst.len() < STEP_BYTES {
            return Err(Error::Invalid);
        }
        let length = STEP_BYTES.min(self.total - self.at);
        let data_length = (self.total - 4).saturating_sub(self.at).min(length);
        let mut written = 0;
        while written < length {
            let pos = self.at + written;
            let h = header(track, format, codec, file_len, self.total);
            let t = track_bytes(track);
            let desc_at = HEADER + TRACK;
            let codec_at = desc_at + track.description.len();
            let packet_at = codec_at + codec.len();
            let source_at = packet_at + track.packets.len() * PACKET;
            let (slice, local): (&[u8], usize) = if pos < HEADER {
                (&h, pos)
            } else if pos < desc_at {
                (&t, pos - HEADER)
            } else if pos < codec_at {
                (&track.description, pos - desc_at)
            } else if pos < packet_at {
                (codec.as_bytes(), pos - codec_at)
            } else if pos < source_at {
                let rel = pos - packet_at;
                let record = packet_bytes(&track.packets[rel / PACKET]);
                let local = rel % PACKET;
                let n = (PACKET - local).min(length - written);
                dst[written..written + n].copy_from_slice(&record[local..local + n]);
                written += n;
                continue;
            } else if pos < self.total - 4 {
                let rel = pos - source_at;
                let record = source_bytes(sources[rel / SOURCE]);
                let local = rel % SOURCE;
                let n = (SOURCE - local).min(length - written);
                dst[written..written + n].copy_from_slice(&record[local..local + n]);
                written += n;
                continue;
            } else {
                if written == data_length {
                    self.crc = crc32(self.crc, &dst[..data_length]);
                }
                let crc = (!self.crc).to_le_bytes();
                let local = pos - (self.total - 4);
                let n = (crc.len() - local).min(length - written);
                dst[written..written + n].copy_from_slice(&crc[local..local + n]);
                written += n;
                continue;
            };
            let n = (slice.len() - local).min(length - written);
            dst[written..written + n].copy_from_slice(&slice[local..local + n]);
            written += n;
        }
        if data_length == length {
            self.crc = crc32(self.crc, &dst[..data_length]);
        }
        self.at += length;
        Ok(length)
    }
}

pub struct Import {
    bytes: Vec<u8>,
    total: usize,
    decoded: usize,
    track: Option<Track>,
    format: Option<Format>,
    codec: Option<String>,
    sources: Vec<TsPacketSource>,
    file_len: u64,
    crc: u32,
}

impl Import {
    pub fn new(total: usize, file_len: u64) -> Result<Self, Error> {
        if !(HEADER + TRACK + PACKET + 4..=MAX_BYTES).contains(&total) {
            return Err(Error::ResourceLimit);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(total)
            .map_err(|_| Error::ResourceLimit)?;
        Ok(Self {
            bytes,
            total,
            decoded: 0,
            track: None,
            format: None,
            codec: None,
            sources: Vec::new(),
            file_len,
            crc: !0,
        })
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), Error> {
        if chunk.is_empty()
            || chunk.len() > STEP_BYTES
            || self
                .bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|n| n > self.total)
        {
            return Err(Error::Invalid);
        }
        let data_remaining = (self.total - 4)
            .saturating_sub(self.bytes.len())
            .min(chunk.len());
        self.crc = crc32(self.crc, &chunk[..data_remaining]);
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() >= HEADER && self.format.is_none() {
            self.validate_header()?;
        }
        Ok(())
    }

    fn validate_header(&mut self) -> Result<(), Error> {
        let b = &self.bytes;
        if &b[..8] != MAGIC
            || u16::from_le_bytes(b[8..10].try_into().unwrap()) != 1
            || u16::from_le_bytes(b[10..12].try_into().unwrap()) != crate::ABI_VERSION as u16
            || b[13..16].iter().any(|&n| n != 0)
            || b[44..64].iter().any(|&n| n != 0)
            || u64::from_le_bytes(b[16..24].try_into().unwrap()) != self.file_len
            || u16::from_le_bytes(b[36..38].try_into().unwrap()) != PACKET as u16
            || u32::from_le_bytes(b[40..44].try_into().unwrap()) as usize != self.total
        {
            return Err(Error::Invalid);
        }
        let format = parse_format(b[12])?;
        let count = u32::from_le_bytes(b[24..28].try_into().unwrap()) as usize;
        let desc = u32::from_le_bytes(b[28..32].try_into().unwrap()) as usize;
        let codec = u32::from_le_bytes(b[32..36].try_into().unwrap()) as usize;
        let source_width = u16::from_le_bytes(b[38..40].try_into().unwrap()) as usize;
        if count == 0
            || desc > 1024 * 1024
            || codec > 128
            || source_width != (if format == Format::Ts { SOURCE } else { 0 })
            || HEADER
                .checked_add(TRACK)
                .and_then(|n| n.checked_add(desc))
                .and_then(|n| n.checked_add(codec))
                .and_then(|n| n.checked_add(count.checked_mul(PACKET + source_width)?))
                .and_then(|n| n.checked_add(4))
                != Some(self.total)
        {
            return Err(Error::Invalid);
        }
        let index_bytes = count
            .checked_mul(
                std::mem::size_of::<Packet>()
                    + if format == Format::Ts {
                        std::mem::size_of::<TsPacketSource>()
                    } else {
                        0
                    },
            )
            .ok_or(Error::Overflow)?;
        // The serialized input remains live while both reconstructed vectors grow.
        if self
            .bytes
            .capacity()
            .checked_add(index_bytes)
            .and_then(|n| n.checked_add(desc))
            .and_then(|n| n.checked_add(codec))
            .and_then(|n| n.checked_add(64 * 1024))
            .is_none_or(|n| n > METADATA_BUDGET)
        {
            return Err(Error::ResourceLimit);
        }
        self.format = Some(format);
        Ok(())
    }

    pub fn complete_input(&self) -> bool {
        self.bytes.len() == self.total
    }

    /// Decode at most 256 packet records per call after the bounded input copy.
    pub fn step(&mut self) -> Result<bool, Error> {
        if !self.complete_input() {
            return Err(Error::Invalid);
        }
        let b = &self.bytes;
        if self.track.is_none() {
            let expected = u32::from_le_bytes(b[self.total - 4..].try_into().unwrap());
            if (!self.crc) != expected {
                return Err(Error::Invalid);
            }
            let t = &b[HEADER..HEADER + TRACK];
            if t[31] != 0
                || t[46..48].iter().any(|&n| n != 0)
                || ![-1, 0, 1].contains(&(t[30] as i8))
            {
                return Err(Error::Invalid);
            }
            let count = u32::from_le_bytes(b[24..28].try_into().unwrap()) as usize;
            let desc = u32::from_le_bytes(b[28..32].try_into().unwrap()) as usize;
            let codec_len = u32::from_le_bytes(b[32..36].try_into().unwrap()) as usize;
            let mut description = Vec::new();
            description
                .try_reserve_exact(desc)
                .map_err(|_| Error::ResourceLimit)?;
            description.extend_from_slice(&b[HEADER + TRACK..HEADER + TRACK + desc]);
            let codec_bytes = &b[HEADER + TRACK + desc..HEADER + TRACK + desc + codec_len];
            if codec_bytes.iter().any(|&n| !n.is_ascii()) {
                return Err(Error::Invalid);
            }
            self.codec = Some(String::from_utf8(codec_bytes.to_vec()).map_err(|_| Error::Invalid)?);
            let mut packets = Vec::new();
            packets
                .try_reserve_exact(count)
                .map_err(|_| Error::ResourceLimit)?;
            if self.format == Some(Format::Ts) {
                self.sources
                    .try_reserve_exact(count)
                    .map_err(|_| Error::ResourceLimit)?;
            }
            let track = Track {
                track_id: u32::from_le_bytes(t[0..4].try_into().unwrap()),
                codec: t[4..8].try_into().unwrap(),
                width: u32::from_le_bytes(t[8..12].try_into().unwrap()),
                height: u32::from_le_bytes(t[12..16].try_into().unwrap()),
                display_width: u32::from_le_bytes(t[16..20].try_into().unwrap()),
                display_height: u32::from_le_bytes(t[20..24].try_into().unwrap()),
                color_primaries: u16::from_le_bytes(t[24..26].try_into().unwrap()),
                color_transfer: u16::from_le_bytes(t[26..28].try_into().unwrap()),
                color_matrix: u16::from_le_bytes(t[28..30].try_into().unwrap()),
                color_full_range: t[30] as i8,
                timescale: u32::from_le_bytes(t[32..36].try_into().unwrap()),
                duration: u64::from_le_bytes(t[36..44].try_into().unwrap()),
                rotation: u16::from_le_bytes(t[44..46].try_into().unwrap()),
                description,
                packets,
                fragment_default_duration: u64::from_le_bytes(t[48..56].try_into().unwrap()),
                fragment_default_size: u32::from_le_bytes(t[56..60].try_into().unwrap()),
                fragment_default_flags: u32::from_le_bytes(t[60..64].try_into().unwrap()),
                edit_shift: 0,
            };
            if track.width == 0
                || track.height == 0
                || track.display_width == 0
                || track.display_height == 0
                || track.timescale == 0
            {
                return Err(Error::Invalid);
            }
            if track.duration > 9_007_199_254_740_991 {
                return Err(Error::Invalid);
            }
            self.track = Some(track);
        }
        let track = self.track.as_mut().ok_or(Error::Invalid)?;
        let count = u32::from_le_bytes(b[24..28].try_into().unwrap()) as usize;
        let desc = track.description.len();
        let codec_len = self.codec.as_ref().ok_or(Error::Invalid)?.len();
        let packet_at = HEADER + TRACK + desc + codec_len;
        let source_at = packet_at + count * PACKET;
        let end = (self.decoded + 256).min(count);
        for index in self.decoded..end {
            let p = &b[packet_at + index * PACKET..packet_at + (index + 1) * PACKET];
            let offset = u64::from_le_bytes(p[0..8].try_into().unwrap());
            let size = u32::from_le_bytes(p[8..12].try_into().unwrap());
            let duration = u64::from_le_bytes(p[28..36].try_into().unwrap());
            let dts = i64::from_le_bytes(p[12..20].try_into().unwrap());
            let pts = i64::from_le_bytes(p[20..28].try_into().unwrap());
            if size == 0
                || size > PACKET_BUDGET
                || duration > 9_007_199_254_740_991
                || dts.unsigned_abs() > 9_007_199_254_740_991
                || pts.unsigned_abs() > 9_007_199_254_740_991
                || p[36] > 1
                || p[37..40].iter().any(|&n| n != 0)
            {
                return Err(Error::Invalid);
            }
            if self.format == Some(Format::Ts) {
                let s = &b[source_at + index * SOURCE..source_at + (index + 1) * SOURCE];
                let source_end = u64::from_le_bytes(s[0..8].try_into().unwrap());
                let stride = u16::from_le_bytes(s[10..12].try_into().unwrap());
                let prefix = s[12];
                if offset >= source_end
                    || source_end > self.file_len
                    || u64::from(size) > source_end - offset
                    || !matches!((stride, prefix), (188, 0) | (192, 4) | (204, 0))
                    || u16::from_le_bytes(s[8..10].try_into().unwrap()) > 0x1fff
                    || s[13..16].iter().any(|&n| n != 0)
                {
                    return Err(Error::Invalid);
                }
                self.sources.push(TsPacketSource {
                    start: offset,
                    end: source_end,
                    pid: u16::from_le_bytes(s[8..10].try_into().unwrap()),
                    stride,
                    prefix,
                });
            } else if offset
                .checked_add(u64::from(size))
                .is_none_or(|end| end > self.file_len)
            {
                return Err(Error::Invalid);
            }
            track.packets.push(Packet {
                offset,
                size,
                dts,
                pts,
                duration,
                key: p[36] == 1,
            });
        }
        self.decoded = end;
        Ok(end == count)
    }

    pub fn take(mut self) -> Result<(Track, Format, String, Vec<TsPacketSource>), Error> {
        if self
            .track
            .as_ref()
            .is_none_or(|t| self.decoded != t.packets.len())
        {
            return Err(Error::Invalid);
        }
        let mut track = self.track.take().unwrap();
        let format = self.format.ok_or(Error::Invalid)?;
        if format == Format::Ts {
            // Older TS snapshots used the transport clock. New ones already start at zero.
            let origin = track
                .packets
                .iter()
                .map(|packet| packet.pts)
                .min()
                .ok_or(Error::Invalid)?;
            rebase_presentation(&mut track, origin)?;
        }
        Ok((
            track,
            format,
            self.codec.take().ok_or(Error::Invalid)?,
            self.sources,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Track {
        Track {
            track_id: 7,
            codec: *b"avc1",
            width: 96,
            height: 64,
            display_width: 192,
            display_height: 64,
            color_primaries: 1,
            color_transfer: 1,
            color_matrix: 1,
            color_full_range: 0,
            timescale: 12_288,
            duration: 24_576,
            rotation: 90,
            description: vec![1, 2, 3, 4],
            packets: vec![
                Packet {
                    offset: 128,
                    size: 32,
                    dts: 0,
                    pts: 1_024,
                    duration: 12_288,
                    key: true,
                },
                Packet {
                    offset: 160,
                    size: 32,
                    dts: 12_288,
                    pts: 13_312,
                    duration: 12_288,
                    key: false,
                },
            ],
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        }
    }

    fn wire(track: &Track, format: Format, sources: &[TsPacketSource]) -> Vec<u8> {
        let mut export = Export::new(track, format, "", sources).unwrap().unwrap();
        let mut wire = Vec::new();
        let mut chunk = [0; STEP_BYTES];
        while !export.finished() {
            let length = export
                .next(&mut chunk, track, format, "", sources, 1024)
                .unwrap();
            wire.extend_from_slice(&chunk[..length]);
        }
        assert_eq!(wire.len(), export.total() as usize);
        assert_eq!(
            !crc32(!0, &wire[..wire.len() - 4]),
            u32::from_le_bytes(wire[wire.len() - 4..].try_into().unwrap())
        );
        wire
    }

    fn import(wire: &[u8]) -> Result<(Track, Format, String, Vec<TsPacketSource>), Error> {
        let mut import = Import::new(wire.len(), 1024)?;
        for chunk in wire.chunks(13) {
            import.feed(chunk)?;
        }
        while !import.step()? {}
        import.take()
    }

    #[test]
    fn round_trip_preserves_logical_packets_and_track() {
        let track = fixture();
        let (restored, format, codec, sources) = import(&wire(&track, Format::Mp4, &[])).unwrap();
        assert_eq!(restored, track);
        assert_eq!(format, Format::Mp4);
        assert!(codec.is_empty());
        assert!(sources.is_empty());
    }

    #[test]
    fn ts_source_ranges_survive_and_corruption_fails() {
        let mut track = fixture();
        track.packets[0].offset = 0;
        track.packets[1].offset = 188;
        track.duration += 1024;
        let sources = [
            TsPacketSource {
                start: 0,
                end: 188,
                pid: 256,
                stride: 188,
                prefix: 0,
            },
            TsPacketSource {
                start: 188,
                end: 376,
                pid: 256,
                stride: 188,
                prefix: 0,
            },
        ];
        let valid = wire(&track, Format::Ts, &sources);
        let (restored, format, _, restored_sources) = import(&valid).unwrap();
        assert_eq!(restored.duration, 24_576);
        assert_eq!(restored.packets[0].pts, 0);
        assert_eq!(restored.packets[0].dts, -1024);
        assert_eq!(restored.packets[1].pts, 12_288);
        assert_eq!(restored.packets[1].dts, 11_264);
        assert_eq!(restored.packets[1].duration, track.packets[1].duration);
        assert_eq!(
            import(&wire(&restored, Format::Ts, &sources)).unwrap().0,
            restored
        );
        assert_eq!(format, Format::Ts);
        assert_eq!(restored_sources.as_slice(), sources.as_slice());
        let mut corrupt = valid;
        corrupt[HEADER + TRACK + 2] ^= 1;
        assert_eq!(import(&corrupt), Err(Error::Invalid));
    }

    #[test]
    fn restores_legacy_ts_decode_preroll_across_the_clock_wrap() {
        let mut track = fixture();
        track.duration = 7;
        track.packets[0].offset = 0;
        track.packets[0].pts = 1;
        track.packets[0].dts = (1i64 << 33) - 2;
        track.packets[0].duration = 3;
        track.packets[1].offset = 188;
        track.packets[1].pts = 4;
        track.packets[1].dts = 1i64 << 33;
        track.packets[1].duration = 3;
        let sources = [0, 188].map(|start| TsPacketSource {
            start,
            end: start + 188,
            pid: 256,
            stride: 188,
            prefix: 0,
        });
        let restored = import(&wire(&track, Format::Ts, &sources)).unwrap().0;
        let clocks: Vec<_> = restored.packets.iter().map(|p| (p.pts, p.dts)).collect();
        assert_eq!(clocks, [(0, -3), (3, -1)]);
        assert_eq!(restored.duration, 6);
    }

    #[test]
    fn oversize_index_is_a_prospective_cache_miss() {
        let mut track = fixture();
        let packet = track.packets[0].clone();
        track.packets.resize(210_000, packet);
        assert!(Export::new(&track, Format::Mp4, "", &[]).unwrap().is_none());
    }

    #[test]
    fn import_decodes_no_more_than_256_packets_per_step() {
        let mut track = fixture();
        let packet = track.packets[0].clone();
        track.packets.resize(600, packet);
        let bytes = wire(&track, Format::Mp4, &[]);
        let mut import = Import::new(bytes.len(), 1024).unwrap();
        for chunk in bytes.chunks(STEP_BYTES) {
            import.feed(chunk).unwrap();
        }
        assert!(!import.step().unwrap());
        assert_eq!(import.track.as_ref().unwrap().packets.len(), 256);
        assert!(!import.step().unwrap());
        assert_eq!(import.track.as_ref().unwrap().packets.len(), 512);
        assert!(import.step().unwrap());
        assert_eq!(import.take().unwrap().0.packets, track.packets);
    }
}
