// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Bounded, conversion-owned parser for local media container metadata and packet ranges.
//! The host owns file reads and compressed payloads. No codec implementation is linked.

mod codec_metadata;
mod ebml;
mod mp4;
mod mp4_compact;
mod snapshot;
mod ts;

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

pub const ABI_VERSION: u32 = 4;
pub const INPUT_CAPACITY: usize = 64 * 1024;
pub const METADATA_BUDGET: usize = 32 * 1024 * 1024;
pub const PACKET_BUDGET: u32 = 16 * 1024 * 1024 - 1024;
pub const MAX_SAMPLES: usize = 100_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Truncated,
    ResourceLimit,
    Unsupported,
    Overflow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub offset: u64,
    pub size: u32,
    pub dts: i64,
    pub pts: i64,
    pub duration: u64,
    pub key: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    pub track_id: u32,
    pub codec: [u8; 4],
    pub width: u32,
    pub height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub color_primaries: u16,
    pub color_transfer: u16,
    pub color_matrix: u16,
    /// -1 unknown, 0 limited, 1 full.
    pub color_full_range: i8,
    pub timescale: u32,
    pub duration: u64,
    pub rotation: u16,
    pub description: Vec<u8>,
    pub packets: Vec<Packet>,
    pub fragment_default_duration: u64,
    pub fragment_default_size: u32,
    pub fragment_default_flags: u32,
    pub edit_shift: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    NeedInput = 1,
    Yield = 2,
    Complete = 3,
    Error = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub offset: u64,
    pub length: u32,
}

pub struct Mp4Session {
    len: u64,
    cursor: u64,
    window_offset: u64,
    window_len: usize,
    input: Vec<u8>,
    pending: Option<PendingBox>,
    index: Option<mp4::IndexBuilder>,
    compact_builder: Option<mp4_compact::CompactBuilder>,
    compact_index: Option<mp4_compact::CompactIndex>,
    classic_selected: bool,
    fragment: Option<mp4::FragmentBuilder>,
    track: Option<Track>,
    status: Status,
    need: Option<Request>,
    error: Option<Error>,
    format: Format,
    ebml: EbmlState,
    ts_parser: Option<ts::TsParser>,
    ts_cursor: u64,
    ts_sources: Vec<ts::TsPacketSource>,
    codec_string: String,
    ts_reassembly: Option<ts::PacketReassembler>,
    ts_reassembly_cursor: u64,
    ts_reconstructed: Vec<u8>,
    ts_carry: Vec<u8>,
    ts_prepared_max: u32,
    final_scan: usize,
    final_end: i64,
    snapshot_export: Option<snapshot::Export>,
    snapshot_import: Option<snapshot::Import>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Unknown,
    Mp4,
    Ebml,
    Ts,
}

struct EbmlFrame {
    id: u64,
    end: u64,
    packet: Option<usize>,
    has_reference: bool,
}
struct EbmlState {
    stack: Vec<EbmlFrame>,
    scale: u64,
    duration: u64,
    observed_duration: u64,
    cluster_time: u64,
    presentation: BTreeMap<(i64, usize), usize>,
    display_explicit: bool,
}
impl Default for EbmlState {
    fn default() -> Self {
        Self {
            stack: Vec::new(),
            scale: 1_000_000,
            duration: 0,
            observed_duration: 0,
            cluster_time: 0,
            presentation: BTreeMap::new(),
            display_explicit: false,
        }
    }
}

struct PendingBox {
    kind: [u8; 4],
    box_start: u64,
    data_start: u64,
    total: usize,
    data: Vec<u8>,
}

impl Mp4Session {
    pub fn new(len: u64) -> Result<Self, Error> {
        if !(8..=500 * 1024 * 1024).contains(&len) {
            return Err(Error::ResourceLimit);
        }
        Ok(Self {
            len,
            cursor: 0,
            window_offset: 0,
            window_len: 0,
            input: vec![0; INPUT_CAPACITY],
            pending: None,
            index: None,
            compact_builder: None,
            compact_index: None,
            classic_selected: false,
            fragment: None,
            track: None,
            status: Status::Yield,
            need: None,
            error: None,
            format: Format::Unknown,
            ebml: EbmlState::default(),
            ts_parser: None,
            ts_cursor: 0,
            ts_sources: Vec::new(),
            codec_string: String::new(),
            ts_reassembly: None,
            ts_reassembly_cursor: 0,
            ts_reconstructed: Vec::new(),
            ts_carry: Vec::new(),
            ts_prepared_max: 0,
            final_scan: 0,
            final_end: 0,
            snapshot_export: None,
            snapshot_import: None,
        })
    }

    pub fn input_ptr(&mut self) -> *mut u8 {
        self.input.as_mut_ptr()
    }
    pub fn request(&self) -> Option<Request> {
        self.need
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn error(&self) -> Option<Error> {
        self.error
    }
    pub fn track(&self) -> Option<&Track> {
        self.track.as_ref()
    }
    fn ts_source(&self, index: usize) -> Option<ts::TsPacketSource> {
        self.ts_sources.get(index).copied()
    }
    fn codec_string(&self) -> &str {
        &self.codec_string
    }

    fn snapshot_begin(&mut self) -> Result<u32, Error> {
        if self.status != Status::Complete
            || self
                .snapshot_export
                .as_ref()
                .is_some_and(|export| !export.finished())
            || self.snapshot_import.is_some()
            || self.ts_reassembly.is_some()
            || self
                .compact_index
                .as_ref()
                .is_some_and(|index| index.seek_active() || index.query_active())
        {
            return Err(Error::Invalid);
        }
        if self.compact_index.is_some() {
            return Ok(0);
        }
        let track = self.track.as_ref().ok_or(Error::Invalid)?;
        self.snapshot_export =
            snapshot::Export::new(track, self.format, &self.codec_string, &self.ts_sources)?;
        Ok(self
            .snapshot_export
            .as_ref()
            .map_or(0, snapshot::Export::total))
    }

    fn snapshot_next(&mut self) -> Result<u32, Error> {
        let mut export = self.snapshot_export.take().ok_or(Error::Invalid)?;
        let result = export.next(
            &mut self.input,
            self.track.as_ref().ok_or(Error::Invalid)?,
            self.format,
            &self.codec_string,
            &self.ts_sources,
            self.len,
        )?;
        if result != 0 {
            self.snapshot_export = Some(export);
        }
        Ok(result as u32)
    }

    fn snapshot_import_begin(&mut self, total: usize) -> Result<(), Error> {
        if self.status != Status::Yield
            || self.track.is_some()
            || self.snapshot_import.is_some()
            || self.snapshot_export.is_some()
            || self.cursor != 0
            || self.need.is_some()
        {
            return Err(Error::Invalid);
        }
        self.snapshot_import = Some(snapshot::Import::new(total, self.len)?);
        Ok(())
    }

    fn snapshot_import_feed(&mut self, length: usize) -> Result<(), Error> {
        if length == 0 || length > snapshot::STEP_BYTES {
            return Err(Error::Invalid);
        }
        self.snapshot_import
            .as_mut()
            .ok_or(Error::Invalid)?
            .feed(&self.input[..length])
    }

    fn snapshot_import_step(&mut self) -> Result<bool, Error> {
        let import = self.snapshot_import.as_mut().ok_or(Error::Invalid)?;
        if !import.step()? {
            return Ok(false);
        }
        let (track, format, codec, sources) =
            self.snapshot_import.take().ok_or(Error::Invalid)?.take()?;
        self.track = Some(track);
        self.compact_index = None;
        self.classic_selected = false;
        self.format = format;
        self.codec_string = codec;
        self.ts_sources = sources;
        self.status = Status::Complete;
        Ok(true)
    }

    fn probe_vp9(&mut self, length: usize) -> Result<(), Error> {
        if self.format != Format::Ebml
            || self.status != Status::Complete
            || !self.codec_string.is_empty()
            || length == 0
            || length > 4096
        {
            return Err(Error::Invalid);
        }
        let track = self.track.as_mut().ok_or(Error::Invalid)?;
        if track.codec != *b"VP90" {
            return Err(Error::Unsupported);
        }
        let metadata = codec_metadata::vp9_from_keyframe(&self.input[..length])?;
        let codec = metadata.codec_string()?;
        if codec.len() > 128 {
            return Err(Error::ResourceLimit);
        }
        if !self.ebml.display_explicit {
            track.display_width = metadata.render_width;
            track.display_height = metadata.render_height;
        }
        if track.color_primaries == u16::MAX {
            track.color_primaries = metadata.color_primaries as u16;
        }
        if track.color_transfer == u16::MAX {
            track.color_transfer = metadata.color_transfer as u16;
        }
        if track.color_matrix == u16::MAX {
            track.color_matrix = metadata.color_matrix as u16;
        }
        if track.color_full_range == -1 {
            track.color_full_range = i8::from(metadata.full_range);
        }
        self.codec_string = codec;
        Ok(())
    }

    fn begin_ts_packet(&mut self, index: usize) -> Result<(), Error> {
        if self.format != Format::Ts
            || self.status != Status::Complete
            || self.ts_reassembly.is_some()
            || self.ts_prepared_max == 0
        {
            return Err(Error::Invalid);
        }
        let source = self.ts_source(index).ok_or(Error::Invalid)?;
        let size = self
            .track
            .as_ref()
            .and_then(|track| track.packets.get(index))
            .ok_or(Error::Invalid)?
            .size;
        if size > self.ts_prepared_max {
            return Err(Error::ResourceLimit);
        }
        let data = std::mem::take(&mut self.ts_reconstructed);
        let carry = std::mem::take(&mut self.ts_carry);
        self.ts_reassembly = Some(ts::PacketReassembler::with_scratch(
            source, size, data, carry,
        )?);
        self.ts_reassembly_cursor = source.start;
        Ok(())
    }

    fn prepare_ts_packets(&mut self, max_packet: u32) -> Result<(), Error> {
        if self.format != Format::Ts
            || self.status != Status::Complete
            || self.ts_prepared_max != 0
            || max_packet == 0
            || max_packet > PACKET_BUDGET
        {
            return Err(Error::Invalid);
        }
        let track = self.track.as_ref().ok_or(Error::Invalid)?;
        let index_bytes = track
            .packets
            .capacity()
            .checked_mul(std::mem::size_of::<Packet>())
            .and_then(|n| {
                n.checked_add(
                    self.ts_sources
                        .capacity()
                        .checked_mul(std::mem::size_of::<ts::TsPacketSource>())?,
                )
            })
            .ok_or(Error::Overflow)?;
        let scratch = (max_packet as usize)
            .checked_add(264)
            .ok_or(Error::Overflow)?;
        let carry = INPUT_CAPACITY + 204;
        let total = index_bytes
            .checked_add(scratch)
            .and_then(|n| n.checked_add(carry))
            .and_then(|n| n.checked_add(self.input.capacity()))
            .and_then(|n| n.checked_add(track.description.capacity()))
            .and_then(|n| n.checked_add(self.codec_string.capacity()))
            .ok_or(Error::Overflow)?;
        if total > 60 * 1024 * 1024 {
            return Err(Error::ResourceLimit);
        }
        self.ts_reconstructed
            .try_reserve_exact(scratch)
            .map_err(|_| Error::ResourceLimit)?;
        self.ts_carry
            .try_reserve_exact(carry)
            .map_err(|_| Error::ResourceLimit)?;
        if self.ts_reconstructed.capacity() < scratch || self.ts_carry.capacity() < carry {
            return Err(Error::ResourceLimit);
        }
        self.ts_prepared_max = max_packet;
        Ok(())
    }

    fn feed_ts_packet(&mut self, length: usize) -> Result<(), Error> {
        if length == 0 || length > INPUT_CAPACITY {
            return Err(Error::Invalid);
        }
        let lease = self.ts_reassembly.as_mut().ok_or(Error::Invalid)?;
        lease.feed(self.ts_reassembly_cursor, &self.input[..length])?;
        self.ts_reassembly_cursor = self
            .ts_reassembly_cursor
            .checked_add(length as u64)
            .ok_or(Error::Overflow)?;
        Ok(())
    }

    fn finish_ts_packet(&mut self) -> Result<*const u8, Error> {
        let lease = self.ts_reassembly.take().ok_or(Error::Invalid)?;
        (self.ts_reconstructed, self.ts_carry) = lease.finish_with_scratch()?;
        Ok(self.ts_reconstructed.as_ptr())
    }

    /// Feed exactly the requested source range after a host-owned read. Caller must
    /// reserve the destination and forbid growth or reset until the copy settles.
    pub fn feed(&mut self, len: usize) -> Result<(), Error> {
        let need = self.need.ok_or(Error::Invalid)?;
        if len != need.length as usize || len > INPUT_CAPACITY {
            return Err(Error::Invalid);
        }
        self.window_offset = need.offset;
        self.window_len = len;
        self.need = None;
        self.status = Status::Yield;
        Ok(())
    }

    fn window(&mut self, offset: u64, wanted: usize) -> Result<Option<&[u8]>, Error> {
        let end = offset.checked_add(wanted as u64).ok_or(Error::Overflow)?;
        if end > self.len {
            return Err(Error::Truncated);
        }
        let window_end = self.window_offset + self.window_len as u64;
        if offset >= self.window_offset && end <= window_end {
            let start = (offset - self.window_offset) as usize;
            return Ok(Some(&self.input[start..start + wanted]));
        }
        let available = self.len - offset;
        let length = available.min(INPUT_CAPACITY as u64) as u32;
        self.need = Some(Request { offset, length });
        self.status = Status::NeedInput;
        Ok(None)
    }

    /// Each call performs at most `work_credit` outer steps. An index step
    /// expands at most 64 samples; a source-copy or TS-feed step reads at most
    /// 64 KiB. The host returns to a browser task between yielded calls.
    pub fn step(&mut self, work_credit: u32) -> Status {
        if self.status == Status::Error || self.status == Status::Complete || self.need.is_some() {
            return self.status;
        }
        let result = self.step_inner(work_credit.clamp(1, 64));
        if let Err(error) = result {
            self.error = Some(error);
            self.status = Status::Error;
        }
        self.status
    }

    fn step_inner(&mut self, work_credit: u32) -> Result<(), Error> {
        if self.format == Format::Unknown {
            let Some(prefix) = self.window(0, 5)? else {
                return Ok(());
            };
            self.format =
                if u32::from_be_bytes(prefix[..4].try_into().unwrap()) as u64 == ebml::EBML {
                    Format::Ebml
                } else if prefix[0] == 0x47 || prefix[4] == 0x47 {
                    self.ts_parser = Some(ts::TsParser::new(self.len)?);
                    Format::Ts
                } else {
                    Format::Mp4
                };
        }
        if self.format == Format::Ts {
            return self.step_ts(work_credit);
        }
        if self.format == Format::Ebml {
            return self.step_ebml(work_credit);
        }
        for _ in 0..work_credit {
            if let Some(builder) = &mut self.compact_builder {
                let track = self.track.as_mut().ok_or(Error::Invalid)?;
                if builder.advance(track, 64)? {
                    self.compact_index = Some(
                        self.compact_builder
                            .take()
                            .ok_or(Error::Invalid)?
                            .into_index()?,
                    );
                }
                self.status = Status::Yield;
                return Ok(());
            }
            if let Some(index) = &mut self.index {
                let track = self.track.as_mut().ok_or(Error::Invalid)?;
                if index.advance(track, 64)? {
                    self.index = None;
                }
                self.status = Status::Yield;
                return Ok(());
            }
            if let Some(fragment) = &mut self.fragment {
                let track = self.track.as_mut().ok_or(Error::Invalid)?;
                if fragment.advance(track, 64)? {
                    self.fragment = None;
                }
                self.status = Status::Yield;
                return Ok(());
            }
            if let Some(mut pending) = self.pending.take() {
                let offset = pending
                    .data_start
                    .checked_add(pending.data.len() as u64)
                    .ok_or(Error::Overflow)?;
                let take = (pending.total - pending.data.len()).min(INPUT_CAPACITY);
                let Some(chunk) = self.window(offset, take)? else {
                    self.pending = Some(pending);
                    return Ok(());
                };
                pending.data.extend_from_slice(chunk);
                if pending.data.len() < pending.total {
                    self.pending = Some(pending);
                    continue;
                }
                if pending.kind == *b"moov" {
                    if self.track.is_some() {
                        return Err(Error::Invalid);
                    }
                    let (mut track, tables) = mp4::parse_moov(&pending.data)?;
                    if let Some(range) = tables {
                        self.classic_selected = true;
                        if mp4_compact::CompactBuilder::preferred(&pending.data, range)? {
                            self.compact_builder = Some(mp4_compact::CompactBuilder::new(
                                pending.data,
                                range,
                                self.len,
                                &track,
                            )?);
                        } else {
                            self.index = Some(mp4::IndexBuilder::new(
                                pending.data,
                                range,
                                self.len,
                                &mut track,
                            )?);
                        }
                    }
                    self.track = Some(track);
                } else if pending.kind == *b"moof" {
                    if self.classic_selected || self.track.is_none() {
                        return Err(Error::Unsupported);
                    }
                    self.fragment = Some(mp4::FragmentBuilder::new(
                        pending.data,
                        pending.box_start,
                        self.len,
                    )?);
                }
                continue;
            }
            if self.cursor == self.len {
                let track = self.track.as_mut().ok_or(Error::Unsupported)?;
                if track.packets.is_empty() && self.compact_index.is_none() {
                    return Err(Error::Unsupported);
                }
                if self.compact_index.is_some() {
                    self.status = Status::Complete;
                    return Ok(());
                }
                if track.duration == 0 {
                    let end_at = (self.final_scan + 64).min(track.packets.len());
                    for packet in &track.packets[self.final_scan..end_at] {
                        let next = packet
                            .pts
                            .checked_add(
                                i64::try_from(packet.duration).map_err(|_| Error::Overflow)?,
                            )
                            .ok_or(Error::Overflow)?;
                        self.final_end = self.final_end.max(next);
                    }
                    self.final_scan = end_at;
                    if self.final_scan < track.packets.len() {
                        self.status = Status::Yield;
                        return Ok(());
                    }
                    track.duration = u64::try_from(self.final_end).map_err(|_| Error::Overflow)?;
                }
                self.status = Status::Complete;
                return Ok(());
            }
            let offset = self.cursor;
            let Some(header) = self.window(offset, 8)? else {
                return Ok(());
            };
            let size32 = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
            let kind: [u8; 4] = header[4..8].try_into().unwrap();
            let (size, head) = if size32 == 1 {
                let Some(large) = self.window(offset, 16)? else {
                    return Ok(());
                };
                (u64::from_be_bytes(large[8..16].try_into().unwrap()), 16u64)
            } else if size32 == 0 {
                (self.len - offset, 8)
            } else {
                (size32, 8)
            };
            if size < head {
                return Err(Error::Invalid);
            }
            let end = offset.checked_add(size).ok_or(Error::Overflow)?;
            if end > self.len {
                return Err(Error::Truncated);
            }
            self.cursor = end;
            // A populated classic sample table owns this track, even if mvex is
            // present. Skip later fragments before admitting their box bodies.
            if kind == *b"moof" && self.classic_selected {
                continue;
            }
            if kind == *b"moov" || kind == *b"moof" {
                let total = usize::try_from(size - head).map_err(|_| Error::ResourceLimit)?;
                // Reserve the simultaneous raw box, input lease, retained index and
                // description before Vec allocation can grow linear memory.
                let retained = self.track.as_ref().map_or(0, |track| {
                    track.packets.capacity() * std::mem::size_of::<Packet>()
                        + track.description.capacity()
                });
                let parse_scratch = if kind == *b"moov" {
                    1024 * 1024 + 512 * 1024
                } else {
                    0
                };
                if total
                    .checked_add(INPUT_CAPACITY)
                    .and_then(|n| n.checked_add(retained))
                    .and_then(|n| n.checked_add(parse_scratch))
                    .is_none_or(|n| n > METADATA_BUDGET)
                {
                    return Err(Error::ResourceLimit);
                }
                self.pending = Some(PendingBox {
                    kind,
                    box_start: offset,
                    data_start: offset + head,
                    total,
                    data: Vec::with_capacity(total),
                });
            }
        }
        self.status = Status::Yield;
        Ok(())
    }

    fn step_ts(&mut self, work_credit: u32) -> Result<(), Error> {
        for _ in 0..work_credit {
            if self.ts_cursor == self.len {
                let result = self.ts_parser.take().ok_or(Error::Invalid)?.finish()?;
                self.ts_sources = result.packet_sources;
                self.codec_string = result.codec_string;
                self.track = Some(result.track);
                self.status = Status::Complete;
                return Ok(());
            }
            let length = (self.len - self.ts_cursor).min(INPUT_CAPACITY as u64) as usize;
            let offset = self.ts_cursor;
            if self.window(offset, length)?.is_none() {
                return Ok(());
            }
            let start = (offset - self.window_offset) as usize;
            self.ts_parser
                .as_mut()
                .ok_or(Error::Invalid)?
                .feed(offset, &self.input[start..start + length])?;
            self.ts_cursor += length as u64;
        }
        self.status = Status::Yield;
        Ok(())
    }

    fn step_ebml(&mut self, work_credit: u32) -> Result<(), Error> {
        for _ in 0..work_credit {
            if let Some(mut pending) = self.pending.take() {
                let offset = pending
                    .data_start
                    .checked_add(pending.data.len() as u64)
                    .ok_or(Error::Overflow)?;
                let take = (pending.total - pending.data.len()).min(INPUT_CAPACITY);
                let Some(bytes) = self.window(offset, take)? else {
                    self.pending = Some(pending);
                    return Ok(());
                };
                pending.data.extend_from_slice(bytes);
                if pending.data.len() < pending.total {
                    self.pending = Some(pending);
                    continue;
                }
                if pending.kind == *b"info" {
                    (self.ebml.scale, self.ebml.duration) = ebml::parse_info(&pending.data)?;
                    if let Some(track) = &mut self.track {
                        track.duration = self.ebml.duration;
                    }
                } else if pending.kind == *b"trks" && self.track.is_none() {
                    let (track, _, display_explicit) =
                        ebml::parse_tracks(&pending.data, self.ebml.scale, self.ebml.duration)?;
                    self.track = Some(track);
                    self.ebml.display_explicit = display_explicit;
                }
                continue;
            }
            if self
                .ebml
                .stack
                .last()
                .is_some_and(|frame| frame.id == ebml::CLUSTER && self.cursor == frame.end)
                && !self.ebml.presentation.is_empty()
            {
                if let Some((_, index)) = self.ebml.presentation.last_key_value() {
                    let packet = &self.track.as_ref().ok_or(Error::Invalid)?.packets[*index];
                    let end = packet
                        .pts
                        .checked_add(i64::try_from(packet.duration).map_err(|_| Error::Overflow)?)
                        .ok_or(Error::Overflow)?;
                    self.ebml.observed_duration = self
                        .ebml
                        .observed_duration
                        .max(u64::try_from(end).map_err(|_| Error::Overflow)?);
                }
                for _ in 0..64 {
                    if self.ebml.presentation.pop_first().is_none() {
                        break;
                    }
                }
                self.status = Status::Yield;
                return Ok(());
            }
            while self
                .ebml
                .stack
                .last()
                .is_some_and(|frame| self.cursor == frame.end)
            {
                let frame = self.ebml.stack.pop().unwrap();
                if frame.id == ebml::BLOCK_GROUP {
                    if let (Some(index), Some(track)) = (frame.packet, self.track.as_mut()) {
                        for packet in &mut track.packets[index..] {
                            packet.key = !frame.has_reference;
                        }
                    }
                }
            }
            if self.cursor == self.len {
                let track = self.track.as_mut().ok_or(Error::Unsupported)?;
                if track.packets.is_empty() {
                    return Err(Error::Unsupported);
                }
                if self.ebml.observed_duration != 0 {
                    // InputTrack.computeDuration rounds the presentation-last packet
                    // end to the Matroska TimecodeScale, independently of its
                    // unrounded per-packet duration or Segment Info duration.
                    track.duration = ebml::round_duration_to_scale(
                        self.ebml.observed_duration,
                        self.ebml.scale,
                    )?;
                }
                self.status = Status::Complete;
                return Ok(());
            }
            let cursor = self.cursor;
            let Some(first) = self.window(cursor, 1)? else {
                return Ok(());
            };
            let id_width = first[0].leading_zeros() as usize + 1;
            if id_width > 4 {
                return Err(Error::Invalid);
            }
            let Some(size_first) = self.window(cursor + id_width as u64, 1)? else {
                return Ok(());
            };
            let size_width = size_first[0].leading_zeros() as usize + 1;
            if size_width > 8 {
                return Err(Error::Invalid);
            }
            let header_len = id_width + size_width;
            let Some(header_bytes) = self.window(cursor, header_len)? else {
                return Ok(());
            };
            let (id, size, parsed_head) = ebml::header(header_bytes, 0)?;
            if parsed_head != header_len {
                return Err(Error::Invalid);
            }
            let start = cursor
                .checked_add(header_len as u64)
                .ok_or(Error::Overflow)?;
            let end = if size == u64::MAX && id == ebml::SEGMENT {
                self.len
            } else {
                start.checked_add(size).ok_or(Error::Overflow)?
            };
            if end > self.len || self.ebml.stack.last().is_some_and(|frame| end > frame.end) {
                return Err(Error::Truncated);
            }
            self.cursor = end;
            if id == ebml::SEGMENT || id == ebml::CLUSTER || id == ebml::BLOCK_GROUP {
                if self.ebml.stack.len() >= 8 {
                    return Err(Error::ResourceLimit);
                }
                if id == ebml::CLUSTER {
                    self.ebml.cluster_time = 0;
                    if !self.ebml.presentation.is_empty() {
                        return Err(Error::Invalid);
                    }
                }
                self.cursor = start;
                self.ebml.stack.push(EbmlFrame {
                    id,
                    end,
                    packet: if id == ebml::CLUSTER {
                        self.track.as_ref().map(|track| track.packets.len())
                    } else {
                        None
                    },
                    has_reference: false,
                });
            } else if id == ebml::INFO || id == ebml::TRACKS {
                let total = usize::try_from(size).map_err(|_| Error::ResourceLimit)?;
                if total > 1024 * 1024 {
                    return Err(Error::ResourceLimit);
                }
                let retained = self.track.as_ref().map_or(0, |track| {
                    track.packets.capacity() * std::mem::size_of::<Packet>()
                        + track.description.capacity()
                });
                let presentation = self
                    .ebml
                    .presentation
                    .len()
                    .checked_mul(96)
                    .ok_or(Error::Overflow)?;
                if total
                    .checked_add(retained)
                    .and_then(|n| n.checked_add(presentation))
                    .and_then(|n| n.checked_add(INPUT_CAPACITY + 1024 * 1024))
                    .is_none_or(|n| n > METADATA_BUDGET)
                {
                    return Err(Error::ResourceLimit);
                }
                self.pending = Some(PendingBox {
                    kind: if id == ebml::INFO { *b"info" } else { *b"trks" },
                    box_start: cursor,
                    data_start: start,
                    total,
                    data: Vec::with_capacity(total),
                });
            } else if id == ebml::TIMECODE
                && self
                    .ebml
                    .stack
                    .last()
                    .is_some_and(|frame| frame.id == ebml::CLUSTER)
            {
                let n = usize::try_from(size).map_err(|_| Error::ResourceLimit)?;
                if n > 8 {
                    return Err(Error::Invalid);
                }
                let Some(bytes) = self.window(start, n)? else {
                    self.cursor = cursor;
                    return Ok(());
                };
                self.ebml.cluster_time = ebml::unsigned(bytes)?;
            } else if id == ebml::REFERENCE_BLOCK
                && self
                    .ebml
                    .stack
                    .last()
                    .is_some_and(|frame| frame.id == ebml::BLOCK_GROUP)
            {
                if let Some(frame) = self.ebml.stack.last_mut() {
                    frame.has_reference = true;
                }
            } else if id == ebml::BLOCK_DURATION
                && self
                    .ebml
                    .stack
                    .last()
                    .is_some_and(|frame| frame.id == ebml::BLOCK_GROUP)
            {
                let n = usize::try_from(size).map_err(|_| Error::ResourceLimit)?;
                if n > 8 {
                    return Err(Error::Invalid);
                }
                let Some(bytes) = self.window(start, n)? else {
                    self.cursor = cursor;
                    return Ok(());
                };
                let ticks = ebml::unsigned(bytes)?
                    .checked_mul(self.ebml.scale)
                    .ok_or(Error::Overflow)?;
                if let Some(index) = self.ebml.stack.last().and_then(|frame| frame.packet) {
                    if let Some(track) = self.track.as_mut() {
                        let count = track.packets.len().saturating_sub(index);
                        if count > 0 {
                            let per_frame = ticks / count as u64;
                            for packet in &mut track.packets[index..] {
                                packet.duration = per_frame;
                            }
                        }
                    }
                }
            } else if id == ebml::SIMPLE_BLOCK || id == ebml::BLOCK {
                if id == ebml::BLOCK
                    && self.ebml.stack.last().is_some_and(|frame| {
                        frame.id == ebml::BLOCK_GROUP && frame.packet.is_some()
                    })
                {
                    return Err(Error::Invalid);
                }
                let n = usize::try_from(size.min(12)).map_err(|_| Error::ResourceLimit)?;
                if size <= 4 || size > (PACKET_BUDGET as u64) * 256 + 1024 {
                    return Err(Error::ResourceLimit);
                }
                let Some(bytes) = self.window(start, n)? else {
                    self.cursor = cursor;
                    return Ok(());
                };
                let (track_id, rel, flags, head) = ebml::block_header(bytes)?;
                let ranges = if flags & 0x06 == 0 {
                    ebml::lace_ranges(bytes, size, flags, head)?
                } else {
                    let n = usize::try_from(size.min(INPUT_CAPACITY as u64))
                        .map_err(|_| Error::ResourceLimit)?;
                    let Some(header) = self.window(start, n)? else {
                        self.cursor = cursor;
                        return Ok(());
                    };
                    ebml::lace_ranges(header, size, flags, head)?
                };
                if self
                    .track
                    .as_ref()
                    .is_some_and(|track| track.track_id as u64 == track_id)
                {
                    let track = self.track.as_mut().unwrap();
                    let needed = track
                        .packets
                        .len()
                        .checked_add(ranges.len())
                        .ok_or(Error::Overflow)?;
                    let old_capacity = track.packets.capacity();
                    let admitted_capacity = if needed > old_capacity {
                        needed
                            .checked_next_power_of_two()
                            .ok_or(Error::ResourceLimit)?
                    } else {
                        old_capacity
                    };
                    let overlap_capacity = if needed > old_capacity {
                        old_capacity
                            .checked_add(admitted_capacity)
                            .ok_or(Error::Overflow)?
                    } else {
                        admitted_capacity
                    };
                    // Account for the old and replacement Vec arenas while reserve
                    // copies, the tree's worst-case nodes, description and input.
                    let live_bytes = overlap_capacity
                        .checked_mul(std::mem::size_of::<Packet>())
                        .and_then(|n| n.checked_add(needed.checked_mul(96)?))
                        .and_then(|n| n.checked_add(track.description.capacity()))
                        .and_then(|n| n.checked_add(INPUT_CAPACITY + 8 * 1024))
                        .ok_or(Error::Overflow)?;
                    if live_bytes > METADATA_BUDGET {
                        return Err(Error::ResourceLimit);
                    }
                    if needed > old_capacity {
                        track
                            .packets
                            .try_reserve_exact(needed - track.packets.len())
                            .map_err(|_| Error::ResourceLimit)?;
                        if track.packets.capacity() > admitted_capacity {
                            return Err(Error::ResourceLimit);
                        }
                    }
                    let clock = (self.ebml.cluster_time as i128) + (rel as i128);
                    let pts = clock
                        .checked_mul(self.ebml.scale as i128)
                        .ok_or(Error::Overflow)?;
                    let pts = i64::try_from(pts).map_err(|_| Error::Overflow)?;
                    let index = track.packets.len();
                    for (lace_index, (relative_offset, frame_size)) in ranges.iter().enumerate() {
                        let next_pts = pts
                            .checked_add(
                                (lace_index as i64)
                                    .checked_mul(
                                        i64::try_from(track.fragment_default_duration)
                                            .map_err(|_| Error::Overflow)?,
                                    )
                                    .ok_or(Error::Overflow)?,
                            )
                            .ok_or(Error::Overflow)?;
                        let decode_index = track.packets.len();
                        let key = (next_pts, decode_index);
                        let previous = self
                            .ebml
                            .presentation
                            .range(..key)
                            .next_back()
                            .map(|(position, index)| (position.0, *index));
                        let following = self
                            .ebml
                            .presentation
                            .range(key..)
                            .next()
                            .map(|(position, _)| position.0);
                        if let Some((prev_pts, prev_index)) = previous {
                            track.packets[prev_index].duration = u64::try_from(
                                next_pts.checked_sub(prev_pts).ok_or(Error::Overflow)?,
                            )
                            .map_err(|_| Error::ResourceLimit)?;
                        }
                        let duration = if let Some(following_pts) = following {
                            u64::try_from(
                                following_pts.checked_sub(next_pts).ok_or(Error::Overflow)?,
                            )
                            .map_err(|_| Error::ResourceLimit)?
                        } else {
                            track.fragment_default_duration
                        };
                        track.packets.push(Packet {
                            offset: start.checked_add(*relative_offset).ok_or(Error::Overflow)?,
                            size: *frame_size,
                            dts: next_pts,
                            pts: next_pts,
                            duration,
                            key: id == ebml::SIMPLE_BLOCK && flags & 0x80 != 0,
                        });
                        self.ebml.presentation.insert(key, decode_index);
                    }
                    if id == ebml::BLOCK {
                        if let Some(frame) = self.ebml.stack.last_mut() {
                            frame.packet.get_or_insert(index);
                        }
                    }
                }
            }
        }
        self.status = Status::Yield;
        Ok(())
    }
}

struct AbiState {
    session: Option<Mp4Session>,
    event: [u8; 64],
}

fn abi() -> &'static Mutex<AbiState> {
    static STATE: OnceLock<Mutex<AbiState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(AbiState {
            session: None,
            event: [0; 64],
        })
    })
}

fn encode_event(state: &mut AbiState) -> u32 {
    let Some(session) = state.session.as_ref() else {
        return 0;
    };
    state.event.fill(0);
    state.event[0..4].copy_from_slice(&(session.status() as u32).to_le_bytes());
    if let Some(request) = session.request() {
        state.event[8..16].copy_from_slice(&request.offset.to_le_bytes());
        state.event[16..20].copy_from_slice(&request.length.to_le_bytes());
    }
    if let Some(error) = session.error() {
        state.event[4..8].copy_from_slice(&(error as u32 + 1).to_le_bytes());
    }
    state.event.as_ptr() as u32
}

fn write_track(state: &mut AbiState) -> u32 {
    let Some(session) = state.session.as_ref() else {
        return 0;
    };
    let Some(track) = session.track() else {
        return 0;
    };
    state.event.fill(0);
    state.event[0..4].copy_from_slice(&6u32.to_le_bytes());
    state.event[8..12].copy_from_slice(&track.codec);
    state.event[12..16].copy_from_slice(&track.width.to_le_bytes());
    state.event[16..20].copy_from_slice(&track.height.to_le_bytes());
    state.event[20..24].copy_from_slice(&track.timescale.to_le_bytes());
    state.event[24..32].copy_from_slice(&track.duration.to_le_bytes());
    state.event[32..36].copy_from_slice(&(track.rotation as u32).to_le_bytes());
    state.event[36..40].copy_from_slice(&(track.description.len() as u32).to_le_bytes());
    state.event[40..44].copy_from_slice(&track.display_width.to_le_bytes());
    state.event[44..48].copy_from_slice(&track.display_height.to_le_bytes());
    state.event[48..50].copy_from_slice(&track.color_primaries.to_le_bytes());
    state.event[50..52].copy_from_slice(&track.color_transfer.to_le_bytes());
    state.event[52..54].copy_from_slice(&track.color_matrix.to_le_bytes());
    state.event[54] = track.color_full_range as u8;
    state.event[56..60].copy_from_slice(&(session.codec_string().len() as u32).to_le_bytes());
    state.event.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn demux_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn demux_init(file_len_lo: u32, file_len_hi: u32) -> u32 {
    let len = (u64::from(file_len_hi) << 32) | u64::from(file_len_lo);
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state.session = Mp4Session::new(len).ok();
    if state.session.is_none() {
        return 0;
    }
    encode_event(&mut state)
}

#[no_mangle]
pub extern "C" fn demux_input_ptr() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .map_or(0, |session| session.input_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn demux_step(work_credit: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_mut() else {
        return 0;
    };
    session.step(work_credit);
    encode_event(&mut state)
}

#[no_mangle]
pub extern "C" fn demux_feed(length: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_mut() else {
        return 0;
    };
    if session.feed(length as usize).is_err() {
        return 0;
    }
    encode_event(&mut state)
}

#[no_mangle]
pub extern "C" fn demux_track() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    write_track(&mut state)
}

#[no_mangle]
pub extern "C" fn demux_description_ptr() -> u32 {
    let Ok(state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_ref()
        .and_then(Mp4Session::track)
        .map_or(0, |track| track.description.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn demux_codec_ptr() -> u32 {
    let Ok(state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_ref()
        .map_or(0, |session| session.codec_string().as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn demux_packet_count() -> u32 {
    let Ok(state) = abi().lock() else {
        return 0;
    };
    state.session.as_ref().map_or(0, |session| {
        session.compact_index.as_ref().map_or_else(
            || {
                session
                    .track
                    .as_ref()
                    .map_or(0, |track| track.packets.len() as u32)
            },
            mp4_compact::CompactIndex::count,
        )
    })
}

#[no_mangle]
pub extern "C" fn demux_index_info() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_ref() else {
        return 0;
    };
    if session.status != Status::Complete {
        return 0;
    }
    let Some(track) = session.track.as_ref() else {
        return 0;
    };
    let (mode, count, max_packet, live_bytes) = if let Some(index) = &session.compact_index {
        let Ok(bytes) = index.retained_bytes(track) else {
            return 0;
        };
        (1u32, index.count(), index.max_packet(), bytes)
    } else {
        let Some(bytes) = track
            .packets
            .capacity()
            .checked_mul(std::mem::size_of::<Packet>())
            .and_then(|n| n.checked_add(track.description.capacity()))
            .and_then(|n| n.checked_add(session.input.capacity()))
        else {
            return 0;
        };
        (
            0u32,
            track.packets.len() as u32,
            track
                .packets
                .iter()
                .map(|packet| packet.size)
                .max()
                .unwrap_or(0),
            bytes,
        )
    };
    if live_bytes > METADATA_BUDGET || count == 0 || max_packet == 0 {
        return 0;
    }
    let Ok(live_bytes) = u32::try_from(live_bytes) else {
        return 0;
    };
    let flags = u32::from(session.format == Format::Ts)
        | if session
            .compact_index
            .as_ref()
            .is_some_and(mp4_compact::CompactIndex::requires_query)
        {
            2
        } else {
            0
        };
    state.event.fill(0);
    state.event[0..4].copy_from_slice(&9u32.to_le_bytes());
    state.event[4..8].copy_from_slice(&mode.to_le_bytes());
    state.event[8..12].copy_from_slice(&count.to_le_bytes());
    state.event[12..16].copy_from_slice(&max_packet.to_le_bytes());
    state.event[16..20].copy_from_slice(&live_bytes.to_le_bytes());
    // The compact key-candidate heap is reserved before Ready and reused.
    state.event[20..24].copy_from_slice(&0u32.to_le_bytes());
    state.event[24..28].copy_from_slice(&flags.to_le_bytes());
    state.event.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn demux_packet(index: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(packet) = state.session.as_ref().and_then(|session| {
        if let Some(compact) = &session.compact_index {
            compact.packet(index).ok()
        } else {
            session.track.as_ref()?.packets.get(index as usize).cloned()
        }
    }) else {
        return 0;
    };
    if state.session.as_ref().is_some_and(|session| {
        session.format == Format::Ts && session.ts_source(index as usize).is_none()
    }) {
        return 0;
    }
    write_packet_event(&mut state.event, packet);
    if let Some(source) = state
        .session
        .as_ref()
        .and_then(|session| session.ts_source(index as usize))
    {
        state.event[48..56].copy_from_slice(&source.end.to_le_bytes());
        state.event[56..58].copy_from_slice(&source.pid.to_le_bytes());
        state.event[58..60].copy_from_slice(&source.stride.to_le_bytes());
        state.event[60] = source.prefix;
    }
    state.event.as_ptr() as u32
}

fn write_packet_event(event: &mut [u8; 64], packet: Packet) {
    event.fill(0);
    event[0..4].copy_from_slice(&5u32.to_le_bytes());
    event[8..16].copy_from_slice(&packet.offset.to_le_bytes());
    event[16..20].copy_from_slice(&packet.size.to_le_bytes());
    event[20..24].copy_from_slice(&(packet.key as u32).to_le_bytes());
    event[24..32].copy_from_slice(&packet.dts.to_le_bytes());
    event[32..40].copy_from_slice(&packet.pts.to_le_bytes());
    event[40..48].copy_from_slice(&packet.duration.to_le_bytes());
}

#[no_mangle]
pub extern "C" fn demux_query_packet_begin(index: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_mut() else {
        return 0;
    };
    if session.status != Status::Complete
        || session.snapshot_export.is_some()
        || session.snapshot_import.is_some()
    {
        return 0;
    }
    session
        .compact_index
        .as_mut()
        .is_some_and(|compact| compact.query_begin(index).is_ok()) as u32
}

#[no_mangle]
pub extern "C" fn demux_query_packet_step(credit: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(index) = state
        .session
        .as_mut()
        .and_then(|session| session.compact_index.as_mut())
    else {
        return 0;
    };
    let result = index.query_step(credit);
    match result {
        Ok(Some(packet)) => write_packet_event(&mut state.event, packet),
        other => {
            let (kind, value) = match other {
                Ok(None) => (1u32, 0u32),
                Err(error) => (4u32, error as u32 + 1),
                Ok(Some(_)) => unreachable!(),
            };
            state.event.fill(0);
            state.event[0..4].copy_from_slice(&11u32.to_le_bytes());
            state.event[4..8].copy_from_slice(&kind.to_le_bytes());
            state.event[8..12].copy_from_slice(&value.to_le_bytes());
        }
    }
    state.event.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn demux_query_packet_end() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .and_then(|session| session.compact_index.as_mut())
        .is_some_and(mp4_compact::CompactIndex::query_end) as u32
}

#[no_mangle]
pub extern "C" fn demux_seek_begin(lo: u32, hi: u32, before: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_mut() else {
        return 0;
    };
    if session.status != Status::Complete
        || session.snapshot_export.is_some()
        || session.snapshot_import.is_some()
    {
        return 0;
    }
    let target = ((u64::from(hi) << 32) | u64::from(lo)) as i64;
    session
        .compact_index
        .as_mut()
        .is_some_and(|index| index.seek_begin(target, before).is_ok()) as u32
}

#[no_mangle]
pub extern "C" fn demux_seek_step(credit: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(index) = state
        .session
        .as_mut()
        .and_then(|session| session.compact_index.as_mut())
    else {
        return 0;
    };
    let (kind, value) = match index.seek_step(credit) {
        Ok(None) => (1u32, 0u32),
        Ok(Some(Some(candidate))) => (2u32, candidate),
        Ok(Some(None)) => (3u32, 0u32),
        Err(error) => (4u32, error as u32 + 1),
    };
    state.event.fill(0);
    state.event[0..4].copy_from_slice(&10u32.to_le_bytes());
    state.event[4..8].copy_from_slice(&kind.to_le_bytes());
    state.event[8..12].copy_from_slice(&value.to_le_bytes());
    state.event.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn demux_seek_end() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .and_then(|session| session.compact_index.as_mut())
        .is_some_and(mp4_compact::CompactIndex::seek_end) as u32
}

#[no_mangle]
pub extern "C" fn demux_packet_begin(index: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .is_some_and(|session| session.begin_ts_packet(index as usize).is_ok()) as u32
}

#[no_mangle]
pub extern "C" fn demux_prepare_packets(max_packet: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .is_some_and(|session| session.prepare_ts_packets(max_packet).is_ok()) as u32
}

#[no_mangle]
pub extern "C" fn demux_probe_vp9(length: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(session) = state.session.as_mut() else {
        return 0;
    };
    match session.probe_vp9(length as usize) {
        Ok(()) => 1,
        Err(Error::Unsupported) => 2,
        Err(Error::Invalid | Error::Truncated) => 3,
        Err(Error::ResourceLimit) => 4,
        Err(Error::Overflow) => 5,
    }
}

#[no_mangle]
pub extern "C" fn demux_packet_feed(length: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .is_some_and(|session| session.feed_ts_packet(length as usize).is_ok()) as u32
}

#[no_mangle]
pub extern "C" fn demux_packet_finish() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_mut()
        .and_then(|session| session.finish_ts_packet().ok())
        .map_or(0, |ptr| ptr as u32)
}

// Snapshot lengths and progress codes fit below the high bit. Terminal errors
// retain the same Error discriminants as the parser's fixed ABI event.
fn snapshot_error_code(error: Error) -> u32 {
    0x8000_0000 | (error as u32 + 1)
}

#[no_mangle]
pub extern "C" fn demux_snapshot_begin() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return snapshot_error_code(Error::Invalid);
    };
    match state
        .session
        .as_mut()
        .map(Mp4Session::snapshot_begin)
        .unwrap_or(Err(Error::Invalid))
    {
        Ok(total) => total,
        Err(error) => snapshot_error_code(error),
    }
}

#[no_mangle]
pub extern "C" fn demux_snapshot_next() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return snapshot_error_code(Error::Invalid);
    };
    match state
        .session
        .as_mut()
        .map(Mp4Session::snapshot_next)
        .unwrap_or(Err(Error::Invalid))
    {
        Ok(length) => length,
        Err(error) => snapshot_error_code(error),
    }
}

#[no_mangle]
pub extern "C" fn demux_snapshot_import_begin(total: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return snapshot_error_code(Error::Invalid);
    };
    match state
        .session
        .as_mut()
        .map(|session| session.snapshot_import_begin(total as usize))
        .unwrap_or(Err(Error::Invalid))
    {
        Ok(()) => 1,
        Err(error) => snapshot_error_code(error),
    }
}

#[no_mangle]
pub extern "C" fn demux_snapshot_import_feed(length: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return snapshot_error_code(Error::Invalid);
    };
    match state
        .session
        .as_mut()
        .map(|session| session.snapshot_import_feed(length as usize))
        .unwrap_or(Err(Error::Invalid))
    {
        Ok(()) => 1,
        Err(error) => snapshot_error_code(error),
    }
}

#[no_mangle]
pub extern "C" fn demux_snapshot_import_step() -> u32 {
    let Ok(mut state) = abi().lock() else {
        return snapshot_error_code(Error::Invalid);
    };
    match state.session.as_mut().map(Mp4Session::snapshot_import_step) {
        Some(Ok(false)) => 1,
        Some(Ok(true)) => 2,
        Some(Err(error)) => snapshot_error_code(error),
        None => snapshot_error_code(Error::Invalid),
    }
}

#[no_mangle]
pub extern "C" fn demux_release() {
    if let Ok(mut state) = abi().lock() {
        state.session = None;
        state.event.fill(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_status_preserves_parser_error_kinds() {
        assert_eq!(snapshot_error_code(Error::Invalid), 0x8000_0001);
        assert_eq!(snapshot_error_code(Error::Truncated), 0x8000_0002);
        assert_eq!(snapshot_error_code(Error::ResourceLimit), 0x8000_0003);
        assert_eq!(snapshot_error_code(Error::Unsupported), 0x8000_0004);
        assert_eq!(snapshot_error_code(Error::Overflow), 0x8000_0005);
    }

    #[test]
    fn moof_admission_counts_retained_index_before_allocating_box() {
        let mut session = Mp4Session::new(40 * 1024 * 1024).unwrap();
        session.format = Format::Mp4;
        session.window_len = 8;
        session.input[..4].copy_from_slice(&(30 * 1024 * 1024u32 + 8).to_be_bytes());
        session.input[4..8].copy_from_slice(b"moof");
        session.track = Some(Track {
            track_id: 1,
            codec: *b"avc1",
            width: 16,
            height: 16,
            display_width: 16,
            display_height: 16,
            color_primaries: 0,
            color_transfer: 0,
            color_matrix: 0,
            color_full_range: -1,
            timescale: 1000,
            duration: 1,
            rotation: 0,
            description: Vec::new(),
            packets: Vec::with_capacity(250_000),
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        });
        assert_eq!(session.step(1), Status::Error);
        assert_eq!(session.error(), Some(Error::ResourceLimit));
        assert!(session.pending.is_none());
    }

    #[test]
    fn selected_classic_samples_skip_later_large_moof_before_body_allocation() {
        let mut session = Mp4Session::new(40 * 1024 * 1024).unwrap();
        session.format = Format::Mp4;
        session.classic_selected = true;
        session.track = Some(Track {
            track_id: 1,
            codec: *b"avc1",
            width: 16,
            height: 16,
            display_width: 16,
            display_height: 16,
            color_primaries: 0,
            color_transfer: 0,
            color_matrix: 0,
            color_full_range: -1,
            timescale: 1000,
            duration: 1,
            rotation: 0,
            description: Vec::new(),
            packets: Vec::new(),
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        });
        let box_size = 30 * 1024 * 1024u32 + 8;
        session.window_len = 8;
        session.input[..4].copy_from_slice(&box_size.to_be_bytes());
        session.input[4..8].copy_from_slice(b"moof");
        assert_eq!(session.step(1), Status::Yield);
        assert_eq!(session.cursor, u64::from(box_size));
        assert!(session.pending.is_none());
        assert!(session.fragment.is_none());
        assert_eq!(session.input.capacity(), INPUT_CAPACITY);
    }

    #[test]
    fn malformed_ranges_terminate_and_new_sessions_reset_state() {
        let mut seed = 0x05ee_d492_u32;
        for length in [8usize, 17, 257, 4096] {
            for _ in 0..16 {
                let mut source = vec![0u8; length];
                for byte in &mut source {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    *byte = seed as u8;
                }
                let mut session = Mp4Session::new(length as u64).unwrap();
                let mut terminal = false;
                for _ in 0..256 {
                    match session.step(64) {
                        Status::NeedInput => {
                            let request = session.request().unwrap();
                            let start = request.offset as usize;
                            let end = start + request.length as usize;
                            assert!(end <= source.len());
                            session.input[..request.length as usize]
                                .copy_from_slice(&source[start..end]);
                            session.feed(request.length as usize).unwrap();
                        }
                        Status::Yield => {}
                        Status::Error => {
                            terminal = true;
                            break;
                        }
                        Status::Complete => panic!("malformed media completed"),
                    }
                }
                assert!(terminal, "malformed input failed to terminate");
            }
        }
    }
}
