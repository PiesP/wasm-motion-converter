// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

//! Checked classic MP4 run tables and sparse byte prefixes for large tracks.
//! All construction, presentation ordering, and seek-heap work is credit limited.

use crate::mp4::{required, table, table_with_count, u32be, u64be, TableRef};
use crate::{Error, Packet, Track, INPUT_CAPACITY, MAX_SAMPLES, METADATA_BUDGET, PACKET_BUDGET};

const SIZE_STRIDE: usize = 256;
const NO_SUCCESSOR: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct TimeRun {
    first: u32,
    dts: i64,
    delta: u32,
}
#[derive(Clone, Copy)]
struct OffsetRun {
    first: u32,
    offset: i64,
}
#[derive(Clone, Copy)]
struct ChunkRun {
    first_sample: u32,
    first_chunk: u32,
    per_chunk: u32,
}
#[derive(Clone, Copy)]
struct Candidate {
    pts: i64,
    index: u32,
    run: u32,
}
struct Seek {
    heap: Vec<Candidate>,
    target: i64,
    before: u32,
    next_run: usize,
    active: bool,
}

pub struct CompactIndex {
    raw: Vec<u8>,
    file_len: u64,
    count: u32,
    fixed_size: u32,
    sizes: TableRef,
    offsets: TableRef,
    stss: Option<TableRef>,
    edit_shift: i64,
    size_prefix: Vec<u64>,
    time_runs: Vec<TimeRun>,
    offset_runs: Vec<OffsetRun>,
    chunk_runs: Vec<ChunkRun>,
    successors: Vec<u32>,
    max_packet: u32,
    seek: Seek,
}

impl CompactIndex {
    pub fn count(&self) -> u32 {
        self.count
    }
    pub fn max_packet(&self) -> u32 {
        self.max_packet
    }
    pub fn seek_active(&self) -> bool {
        self.seek.active
    }
    pub fn retained_bytes(&self, track: &Track) -> Result<usize, Error> {
        self.raw
            .capacity()
            .checked_add(track.description.capacity())
            .and_then(|n| n.checked_add(INPUT_CAPACITY))
            .and_then(|n| {
                n.checked_add(
                    self.size_prefix
                        .capacity()
                        .checked_mul(std::mem::size_of::<u64>())?,
                )
            })
            .and_then(|n| {
                n.checked_add(
                    self.time_runs
                        .capacity()
                        .checked_mul(std::mem::size_of::<TimeRun>())?,
                )
            })
            .and_then(|n| {
                n.checked_add(
                    self.offset_runs
                        .capacity()
                        .checked_mul(std::mem::size_of::<OffsetRun>())?,
                )
            })
            .and_then(|n| {
                n.checked_add(
                    self.chunk_runs
                        .capacity()
                        .checked_mul(std::mem::size_of::<ChunkRun>())?,
                )
            })
            .and_then(|n| {
                n.checked_add(
                    self.successors
                        .capacity()
                        .checked_mul(std::mem::size_of::<u32>())?,
                )
            })
            .and_then(|n| {
                n.checked_add(
                    self.seek
                        .heap
                        .capacity()
                        .checked_mul(std::mem::size_of::<Candidate>())?,
                )
            })
            .ok_or(Error::Overflow)
    }
    fn size(&self, index: u32) -> Result<u32, Error> {
        if index >= self.count {
            return Err(Error::Invalid);
        }
        if self.fixed_size != 0 {
            return Ok(self.fixed_size);
        }
        u32be(self.sizes.entry(&self.raw, index as usize)?, 0)
    }
    fn cumulative_size(&self, index: u32) -> Result<u64, Error> {
        if index > self.count {
            return Err(Error::Invalid);
        }
        if self.fixed_size != 0 {
            return u64::from(index)
                .checked_mul(u64::from(self.fixed_size))
                .ok_or(Error::Overflow);
        }
        let block = index as usize / SIZE_STRIDE;
        let mut sum = *self.size_prefix.get(block).ok_or(Error::Invalid)?;
        for sample in block * SIZE_STRIDE..index as usize {
            sum = sum
                .checked_add(u64::from(u32be(self.sizes.entry(&self.raw, sample)?, 0)?))
                .ok_or(Error::Overflow)?;
        }
        Ok(sum)
    }
    fn time(&self, index: u32) -> Result<(i64, u32), Error> {
        let run = self
            .time_runs
            .partition_point(|run| run.first <= index)
            .checked_sub(1)
            .ok_or(Error::Invalid)?;
        let entry = *self.time_runs.get(run).ok_or(Error::Invalid)?;
        let offset = i64::from(index - entry.first)
            .checked_mul(i64::from(entry.delta))
            .ok_or(Error::Overflow)?;
        Ok((
            entry.dts.checked_add(offset).ok_or(Error::Overflow)?,
            entry.delta,
        ))
    }
    fn pts(&self, index: u32) -> Result<(i64, u32), Error> {
        let (dts, duration) = self.time(index)?;
        let offset = if self.offset_runs.is_empty() {
            0
        } else {
            let run = self
                .offset_runs
                .partition_point(|run| run.first <= index)
                .checked_sub(1)
                .ok_or(Error::Invalid)?;
            self.offset_runs[run].offset
        };
        Ok((
            dts.checked_add(offset)
                .and_then(|n| n.checked_add(self.edit_shift))
                .ok_or(Error::Overflow)?,
            duration,
        ))
    }
    fn key(&self, index: u32) -> Result<bool, Error> {
        let Some(stss) = self.stss else {
            return Ok(true);
        };
        let sample = index.checked_add(1).ok_or(Error::Overflow)?;
        let mut low = 0usize;
        let mut high = stss.count;
        while low < high {
            let mid = low + (high - low) / 2;
            if u32be(stss.entry(&self.raw, mid)?, 0)? < sample {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        Ok(low < stss.count && u32be(stss.entry(&self.raw, low)?, 0)? == sample)
    }
    pub fn packet(&self, index: u32) -> Result<Packet, Error> {
        if index >= self.count {
            return Err(Error::Invalid);
        }
        let run = self
            .chunk_runs
            .partition_point(|run| run.first_sample <= index)
            .checked_sub(1)
            .ok_or(Error::Invalid)?;
        let chunk = self.chunk_runs[run];
        let within = index - chunk.first_sample;
        let chunk_index = chunk
            .first_chunk
            .checked_add(within / chunk.per_chunk)
            .ok_or(Error::Overflow)?;
        let first_sample = index - within % chunk.per_chunk;
        let entry = self.offsets.entry(&self.raw, chunk_index as usize)?;
        let chunk_offset = if self.offsets.width == 8 {
            u64be(entry, 0)?
        } else {
            u64::from(u32be(entry, 0)?)
        };
        let offset = chunk_offset
            .checked_add(
                self.cumulative_size(index)?
                    .checked_sub(self.cumulative_size(first_sample)?)
                    .ok_or(Error::Overflow)?,
            )
            .ok_or(Error::Overflow)?;
        let size = self.size(index)?;
        if size == 0
            || size > PACKET_BUDGET
            || offset
                .checked_add(u64::from(size))
                .is_none_or(|end| end > self.file_len)
        {
            return Err(Error::ResourceLimit);
        }
        let (pts, stts_duration) = self.pts(index)?;
        let duration = if self.offset_runs.is_empty() {
            u64::from(stts_duration)
        } else {
            let next = if self.successors.is_empty() {
                (index + 1 < self.count).then_some(index + 1)
            } else {
                let successor = *self.successors.get(index as usize).ok_or(Error::Invalid)?;
                (successor != NO_SUCCESSOR).then_some(successor)
            };
            if let Some(next) = next {
                u64::try_from(self.pts(next)?.0.checked_sub(pts).ok_or(Error::Overflow)?)
                    .map_err(|_| Error::Overflow)?
            } else {
                u64::from(stts_duration)
            }
        };
        let (dts, _) = self.time(index)?;
        Ok(Packet {
            offset,
            size,
            dts: dts.checked_add(self.edit_shift).ok_or(Error::Overflow)?,
            pts,
            duration,
            key: self.key(index)?,
        })
    }
    fn run_bounds(&self, run: usize) -> (u32, u32) {
        if self.offset_runs.is_empty() {
            (0, self.count)
        } else {
            (
                self.offset_runs[run].first,
                self.offset_runs
                    .get(run + 1)
                    .map_or(self.count, |entry| entry.first),
            )
        }
    }
    fn previous_key(&self, low: u32, exclusive_end: u32) -> Result<Option<u32>, Error> {
        if exclusive_end <= low {
            return Ok(None);
        }
        let Some(stss) = self.stss else {
            return Ok(Some(exclusive_end - 1));
        };
        let mut left = 0usize;
        let mut right = stss.count;
        while left < right {
            let mid = left + (right - left) / 2;
            if u32be(stss.entry(&self.raw, mid)?, 0)? <= exclusive_end {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        if left == 0 {
            return Ok(None);
        }
        let sample = u32be(stss.entry(&self.raw, left - 1)?, 0)?;
        Ok((sample > low).then_some(sample - 1))
    }
    fn candidate(&self, run: usize, limit: u32, target: i64) -> Result<Option<Candidate>, Error> {
        let (start, end) = self.run_bounds(run);
        let mut left = start;
        let mut right = end.min(limit);
        while left < right {
            let mid = left + (right - left) / 2;
            if self.pts(mid)?.0 <= target {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        let Some(index) = self.previous_key(start, left)? else {
            return Ok(None);
        };
        Ok(Some(Candidate {
            pts: self.pts(index)?.0,
            index,
            run: run as u32,
        }))
    }
    fn higher(left: Candidate, right: Candidate) -> bool {
        (left.pts, left.index) > (right.pts, right.index)
    }
    fn push_candidate(&mut self, candidate: Candidate) -> Result<(), Error> {
        if self.seek.heap.len() == self.seek.heap.capacity() {
            return Err(Error::ResourceLimit);
        }
        self.seek.heap.push(candidate);
        let mut at = self.seek.heap.len() - 1;
        while at > 0 {
            let parent = (at - 1) / 2;
            if !Self::higher(self.seek.heap[at], self.seek.heap[parent]) {
                break;
            }
            self.seek.heap.swap(at, parent);
            at = parent;
        }
        Ok(())
    }
    fn pop_candidate(&mut self) -> Result<Option<Candidate>, Error> {
        let Some(first) = self.seek.heap.first().copied() else {
            return Ok(None);
        };
        let last = self.seek.heap.pop().ok_or(Error::Invalid)?;
        if !self.seek.heap.is_empty() {
            self.seek.heap[0] = last;
            let mut at = 0usize;
            loop {
                let left = at * 2 + 1;
                if left >= self.seek.heap.len() {
                    break;
                }
                let right = left + 1;
                let greater = if right < self.seek.heap.len()
                    && Self::higher(self.seek.heap[right], self.seek.heap[left])
                {
                    right
                } else {
                    left
                };
                if !Self::higher(self.seek.heap[greater], self.seek.heap[at]) {
                    break;
                }
                self.seek.heap.swap(at, greater);
                at = greater;
            }
        }
        Ok(Some(first))
    }
    pub fn seek_begin(&mut self, target: i64, before: u32) -> Result<(), Error> {
        if self.seek.active {
            return Err(Error::Invalid);
        }
        self.seek.heap.clear();
        self.seek.target = target;
        self.seek.before = before;
        self.seek.next_run = 0;
        self.seek.active = true;
        Ok(())
    }
    pub fn seek_step(&mut self, credit: u32) -> Result<Option<Option<u32>>, Error> {
        if !self.seek.active {
            return Err(Error::Invalid);
        }
        let run_count = self.offset_runs.len().max(1);
        for _ in 0..credit.clamp(1, 64) {
            if self.seek.next_run < run_count {
                let run = self.seek.next_run;
                self.seek.next_run += 1;
                let limit = if self.seek.before == NO_SUCCESSOR {
                    self.count
                } else {
                    self.seek.before.min(self.count)
                };
                if let Some(candidate) = self.candidate(run, limit, self.seek.target)? {
                    self.push_candidate(candidate)?;
                }
                continue;
            }
            let Some(candidate) = self.pop_candidate()? else {
                return Ok(Some(None));
            };
            let (start, _) = self.run_bounds(candidate.run as usize);
            if let Some(previous) = self.previous_key(start, candidate.index)? {
                self.push_candidate(Candidate {
                    pts: self.pts(previous)?.0,
                    index: previous,
                    run: candidate.run,
                })?;
            }
            return Ok(Some(Some(candidate.index)));
        }
        Ok(None)
    }
    pub fn seek_end(&mut self) -> bool {
        let active = self.seek.active;
        self.seek.active = false;
        self.seek.heap.clear();
        active
    }
}

enum Phase {
    Scan,
    Fill,
    Heapify,
    Emit,
    Ready,
}

pub struct CompactBuilder {
    index: CompactIndex,
    stsc: TableRef,
    stts: TableRef,
    ctts: Option<TableRef>,
    ctts_signed: bool,
    sample_at: u32,
    chunk_at: u32,
    chunk_run_at: usize,
    sample_in_chunk: u32,
    per_chunk: u32,
    offset: u64,
    dts: i64,
    stts_at: usize,
    stts_remaining: u32,
    stts_delta: u32,
    ctts_at: usize,
    ctts_remaining: u32,
    ctts_offset: i64,
    stss_at: usize,
    size_total: u64,
    previous_pts: Option<i64>,
    max_pts: i64,
    max_pts_duration: u32,
    reordered: bool,
    phase: Phase,
    sort_heap: Vec<u32>,
    fill_at: u32,
    heapify_at: usize,
    previous_sorted: Option<u32>,
}

fn reserve<T>(count: usize) -> Result<Vec<T>, Error> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| Error::ResourceLimit)?;
    Ok(values)
}

impl CompactBuilder {
    pub fn preferred(raw: &[u8], range: (usize, usize)) -> Result<bool, Error> {
        let stbl = raw
            .get(range.0..range.0.checked_add(range.1).ok_or(Error::Overflow)?)
            .ok_or(Error::Invalid)?;
        let sizes = required(stbl, *b"stsz")?;
        let count = u32be(sizes, 8)? as usize;
        if count == 0 || count > MAX_SAMPLES {
            return Err(Error::ResourceLimit);
        }
        Ok(count >= 200_000)
    }

    pub fn new(
        raw: Vec<u8>,
        range: (usize, usize),
        file_len: u64,
        track: &Track,
    ) -> Result<Self, Error> {
        let stbl = raw
            .get(range.0..range.0.checked_add(range.1).ok_or(Error::Overflow)?)
            .ok_or(Error::Invalid)?;
        let body = required(stbl, *b"stsz")?;
        let fixed_size = u32be(body, 4)?;
        let sizes = table_with_count(&raw, body, 12, if fixed_size == 0 { 4 } else { 0 }, 8)?;
        let count = u32::try_from(sizes.count).map_err(|_| Error::ResourceLimit)?;
        if count == 0 || sizes.count > MAX_SAMPLES {
            return Err(Error::ResourceLimit);
        }
        let offsets = if let Some(body) = crate::mp4::child(stbl, *b"co64")? {
            table(&raw, body, 8, 8)?
        } else {
            table(&raw, required(stbl, *b"stco")?, 8, 4)?
        };
        let stsc = table(&raw, required(stbl, *b"stsc")?, 8, 12)?;
        let stts = table(&raw, required(stbl, *b"stts")?, 8, 8)?;
        let ctts_body = crate::mp4::child(stbl, *b"ctts")?;
        let ctts_signed = ctts_body.is_some_and(|body| body.first() == Some(&1));
        let ctts = ctts_body.map(|body| table(&raw, body, 8, 8)).transpose()?;
        let stss = crate::mp4::child(stbl, *b"stss")?
            .map(|body| table(&raw, body, 8, 4))
            .transpose()?;
        if offsets.count == 0 || stsc.count == 0 || stts.count == 0 {
            return Err(Error::Invalid);
        }
        let first = stsc.entry(&raw, 0)?;
        if u32be(first, 0)? != 1 || u32be(first, 4)? == 0 || u32be(first, 8)? != 1 {
            return Err(Error::Invalid);
        }
        let per_chunk = u32be(first, 4)?;
        let offset = if offsets.width == 8 {
            u64be(offsets.entry(&raw, 0)?, 0)?
        } else {
            u64::from(u32be(offsets.entry(&raw, 0)?, 0)?)
        };
        let prefix_count = if fixed_size == 0 {
            sizes.count.div_ceil(SIZE_STRIDE)
        } else {
            0
        };
        let seek_count = ctts.map_or(1, |table| table.count.max(1));
        let estimated = raw
            .capacity()
            .checked_add(track.description.capacity())
            .and_then(|n| n.checked_add(INPUT_CAPACITY))
            .and_then(|n| n.checked_add(prefix_count.checked_mul(std::mem::size_of::<u64>())?))
            .and_then(|n| n.checked_add(stts.count.checked_mul(std::mem::size_of::<TimeRun>())?))
            .and_then(|n| {
                n.checked_add(
                    ctts.map_or(0, |table| table.count)
                        .checked_mul(std::mem::size_of::<OffsetRun>())?,
                )
            })
            .and_then(|n| n.checked_add(stsc.count.checked_mul(std::mem::size_of::<ChunkRun>())?))
            .and_then(|n| n.checked_add(seek_count.checked_mul(std::mem::size_of::<Candidate>())?))
            .ok_or(Error::Overflow)?;
        if estimated > METADATA_BUDGET {
            return Err(Error::ResourceLimit);
        }
        let mut index = CompactIndex {
            raw,
            file_len,
            count,
            fixed_size,
            sizes,
            offsets,
            stss,
            edit_shift: track.edit_shift,
            size_prefix: reserve(prefix_count)?,
            time_runs: reserve(stts.count)?,
            offset_runs: reserve(ctts.map_or(0, |table| table.count))?,
            chunk_runs: reserve(stsc.count)?,
            successors: Vec::new(),
            max_packet: 0,
            seek: Seek {
                heap: reserve(seek_count)?,
                target: 0,
                before: NO_SUCCESSOR,
                next_run: 0,
                active: false,
            },
        };
        if index.retained_bytes(track)? > METADATA_BUDGET {
            return Err(Error::ResourceLimit);
        }
        index.chunk_runs.push(ChunkRun {
            first_sample: 0,
            first_chunk: 0,
            per_chunk,
        });
        Ok(Self {
            index,
            stsc,
            stts,
            ctts,
            ctts_signed,
            sample_at: 0,
            chunk_at: 0,
            chunk_run_at: 0,
            sample_in_chunk: 0,
            per_chunk,
            offset,
            dts: 0,
            stts_at: 0,
            stts_remaining: 0,
            stts_delta: 0,
            ctts_at: 0,
            ctts_remaining: 0,
            ctts_offset: 0,
            stss_at: 0,
            size_total: 0,
            previous_pts: None,
            max_pts: i64::MIN,
            max_pts_duration: 0,
            reordered: false,
            phase: Phase::Scan,
            sort_heap: Vec::new(),
            fill_at: 0,
            heapify_at: 0,
            previous_sorted: None,
        })
    }

    fn admit_order(&mut self, track: &Track) -> Result<(), Error> {
        let bytes = (self.index.count as usize)
            .checked_mul(std::mem::size_of::<u32>() * 2)
            .ok_or(Error::Overflow)?;
        if self
            .index
            .retained_bytes(track)?
            .checked_add(bytes)
            .is_none_or(|total| total > METADATA_BUDGET)
        {
            return Err(Error::ResourceLimit);
        }
        self.index.successors = reserve(self.index.count as usize)?;
        if self
            .index
            .retained_bytes(track)?
            .checked_add(bytes / 2)
            .is_none_or(|total| total > METADATA_BUDGET)
        {
            return Err(Error::ResourceLimit);
        }
        self.sort_heap = reserve(self.index.count as usize)?;
        if self
            .index
            .retained_bytes(track)?
            .checked_add(self.sort_heap.capacity() * std::mem::size_of::<u32>())
            .is_none_or(|total| total > METADATA_BUDGET)
        {
            return Err(Error::ResourceLimit);
        }
        Ok(())
    }

    fn scan_one(&mut self, track: &Track) -> Result<(), Error> {
        let index = self.sample_at;
        if self.sample_in_chunk == self.per_chunk {
            self.chunk_at = self.chunk_at.checked_add(1).ok_or(Error::Overflow)?;
            if self.chunk_at as usize >= self.index.offsets.count {
                return Err(Error::Invalid);
            }
            self.sample_in_chunk = 0;
            if self.chunk_run_at + 1 < self.stsc.count {
                let next = self.stsc.entry(&self.index.raw, self.chunk_run_at + 1)?;
                if u32be(next, 0)? == self.chunk_at + 1 {
                    self.chunk_run_at += 1;
                    self.per_chunk = u32be(next, 4)?;
                    if self.per_chunk == 0 || u32be(next, 8)? != 1 {
                        return Err(Error::Invalid);
                    }
                    self.index.chunk_runs.push(ChunkRun {
                        first_sample: index,
                        first_chunk: self.chunk_at,
                        per_chunk: self.per_chunk,
                    });
                }
            }
            let entry = self
                .index
                .offsets
                .entry(&self.index.raw, self.chunk_at as usize)?;
            self.offset = if self.index.offsets.width == 8 {
                u64be(entry, 0)?
            } else {
                u64::from(u32be(entry, 0)?)
            };
        }
        if self.index.fixed_size == 0 && (index as usize).is_multiple_of(SIZE_STRIDE) {
            self.index.size_prefix.push(self.size_total);
        }
        let size = self.index.size(index)?;
        if size == 0 || size > PACKET_BUDGET {
            return Err(Error::ResourceLimit);
        }
        let end = self
            .offset
            .checked_add(u64::from(size))
            .ok_or(Error::Overflow)?;
        if end > self.index.file_len {
            return Err(Error::Truncated);
        }
        if self.stts_remaining == 0 {
            let entry = self.stts.entry(&self.index.raw, self.stts_at)?;
            self.stts_remaining = u32be(entry, 0)?;
            self.stts_delta = u32be(entry, 4)?;
            if self.stts_remaining == 0 {
                return Err(Error::Invalid);
            }
            self.index.time_runs.push(TimeRun {
                first: index,
                dts: self.dts,
                delta: self.stts_delta,
            });
            self.stts_at += 1;
        }
        self.stts_remaining -= 1;
        if let Some(ctts) = self.ctts {
            if self.ctts_remaining == 0 {
                let entry = ctts.entry(&self.index.raw, self.ctts_at)?;
                self.ctts_remaining = u32be(entry, 0)?;
                let raw = u32be(entry, 4)?;
                self.ctts_offset = if self.ctts_signed {
                    i64::from(raw as i32)
                } else {
                    i64::from(raw)
                };
                if self.ctts_remaining == 0 {
                    return Err(Error::Invalid);
                }
                self.index.offset_runs.push(OffsetRun {
                    first: index,
                    offset: self.ctts_offset,
                });
                self.ctts_at += 1;
            }
            self.ctts_remaining -= 1;
        }
        let pts = self
            .dts
            .checked_add(self.ctts_offset)
            .and_then(|n| n.checked_add(track.edit_shift))
            .ok_or(Error::Overflow)?;
        if let Some(previous) = self.previous_pts {
            if pts < previous && !self.reordered {
                self.admit_order(track)?;
                self.reordered = true;
            }
        }
        self.previous_pts = Some(pts);
        if pts >= self.max_pts {
            self.max_pts = pts;
            self.max_pts_duration = self.stts_delta;
        }
        if let Some(stss) = self.index.stss {
            if self.stss_at < stss.count {
                let key = u32be(stss.entry(&self.index.raw, self.stss_at)?, 0)?;
                if key == 0 || key < index + 1 {
                    return Err(Error::Invalid);
                }
                if key == index + 1 {
                    self.stss_at += 1;
                }
            }
        }
        self.index.max_packet = self.index.max_packet.max(size);
        self.size_total = self
            .size_total
            .checked_add(u64::from(size))
            .ok_or(Error::Overflow)?;
        self.offset = end;
        self.dts = self
            .dts
            .checked_add(i64::from(self.stts_delta))
            .ok_or(Error::Overflow)?;
        self.sample_at += 1;
        self.sample_in_chunk += 1;
        Ok(())
    }

    fn lower(&self, left: u32, right: u32) -> Result<bool, Error> {
        Ok((self.index.pts(left)?.0, left) < (self.index.pts(right)?.0, right))
    }
    fn sift_down(&mut self, mut at: usize) -> Result<(), Error> {
        loop {
            let left = at
                .checked_mul(2)
                .and_then(|n| n.checked_add(1))
                .ok_or(Error::Overflow)?;
            if left >= self.sort_heap.len() {
                break;
            }
            let right = left + 1;
            let smallest = if right < self.sort_heap.len()
                && self.lower(self.sort_heap[right], self.sort_heap[left])?
            {
                right
            } else {
                left
            };
            if !self.lower(self.sort_heap[smallest], self.sort_heap[at])? {
                break;
            }
            self.sort_heap.swap(at, smallest);
            at = smallest;
        }
        Ok(())
    }
    fn pop_sorted(&mut self) -> Result<u32, Error> {
        let first = *self.sort_heap.first().ok_or(Error::Invalid)?;
        let last = self.sort_heap.pop().ok_or(Error::Invalid)?;
        if !self.sort_heap.is_empty() {
            self.sort_heap[0] = last;
            self.sift_down(0)?;
        }
        Ok(first)
    }

    pub fn advance(&mut self, track: &mut Track, credit: u32) -> Result<bool, Error> {
        for _ in 0..credit.clamp(1, 64) {
            match self.phase {
                Phase::Scan => {
                    if self.sample_at < self.index.count {
                        self.scan_one(track)?;
                        continue;
                    }
                    if self.chunk_at as usize + 1 != self.index.offsets.count
                        || self.sample_in_chunk != self.per_chunk
                    {
                        return Err(Error::Invalid);
                    }
                    let end = self
                        .max_pts
                        .checked_add(i64::from(self.max_pts_duration))
                        .ok_or(Error::Overflow)?;
                    track.duration = u64::try_from(end.max(0)).map_err(|_| Error::Overflow)?;
                    self.phase = if self.reordered {
                        Phase::Fill
                    } else {
                        Phase::Ready
                    };
                }
                Phase::Fill => {
                    if self.fill_at < self.index.count {
                        self.sort_heap.push(self.fill_at);
                        self.index.successors.push(NO_SUCCESSOR);
                        self.fill_at += 1;
                    } else {
                        self.heapify_at = self.sort_heap.len() / 2;
                        self.phase = Phase::Heapify;
                    }
                }
                Phase::Heapify => {
                    if self.heapify_at > 0 {
                        self.heapify_at -= 1;
                        self.sift_down(self.heapify_at)?;
                    } else {
                        self.phase = Phase::Emit;
                    }
                }
                Phase::Emit => {
                    if !self.sort_heap.is_empty() {
                        let current = self.pop_sorted()?;
                        if let Some(previous) = self.previous_sorted.replace(current) {
                            self.index.successors[previous as usize] = current;
                        }
                    } else {
                        self.phase = Phase::Ready;
                    }
                }
                Phase::Ready => return Ok(true),
            }
        }
        Ok(false)
    }
    pub fn into_index(self) -> Result<CompactIndex, Error> {
        if !matches!(self.phase, Phase::Ready) {
            return Err(Error::Invalid);
        }
        Ok(self.index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(body);
        bytes
    }
    fn track() -> Track {
        Track {
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
            duration: 0,
            rotation: 0,
            description: Vec::new(),
            packets: Vec::new(),
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        }
    }
    fn table_body(entries: &[(u32, u32)]) -> Vec<u8> {
        let mut body = vec![0; 8];
        body[4..8].copy_from_slice(&(entries.len() as u32).to_be_bytes());
        for &(count, value) in entries {
            body.extend_from_slice(&count.to_be_bytes());
            body.extend_from_slice(&value.to_be_bytes());
        }
        body
    }
    fn fixed_file(count: u32, size: u32) -> Vec<u8> {
        let mut stsz = vec![0; 12];
        stsz[4..8].copy_from_slice(&size.to_be_bytes());
        stsz[8..12].copy_from_slice(&count.to_be_bytes());
        let mut stco = vec![0; 12];
        stco[4..8].copy_from_slice(&1u32.to_be_bytes());
        stco[8..12].copy_from_slice(&100u32.to_be_bytes());
        let mut stsc = vec![0; 20];
        stsc[4..8].copy_from_slice(&1u32.to_be_bytes());
        stsc[8..12].copy_from_slice(&1u32.to_be_bytes());
        stsc[12..16].copy_from_slice(&count.to_be_bytes());
        stsc[16..20].copy_from_slice(&1u32.to_be_bytes());
        [
            atom(b"stsz", &stsz),
            atom(b"stco", &stco),
            atom(b"stsc", &stsc),
            atom(b"stts", &table_body(&[(count, 1)])),
        ]
        .concat()
    }
    fn complete(raw: Vec<u8>, file_len: u64, track: &mut Track) -> Result<CompactIndex, Error> {
        let len = raw.len();
        let mut builder = CompactBuilder::new(raw, (0, len), file_len, track)?;
        let mut steps = 0usize;
        while !builder.advance(track, 64)? {
            steps += 1;
            assert!(steps < 40_000);
        }
        builder.into_index()
    }

    #[test]
    fn seven_hundred_thousand_fixed_samples_keep_only_run_tables() {
        let raw = fixed_file(700_000, 24);
        assert!(CompactBuilder::preferred(&raw, (0, raw.len())).unwrap());
        let mut track = track();
        let mut index = complete(raw, 16_800_100, &mut track).unwrap();
        assert_eq!(index.count(), 700_000);
        assert_eq!(index.max_packet(), 24);
        assert!(index.retained_bytes(&track).unwrap() < 128 * 1024);
        assert!(track.packets.is_empty());
        assert_eq!(index.packet(0).unwrap().offset, 100);
        assert_eq!(index.packet(699_999).unwrap().offset, 16_800_076);
        assert_eq!(track.duration, 700_000);
        index.seek_begin(699_999, NO_SUCCESSOR).unwrap();
        let mut candidate = None;
        for _ in 0..8 {
            match index.seek_step(1).unwrap() {
                Some(Some(value)) => {
                    candidate = Some(value);
                    break;
                }
                Some(None) => break,
                None => {}
            }
        }
        assert_eq!(candidate, Some(699_999));
        assert!(index.seek_end());
    }

    #[test]
    fn variable_size_co64_chunk_runs_ctts_and_sparse_keys_are_exact() {
        let sizes = [3u32, 4, 5, 6, 7, 8];
        let mut stsz = vec![0; 12];
        stsz[8..12].copy_from_slice(&6u32.to_be_bytes());
        for size in sizes {
            stsz.extend_from_slice(&size.to_be_bytes());
        }
        let mut co64 = vec![0; 8];
        co64[4..8].copy_from_slice(&4u32.to_be_bytes());
        for offset in [100u64, 200, 300, 400] {
            co64.extend_from_slice(&offset.to_be_bytes());
        }
        let mut stsc = vec![0; 8];
        stsc[4..8].copy_from_slice(&3u32.to_be_bytes());
        for (first, per_chunk) in [(1u32, 2u32), (2, 1), (4, 2)] {
            stsc.extend_from_slice(&first.to_be_bytes());
            stsc.extend_from_slice(&per_chunk.to_be_bytes());
            stsc.extend_from_slice(&1u32.to_be_bytes());
        }
        let stts = table_body(&[(1, 10), (1, 30), (1, 20), (1, 40), (1, 15), (1, 25)]);
        let mut ctts = table_body(&[
            (1, (-20i32) as u32),
            (1, 40),
            (1, (-10i32) as u32),
            (1, (-10i32) as u32),
            (1, (-50i32) as u32),
            (1, (-5i32) as u32),
        ]);
        ctts[0] = 1;
        let mut stss = vec![0; 8];
        stss[4..8].copy_from_slice(&5u32.to_be_bytes());
        for sample in [1u32, 2, 4, 5, 6] {
            stss.extend_from_slice(&sample.to_be_bytes());
        }
        let raw = [
            atom(b"stsz", &stsz),
            atom(b"co64", &co64),
            atom(b"stsc", &stsc),
            atom(b"stts", &stts),
            atom(b"ctts", &ctts),
            atom(b"stss", &stss),
        ]
        .concat();
        let mut track = track();
        let mut index = complete(raw, 1000, &mut track).unwrap();
        assert_eq!(index.count(), 6);
        assert_eq!(index.max_packet(), 8);
        assert_eq!(track.duration, 135);
        assert_eq!(
            (0..6)
                .map(|i| index.packet(i).unwrap().offset)
                .collect::<Vec<_>>(),
            [100, 103, 200, 300, 400, 407]
        );
        assert_eq!(
            (0..6)
                .map(|i| index.packet(i).unwrap().pts)
                .collect::<Vec<_>>(),
            [-20, 50, 30, 50, 50, 110]
        );
        assert_eq!(
            (0..6)
                .map(|i| index.packet(i).unwrap().duration)
                .collect::<Vec<_>>(),
            [50, 0, 20, 0, 60, 25]
        );
        assert_eq!(
            (0..6)
                .map(|i| index.packet(i).unwrap().key)
                .collect::<Vec<_>>(),
            [true, true, false, true, true, true]
        );
        index.seek_begin(50, NO_SUCCESSOR).unwrap();
        let mut found = Vec::new();
        for _ in 0..30 {
            match index.seek_step(1).unwrap() {
                Some(Some(index)) => found.push(index),
                Some(None) => break,
                None => {}
            }
        }
        assert_eq!(found, [4, 3, 1, 0]);
        assert!(index.seek_end());
        assert!(!index.seek_end());
        index.seek_begin(50, 4).unwrap();
        let mut bounded = Vec::new();
        for _ in 0..30 {
            match index.seek_step(1).unwrap() {
                Some(Some(candidate)) => bounded.push(candidate),
                Some(None) => break,
                None => {}
            }
        }
        assert_eq!(bounded, [3, 1, 0]);
        assert!(index.seek_end());
    }

    #[test]
    fn invalid_sample_extent_fails_during_bounded_scan() {
        let raw = fixed_file(300_000, 24);
        let mut track = track();
        assert_eq!(complete(raw, 100, &mut track).err(), Some(Error::Truncated));
    }
}
