// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

use core::arch::wasm32::memory_size;
use core::cell::UnsafeCell;
use core::ptr::addr_of;

mod lzw;
mod mapper;
mod palette;

use lzw::{encode_lzw, LzwError, LzwScratch};

use mapper::{map_in_place, MapperScratch};
use palette::{build_palette, PaletteMethod, PaletteScratch};

const PAGE_BYTES: usize = 65_536;
const MAX_RETAINED_GENERATION: u32 = (i32::MAX as u32) >> 2;
const BAYER_8X8: [i16; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

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

#[repr(C)]
struct RetainedResult {
    status: i32,
    handle: u32,
}

impl RetainedResult {
    const EMPTY: Self = Self {
        status: 0,
        handle: 0,
    };
}

struct State {
    scratch: PaletteScratch,
    mapper: MapperScratch,
    lzw: LzwScratch,
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
    retained_result: RetainedResult,
}

struct ConversionState(UnsafeCell<State>);

// Each GIF conversion instantiates its own module and calls it serially, in
// the usual Worker route or the existing main-thread fallback. No threads,
// shared memory or references into State escape the ABI.
unsafe impl Sync for ConversionState {}

static STATE: ConversionState = ConversionState(UnsafeCell::new(State {
    scratch: PaletteScratch::EMPTY,
    mapper: MapperScratch::EMPTY,
    lzw: LzwScratch::EMPTY,
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
    retained_result: RetainedResult::EMPTY,
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

fn fresh_handle(state: &mut State, slot: usize) -> Option<u32> {
    if state.generation >= MAX_RETAINED_GENERATION {
        return None;
    }
    state.generation += 1;
    state.retained[slot].generation = state.generation;
    state.retained[slot].live = true;
    Some((state.generation << 2) | slot as u32)
}

#[inline]
fn record_retained_result(state: &mut State, status: i32, handle: u32) -> i32 {
    state.retained_result = RetainedResult {
        status,
        handle: if status == 0 { handle } else { 0 },
    };
    status
}

#[no_mangle]
pub extern "C" fn retained_result_ptr() -> u32 {
    unsafe { core::ptr::addr_of!((*STATE.0.get()).retained_result) as u32 }
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
        let offsets = BAYER_8X8.map(|b| (i32::from(b - 32) * strength as i32) / 64);
        for (y, row) in rgba.chunks_exact_mut(width as usize * 4).enumerate() {
            let phases = &offsets[(y & 7) * 8..(y & 7) * 8 + 8];
            for block in row.chunks_mut(8 * 4) {
                for (px, &delta) in block.as_chunks_mut::<4>().0.iter_mut().zip(phases) {
                    if delta != 0 {
                        for c in &mut px[..3] {
                            *c = (i32::from(*c) + delta).clamp(0, 255) as u8;
                        }
                    }
                }
            }
        }
    }
    state.input_prepared = true;
    0
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
    build_palette(
        rgba,
        colors as usize,
        &mut state.palette,
        &mut state.scratch,
        PaletteMethod::Variance,
    )
    .map_or(-1, |count| count as i32)
}

#[inline]
fn indexed_start() -> usize {
    input_start()
}

#[no_mangle]
pub extern "C" fn indices_ptr() -> u32 {
    indexed_start() as u32
}

// The fixed-palette ABI caches the first pixel in each five-bit R/G/B cell.
// Preserve its green mask and last-index tie rule on both mapping paths.
#[no_mangle]
pub extern "C" fn map_palette(input_len: u32, colors: u32) -> i32 {
    if input_len == 0 || (input_len & 3) != 0 || !(1..=256).contains(&colors) {
        return -1;
    }
    let state = unsafe { &mut *STATE.0.get() };
    if state.reserved_input_len != input_len || state.input_was_mapped {
        return -1;
    }
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

    // reserve_input validated the caller-owned arena. Its unique mutable view is
    // disjoint from the palette and static mapper scratch and ends inside this call.
    let rgba = unsafe { core::slice::from_raw_parts_mut(start as *mut u8, input_len as usize) };
    let Some(count) = map_in_place(
        rgba,
        &state.palette[..colors as usize * 3],
        &mut state.mapper,
    ) else {
        return -1;
    };
    state.input_was_mapped = true;
    count as i32
}

// The mapped indexes still occupy the first N bytes of the RGBA arena. Keep
// this transient candidate until the host either discards it or promotes it
// into one of two protected slots before admitting the next input frame.
#[no_mangle]
pub extern "C" fn map_retained(input_len: u32, colors: u32) -> i32 {
    {
        let state = unsafe { &mut *STATE.0.get() };
        state.retained_result = RetainedResult::EMPTY;
        if !state.retained_enabled || state.retained_len != input_len || state.retained[0].live {
            return record_retained_result(state, -1, 0);
        }
        if state.generation >= MAX_RETAINED_GENERATION {
            return record_retained_result(state, -1, 0);
        }
    }
    let mapped = map_palette(input_len, colors);
    if mapped < 0 {
        return record_retained_result(unsafe { &mut *STATE.0.get() }, mapped, 0);
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
            return record_retained_result(state, -3, 0);
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
    match fresh_handle(state, 0) {
        Some(handle) => record_retained_result(state, 0, handle),
        None => record_retained_result(state, -1, 0),
    }
}

#[no_mangle]
pub extern "C" fn promote_retained(handle: u32) -> i32 {
    let state = unsafe { &mut *STATE.0.get() };
    state.retained_result = RetainedResult::EMPTY;
    if checked_slot(state, handle) != Some(0) || !state.retained_enabled {
        return record_retained_result(state, -1, 0);
    }
    let Some(slot) = (1..=2).find(|&slot| !state.retained[slot].live) else {
        return record_retained_result(state, -2, 0);
    };
    if state.generation >= MAX_RETAINED_GENERATION {
        return record_retained_result(state, -1, 0);
    }
    let pixels = (state.retained_len / 4) as usize;
    let Some(end) = retained_ptr(slot, pixels).and_then(|start| start.checked_add(pixels)) else {
        return record_retained_result(state, -1, 0);
    };
    if end > memory_size::<0>() * PAGE_BYTES {
        return record_retained_result(state, -2, 0);
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
    match fresh_handle(state, slot) {
        Some(handle) => record_retained_result(state, 0, handle),
        None => record_retained_result(state, -1, 0),
    }
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
    let indices =
        unsafe { core::slice::from_raw_parts(index_start as *const u8, pixel_count as usize) };
    let output = unsafe {
        core::slice::from_raw_parts_mut(output_start as *mut u8, output_capacity as usize)
    };
    match encode_lzw(indices, depth as u8, output, &mut state.lzw) {
        Ok(length) => length as i32,
        Err(LzwError::InvalidDepth | LzwError::InvalidIndex) => -1,
        Err(LzwError::OutputTooSmall) => -2,
    }
}
