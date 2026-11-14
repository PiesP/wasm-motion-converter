// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Bounded, conversion-owned parser for local media container metadata and packet ranges.
//! The host owns file reads and compressed payloads. No codec implementation is linked.

mod mp4;

use std::sync::{Mutex, OnceLock};

pub const ABI_VERSION: u32 = 1;
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
    pub duration: u32,
    pub key: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    pub track_id: u32,
    pub codec: [u8; 4],
    pub width: u32,
    pub height: u32,
    pub timescale: u32,
    pub duration: u64,
    pub rotation: u16,
    pub description: Vec<u8>,
    pub packets: Vec<Packet>,
    pub fragment_default_duration: u32,
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
    track: Option<Track>,
    status: Status,
    need: Option<Request>,
    error: Option<Error>,
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
        if len < 8 || len > 500 * 1024 * 1024 {
            return Err(Error::ResourceLimit);
        }
        Ok(Self {
            len,
            cursor: 0,
            window_offset: 0,
            window_len: 0,
            input: vec![0; INPUT_CAPACITY],
            pending: None,
            track: None,
            status: Status::Yield,
            need: None,
            error: None,
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

    /// Each call performs at most `work_credit` top-level box or 64 KiB copy steps.
    /// The host must return to a real task between yielded calls.
    pub fn step(&mut self, work_credit: u32) -> Status {
        if self.status == Status::Error || self.status == Status::Complete || self.need.is_some() {
            return self.status;
        }
        let result = self.step_inner(work_credit.min(64).max(1));
        if let Err(error) = result {
            self.error = Some(error);
            self.status = Status::Error;
        }
        self.status
    }

    fn step_inner(&mut self, work_credit: u32) -> Result<(), Error> {
        for _ in 0..work_credit {
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
                    self.track = Some(mp4::parse_moov(&pending.data, self.len)?);
                } else if pending.kind == *b"moof" {
                    let track = self.track.as_mut().ok_or(Error::Unsupported)?;
                    mp4::append_moof(&pending.data, pending.box_start, self.len, track)?;
                }
                continue;
            }
            if self.cursor == self.len {
                if self.track.is_none() {
                    return Err(Error::Unsupported);
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
            if kind == *b"moov" || kind == *b"moof" {
                let total = usize::try_from(size - head).map_err(|_| Error::ResourceLimit)?;
                if total > METADATA_BUDGET {
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
    let Some(track) = state.session.as_ref().and_then(Mp4Session::track) else {
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
pub extern "C" fn demux_packet_count() -> u32 {
    let Ok(state) = abi().lock() else {
        return 0;
    };
    state
        .session
        .as_ref()
        .and_then(Mp4Session::track)
        .map_or(0, |track| track.packets.len() as u32)
}

#[no_mangle]
pub extern "C" fn demux_packet(index: u32) -> u32 {
    let Ok(mut state) = abi().lock() else {
        return 0;
    };
    let Some(packet) = state
        .session
        .as_ref()
        .and_then(Mp4Session::track)
        .and_then(|track| track.packets.get(index as usize))
        .cloned()
    else {
        return 0;
    };
    state.event.fill(0);
    state.event[0..4].copy_from_slice(&5u32.to_le_bytes());
    state.event[8..16].copy_from_slice(&packet.offset.to_le_bytes());
    state.event[16..20].copy_from_slice(&packet.size.to_le_bytes());
    state.event[20..24].copy_from_slice(&(packet.key as u32).to_le_bytes());
    state.event[24..32].copy_from_slice(&packet.dts.to_le_bytes());
    state.event[32..40].copy_from_slice(&packet.pts.to_le_bytes());
    state.event[40..44].copy_from_slice(&packet.duration.to_le_bytes());
    state.event.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn demux_release() {
    if let Ok(mut state) = abi().lock() {
        state.session = None;
        state.event.fill(0);
    }
}
