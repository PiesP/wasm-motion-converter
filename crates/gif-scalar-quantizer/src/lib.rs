// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Adapted from gifenc 1.0.3 src/pnnquant2.js (MIT), Copyright (c) 2017
// Matt DesLauriers; PNN origin Copyright (C) 2004-2019 Mark Tyler and
// Dmitry Groshev, and Copyright (c) 2018-2021 Miller Cy Chan.
// The image-data encoder is adapted from gifenc 1.0.3 src/lzwEncode.js (MIT),
// Kevin Weiner, Thibault Imbert, Johan Nordberg and its credited contributors.

use core::arch::wasm32::memory_size;
use core::cell::UnsafeCell;
use core::ptr::addr_of;

const BIN_COUNT: usize = 65_536;
const DELETED: u32 = (BIN_COUNT - 1) as u32;
const PAGE_BYTES: usize = 65_536;
const LZW_HASH_SIZE: usize = 5003;
const LZW_MAX_CODE: u32 = 4096;
const MAX_RETAINED_GENERATION: u32 = (i32::MAX as u32) >> 2;
const BAYER_8X8: [i16; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// The field order keeps each bin at 64 bytes. All arithmetic stays f64 and in
// the same expression order as the locked gifenc RGB565 path.
#[derive(Clone, Copy)]
#[repr(C)]
struct Bin {
    rc: f64,
    gc: f64,
    bc: f64,
    cnt: f64,
    err: f64,
    nn: u32,
    fw: u32,
    bk: u32,
    tm: u32,
    mtm: u32,
    _padding: u32,
}

impl Bin {
    const EMPTY: Self = Self {
        rc: 0.0,
        gc: 0.0,
        bc: 0.0,
        cnt: 0.0,
        err: 0.0,
        nn: 0,
        fw: 0,
        bk: 0,
        tm: 0,
        mtm: 0,
        _padding: 0,
    };
}

#[derive(Clone, Copy)]
struct RetainedSlot {
    palette: [u8; 256 * 3],
    palette_len: u16,
    hash: i32,
    generation: u32,
    live: bool,
}

impl RetainedSlot {
    const EMPTY: Self = Self {
        palette: [0; 256 * 3],
        palette_len: 0,
        hash: 0,
        generation: 0,
        live: false,
    };
}

struct State {
    bins: [Bin; BIN_COUNT],
    order: [u32; BIN_COUNT],
    heap: [u32; BIN_COUNT + 1],
    palette: [u8; 256 * 3],
    reserved_input_len: u32,
    input_was_mapped: bool,
    input_prepared: bool,
    retained: [RetainedSlot; 3],
    retained_len: u32,
    retained_enabled: bool,
    generation: u32,
    global_palette: [u8; 256 * 3],
    global_len: u16,
}

struct ConversionState(UnsafeCell<State>);

// Each GIF conversion instantiates its own module and calls it serially, in
// the usual Worker route or the existing main-thread fallback. No threads,
// shared memory or references into State escape the ABI.
unsafe impl Sync for ConversionState {}

static STATE: ConversionState = ConversionState(UnsafeCell::new(State {
    bins: [Bin::EMPTY; BIN_COUNT],
    order: [0; BIN_COUNT],
    heap: [0; BIN_COUNT + 1],
    palette: [0; 256 * 3],
    reserved_input_len: 0,
    input_was_mapped: false,
    input_prepared: false,
    retained: [RetainedSlot::EMPTY; 3],
    retained_len: 0,
    retained_enabled: false,
    generation: 0,
    global_palette: [0; 256 * 3],
    global_len: 0,
}));

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    3
}

extern "C" {
    static __heap_base: u8;
}

#[inline]
fn input_start() -> usize {
    addr_of!(__heap_base) as usize
}

#[no_mangle]
pub extern "C" fn input_ptr() -> u32 {
    input_start() as u32
}

#[no_mangle]
pub extern "C" fn palette_ptr() -> u32 {
    unsafe { (*STATE.0.get()).palette.as_ptr() as u32 }
}

// JS grows memory after charging both old and new capacities to the existing
// Worker guard. This function checks that capacity; Rust never allocates input.
#[no_mangle]
pub extern "C" fn reserve_input(input_len: u32) -> i32 {
    let len = input_len as usize;
    if len == 0 || (len & 3) != 0 {
        return -1;
    }
    let Some(end) = input_start().checked_add(len) else {
        return -1;
    };
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.retained_enabled && (state.retained_len != input_len || state.retained[0].live) {
        return -1;
    }
    state.reserved_input_len = input_len;
    state.input_was_mapped = false;
    state.input_prepared = false;
    0
}

fn retained_end(input_len: u32) -> Option<usize> {
    if input_len == 0 || (input_len & 3) != 0 {
        return None;
    }
    let pixels = (input_len / 4) as usize;
    retained_ptr(2, pixels)?.checked_add(pixels)
}

#[no_mangle]
pub extern "C" fn retained_layout_end(input_len: u32) -> u32 {
    retained_end(input_len)
        .and_then(|end| u32::try_from(end).ok())
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn enable_retained(input_len: u32) -> i32 {
    let Some(end) = retained_end(input_len) else {
        return -1;
    };
    if end > u32::MAX as usize {
        return -1;
    }
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.retained_enabled
        || state.reserved_input_len != 0
        || state.retained.iter().any(|slot| slot.live)
    {
        return -1;
    }
    state.retained_len = input_len;
    state.retained_enabled = true;
    0
}

#[inline]
fn retained_ptr(slot: usize, pixels: usize) -> Option<usize> {
    match slot {
        0 => Some(input_start()),
        1 | 2 => {
            // For tiny frames the conservative LZW bound can extend past the
            // 4N RGBA arena. Keep both protected slots beyond that bound.
            let rgba_end = pixels.checked_mul(4)?;
            let image_end = pixels.checked_add(image_data_bound(u32::try_from(pixels).ok()?)?)?;
            input_start()
                .checked_add(rgba_end.max(image_end))?
                .checked_add(pixels.checked_mul(slot - 1)?)
        }
        _ => None,
    }
}

#[inline]
fn checked_slot(state: &State, handle: u32) -> Option<usize> {
    let slot = (handle & 3) as usize;
    let generation = handle >> 2;
    if slot < 3 && generation != 0 {
        let entry = &state.retained[slot];
        if entry.live && entry.generation == generation {
            return Some(slot);
        }
    }
    None
}

fn fresh_handle(state: &mut State, slot: usize) -> Option<i32> {
    if state.generation >= MAX_RETAINED_GENERATION {
        return None;
    }
    state.generation += 1;
    state.retained[slot].generation = state.generation;
    state.retained[slot].live = true;
    Some(((state.generation << 2) | slot as u32) as i32)
}

// Apply the locked JS 8x8 Bayer threshold after the host has made its one
// admitted RGBA copy. Signed integer division truncates toward zero, matching
// the Int8 LUT's `(value * strength / 64) | 0` for every supported strength.
#[no_mangle]
pub extern "C" fn prepare_rgba(input_len: u32, width: u32, height: u32, strength: u32) -> i32 {
    if input_len == 0
        || input_len as usize > isize::MAX as usize
        || width == 0
        || height == 0
        || strength > 255
    {
        return -1;
    }
    let Some(pixels) = width.checked_mul(height) else {
        return -1;
    };
    if pixels.checked_mul(4) != Some(input_len) {
        return -1;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.reserved_input_len != input_len || state.input_was_mapped || state.input_prepared {
        return -1;
    }
    let Some(end) = input_start().checked_add(input_len as usize) else {
        return -1;
    };
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    // The input arena begins at __heap_base and is disjoint from static State.
    // No input borrow survives this synchronous ABI call.
    let rgba =
        unsafe { core::slice::from_raw_parts_mut(input_start() as *mut u8, input_len as usize) };
    if strength != 0 {
        for y in 0..height as usize {
            for x in 0..width as usize {
                let threshold =
                    ((BAYER_8X8[(y & 7) * 8 + (x & 7)] - 32) as i32 * strength as i32) / 64;
                if threshold == 0 {
                    continue;
                }
                let offset = (y * width as usize + x) * 4;
                for channel in &mut rgba[offset..offset + 3] {
                    *channel = (*channel as i32 + threshold).clamp(0, 255) as u8;
                }
            }
        }
    }
    state.input_prepared = true;
    0
}

#[inline]
fn sqr(value: f64) -> f64 {
    value * value
}

#[inline]
fn at(state: &State, index: usize) -> &Bin {
    &state.bins[state.order[index] as usize]
}

#[inline]
fn at_mut(state: &mut State, index: usize) -> &mut Bin {
    &mut state.bins[state.order[index] as usize]
}

fn find_nearest(state: &mut State, index: usize) {
    let first = *at(state, index);
    let n1 = first.cnt;
    let wr = first.rc;
    let wg = first.gc;
    let wb = first.bc;
    let mut next = first.fw as usize;
    let mut nearest = 0;
    let mut err = 1e100;
    while next != 0 {
        let bin = *at(state, next);
        let n2 = bin.cnt;
        let nerr2 = (n1 * n2) / (n1 + n2);
        if nerr2 < err {
            let mut nerr = 0.0;
            nerr += nerr2 * sqr(bin.rc - wr);
            if nerr < err {
                nerr += nerr2 * sqr(bin.gc - wg);
                if nerr < err {
                    nerr += nerr2 * sqr(bin.bc - wb);
                    if nerr < err {
                        err = nerr;
                        nearest = next as u32;
                    }
                }
            }
        }
        next = bin.fw as usize;
    }
    let first = at_mut(state, index);
    first.err = err;
    first.nn = nearest;
}

#[inline]
fn rounded_channel(value: f64) -> u8 {
    // Histogram means and merged channels are finite and nonnegative. Compare
    // the fractional part directly so adding 0.5 cannot round a near-half up.
    let base = value.floor();
    let rounded = if value - base >= 0.5 {
        base + 1.0
    } else {
        base
    };
    rounded.clamp(0.0, 255.0) as u8
}

#[no_mangle]
pub extern "C" fn quantize(input_len: u32, colors: u32) -> i32 {
    if input_len == 0 || (input_len & 3) != 0 || !(1..=256).contains(&colors) {
        return -1;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.reserved_input_len != input_len || state.input_was_mapped {
        return -1;
    }
    let Some(end) = input_start().checked_add(input_len as usize) else {
        return -1;
    };
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    // The caller owns this disjoint region from __heap_base through end.
    let rgba =
        unsafe { core::slice::from_raw_parts(input_start() as *const u8, input_len as usize) };
    state.bins.fill(Bin::EMPTY);
    for pixel in rgba.chunks_exact(4) {
        let r = pixel[0] as usize;
        let g = pixel[1] as usize;
        let b = pixel[2] as usize;
        let key = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
        let bin = &mut state.bins[key];
        bin.rc += r as f64;
        bin.gc += g as f64;
        bin.bc += b as f64;
        bin.cnt += 1.0;
    }

    let mut maxbins = 0;
    for key in 0..BIN_COUNT {
        let bin = &mut state.bins[key];
        if bin.cnt != 0.0 {
            let d = 1.0 / bin.cnt;
            bin.rc *= d;
            bin.gc *= d;
            bin.bc *= d;
            state.order[maxbins] = key as u32;
            maxbins += 1;
        }
    }
    if maxbins == 0 {
        return -3;
    }
    let use_sqrt = sqr(colors as f64) / (maxbins as f64) >= 0.022;
    for index in 0..maxbins - 1 {
        at_mut(state, index).fw = (index + 1) as u32;
        at_mut(state, index + 1).bk = index as u32;
        if use_sqrt {
            let count = at(state, index).cnt;
            at_mut(state, index).cnt = count.sqrt();
        }
    }
    if use_sqrt {
        let count = at(state, maxbins - 1).cnt;
        at_mut(state, maxbins - 1).cnt = count.sqrt();
    }

    state.heap[0] = 0;
    for index in 0..maxbins {
        find_nearest(state, index);
        let err = at(state, index).err;
        state.heap[0] += 1;
        let mut slot = state.heap[0] as usize;
        while slot > 1 {
            let parent = slot >> 1;
            let h = state.heap[parent] as usize;
            if at(state, h).err <= err {
                break;
            }
            state.heap[slot] = h as u32;
            slot = parent;
        }
        state.heap[slot] = index as u32;
    }

    let extbins = maxbins.saturating_sub(colors as usize);
    let mut merged = 0;
    while merged < extbins {
        let mut b1;
        let tb;
        loop {
            b1 = state.heap[1] as usize;
            let current = *at(state, b1);
            if current.tm >= current.mtm && at(state, current.nn as usize).mtm <= current.tm {
                tb = b1;
                break;
            }
            if current.mtm == DELETED {
                b1 = state.heap[state.heap[0] as usize] as usize;
                state.heap[1] = b1 as u32;
                state.heap[0] -= 1;
            } else {
                find_nearest(state, b1);
                at_mut(state, b1).tm = merged as u32;
            }
            let err = at(state, b1).err;
            let mut slot = 1;
            loop {
                let mut child = slot + slot;
                if child > state.heap[0] as usize {
                    break;
                }
                if child < state.heap[0] as usize
                    && at(state, state.heap[child] as usize).err
                        > at(state, state.heap[child + 1] as usize).err
                {
                    child += 1;
                }
                let h = state.heap[child] as usize;
                if err <= at(state, h).err {
                    break;
                }
                state.heap[slot] = h as u32;
                slot = child;
            }
            state.heap[slot] = b1 as u32;
        }
        let current = *at(state, tb);
        let nb_index = current.nn as usize;
        let neighbor = *at(state, nb_index);
        let n1 = current.cnt;
        let n2 = neighbor.cnt;
        let d = 1.0 / (n1 + n2);
        let bin = at_mut(state, tb);
        bin.rc = d * (n1 * bin.rc + n2 * neighbor.rc);
        bin.gc = d * (n1 * bin.gc + n2 * neighbor.gc);
        bin.bc = d * (n1 * bin.bc + n2 * neighbor.bc);
        bin.cnt += neighbor.cnt;
        merged += 1;
        bin.mtm = merged as u32;
        at_mut(state, neighbor.bk as usize).fw = neighbor.fw;
        at_mut(state, neighbor.fw as usize).bk = neighbor.bk;
        at_mut(state, nb_index).mtm = DELETED;
    }

    let mut palette_len = 0;
    let mut index = 0;
    loop {
        let bin = *at(state, index);
        let color = [
            rounded_channel(bin.rc),
            rounded_channel(bin.gc),
            rounded_channel(bin.bc),
        ];
        let exists = state.palette[..palette_len * 3]
            .chunks_exact(3)
            .any(|prior| prior == color);
        if !exists {
            state.palette[palette_len * 3..palette_len * 3 + 3].copy_from_slice(&color);
            palette_len += 1;
        }
        index = bin.fw as usize;
        if index == 0 {
            break;
        }
    }
    palette_len as i32
}

#[inline]
fn indexed_start() -> usize {
    input_start()
}

#[no_mangle]
pub extern "C" fn indices_ptr() -> u32 {
    indexed_start() as u32
}

// The cache is deliberately keyed by the original first pixel in each RGB565
// bucket, not by a synthetic bucket center. A new frame clears every entry.
#[no_mangle]
pub extern "C" fn map_palette(input_len: u32, colors: u32) -> i32 {
    if input_len == 0 || (input_len & 3) != 0 || !(1..=256).contains(&colors) {
        return -1;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.reserved_input_len != input_len || state.input_was_mapped {
        return -1;
    }
    let count = (input_len / 4) as usize;
    let start = indexed_start();
    let Some(end) = input_start().checked_add(input_len as usize) else {
        return -1;
    };
    if end > u32::MAX as usize {
        return -1;
    }
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }

    // The output reuses the start of the RGBA region. For pixel i, the four
    // input bytes at 4*i..4*i+4 are read before byte i is overwritten; all
    // later pixels are untouched. Raw accesses avoid overlapping Rust slices.
    // State is disjoint from __heap_base and no quantizer borrow survives ABI.
    state.order.fill(u32::MAX);
    for pixel in 0..count {
        let offset = pixel * 4;
        let r = unsafe { *((start + offset) as *const u8) } as i32;
        let g = unsafe { *((start + offset + 1) as *const u8) } as i32;
        let b = unsafe { *((start + offset + 2) as *const u8) } as i32;
        let key = (((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3)) as usize;
        let cached = state.order[key];
        if cached != u32::MAX {
            unsafe { *((start + pixel) as *mut u8) = cached as u8 };
            continue;
        }
        let mut best = 0;
        let mut minimum = i32::MAX;
        for candidate in 0..colors as usize {
            let offset = candidate * 3;
            let dr = state.palette[offset] as i32 - r;
            let mut distance = dr * dr;
            if distance > minimum {
                continue;
            }
            let dg = state.palette[offset + 1] as i32 - g;
            distance += dg * dg;
            if distance > minimum {
                continue;
            }
            let db = state.palette[offset + 2] as i32 - b;
            distance += db * db;
            if distance > minimum {
                continue;
            }
            // gifenc's internal RGB mapper accepts equality, so the last
            // palette entry at an equal distance wins.
            minimum = distance;
            best = candidate;
        }
        state.order[key] = best as u32;
        unsafe { *((start + pixel) as *mut u8) = best as u8 };
    }
    state.input_was_mapped = true;
    count as i32
}

// The mapped indexes still occupy the first N bytes of the RGBA arena. Keep
// this transient candidate until the host either discards it or promotes it
// into one of two protected slots before admitting the next input frame.
#[no_mangle]
pub extern "C" fn map_retained(input_len: u32, colors: u32) -> i32 {
    {
        let state = unsafe { &*STATE.0.get() };
        if !state.retained_enabled || state.retained_len != input_len || state.retained[0].live {
            return -1;
        }
        if state.generation >= MAX_RETAINED_GENERATION {
            return -1;
        }
    }
    let mapped = map_palette(input_len, colors);
    if mapped < 0 {
        return mapped;
    }
    let state = unsafe { &mut *STATE.0.get() };
    let count = mapped as usize;
    let mut compact = [0u8; 256 * 3];
    let mut compact_len = 0usize;
    let mut old_to_new = [u16::MAX; 256];
    let mut hash = 0x811c9dc5u32;
    for pixel in 0..count {
        let pointer = input_start() + pixel;
        let old_index = unsafe { *(pointer as *const u8) } as usize;
        if old_index >= colors as usize {
            return -3;
        }
        let color = &state.palette[old_index * 3..old_index * 3 + 3];
        let packed = ((color[0] as u32) << 16) | ((color[1] as u32) << 8) | color[2] as u32;
        let mut new_index = old_to_new[old_index];
        if new_index == u16::MAX {
            new_index = (0..compact_len)
                .find(|&index| compact[index * 3..index * 3 + 3] == *color)
                .map(|index| index as u16)
                .unwrap_or_else(|| {
                    let index = compact_len;
                    compact[index * 3..index * 3 + 3].copy_from_slice(color);
                    compact_len += 1;
                    index as u16
                });
            old_to_new[old_index] = new_index;
        }
        unsafe { *(pointer as *mut u8) = new_index as u8 };
        hash = (hash ^ packed).wrapping_mul(0x0100_0193);
    }
    state.retained[0].palette = compact;
    state.retained[0].palette_len = compact_len as u16;
    state.retained[0].hash = hash as i32;
    fresh_handle(state, 0).unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn promote_retained(handle: u32) -> i32 {
    let state = unsafe { &mut *STATE.0.get() };
    if checked_slot(state, handle) != Some(0) || !state.retained_enabled {
        return -1;
    }
    let Some(slot) = (1..=2).find(|&slot| !state.retained[slot].live) else {
        return -2;
    };
    if state.generation >= MAX_RETAINED_GENERATION {
        return -1;
    }
    let pixels = (state.retained_len / 4) as usize;
    let Some(end) = retained_ptr(slot, pixels).and_then(|start| start.checked_add(pixels)) else {
        return -1;
    };
    if end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(
            input_start() as *const u8,
            retained_ptr(slot, pixels).unwrap() as *mut u8,
            pixels,
        );
    }
    state.retained[slot] = state.retained[0];
    state.retained[0].live = false;
    fresh_handle(state, slot).unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn release_retained(handle: u32) -> i32 {
    let state = unsafe { &mut *STATE.0.get() };
    let Some(slot) = checked_slot(state, handle) else {
        return -1;
    };
    state.retained[slot].live = false;
    0
}

#[no_mangle]
pub extern "C" fn retained_palette_len(handle: u32) -> i32 {
    let state = unsafe { &*STATE.0.get() };
    checked_slot(state, handle)
        .map(|slot| state.retained[slot].palette_len as i32)
        .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn retained_palette_ptr(handle: u32) -> u32 {
    let state = unsafe { &*STATE.0.get() };
    checked_slot(state, handle)
        .map(|slot| state.retained[slot].palette.as_ptr() as u32)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn retained_hash(handle: u32) -> i32 {
    let state = unsafe { &*STATE.0.get() };
    checked_slot(state, handle)
        .map(|slot| state.retained[slot].hash)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn same_retained_pixels(first: u32, second: u32) -> i32 {
    let state = unsafe { &*STATE.0.get() };
    let (Some(a), Some(b)) = (checked_slot(state, first), checked_slot(state, second)) else {
        return -1;
    };
    if state.retained[a].hash != state.retained[b].hash {
        return 0;
    }
    let pixels = (state.retained_len / 4) as usize;
    let (Some(a_ptr), Some(b_ptr)) = (retained_ptr(a, pixels), retained_ptr(b, pixels)) else {
        return -1;
    };
    for pixel in 0..pixels {
        let a_index = unsafe { *((a_ptr + pixel) as *const u8) } as usize;
        let b_index = unsafe { *((b_ptr + pixel) as *const u8) } as usize;
        if a_index >= state.retained[a].palette_len as usize
            || b_index >= state.retained[b].palette_len as usize
        {
            return -1;
        }
        if state.retained[a].palette[a_index * 3..a_index * 3 + 3]
            != state.retained[b].palette[b_index * 3..b_index * 3 + 3]
        {
            return 0;
        }
    }
    1
}

fn palette_depth(len: usize) -> u32 {
    (usize::BITS - (len.max(2) - 1).leading_zeros()).max(2)
}

#[no_mangle]
pub extern "C" fn capture_global_palette(handle: u32) -> i32 {
    let state = unsafe { &mut *STATE.0.get() };
    let Some(slot) = checked_slot(state, handle) else {
        return -1;
    };
    if state.global_len != 0 {
        return -1;
    }
    state.global_len = state.retained[slot].palette_len;
    state.global_palette = state.retained[slot].palette;
    0
}

#[no_mangle]
pub extern "C" fn remap_retained_global(handle: u32) -> i32 {
    let state = unsafe { &mut *STATE.0.get() };
    let Some(slot) = checked_slot(state, handle) else {
        return -1;
    };
    let local_len = state.retained[slot].palette_len as usize;
    let global_len = state.global_len as usize;
    if slot == 0 || global_len == 0 || palette_depth(local_len) != palette_depth(global_len) {
        return 0;
    }
    let mut remap = [0u8; 256];
    for (local, target) in remap.iter_mut().enumerate().take(local_len) {
        let color = &state.retained[slot].palette[local * 3..local * 3 + 3];
        let Some(global) =
            (0..global_len).find(|&index| state.global_palette[index * 3..index * 3 + 3] == *color)
        else {
            return 0;
        };
        *target = global as u8;
    }
    let pixels = (state.retained_len / 4) as usize;
    let Some(pointer) = retained_ptr(slot, pixels) else {
        return -1;
    };
    for pixel in 0..pixels {
        let old = unsafe { *((pointer + pixel) as *const u8) } as usize;
        if old >= local_len {
            return -1;
        }
        unsafe { *((pointer + pixel) as *mut u8) = remap[old] };
    }
    // The frame now references the global palette. Its expanded colors and
    // pre-remap FNV hash remain identical.
    state.retained[slot].palette = state.global_palette;
    state.retained[slot].palette_len = state.global_len;
    1
}

fn image_data_bound(pixel_count: u32) -> Option<usize> {
    if pixel_count == 0 {
        return None;
    }
    let pixels = pixel_count as usize;
    // Every input pixel produces at most one ordinary code. A full table can
    // cause one extra clear only after at least 3838 misses (depth 8 is the
    // worst case). All codes fit in 12 bits. Count packet sizes separately.
    let clears = pixels.checked_add(3837)?.checked_div(3838)?;
    let codes = pixels.checked_add(clears)?.checked_add(3)?;
    let packed = codes.checked_mul(12)?.checked_add(7)?.checked_div(8)?;
    let blocks = packed.checked_add(253)?.checked_div(254)?;
    packed.checked_add(blocks)?.checked_add(2)
}

#[no_mangle]
pub extern "C" fn lzw_bound(pixel_count: u32) -> u32 {
    image_data_bound(pixel_count)
        .and_then(|bound| u32::try_from(bound).ok())
        .unwrap_or(0)
}

fn image_data_start(input_len: usize) -> Option<usize> {
    input_start().checked_add(input_len / 4)
}

#[no_mangle]
pub extern "C" fn lzw_output_ptr() -> u32 {
    let input_len = unsafe { (*STATE.0.get()).reserved_input_len as usize };
    image_data_start(input_len)
        .and_then(|start| u32::try_from(start).ok())
        .unwrap_or(0)
}

struct ImageDataWriter<'a> {
    bytes: &'a mut [u8],
    written: usize,
    packet: [u8; 254],
    packet_len: usize,
    accumulator: u32,
    bits: u32,
    code_bits: u32,
    max_code: u32,
    clear_pending: bool,
    initial_bits: u32,
    free_entry: u32,
}

impl ImageDataWriter<'_> {
    fn byte(&mut self, byte: u8) -> Result<(), ()> {
        let Some(slot) = self.bytes.get_mut(self.written) else {
            return Err(());
        };
        *slot = byte;
        self.written += 1;
        Ok(())
    }

    fn packet_byte(&mut self, byte: u8) -> Result<(), ()> {
        self.packet[self.packet_len] = byte;
        self.packet_len += 1;
        if self.packet_len == 254 {
            self.flush_packet()?;
        }
        Ok(())
    }

    fn flush_packet(&mut self) -> Result<(), ()> {
        if self.packet_len != 0 {
            self.byte(self.packet_len as u8)?;
            let end = self.written.checked_add(self.packet_len).ok_or(())?;
            let target = self.bytes.get_mut(self.written..end).ok_or(())?;
            target.copy_from_slice(&self.packet[..self.packet_len]);
            self.written = end;
            self.packet_len = 0;
        }
        Ok(())
    }

    fn code(&mut self, code: u32, end_code: u32) -> Result<(), ()> {
        self.accumulator &= (1 << self.bits) - 1;
        self.accumulator |= code << self.bits;
        self.bits += self.code_bits;
        while self.bits >= 8 {
            self.packet_byte(self.accumulator as u8)?;
            self.accumulator >>= 8;
            self.bits -= 8;
        }
        if self.free_entry > self.max_code || self.clear_pending {
            if self.clear_pending {
                self.code_bits = self.initial_bits;
                self.max_code = (1 << self.code_bits) - 1;
                self.clear_pending = false;
            } else {
                self.code_bits += 1;
                self.max_code = if self.code_bits == 12 {
                    LZW_MAX_CODE
                } else {
                    (1 << self.code_bits) - 1
                };
            }
        }
        if code == end_code {
            while self.bits > 0 {
                self.packet_byte(self.accumulator as u8)?;
                self.accumulator >>= 8;
                self.bits = self.bits.saturating_sub(8);
            }
            self.flush_packet()?;
        }
        Ok(())
    }
}

#[no_mangle]
pub extern "C" fn lzw_encode(pixel_count: u32, depth: u32, output_capacity: u32) -> i32 {
    let state = unsafe { &*STATE.0.get() };
    let input_len = state.reserved_input_len as usize;
    if input_len == 0 || (input_len & 3) != 0 || pixel_count as usize != input_len / 4 {
        return -1;
    }
    lzw_encode_from(indexed_start(), pixel_count, depth, output_capacity)
}

#[no_mangle]
pub extern "C" fn lzw_encode_retained(handle: u32, depth: u32, output_capacity: u32) -> i32 {
    let state = unsafe { &*STATE.0.get() };
    let Some(slot) = checked_slot(state, handle) else {
        return -1;
    };
    if !state.retained_enabled || slot == 0 || state.reserved_input_len != state.retained_len {
        return -1;
    }
    let pixels = state.retained_len / 4;
    let bound = lzw_bound(pixels);
    if bound == 0 || output_capacity > bound {
        return -1;
    }
    let Some(pointer) = retained_ptr(slot, pixels as usize) else {
        return -1;
    };
    lzw_encode_from(pointer, pixels, depth, output_capacity)
}

fn lzw_encode_from(index_start: usize, pixel_count: u32, depth: u32, output_capacity: u32) -> i32 {
    if pixel_count == 0 || !(2..=8).contains(&depth) || output_capacity == 0 {
        return -1;
    }
    let state = unsafe { &mut *STATE.0.get() };
    let input_len = state.reserved_input_len as usize;
    let Some(index_end) = index_start.checked_add(pixel_count as usize) else {
        return -1;
    };
    let Some(output_start) = image_data_start(input_len) else {
        return -1;
    };
    let Some(output_end) = output_start.checked_add(output_capacity as usize) else {
        return -1;
    };
    if output_end > u32::MAX as usize || (output_start < index_end && output_end > index_start) {
        return -1;
    }
    if index_end > memory_size::<0>() * PAGE_BYTES || output_end > memory_size::<0>() * PAGE_BYTES {
        return -2;
    }
    // No reference to these disjoint ABI ranges escapes this synchronous call.
    // The static hash/code arrays are reused only after quantize/map_palette.
    let indices =
        unsafe { core::slice::from_raw_parts(index_start as *const u8, pixel_count as usize) };
    if indices.iter().any(|&index| index as u32 >= (1 << depth)) {
        return -1;
    }
    let output = unsafe {
        core::slice::from_raw_parts_mut(output_start as *mut u8, output_capacity as usize)
    };
    state.order[..LZW_HASH_SIZE].fill(u32::MAX);
    state.heap[..LZW_HASH_SIZE].fill(0);
    let initial_bits = depth + 1;
    let clear_code = 1 << depth;
    let end_code = clear_code + 1;
    let mut writer = ImageDataWriter {
        bytes: output,
        written: 0,
        packet: [0; 254],
        packet_len: 0,
        accumulator: 0,
        bits: 0,
        code_bits: initial_bits,
        max_code: (1 << initial_bits) - 1,
        clear_pending: false,
        initial_bits,
        free_entry: clear_code + 2,
    };
    if writer.byte(depth as u8).is_err() || writer.code(clear_code, end_code).is_err() {
        return -2;
    }
    let mut entry = indices[0] as u32;
    let mut hash_shift = 0;
    let mut hash_size = LZW_HASH_SIZE;
    while hash_size < 65_536 {
        hash_shift += 1;
        hash_size *= 2;
    }
    hash_shift = 8 - hash_shift;
    for &character in &indices[1..] {
        let character = character as u32;
        let key = (character << 12) + entry;
        let mut slot = ((character << hash_shift) ^ entry) as usize;
        if state.order[slot] == key {
            entry = state.heap[slot];
            continue;
        }
        let displacement = if slot == 0 { 1 } else { LZW_HASH_SIZE - slot };
        let mut found = false;
        while state.order[slot] != u32::MAX {
            slot = if slot < displacement {
                slot + LZW_HASH_SIZE - displacement
            } else {
                slot - displacement
            };
            if state.order[slot] == key {
                entry = state.heap[slot];
                found = true;
                break;
            }
        }
        if found {
            continue;
        }
        if writer.code(entry, end_code).is_err() {
            return -2;
        }
        entry = character;
        if writer.free_entry < LZW_MAX_CODE {
            state.heap[slot] = writer.free_entry;
            writer.free_entry += 1;
            state.order[slot] = key;
        } else {
            state.order[..LZW_HASH_SIZE].fill(u32::MAX);
            writer.free_entry = clear_code + 2;
            writer.clear_pending = true;
            if writer.code(clear_code, end_code).is_err() {
                return -2;
            }
        }
    }
    if writer.code(entry, end_code).is_err()
        || writer.code(end_code, end_code).is_err()
        || writer.byte(0).is_err()
    {
        return -2;
    }
    writer.written as i32
}
