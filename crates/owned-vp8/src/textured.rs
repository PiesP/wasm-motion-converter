// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{
    bmode_probs::BMODE_PROBS,
    prediction::{self, LargeMode, SmallMode},
    rate::{BoolSink, RateCounter},
    residual, transform,
};

#[derive(Default)]
struct Macroblock {
    y: [[i16; 16]; 16],
    y2: [i16; 16],
    i16: bool,
    y_mode: u8,
    b_modes: [u8; 16],
    uv_mode: u8,
    u: [[i16; 16]; 4],
    v: [[i16; 16]; 4],
}

fn allocated(size: usize) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| EncodeError::OutputLimit)?;
    bytes.resize(size, 0);
    Ok(bytes)
}

fn clamp(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}
fn yuv_from_rgb(r: i32, g: i32, b: i32) -> (u8, u8, u8) {
    // Fixed-point limited-range BT.601-like transform. This is an experiment:
    // the exact product Canvas color contract still requires qualification.
    (
        clamp(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16),
        clamp(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128),
        clamp(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128),
    )
}

#[cfg(test)]
fn predictor_y(reconstructed: &[u8], stride: usize, x: usize, y: usize) -> i32 {
    let mut sum = 4;
    for i in 0..4 {
        sum += if y == 0 {
            127
        } else {
            i32::from(reconstructed[(y - 1) * stride + x + i])
        };
        sum += if x == 0 {
            129
        } else {
            i32::from(reconstructed[(y + i) * stride + x - 1])
        };
    }
    sum >> 3
}

#[cfg(test)]
fn predictor_dc(reconstructed: &[u8], stride: usize, x: usize, y: usize, size: usize) -> i32 {
    if x == 0 && y == 0 {
        return 128;
    }
    let mut sum = 0;
    let mut count = 0;
    if y > 0 {
        for i in 0..size {
            sum += i32::from(reconstructed[(y - 1) * stride + x + i]);
        }
        count += size as i32;
    }
    if x > 0 {
        for i in 0..size {
            sum += i32::from(reconstructed[(y + i) * stride + x - 1]);
        }
        count += size as i32;
    }
    (sum + count / 2) / count
}

fn code_predicted_block(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    steps: Steps,
) -> ([i16; 16], [u8; 16]) {
    let mut residual = [0i16; 16];
    for row in 0..4 {
        for col in 0..4 {
            residual[row * 4 + col] = (i32::from(source[(y + row) * stride + x + col])
                - i32::from(predictor[row * 4 + col])) as i16;
        }
    }
    let transformed = transform::forward(&residual);
    let coefficients = ac_quant::quantize_block(&transformed, steps);
    let inverse = transform::inverse(&ac_quant::dequantize_block(&coefficients, steps));
    let mut reconstructed = [0u8; 16];
    for i in 0..16 {
        reconstructed[i] = clamp(i32::from(predictor[i]) + i32::from(inverse[i]));
    }
    (coefficients, reconstructed)
}

fn store_patch<const N: usize, const LEN: usize>(
    tile: &mut [u8; LEN],
    bx: usize,
    by: usize,
    patch: &[u8; 16],
) {
    for row in 0..4 {
        tile[(by * 4 + row) * N + bx * 4..(by * 4 + row) * N + bx * 4 + 4]
            .copy_from_slice(&patch[row * 4..row * 4 + 4]);
    }
}

fn prediction_patch<const N: usize, const LEN: usize>(
    tile: &[u8; LEN],
    bx: usize,
    by: usize,
) -> [u8; 16] {
    let mut result = [0; 16];
    for row in 0..4 {
        result[row * 4..row * 4 + 4]
            .copy_from_slice(&tile[(by * 4 + row) * N + bx * 4..(by * 4 + row) * N + bx * 4 + 4]);
    }
    result
}

fn edge<const N: usize>(
    reconstructed: &[u8],
    stride: usize,
    x: usize,
    y: usize,
) -> ([u8; N], [u8; N], u8) {
    let mut top = [127; N];
    let mut left = [129; N];
    if y > 0 {
        for (i, value) in top.iter_mut().enumerate() {
            *value = reconstructed[(y - 1) * stride + x + i];
        }
    }
    if x > 0 {
        for (i, value) in left.iter_mut().enumerate() {
            *value = reconstructed[(y + i) * stride + x - 1];
        }
    }
    let corner = if x == 0 && y == 0 {
        127
    } else if x > 0 && y > 0 {
        reconstructed[(y - 1) * stride + x - 1]
    } else if x == 0 {
        129
    } else {
        127
    };
    (top, left, corner)
}

fn mode_from_u8(mode: u8) -> LargeMode {
    match mode {
        0 => LargeMode::Dc,
        1 => LargeMode::Vertical,
        2 => LargeMode::Horizontal,
        _ => LargeMode::TrueMotion,
    }
}
fn bmode_from_u8(mode: u8) -> SmallMode {
    match mode {
        0 => SmallMode::Dc,
        1 => SmallMode::TrueMotion,
        2 => SmallMode::VerticalEdge,
        _ => SmallMode::HorizontalEdge,
    }
}
fn derived_bmode(mode: u8) -> u8 {
    match mode {
        1 => 2,
        2 => 3,
        3 => 1,
        _ => 0,
    }
}

fn write_y_mode(sink: &mut impl BoolSink, i16: bool, mode: u8) -> Result<(), EncodeError> {
    sink.write(145, i16)?;
    if i16 {
        sink.write(156, mode >= 2)?;
        sink.write(if mode < 2 { 163 } else { 128 }, mode == 1 || mode == 3)?;
        // kf_ymode_tree uses 100/101/110/111.
    }
    Ok(())
}
fn write_uv_mode(sink: &mut impl BoolSink, mode: u8) -> Result<(), EncodeError> {
    sink.write(142, mode != 0)?;
    if mode != 0 {
        sink.write(114, mode >= 2)?;
        if mode >= 2 {
            sink.write(183, mode == 3)?;
        }
    }
    Ok(())
}
fn write_bmode(sink: &mut impl BoolSink, above: u8, left: u8, mode: u8) -> Result<(), EncodeError> {
    let probs = BMODE_PROBS[above as usize][left as usize];
    sink.write(probs[0], mode != 0)?;
    if mode != 0 {
        sink.write(probs[1], mode != 1)?;
        if mode != 1 {
            sink.write(probs[2], mode != 2)?;
            if mode != 2 {
                sink.write(probs[3], false)?; // B_HE = 11100.
                sink.write(probs[4], false)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
struct CoeffContexts {
    y2: Vec<bool>,
    y: Vec<bool>,
    u: Vec<bool>,
    v: Vec<bool>,
    left_y2: bool,
    left_y: [bool; 4],
    left_u: [bool; 2],
    left_v: [bool; 2],
}
impl CoeffContexts {
    fn new(blocks_x: usize) -> Self {
        Self {
            y2: vec![false; blocks_x],
            y: vec![false; blocks_x * 4],
            u: vec![false; blocks_x * 2],
            v: vec![false; blocks_x * 2],
            left_y2: false,
            left_y: [false; 4],
            left_u: [false; 2],
            left_v: [false; 2],
        }
    }
    fn row(&mut self) {
        self.left_y2 = false;
        self.left_y.fill(false);
        self.left_u.fill(false);
        self.left_v.fill(false);
    }
    fn measure(&self, block: &Macroblock, mx: usize) -> Result<u64, EncodeError> {
        let mut copy = self.clone();
        let mut rate = RateCounter::default();
        copy.encode_coefficients(&mut rate, block, mx)?;
        Ok(rate.cost)
    }
    fn encode_coefficients(
        &mut self,
        sink: &mut impl BoolSink,
        block: &Macroblock,
        mx: usize,
    ) -> Result<(), EncodeError> {
        let skip = block.skip();
        if skip {
            if block.i16 {
                self.y2[mx] = false;
                self.left_y2 = false;
            }
            self.y[mx * 4..mx * 4 + 4].fill(false);
            self.u[mx * 2..mx * 2 + 2].fill(false);
            self.v[mx * 2..mx * 2 + 2].fill(false);
            self.left_y.fill(false);
            self.left_u.fill(false);
            self.left_v.fill(false);
            return Ok(());
        }
        if block.i16 {
            let context = usize::from(self.y2[mx]) + usize::from(self.left_y2);
            let nonzero = residual::encode_block(sink, &block.y2, 1, context)?;
            self.y2[mx] = nonzero;
            self.left_y2 = nonzero;
        }
        encode_macroblock_coeffs(
            sink,
            &block.y,
            if block.i16 { 0 } else { 3 },
            &mut self.y,
            &mut self.left_y,
            mx,
            4,
        )?;
        encode_macroblock_coeffs(sink, &block.u, 2, &mut self.u, &mut self.left_u, mx, 2)?;
        encode_macroblock_coeffs(sink, &block.v, 2, &mut self.v, &mut self.left_v, mx, 2)?;
        Ok(())
    }
}
impl Macroblock {
    fn skip(&self) -> bool {
        self.y
            .iter()
            .chain(&self.u)
            .chain(&self.v)
            .all(|v| v.iter().all(|&c| c == 0))
            && self.y2.iter().all(|&c| c == 0)
    }
}

struct LumaCandidate {
    block: Macroblock,
    tile: [u8; 256],
    distortion: u64,
}
struct UvCandidate {
    u: [[i16; 16]; 4],
    v: [[i16; 16]; 4],
    u_tile: [u8; 64],
    v_tile: [u8; 64],
    distortion: u64,
}

fn squared_error<const N: usize, const LEN: usize>(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    tile: &[u8; LEN],
) -> u64 {
    let mut result = 0u64;
    for row in 0..N {
        for col in 0..N {
            let diff =
                i32::from(source[(y + row) * stride + x + col]) - i32::from(tile[row * N + col]);
            result += (diff * diff) as u64;
        }
    }
    result
}
fn commit_tile<const N: usize, const LEN: usize>(
    destination: &mut [u8],
    stride: usize,
    x: usize,
    y: usize,
    tile: &[u8; LEN],
) {
    for row in 0..N {
        destination[(y + row) * stride + x..(y + row) * stride + x + N]
            .copy_from_slice(&tile[row * N..row * N + N]);
    }
}

// Keep plane and tile coordinates explicit while trials borrow committed state.
#[allow(clippy::too_many_arguments)]
fn make_i16(
    source: &[u8],
    reconstructed: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    mode: u8,
    y_steps: Steps,
    y2_steps: Steps,
) -> LumaCandidate {
    let (top, left, corner) = edge::<16>(reconstructed, stride, x, y);
    let predicted =
        prediction::predict_large(&top, &left, corner, y > 0, x > 0, mode_from_u8(mode));
    let mut block = Macroblock {
        i16: true,
        y_mode: mode,
        ..Macroblock::default()
    };
    let mut dc = [0i16; 16];
    for by in 0..4 {
        for bx in 0..4 {
            let index = by * 4 + bx;
            let pred = prediction_patch::<16, 256>(&predicted, bx, by);
            let mut samples = [0i16; 16];
            for row in 0..4 {
                for col in 0..4 {
                    samples[row * 4 + col] =
                        (i32::from(source[(y + by * 4 + row) * stride + x + bx * 4 + col])
                            - i32::from(pred[row * 4 + col])) as i16;
                }
            }
            let mut transformed = transform::forward(&samples);
            dc[index] = transformed[0] as i16;
            transformed[0] = 0;
            block.y[index] = ac_quant::quantize_block(&transformed, y_steps);
        }
    }
    block.y2 = ac_quant::quantize_block(&transform::forward_wht(&dc), y2_steps);
    let dc = transform::inverse_wht(&ac_quant::dequantize_block(&block.y2, y2_steps));
    let mut tile = [0u8; 256];
    for by in 0..4 {
        for bx in 0..4 {
            let index = by * 4 + bx;
            let mut dequantized = ac_quant::dequantize_block(&block.y[index], y_steps);
            dequantized[0] = i32::from(dc[index]);
            let inverse = transform::inverse(&dequantized);
            for row in 0..4 {
                for col in 0..4 {
                    let local = (by * 4 + row) * 16 + bx * 4 + col;
                    tile[local] =
                        clamp(i32::from(predicted[local]) + i32::from(inverse[row * 4 + col]));
                }
            }
        }
    }
    LumaCandidate {
        block,
        tile,
        distortion: squared_error::<16, 256>(source, stride, x, y, &tile),
    }
}

fn i4_edge(
    global: &[u8],
    tile: &[u8; 256],
    stride: usize,
    mx: usize,
    my: usize,
    bx: usize,
    by: usize,
) -> ([u8; 8], [u8; 4], u8) {
    let x = mx * 16 + bx * 4;
    let y = my * 16 + by * 4;
    let mut top = [127u8; 8];
    let mut left = [129u8; 4];
    if by == 0 {
        if my > 0 {
            for i in 0..8 {
                top[i] = global[(y - 1) * stride + (x + i).min(stride - 1)];
            }
        }
    } else {
        for i in 0..8 {
            top[i] = if bx * 4 + i < 16 {
                tile[(by * 4 - 1) * 16 + bx * 4 + i]
            } else if my > 0 {
                global[(my * 16 - 1) * stride + (mx * 16 + bx * 4 + i).min(stride - 1)]
            } else {
                127
            };
        }
    }
    if bx == 0 {
        if mx > 0 {
            for i in 0..4 {
                left[i] = global[(y + i) * stride + x - 1];
            }
        }
    } else {
        for i in 0..4 {
            left[i] = tile[(by * 4 + i) * 16 + bx * 4 - 1];
        }
    }
    let corner = if bx > 0 && by > 0 {
        tile[(by * 4 - 1) * 16 + bx * 4 - 1]
    } else if x > 0 && y > 0 {
        global[(y - 1) * stride + x - 1]
    } else if x == 0 && y == 0 {
        127
    } else if x == 0 {
        129
    } else {
        127
    };
    (top, left, corner)
}
#[allow(clippy::too_many_arguments)]
fn make_i4(
    source: &[u8],
    reconstructed: &[u8],
    stride: usize,
    mx: usize,
    my: usize,
    y_steps: Steps,
    above_modes: &[u8],
    left_modes: &[u8; 4],
    contexts: &CoeffContexts,
    lambda: u64,
) -> LumaCandidate {
    let mut tile = [0u8; 256];
    let mut block = Macroblock::default();
    let mut local_above = [false; 4];
    local_above.copy_from_slice(&contexts.y[mx * 4..mx * 4 + 4]);
    let mut local_left = contexts.left_y;
    for by in 0..4 {
        for bx in 0..4 {
            let index = by * 4 + bx;
            let x = mx * 16 + bx * 4;
            let y = my * 16 + by * 4;
            let (top, left, corner) = i4_edge(reconstructed, &tile, stride, mx, my, bx, by);
            let above = if by > 0 {
                block.b_modes[index - 4]
            } else {
                above_modes[mx * 4 + bx]
            };
            let left_mode = if bx > 0 {
                block.b_modes[index - 1]
            } else {
                left_modes[by]
            };
            let mut best: Option<([i16; 16], [u8; 16], u8, u64)> = None;
            for mode in 0..4u8 {
                let predicted = prediction::predict_i4(&top, &left, corner, bmode_from_u8(mode));
                let (coeff, patch) =
                    code_predicted_block(source, stride, x, y, &predicted, y_steps);
                let mut trial = RateCounter::default();
                write_bmode(&mut trial, above, left_mode, mode).unwrap();
                residual::encode_block(
                    &mut trial,
                    &coeff,
                    3,
                    usize::from(local_above[bx]) + usize::from(local_left[by]),
                )
                .unwrap();
                let mut distortion = 0u64;
                for row in 0..4 {
                    for col in 0..4 {
                        let diff = i32::from(source[(y + row) * stride + x + col])
                            - i32::from(patch[row * 4 + col]);
                        distortion += (diff * diff) as u64;
                    }
                }
                let score = distortion * 256 + lambda * trial.cost;
                if best.as_ref().is_none_or(|last| score < last.3) {
                    best = Some((coeff, patch, mode, score));
                }
            }
            let (coeff, patch, mode, _) = best.unwrap();
            block.y[index] = coeff;
            block.b_modes[index] = mode;
            store_patch::<16, 256>(&mut tile, bx, by, &patch);
            let nonzero = coeff.iter().any(|&c| c != 0);
            local_above[bx] = nonzero;
            local_left[by] = nonzero;
        }
    }
    LumaCandidate {
        block,
        tile,
        distortion: squared_error::<16, 256>(source, stride, mx * 16, my * 16, &tile),
    }
}
#[allow(clippy::too_many_arguments)]
fn make_uv(
    source_u: &[u8],
    source_v: &[u8],
    reconstructed_u: &[u8],
    reconstructed_v: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    mode: u8,
    steps: Steps,
) -> UvCandidate {
    let mut coeffs = [[[0i16; 16]; 4]; 2];
    let mut tiles = [[0u8; 64]; 2];
    for (index, (source, reconstructed)) in
        [(source_u, reconstructed_u), (source_v, reconstructed_v)]
            .into_iter()
            .enumerate()
    {
        let (top, left, corner) = edge::<8>(reconstructed, stride, x, y);
        let predicted =
            prediction::predict_uv(&top, &left, corner, y > 0, x > 0, mode_from_u8(mode));
        for by in 0..2 {
            for bx in 0..2 {
                let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
                let (coeff, patch) =
                    code_predicted_block(source, stride, x + bx * 4, y + by * 4, &predictor, steps);
                coeffs[index][by * 2 + bx] = coeff;
                store_patch::<8, 64>(&mut tiles[index], bx, by, &patch);
            }
        }
    }
    let distortion = squared_error::<8, 64>(source_u, stride, x, y, &tiles[0])
        + squared_error::<8, 64>(source_v, stride, x, y, &tiles[1]);
    UvCandidate {
        u: coeffs[0],
        v: coeffs[1],
        u_tile: tiles[0],
        v_tile: tiles[1],
        distortion,
    }
}
fn mode_cost(
    block: &Macroblock,
    mx: usize,
    above: &[u8],
    left: &[u8; 4],
) -> Result<u64, EncodeError> {
    let mut rate = RateCounter::default();
    write_y_mode(&mut rate, block.i16, block.y_mode)?;
    if !block.i16 {
        for (by, &left_mode) in left.iter().enumerate() {
            for bx in 0..4 {
                let index = by * 4 + bx;
                let a = if by > 0 {
                    block.b_modes[index - 4]
                } else {
                    above[mx * 4 + bx]
                };
                let l = if bx > 0 {
                    block.b_modes[index - 1]
                } else {
                    left_mode
                };
                write_bmode(&mut rate, a, l, block.b_modes[index])?;
            }
        }
    }
    write_uv_mode(&mut rate, block.uv_mode)?;
    Ok(rate.cost)
}
fn selected_cost(
    block: &Macroblock,
    mx: usize,
    contexts: &CoeffContexts,
    above: &[u8],
    left: &[u8; 4],
    distortion: u64,
    lambda: u64,
) -> Result<u64, EncodeError> {
    let skip = block.skip();
    let mut rate = RateCounter::default();
    rate.write(128, skip)?;
    let cost = rate.cost + mode_cost(block, mx, above, left)? + contexts.measure(block, mx)?;
    Ok(distortion * 256 + lambda * cost)
}
fn update_modes(block: &Macroblock, mx: usize, above: &mut [u8], left: &mut [u8; 4]) {
    for (row, left_mode) in left.iter_mut().enumerate() {
        for col in 0..4 {
            let mode = if block.i16 {
                derived_bmode(block.y_mode)
            } else {
                block.b_modes[row * 4 + col]
            };
            if row == 3 {
                above[mx * 4 + col] = mode;
            }
            if col == 3 {
                *left_mode = mode;
            }
        }
    }
}

fn encode_macroblock_coeffs(
    writer: &mut impl BoolSink,
    values: &[[i16; 16]],
    plane: usize,
    above: &mut [bool],
    left: &mut [bool],
    column: usize,
    width: usize,
) -> Result<(), EncodeError> {
    for (index, value) in values.iter().enumerate() {
        let x = index % width;
        let y = index / width;
        let slot = column * width + x;
        let context = usize::from(above[slot]) + usize::from(left[y]);
        let nonzero = residual::encode_block(writer, value, plane, context)?;
        above[slot] = nonzero;
        left[y] = nonzero;
    }
    Ok(())
}

pub fn encode_textured(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<Vec<u8>, EncodeError> {
    encode_observed(
        pixels,
        FrameSpec {
            width,
            height,
            stride,
            format,
            quality,
        },
        0,
        |_, _, _, _| {},
    )
}

#[derive(Clone, Copy)]
struct FrameSpec {
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
}

fn encode_observed(
    pixels: &[u8],
    spec: FrameSpec,
    luma_policy: u8,
    observe: impl FnOnce(&[u8], &[u8], &[u8], usize),
) -> Result<Vec<u8>, EncodeError> {
    let FrameSpec {
        width,
        height,
        stride,
        format,
        quality,
    } = spec;
    let width = width as usize;
    let height = height as usize;
    let stride = stride as usize;
    let padded_w = width.checked_add(15).ok_or(EncodeError::InvalidInput)? & !15;
    let padded_h = height.checked_add(15).ok_or(EncodeError::InvalidInput)? & !15;
    let y_size = padded_w
        .checked_mul(padded_h)
        .ok_or(EncodeError::InvalidInput)?;
    let uv_size = y_size / 4;
    let uv_w = padded_w / 2;
    let mut source_y = allocated(y_size)?;
    let mut source_u = allocated(uv_size)?;
    let mut source_v = allocated(uv_size)?;
    let mut reconstructed_y = allocated(y_size)?;
    let mut reconstructed_u = allocated(uv_size)?;
    let mut reconstructed_v = allocated(uv_size)?;
    for cy in 0..padded_h / 2 {
        for cx in 0..uv_w {
            let mut sum_u = 0u32;
            let mut sum_v = 0u32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let x = (cx * 2 + dx).min(width - 1);
                    let y = (cy * 2 + dy).min(height - 1);
                    let at = y * stride + x * 4;
                    let (r, g, b) = if format == 0 {
                        (pixels[at], pixels[at + 1], pixels[at + 2])
                    } else {
                        (pixels[at + 2], pixels[at + 1], pixels[at])
                    };
                    let (luma, chroma_u, chroma_v) =
                        yuv_from_rgb(i32::from(r), i32::from(g), i32::from(b));
                    source_y[(cy * 2 + dy) * padded_w + cx * 2 + dx] = luma;
                    sum_u += u32::from(chroma_u);
                    sum_v += u32::from(chroma_v);
                }
            }
            source_u[cy * uv_w + cx] = ((sum_u + 2) / 4) as u8;
            source_v[cy * uv_w + cx] = ((sum_v + 2) / 4) as u8;
        }
    }
    let blocks_x = padded_w / 16;
    let blocks_y = padded_h / 16;
    let count = blocks_x
        .checked_mul(blocks_y)
        .ok_or(EncodeError::InvalidInput)?;
    let mut blocks = Vec::new();
    blocks
        .try_reserve_exact(count)
        .map_err(|_| EncodeError::OutputLimit)?;
    let qindex = match quality {
        60 => 40,
        75 => 22,
        _ => 8,
    };
    let y_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::Y1);
    let uv_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::UV);
    let y2_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::Y2);
    let mut coeff_contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    // The provisional qindexes are still uncalibrated. This integer lambda is
    // a deterministic engineering search weight, not libwebp quality parity.
    let lambda = ((qindex + 8) * (qindex + 8) / 4) as u64;
    for my in 0..blocks_y {
        coeff_contexts.row();
        left_modes.fill(0);
        for mx in 0..blocks_x {
            let x = mx * 16;
            let y = my * 16;
            let luma = if luma_policy == 0 {
                let mut options = Vec::with_capacity(5);
                for mode in 0..4 {
                    options.push(make_i16(
                        &source_y,
                        &reconstructed_y,
                        padded_w,
                        x,
                        y,
                        mode,
                        y_steps,
                        y2_steps,
                    ));
                }
                options.push(make_i4(
                    &source_y,
                    &reconstructed_y,
                    padded_w,
                    mx,
                    my,
                    y_steps,
                    &above_modes,
                    &left_modes,
                    &coeff_contexts,
                    lambda,
                ));
                options
            } else if luma_policy == 1 {
                (0..4)
                    .map(|mode| {
                        make_i16(
                            &source_y,
                            &reconstructed_y,
                            padded_w,
                            x,
                            y,
                            mode,
                            y_steps,
                            y2_steps,
                        )
                    })
                    .collect()
            } else {
                vec![make_i4(
                    &source_y,
                    &reconstructed_y,
                    padded_w,
                    mx,
                    my,
                    y_steps,
                    &above_modes,
                    &left_modes,
                    &coeff_contexts,
                    lambda,
                )]
            };
            let uv: Vec<_> = (0..4)
                .map(|mode| {
                    make_uv(
                        &source_u,
                        &source_v,
                        &reconstructed_u,
                        &reconstructed_v,
                        uv_w,
                        mx * 8,
                        my * 8,
                        mode,
                        uv_steps,
                    )
                })
                .collect();
            let mut best: Option<(u64, usize, usize)> = None;
            for (li, luma_candidate) in luma.iter().enumerate() {
                for (ui, uv_candidate) in uv.iter().enumerate() {
                    let candidate = Macroblock {
                        y: luma_candidate.block.y,
                        y2: luma_candidate.block.y2,
                        i16: luma_candidate.block.i16,
                        y_mode: luma_candidate.block.y_mode,
                        b_modes: luma_candidate.block.b_modes,
                        uv_mode: ui as u8,
                        u: uv_candidate.u,
                        v: uv_candidate.v,
                    };
                    let distortion = luma_candidate.distortion + uv_candidate.distortion;
                    let score = selected_cost(
                        &candidate,
                        mx,
                        &coeff_contexts,
                        &above_modes,
                        &left_modes,
                        distortion,
                        lambda,
                    )?;
                    if best.is_none_or(|previous| score < previous.0) {
                        best = Some((score, li, ui));
                    }
                    // Trials own only stack/tile state. No committed neighbor,
                    // context, mode or coefficient statistic changes here.
                }
            }
            let (_, li, ui) = best.expect("at least one bounded mode candidate");
            let selected_luma = &luma[li];
            let selected_uv = &uv[ui];
            let block = Macroblock {
                y: selected_luma.block.y,
                y2: selected_luma.block.y2,
                i16: selected_luma.block.i16,
                y_mode: selected_luma.block.y_mode,
                b_modes: selected_luma.block.b_modes,
                uv_mode: ui as u8,
                u: selected_uv.u,
                v: selected_uv.v,
            };
            commit_tile::<16, 256>(&mut reconstructed_y, padded_w, x, y, &selected_luma.tile);
            commit_tile::<8, 64>(
                &mut reconstructed_u,
                uv_w,
                mx * 8,
                my * 8,
                &selected_uv.u_tile,
            );
            commit_tile::<8, 64>(
                &mut reconstructed_v,
                uv_w,
                mx * 8,
                my * 8,
                &selected_uv.v_tile,
            );
            coeff_contexts.encode_coefficients(&mut RateCounter::default(), &block, mx)?;
            update_modes(&block, mx, &mut above_modes, &mut left_modes);
            blocks.push(block);
        }
    }
    let result = emit_frame(&blocks, width, height, qindex)?;
    observe(
        &reconstructed_y,
        &reconstructed_u,
        &reconstructed_v,
        padded_w,
    );
    Ok(result)
}

fn emit_frame(
    blocks: &[Macroblock],
    width: usize,
    height: usize,
    qindex: usize,
) -> Result<Vec<u8>, EncodeError> {
    let blocks_x = width.div_ceil(16);
    let blocks_y = height.div_ceil(16);
    let mut header = BoolWriter::new();
    header.bit(false)?; // YUV color space.
    header.bit(false)?; // Decoder clamps output pixels.
    header.bit(false)?; // Segmentation disabled.
    header.bit(false)?; // Normal loop filter.
    header.literal(0, 6)?; // No loop filtering during this experiment.
    header.literal(0, 3)?;
    header.bit(false)?; // Macroblock filter deltas disabled.
    header.literal(0, 2)?; // One coefficient partition.
    header.literal(qindex as u32, 7)?;
    for _ in 0..5 {
        header.bit(false)?;
    }
    header.bit(false)?; // Entropy updates not retained.
    for probability in super::COEFF_UPDATE_PROBS {
        header.write(probability, false)?;
    }
    header.bit(true)?; // Macroblock coefficient skip flags enabled.
    header.literal(128, 8)?;
    let mut token = BoolWriter::new();
    let mut contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    for my in 0..blocks_y {
        contexts.row();
        left_modes.fill(0);
        for mx in 0..blocks_x {
            let block = &blocks[my * blocks_x + mx];
            header.write(128, block.skip())?;
            write_y_mode(&mut header, block.i16, block.y_mode)?;
            if !block.i16 {
                for (by, &left_mode) in left_modes.iter().enumerate() {
                    for bx in 0..4 {
                        let index = by * 4 + bx;
                        let a = if by > 0 {
                            block.b_modes[index - 4]
                        } else {
                            above_modes[mx * 4 + bx]
                        };
                        let l = if bx > 0 {
                            block.b_modes[index - 1]
                        } else {
                            left_mode
                        };
                        write_bmode(&mut header, a, l, block.b_modes[index])?;
                    }
                }
            }
            write_uv_mode(&mut header, block.uv_mode)?;
            contexts.encode_coefficients(&mut token, block, mx)?;
            update_modes(block, mx, &mut above_modes, &mut left_modes);
        }
    }
    let first = header.finish()?;
    let second = token.finish()?;
    let total = 10usize
        .checked_add(first.len())
        .and_then(|n| n.checked_add(second.len()))
        .ok_or(EncodeError::OutputLimit)?;
    if first.len() > 0x7ffff || total > MAX_OUTPUT_BYTES {
        return Err(EncodeError::OutputLimit);
    }
    let mut result = Vec::new();
    result
        .try_reserve_exact(total)
        .map_err(|_| EncodeError::OutputLimit)?;
    let tag = ((first.len() as u32) << 5) | 0x10;
    result.extend_from_slice(&tag.to_le_bytes()[..3]);
    result.extend_from_slice(&[0x9d, 0x01, 0x2a]);
    result.extend_from_slice(&(width as u16).to_le_bytes());
    result.extend_from_slice(&(height as u16).to_le_bytes());
    result.extend_from_slice(&first);
    result.extend_from_slice(&second);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn mode_trials_leave_committed_neighbors_and_contexts_unchanged() {
        let source_y: Vec<_> = (0..32 * 32).map(|i| (i * 37) as u8).collect();
        let reconstructed_y: Vec<_> = (0..32 * 32).map(|i| (i * 19) as u8).collect();
        let source_uv: Vec<_> = (0..16 * 16).map(|i| (i * 29) as u8).collect();
        let reconstructed_uv: Vec<_> = (0..16 * 16).map(|i| (i * 11) as u8).collect();
        let original_y = reconstructed_y.clone();
        let original_uv = reconstructed_uv.clone();
        let contexts = CoeffContexts::new(2);
        let above = [0u8; 8];
        let left = [0u8; 4];
        let y_steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let y2_steps = ac_quant::steps(22, Deltas::default(), Plane::Y2);
        let uv_steps = ac_quant::steps(22, Deltas::default(), Plane::UV);
        let trial = || {
            let i16 = make_i16(
                &source_y,
                &reconstructed_y,
                32,
                16,
                16,
                3,
                y_steps,
                y2_steps,
            );
            let i4 = make_i4(
                &source_y,
                &reconstructed_y,
                32,
                1,
                1,
                y_steps,
                &above,
                &left,
                &contexts,
                225,
            );
            let uv = make_uv(
                &source_uv,
                &source_uv,
                &reconstructed_uv,
                &reconstructed_uv,
                16,
                8,
                8,
                3,
                uv_steps,
            );
            (
                i16.tile,
                i16.block.y2,
                i4.tile,
                i4.block.b_modes,
                uv.u_tile,
                uv.u,
            )
        };
        assert_eq!(trial(), trial());
        assert_eq!(reconstructed_y, original_y);
        assert_eq!(reconstructed_uv, original_uv);
        assert!(contexts.y.iter().all(|&context| !context));
        assert!(contexts.y2.iter().all(|&context| !context));
        assert_eq!(above, [0; 8]);
        assert_eq!(left, [0; 4]);
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_coefficient_categories_and_skip_contexts() {
        let magnitudes = [
            1, 2, 3, 4, 5, 6, 7, 10, 11, 18, 19, 34, 35, 66, 67, 2047, 2114,
        ];
        let mut blocks = Vec::new();
        // Each magnitude/sign exercises all sixteen scan positions. Interspersed
        // skipped blocks reset Y/UV and, when present, the separate Y2 contexts.
        for magnitude in magnitudes {
            for sign in [-1, 1] {
                for i16 in [false, true] {
                    let mut block = Macroblock {
                        i16,
                        ..Macroblock::default()
                    };
                    for position in 0..16 {
                        block.y[position][position] = sign * magnitude;
                        if i16 {
                            block.y[position][0] = 0;
                        }
                    }
                    for index in 0..4 {
                        block.u[index][(blocks.len() / 4 + index * 4) % 16] = sign * magnitude;
                        block.v[index][(blocks.len() / 4 + index * 4 + 3) % 16] = -sign * magnitude;
                    }
                    if i16 {
                        block.y2[(blocks.len() / 4) % 16] = sign * magnitude;
                    }
                    blocks.push(block);
                    blocks.push(Macroblock {
                        i16,
                        ..Macroblock::default()
                    });
                }
            }
        }
        let columns = 8;
        while blocks.len() % columns != 0 {
            blocks.push(Macroblock::default());
        }
        let width = columns * 16;
        let height = blocks.len() / columns * 16;
        let frame = emit_frame(&blocks, width, height, 0).unwrap();
        let y_steps = ac_quant::steps(0, Deltas::default(), Plane::Y1);
        let uv_steps = ac_quant::steps(0, Deltas::default(), Plane::UV);
        let y2_steps = ac_quant::steps(0, Deltas::default(), Plane::Y2);
        let mut y = vec![0u8; width * height];
        let mut u = vec![0u8; width * height / 4];
        let mut v = u.clone();
        for (index, block) in blocks.iter().enumerate() {
            let mx = index % columns;
            let my = index / columns;
            let dc = transform::inverse_wht(&ac_quant::dequantize_block(&block.y2, y2_steps));
            let i16_predictor = predictor_dc(&y, width, mx * 16, my * 16, 16);
            for by in 0..4 {
                for bx in 0..4 {
                    let x = mx * 16 + bx * 4;
                    let row = my * 16 + by * 4;
                    let mut coefficients =
                        ac_quant::dequantize_block(&block.y[by * 4 + bx], y_steps);
                    let predictor = if block.i16 {
                        coefficients[0] = i32::from(dc[by * 4 + bx]);
                        i16_predictor
                    } else {
                        predictor_y(&y, width, x, row)
                    };
                    let residual = transform::inverse(&coefficients);
                    for dy in 0..4 {
                        for dx in 0..4 {
                            y[(row + dy) * width + x + dx] =
                                clamp(predictor + i32::from(residual[dy * 4 + dx]));
                        }
                    }
                }
            }
            for (plane, coefficients) in [(&mut u, &block.u), (&mut v, &block.v)] {
                let stride = width / 2;
                let predictor = predictor_dc(plane, stride, mx * 8, my * 8, 8);
                for by in 0..2 {
                    for bx in 0..2 {
                        let residual = transform::inverse(&ac_quant::dequantize_block(
                            &coefficients[by * 2 + bx],
                            uv_steps,
                        ));
                        for dy in 0..4 {
                            for dx in 0..4 {
                                plane[(my * 8 + by * 4 + dy) * stride + mx * 8 + bx * 4 + dx] =
                                    clamp(predictor + i32::from(residual[dy * 4 + dx]));
                            }
                        }
                    }
                }
            }
        }
        let expected: Vec<u8> = y.into_iter().chain(u).chain(v).collect();
        assert_decodes(
            &frame,
            width,
            height,
            &expected,
            "categories/zero-runs/skip/Y2",
        );
    }

    fn assert_decodes(frame: &[u8], width: usize, height: usize, expected: &[u8], label: &str) {
        let mut ivf = vec![0u8; 44];
        ivf[..4].copy_from_slice(b"DKIF");
        ivf[6..8].copy_from_slice(&32u16.to_le_bytes());
        ivf[8..12].copy_from_slice(b"VP80");
        ivf[12..14].copy_from_slice(&(width as u16).to_le_bytes());
        ivf[14..16].copy_from_slice(&(height as u16).to_le_bytes());
        ivf[16..20].copy_from_slice(&1u32.to_le_bytes());
        ivf[20..24].copy_from_slice(&1u32.to_le_bytes());
        ivf[24..28].copy_from_slice(&1u32.to_le_bytes());
        ivf[32..36].copy_from_slice(&(frame.len() as u32).to_le_bytes());
        ivf.extend_from_slice(frame);
        for decoder in ["vp8", "libvpx"] {
            let mut child = Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-c:v",
                    decoder,
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "yuv420p",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&ivf).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let difference = output.stdout.iter().zip(expected).position(|(a, b)| a != b);
            assert_eq!(output.stdout.len(), expected.len());
            assert!(
                difference.is_none(),
                "decoder={decoder} {width}x{height} {label} mismatch={difference:?} actual={:?} expected={:?}", difference.map(|i| &output.stdout[i..(i+8).min(expected.len())]), difference.map(|i| &expected[i..(i+8).min(expected.len())])
            );
        }
    }

    /// External engineering oracle, deliberately separate from product acceptance.
    /// Both FFmpeg's native VP8 decoder and libvpx must match every visible YUV byte.
    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoder_reconstruction() {
        let mut cases = vec![(1, 1), (1, 33), (33, 1), (64, 48)];
        for remainder in 0..16 {
            cases.push((32 + remainder, 48 + (15 - remainder)));
        }
        for (width, height) in cases {
            for quality in [60, 75, 85] {
                for pattern in 0..3 {
                    let mut seed = 0x501u32;
                    let mut pixels = vec![0; width * height * 4];
                    for (i, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        let rgb = match pattern {
                            0 => [((i * 37) & 255) as u8; 3],
                            1 => [seed as u8, (seed >> 8) as u8, (seed >> 16) as u8],
                            _ => [if i % 9 < 2 { 255 } else { 0 }; 3],
                        };
                        pixel.copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                    }
                    let mut expected = Vec::new();
                    let frame = encode_observed(
                        &pixels,
                        FrameSpec {
                            width: width as u32,
                            height: height as u32,
                            stride: width as u32 * 4,
                            format: 0,
                            quality,
                        },
                        pattern,
                        |y, u, v, padded_w| {
                            for (plane, stride, w, h) in [
                                (y, padded_w, width, height),
                                (u, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
                                (v, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
                            ] {
                                for row in 0..h {
                                    expected
                                        .extend_from_slice(&plane[row * stride..row * stride + w]);
                                }
                            }
                        },
                    )
                    .unwrap();
                    assert_eq!(
                        frame,
                        encode_observed(
                            &pixels,
                            FrameSpec {
                                width: width as u32,
                                height: height as u32,
                                stride: width as u32 * 4,
                                format: 0,
                                quality
                            },
                            pattern,
                            |_, _, _, _| {}
                        )
                        .unwrap()
                    );
                    assert_decodes(
                        &frame,
                        width,
                        height,
                        &expected,
                        &format!("q={quality} pattern={pattern}"),
                    );
                }
            }
        }
    }
}
