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
struct RunOrder {
    run: u32,
    start_pts: i64,
    last_pts: i64,
    prefix_max_last: i64,
}
#[derive(Clone)]
struct Query {
    index: u32,
    packet: Packet,
    scan_at: usize,
    next: Option<(i64, u32)>,
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
    sorted_runs: Vec<RunOrder>,
    query: Option<Query>,
    cached_packet: Option<(u32, Packet)>,
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
    pub fn query_active(&self) -> bool {
        self.query.is_some()
    }
    pub fn requires_query(&self) -> bool {
        !self.offset_runs.is_empty()
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
                    self.sorted_runs
                        .capacity()
                        .checked_mul(std::mem::size_of::<RunOrder>())?,
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
    fn sum_sample_sizes(
        &self,
        mut sum: u64,
        samples: std::ops::Range<usize>,
    ) -> Result<u64, Error> {
        if samples.end > self.sizes.count {
            return Err(Error::Invalid);
        }
        let bytes = self.raw.get(self.sizes.start..).ok_or(Error::Truncated)?;
        let (entries, _) = bytes.as_chunks::<4>();
        for size in entries.get(samples).ok_or(Error::Truncated)? {
            sum = sum
                .checked_add(u64::from(u32::from_be_bytes(*size)))
                .ok_or(Error::Overflow)?;
        }
        Ok(sum)
    }
    fn chunk_relative_offset(&self, first: u32, index: u32) -> Result<u64, Error> {
        if self.fixed_size != 0 {
            let distance = index.checked_sub(first).ok_or(Error::Overflow)?;
            return u64::from(distance)
                .checked_mul(u64::from(self.fixed_size))
                .ok_or(Error::Overflow);
        }
        let first = first as usize;
        let index = index as usize;
        if first / SIZE_STRIDE == index / SIZE_STRIDE {
            return self.sum_sample_sizes(0, first..index);
        }
        let cumulative_size = |end: usize| {
            let block = end / SIZE_STRIDE;
            let prefix = *self.size_prefix.get(block).ok_or(Error::Invalid)?;
            self.sum_sample_sizes(prefix, block * SIZE_STRIDE..end)
        };
        cumulative_size(index)?
            .checked_sub(cumulative_size(first)?)
            .ok_or(Error::Overflow)
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
    fn pts(&self, index: u32) -> Result<i64, Error> {
        self.pts_from_dts(index, self.time(index)?.0)
    }
    fn pts_from_dts(&self, index: u32, dts: i64) -> Result<i64, Error> {
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
        dts.checked_add(offset)
            .and_then(|n| n.checked_add(self.edit_shift))
            .ok_or(Error::Overflow)
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
        if self.requires_query() {
            return self
                .cached_packet
                .as_ref()
                .filter(|(cached_index, _)| *cached_index == index)
                .map(|(_, packet)| packet.clone())
                .ok_or(Error::Invalid);
        }
        self.packet_base(index)
    }
    fn packet_base(&self, index: u32) -> Result<Packet, Error> {
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
            .checked_add(self.chunk_relative_offset(first_sample, index)?)
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
        let (dts, stts_duration) = self.time(index)?;
        let pts = self.pts_from_dts(index, dts)?;
        Ok(Packet {
            offset,
            size,
            dts: dts.checked_add(self.edit_shift).ok_or(Error::Overflow)?,
            pts,
            duration: u64::from(stts_duration),
            key: self.key(index)?,
        })
    }
    pub fn query_begin(&mut self, index: u32) -> Result<(), Error> {
        if !self.requires_query() || self.query.is_some() {
            return Err(Error::Invalid);
        }
        let packet = self.packet_base(index)?;
        let scan_at = self
            .sorted_runs
            .partition_point(|run| run.start_pts <= packet.pts);
        let next = self
            .sorted_runs
            .get(scan_at)
            .map(|run| (run.start_pts, self.offset_runs[run.run as usize].first));
        self.query = Some(Query {
            index,
            packet,
            scan_at,
            next,
        });
        Ok(())
    }
    pub fn query_step(&mut self, credit: u32) -> Result<Option<Packet>, Error> {
        let mut query = self.query.clone().ok_or(Error::Invalid)?;
        for _ in 0..credit.clamp(1, 64) {
            if query.scan_at == 0
                || self.sorted_runs[query.scan_at - 1].prefix_max_last < query.packet.pts
            {
                if let Some((next_pts, _)) = query.next {
                    query.packet.duration = u64::try_from(
                        next_pts
                            .checked_sub(query.packet.pts)
                            .ok_or(Error::Overflow)?,
                    )
                    .map_err(|_| Error::Overflow)?;
                }
                self.cached_packet = Some((query.index, query.packet.clone()));
                self.query = Some(query);
                return Ok(self
                    .cached_packet
                    .as_ref()
                    .map(|(_, packet)| packet.clone()));
            }
            query.scan_at -= 1;
            let order = self.sorted_runs[query.scan_at];
            if order.last_pts < query.packet.pts {
                continue;
            }
            let (start, end) = self.run_bounds(order.run as usize);
            let mut low = start;
            let mut high = end;
            while low < high {
                let mid = low + (high - low) / 2;
                if (self.pts(mid)?, mid) <= (query.packet.pts, query.index) {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            if low < end {
                let candidate = (self.pts(low)?, low);
                if query.next.is_none_or(|next| candidate < next) {
                    query.next = Some(candidate);
                }
            }
        }
        self.query = Some(query);
        Ok(None)
    }
    pub fn query_end(&mut self) -> bool {
        self.query.take().is_some()
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
            if self.pts(mid)? <= target {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        let Some(index) = self.previous_key(start, left)? else {
            return Ok(None);
        };
        Ok(Some(Candidate {
            pts: self.pts(index)?,
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
                    pts: self.pts(previous)?,
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
    ValidateStsc,
    ValidateStss,
    BuildRuns,
    HeapifyRuns,
    SortRuns,
    PrefixRuns,
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
    max_pts: i64,
    max_pts_duration: u32,
    phase: Phase,
    validate_at: usize,
    validate_previous: u32,
    run_at: usize,
    heapify_at: usize,
    sort_at: usize,
    prefix_at: usize,
    prefix_max: i64,
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
            .and_then(|n| {
                n.checked_add(
                    ctts.map_or(0, |table| table.count)
                        .checked_mul(std::mem::size_of::<RunOrder>())?,
                )
            })
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
            sorted_runs: reserve(ctts.map_or(0, |table| table.count))?,
            query: None,
            cached_packet: None,
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
            max_pts: i64::MIN,
            max_pts_duration: 0,
            phase: Phase::Scan,
            validate_at: 0,
            validate_previous: 0,
            run_at: 0,
            heapify_at: 0,
            sort_at: 0,
            prefix_at: 0,
            prefix_max: i64::MIN,
        })
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

    fn scan_fixed_tail(&mut self, track: &Track) -> Result<(), Error> {
        if self.index.fixed_size == 0 {
            return Ok(());
        }
        let mut count = self
            .index
            .count
            .checked_sub(self.sample_at)
            .ok_or(Error::Invalid)?
            .min(
                self.per_chunk
                    .checked_sub(self.sample_in_chunk)
                    .ok_or(Error::Invalid)?,
            )
            .min(self.stts_remaining);
        if self.ctts.is_some() {
            count = count.min(self.ctts_remaining);
        }
        if let Some(stss) = self.index.stss {
            if self.stss_at < stss.count {
                let next_key = u32be(stss.entry(&self.index.raw, self.stss_at)?, 0)?;
                if next_key <= self.sample_at {
                    return Err(Error::Invalid);
                }
                count = count.min(next_key - 1 - self.sample_at);
            }
        }
        if count == 0 {
            return Ok(());
        }
        let byte_count = u64::from(count)
            .checked_mul(u64::from(self.index.fixed_size))
            .ok_or(Error::Overflow)?;
        let end = self.offset.checked_add(byte_count).ok_or(Error::Overflow)?;
        if end > self.index.file_len {
            return Err(Error::Truncated);
        }
        let last_dts = i64::from(count - 1)
            .checked_mul(i64::from(self.stts_delta))
            .and_then(|n| self.dts.checked_add(n))
            .ok_or(Error::Overflow)?;
        let last_pts = last_dts
            .checked_add(self.ctts_offset)
            .and_then(|n| n.checked_add(track.edit_shift))
            .ok_or(Error::Overflow)?;
        if last_pts >= self.max_pts {
            self.max_pts = last_pts;
            self.max_pts_duration = self.stts_delta;
        }
        let next_dts = i64::from(count)
            .checked_mul(i64::from(self.stts_delta))
            .and_then(|n| self.dts.checked_add(n))
            .ok_or(Error::Overflow)?;
        let size_total = self
            .size_total
            .checked_add(byte_count)
            .ok_or(Error::Overflow)?;
        self.offset = end;
        self.size_total = size_total;
        self.dts = next_dts;
        self.sample_at += count;
        self.sample_in_chunk += count;
        self.stts_remaining -= count;
        if self.ctts.is_some() {
            self.ctts_remaining -= count;
        }
        Ok(())
    }

    fn order_higher(left: RunOrder, right: RunOrder) -> bool {
        (left.start_pts, left.run) > (right.start_pts, right.run)
    }
    fn sift_down(&mut self, mut at: usize, limit: usize) -> Result<(), Error> {
        loop {
            let left = at
                .checked_mul(2)
                .and_then(|n| n.checked_add(1))
                .ok_or(Error::Overflow)?;
            if left >= limit {
                break;
            }
            let right = left + 1;
            let greater = if right < limit
                && Self::order_higher(self.index.sorted_runs[right], self.index.sorted_runs[left])
            {
                right
            } else {
                left
            };
            if !Self::order_higher(self.index.sorted_runs[greater], self.index.sorted_runs[at]) {
                break;
            }
            self.index.sorted_runs.swap(at, greater);
            at = greater;
        }
        Ok(())
    }

    pub fn advance(&mut self, track: &mut Track, credit: u32) -> Result<bool, Error> {
        for _ in 0..credit.clamp(1, 64) {
            match self.phase {
                Phase::Scan => {
                    if self.sample_at < self.index.count {
                        self.scan_one(track)?;
                        self.scan_fixed_tail(track)?;
                        continue;
                    }
                    if self.chunk_at as usize + 1 != self.index.offsets.count
                        || self.sample_in_chunk != self.per_chunk
                        || self.stts_remaining != 0
                        || self.stts_at != self.stts.count
                        || self.ctts.is_some_and(|ctts| {
                            self.ctts_remaining != 0 || self.ctts_at != ctts.count
                        })
                    {
                        return Err(Error::Invalid);
                    }
                    let end = self
                        .max_pts
                        .checked_add(i64::from(self.max_pts_duration))
                        .ok_or(Error::Overflow)?;
                    track.duration = u64::try_from(end.max(0)).map_err(|_| Error::Overflow)?;
                    self.phase = Phase::ValidateStsc;
                }
                Phase::ValidateStsc => {
                    if self.validate_at < self.stsc.count {
                        let entry = self.stsc.entry(&self.index.raw, self.validate_at)?;
                        let first_chunk = u32be(entry, 0)?;
                        if first_chunk <= self.validate_previous
                            || first_chunk as usize > self.index.offsets.count
                            || u32be(entry, 4)? == 0
                            || u32be(entry, 8)? != 1
                        {
                            return Err(Error::Invalid);
                        }
                        self.validate_previous = first_chunk;
                        self.validate_at += 1;
                    } else {
                        self.validate_at = 0;
                        self.validate_previous = 0;
                        self.phase = Phase::ValidateStss;
                    }
                }
                Phase::ValidateStss => {
                    if let Some(stss) = self.index.stss {
                        if self.validate_at < stss.count {
                            let sample = u32be(stss.entry(&self.index.raw, self.validate_at)?, 0)?;
                            if sample <= self.validate_previous || sample > self.index.count {
                                return Err(Error::Invalid);
                            }
                            self.validate_previous = sample;
                            self.validate_at += 1;
                            continue;
                        }
                    }
                    self.phase = if self.ctts.is_some() {
                        Phase::BuildRuns
                    } else {
                        Phase::Ready
                    };
                }
                Phase::BuildRuns => {
                    if self.run_at < self.index.offset_runs.len() {
                        let (first, end) = self.index.run_bounds(self.run_at);
                        let start_pts = self.index.pts(first)?;
                        let last_pts = self.index.pts(end - 1)?;
                        self.index.sorted_runs.push(RunOrder {
                            run: u32::try_from(self.run_at).map_err(|_| Error::ResourceLimit)?,
                            start_pts,
                            last_pts,
                            prefix_max_last: i64::MIN,
                        });
                        self.run_at += 1;
                    } else {
                        self.heapify_at = self.index.sorted_runs.len() / 2;
                        self.phase = Phase::HeapifyRuns;
                    }
                }
                Phase::HeapifyRuns => {
                    if self.heapify_at > 0 {
                        self.heapify_at -= 1;
                        self.sift_down(self.heapify_at, self.index.sorted_runs.len())?;
                    } else {
                        self.sort_at = self.index.sorted_runs.len();
                        self.phase = Phase::SortRuns;
                    }
                }
                Phase::SortRuns => {
                    if self.sort_at > 1 {
                        self.sort_at -= 1;
                        self.index.sorted_runs.swap(0, self.sort_at);
                        self.sift_down(0, self.sort_at)?;
                    } else {
                        self.phase = Phase::PrefixRuns;
                    }
                }
                Phase::PrefixRuns => {
                    if let Some(run) = self.index.sorted_runs.get_mut(self.prefix_at) {
                        self.prefix_max = self.prefix_max.max(run.last_pts);
                        run.prefix_max_last = self.prefix_max;
                        self.prefix_at += 1;
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
    fn complete_with_calls(
        raw: Vec<u8>,
        file_len: u64,
        track: &mut Track,
    ) -> Result<(CompactIndex, usize), Error> {
        let len = raw.len();
        let mut builder = CompactBuilder::new(raw, (0, len), file_len, track)?;
        let mut calls = 0usize;
        loop {
            calls += 1;
            if builder.advance(track, 64)? {
                break;
            }
            assert!(calls < 100_000);
        }
        Ok((builder.into_index()?, calls))
    }
    fn complete(raw: Vec<u8>, file_len: u64, track: &mut Track) -> Result<CompactIndex, Error> {
        complete_with_calls(raw, file_len, track).map(|(index, _)| index)
    }
    fn query_packet(index: &mut CompactIndex, sample: u32) -> Packet {
        assert!(index.packet(sample).is_err());
        index.query_begin(sample).unwrap();
        let packet = loop {
            if let Some(packet) = index.query_step(1).unwrap() {
                break packet;
            }
        };
        assert!(index.query_end());
        assert_eq!(index.packet(sample).unwrap().duration, packet.duration);
        packet
    }

    #[test]
    fn seven_hundred_thousand_fixed_samples_keep_only_run_tables() {
        let raw = fixed_file(700_000, 24);
        assert!(CompactBuilder::preferred(&raw, (0, raw.len())).unwrap());
        let mut track = track();
        let (mut index, calls) = complete_with_calls(raw, 16_800_100, &mut track).unwrap();
        assert!(
            calls <= 1024,
            "fixed-size sparse track took {calls} parser calls"
        );
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
    fn four_million_reordered_samples_use_two_runs_without_sample_order_storage() {
        let count = 4_200_000u32;
        let mut raw = fixed_file(count, 24);
        let stts_delta = raw.len() - 4;
        raw[stts_delta..].copy_from_slice(&512u32.to_be_bytes());
        let mut ctts = table_body(&[(count / 2, 0), (count / 2, (-1_075_200_000i32) as u32)]);
        ctts[0] = 1;
        raw.extend_from_slice(&atom(b"ctts", &ctts));
        let mut track = track();
        let mut index = complete(raw, 100_800_100, &mut track).unwrap();
        assert!(index.requires_query());
        assert!(index.retained_bytes(&track).unwrap() < 128 * 1024);
        assert_eq!(track.duration, 1_075_200_000);
        assert_eq!(query_packet(&mut index, 0).duration, 0);
        assert_eq!(query_packet(&mut index, count / 2).duration, 512);
        assert_eq!(query_packet(&mut index, count - 1).duration, 512);
        index.seek_begin(0, NO_SUCCESSOR).unwrap();
        let mut found = None;
        for _ in 0..8 {
            if let Some(Some(candidate)) = index.seek_step(1).unwrap() {
                found = Some(candidate);
                break;
            }
        }
        assert_eq!(found, Some(count / 2));
        assert!(index.seek_end());
    }

    #[test]
    fn overlapping_ctts_runs_pause_and_preserve_equal_time_index_order() {
        let count = 128u32;
        let mut raw = fixed_file(count, 24);
        let offsets = (0..count)
            .map(|i| (1, (-(i as i32)) as u32))
            .collect::<Vec<_>>();
        let mut ctts = table_body(&offsets);
        ctts[0] = 1;
        raw.extend_from_slice(&atom(b"ctts", &ctts));
        let mut track = track();
        let mut index = complete(raw, 100 + u64::from(count) * 24, &mut track).unwrap();
        assert_eq!(track.duration, 1);
        index.query_begin(0).unwrap();
        assert!(index.query_step(4096).unwrap().is_none());
        assert!(index.query_step(4096).unwrap().is_none());
        assert_eq!(index.query_step(4096).unwrap().unwrap().duration, 0);
        assert!(index.query_end());
        assert_eq!(index.packet(0).unwrap().duration, 0);
        assert_eq!(query_packet(&mut index, count - 1).duration, 1);
    }

    #[test]
    fn fixed_batch_stops_at_chunk_time_offset_and_key_boundaries() {
        let count = 6u32;
        let mut raw = fixed_file(count, 3);
        let stco = raw.windows(4).position(|bytes| bytes == b"stco").unwrap();
        raw[stco + 8..stco + 12].copy_from_slice(&2u32.to_be_bytes());
        raw.splice(stco + 16..stco + 16, 200u32.to_be_bytes());
        let stco_len = stco - 4;
        raw[stco_len..stco_len + 4].copy_from_slice(&24u32.to_be_bytes());
        let stsc = raw.windows(4).position(|bytes| bytes == b"stsc").unwrap();
        raw[stsc + 16..stsc + 20].copy_from_slice(&3u32.to_be_bytes());
        let stts = raw.windows(4).position(|bytes| bytes == b"stts").unwrap();
        raw[stts + 8..stts + 12].copy_from_slice(&2u32.to_be_bytes());
        raw[stts + 12..stts + 16].copy_from_slice(&3u32.to_be_bytes());
        raw[stts + 16..stts + 20].copy_from_slice(&10u32.to_be_bytes());
        raw.splice(
            stts + 20..stts + 20,
            [3u32.to_be_bytes(), 20u32.to_be_bytes()].concat(),
        );
        raw[stts - 4..stts].copy_from_slice(&32u32.to_be_bytes());
        let mut ctts = table_body(&[(2, 0), (4, (-5i32) as u32)]);
        ctts[0] = 1;
        let mut stss = vec![0; 8];
        stss[4..8].copy_from_slice(&3u32.to_be_bytes());
        for sample in [1u32, 4, 6] {
            stss.extend_from_slice(&sample.to_be_bytes());
        }
        raw.extend_from_slice(&atom(b"ctts", &ctts));
        raw.extend_from_slice(&atom(b"stss", &stss));
        let mut track = track();
        let mut index = complete(raw, 209, &mut track).unwrap();
        assert_eq!(track.duration, 85);
        let packets = (0..count)
            .map(|sample| query_packet(&mut index, sample))
            .collect::<Vec<_>>();
        assert_eq!(
            packets.iter().map(|p| p.offset).collect::<Vec<_>>(),
            [100, 103, 106, 200, 203, 206]
        );
        assert_eq!(
            packets.iter().map(|p| p.pts).collect::<Vec<_>>(),
            [0, 10, 15, 25, 45, 65]
        );
        assert_eq!(
            packets.iter().map(|p| p.duration).collect::<Vec<_>>(),
            [10, 5, 10, 20, 20, 20]
        );
        assert_eq!(
            packets.iter().map(|p| p.key).collect::<Vec<_>>(),
            [true, false, false, true, false, true]
        );
    }

    #[test]
    fn fixed_batch_rejects_a_late_truncated_extent() {
        let raw = fixed_file(700_000, 24);
        let mut track = track();
        assert_eq!(
            complete(raw, 16_800_099, &mut track).err(),
            Some(Error::Truncated)
        );
    }

    #[test]
    fn fixed_batch_rejects_trailing_and_inconsistent_table_rows() {
        let count = 300_000u32;
        let file_len = 100 + u64::from(count) * 24;
        let mut stsc = fixed_file(count, 24);
        let stsc_type = stsc.windows(4).position(|bytes| bytes == b"stsc").unwrap();
        stsc[stsc_type + 8..stsc_type + 12].copy_from_slice(&2u32.to_be_bytes());
        stsc.splice(
            stsc_type + 24..stsc_type + 24,
            [1u32.to_be_bytes(), count.to_be_bytes(), 1u32.to_be_bytes()].concat(),
        );
        stsc[stsc_type - 4..stsc_type].copy_from_slice(&40u32.to_be_bytes());
        assert_eq!(
            complete(stsc, file_len, &mut track()).err(),
            Some(Error::Invalid)
        );

        let mut stss = fixed_file(count, 24);
        let mut keys = vec![0; 8];
        keys[4..8].copy_from_slice(&1u32.to_be_bytes());
        keys.extend_from_slice(&(count + 1).to_be_bytes());
        stss.extend_from_slice(&atom(b"stss", &keys));
        assert_eq!(
            complete(stss, file_len, &mut track()).err(),
            Some(Error::Invalid)
        );

        let mut stts = fixed_file(count, 24);
        let stts_type = stts.windows(4).position(|bytes| bytes == b"stts").unwrap();
        stts[stts_type + 12..stts_type + 16].copy_from_slice(&(count + 1).to_be_bytes());
        assert_eq!(
            complete(stts, file_len, &mut track()).err(),
            Some(Error::Invalid)
        );

        let mut ctts = fixed_file(count, 24);
        ctts.extend_from_slice(&atom(b"ctts", &table_body(&[(count + 1, 0)])));
        assert_eq!(
            complete(ctts, file_len, &mut track()).err(),
            Some(Error::Invalid)
        );
    }

    #[test]
    fn packet_offsets_match_a_linear_scan_across_size_checkpoints_and_chunk_runs() {
        let chunk_sizes = [253u32, 5, 5, 300, 1];
        let chunk_offsets = [100u32, 4000, 5000, 6000, 12000];
        let count: u32 = chunk_sizes.iter().sum();
        let words = |values: &[u32]| {
            values
                .iter()
                .flat_map(|v| v.to_be_bytes())
                .collect::<Vec<_>>()
        };
        let stsc = words(&[0, 4, 1, 253, 1, 2, 5, 1, 4, 300, 1, 5, 1, 1]);
        let mut stco = words(&[0, chunk_offsets.len() as u32]);
        stco.extend(words(&chunk_offsets));
        for fixed in [0, 7] {
            let sizes: Vec<u32> = (0..count)
                .map(|i| if fixed == 0 { 1 + i % 17 } else { fixed })
                .collect();
            let mut stsz = words(&[0, fixed, count]);
            if fixed == 0 {
                stsz.extend(words(&sizes));
            }
            let raw = [
                atom(b"stsz", &stsz),
                atom(b"stco", &stco),
                atom(b"stsc", &stsc),
                atom(b"stts", &table_body(&[(255, 3), (count - 255, 7)])),
            ]
            .concat();
            let mut track = track();
            track.edit_shift = -19;
            let index = complete(raw, 13000, &mut track).unwrap();

            let mut sample = 0;
            let mut dts = track.edit_shift;
            for (samples, start) in chunk_sizes.into_iter().zip(chunk_offsets) {
                let mut offset = u64::from(start);
                for _ in 0..samples {
                    let size = sizes[sample as usize];
                    let delta = if sample < 255 { 3 } else { 7 };
                    let packet = index.packet(sample).unwrap();
                    assert_eq!(
                        (packet.offset, packet.size),
                        (offset, size),
                        "sample {sample}"
                    );
                    assert_eq!((packet.dts, packet.pts, packet.duration), (dts, dts, delta));
                    offset += u64::from(size);
                    dts += delta as i64;
                    sample += 1;
                }
            }
            assert_eq!(index.packet(count).err(), Some(Error::Invalid));
        }
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
                .map(|i| query_packet(&mut index, i).offset)
                .collect::<Vec<_>>(),
            [100, 103, 200, 300, 400, 407]
        );
        assert_eq!(
            (0..6)
                .map(|i| query_packet(&mut index, i).pts)
                .collect::<Vec<_>>(),
            [-20, 50, 30, 50, 50, 110]
        );
        assert_eq!(
            (0..6)
                .map(|i| query_packet(&mut index, i).duration)
                .collect::<Vec<_>>(),
            [50, 0, 20, 0, 60, 25]
        );
        assert_eq!(
            (0..6)
                .map(|i| query_packet(&mut index, i).key)
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
