// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Adapted from gifenc 1.0.3 src/pnnquant2.js (MIT), Copyright (c) 2017
// Matt DesLauriers; PNN origin Copyright (C) 2004-2019 Mark Tyler and
// Dmitry Groshev, and Copyright (c) 2018-2021 Miller Cy Chan.

use core::arch::wasm32::memory_size;
use core::cell::UnsafeCell;
use core::ptr::addr_of;

const BIN_COUNT: usize = 65_536;
const DELETED: u32 = (BIN_COUNT - 1) as u32;
const PAGE_BYTES: usize = 65_536;

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

struct State {
    bins: [Bin; BIN_COUNT],
    order: [u32; BIN_COUNT],
    heap: [u32; BIN_COUNT + 1],
    palette: [u8; 256 * 3],
    reserved_input_len: u32,
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
}));

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
    unsafe { (*STATE.0.get()).reserved_input_len = input_len };
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
    if state.reserved_input_len != input_len {
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
