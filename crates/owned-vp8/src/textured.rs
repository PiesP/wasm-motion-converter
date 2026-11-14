// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{
    bmode_probs::BMODE_PROBS,
    limits::{Request, ResourcePlan, Status},
    prediction::{self, LargeMode, SmallMode},
    probability::{Model, Statistics, NODE_COUNT},
    rate::{probability_cost, BoolSink, CountingBoolSink, OpBuffer, RateCounter},
    residual,
    segmentation::{self, Config as SegmentConfig},
    transform,
};

#[derive(Default)]
struct Macroblock {
    y: [[i16; 16]; 16],
    y2: [i16; 16],
    i16: bool,
    y_mode: u8,
    b_modes: [u8; 16],
    uv_mode: u8,
    segment_id: u8,
    u: [[i16; 16]; 4],
    v: [[i16; 16]; 4],
}

const _: () = assert!(std::mem::size_of::<Macroblock>() <= 832);

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
    fn try_new(blocks_x: usize) -> Result<Self, Status> {
        fn zeros(len: usize) -> Result<Vec<bool>, Status> {
            let mut values = Vec::new();
            values
                .try_reserve_exact(len)
                .map_err(|_| Status::MemoryAdmission)?;
            values.resize(len, false);
            Ok(values)
        }
        Ok(Self {
            y2: zeros(blocks_x)?,
            y: zeros(blocks_x * 4)?,
            u: zeros(blocks_x * 2)?,
            v: zeros(blocks_x * 2)?,
            left_y2: false,
            left_y: [false; 4],
            left_u: [false; 2],
            left_v: [false; 2],
        })
    }
    fn reset(&mut self) {
        self.y2.fill(false);
        self.y.fill(false);
        self.u.fill(false);
        self.v.fill(false);
        self.row();
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
#[allow(clippy::too_many_arguments)]
fn selected_cost(
    block: &Macroblock,
    mx: usize,
    contexts: &CoeffContexts,
    above: &[u8],
    left: &[u8; 4],
    distortion: u64,
    lambda: u64,
    segments: SegmentConfig,
) -> Result<u64, EncodeError> {
    let skip = block.skip();
    let mut rate = RateCounter::default();
    segments.write_id(&mut rate, block.segment_id)?;
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
            let mut rgb = [[0u8; 3]; 4];
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
                    rgb[dy * 2 + dx] = [r, g, b];
                }
            }
            let (luma, u, v) = crate::color::convert_2x2(rgb);
            for dy in 0..2 {
                for dx in 0..2 {
                    source_y[(cy * 2 + dy) * padded_w + cx * 2 + dx] = luma[dy * 2 + dx];
                }
            }
            source_u[cy * uv_w + cx] = u;
            source_v[cy * uv_w + cx] = v;
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
    let mut segment_ids = Vec::new();
    segment_ids
        .try_reserve_exact(count)
        .map_err(|_| EncodeError::OutputLimit)?;
    let mut smooth_count = 0;
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let id = segmentation::classify(&source_y, &source_u, &source_v, padded_w, mx, my);
            smooth_count += usize::from(id == segmentation::SMOOTH);
            segment_ids.push(id);
        }
    }
    let segments = SegmentConfig::from_counts(quality, smooth_count, count);
    let deltas = crate::presets::deltas(quality);
    let mut coeff_contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    for my in 0..blocks_y {
        coeff_contexts.row();
        left_modes.fill(0);
        for mx in 0..blocks_x {
            let segment_id = segment_ids[my * blocks_x + mx];
            let qindex = segments.qindex_for(segment_id);
            let y_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y1);
            let uv_steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
            let y2_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y2);
            let lambda = crate::presets::lambda_for_q(qindex);
            blocks.push(analyze_one(
                &source_y,
                &source_u,
                &source_v,
                &mut reconstructed_y,
                &mut reconstructed_u,
                &mut reconstructed_v,
                padded_w,
                uv_w,
                mx,
                my,
                y_steps,
                uv_steps,
                y2_steps,
                &mut coeff_contexts,
                &mut above_modes,
                &mut left_modes,
                lambda,
                luma_policy,
                segment_id,
                segments,
            )?);
        }
    }
    let result = emit_segmented_frame(&blocks, width, height, segments, deltas)?;
    observe(
        &reconstructed_y,
        &reconstructed_u,
        &reconstructed_v,
        padded_w,
    );
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn analyze_one(
    source_y: &[u8],
    source_u: &[u8],
    source_v: &[u8],
    reconstructed_y: &mut [u8],
    reconstructed_u: &mut [u8],
    reconstructed_v: &mut [u8],
    padded_w: usize,
    uv_w: usize,
    mx: usize,
    my: usize,
    y_steps: Steps,
    uv_steps: Steps,
    y2_steps: Steps,
    coeff_contexts: &mut CoeffContexts,
    above_modes: &mut [u8],
    left_modes: &mut [u8; 4],
    lambda: u64,
    luma_policy: u8,
    segment_id: u8,
    segments: SegmentConfig,
) -> Result<Macroblock, EncodeError> {
    let x = mx * 16;
    let y = my * 16;
    let luma = if luma_policy == 0 {
        let mut options = Vec::with_capacity(5);
        for mode in 0..4 {
            options.push(make_i16(
                source_y,
                reconstructed_y,
                padded_w,
                x,
                y,
                mode,
                y_steps,
                y2_steps,
            ));
        }
        options.push(make_i4(
            source_y,
            reconstructed_y,
            padded_w,
            mx,
            my,
            y_steps,
            above_modes,
            left_modes,
            coeff_contexts,
            lambda,
        ));
        options
    } else if luma_policy == 1 {
        (0..4)
            .map(|mode| {
                make_i16(
                    source_y,
                    reconstructed_y,
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
            source_y,
            reconstructed_y,
            padded_w,
            mx,
            my,
            y_steps,
            above_modes,
            left_modes,
            coeff_contexts,
            lambda,
        )]
    };
    let uv: Vec<_> = (0..4)
        .map(|mode| {
            make_uv(
                source_u,
                source_v,
                reconstructed_u,
                reconstructed_v,
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
                segment_id,
                u: uv_candidate.u,
                v: uv_candidate.v,
            };
            let distortion = luma_candidate.distortion + uv_candidate.distortion;
            let score = selected_cost(
                &candidate,
                mx,
                coeff_contexts,
                above_modes,
                left_modes,
                distortion,
                lambda,
                segments,
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
        segment_id,
        u: selected_uv.u,
        v: selected_uv.v,
    };
    commit_tile::<16, 256>(reconstructed_y, padded_w, x, y, &selected_luma.tile);
    commit_tile::<8, 64>(reconstructed_u, uv_w, mx * 8, my * 8, &selected_uv.u_tile);
    commit_tile::<8, 64>(reconstructed_v, uv_w, mx * 8, my * 8, &selected_uv.v_tile);
    coeff_contexts.encode_coefficients(&mut RateCounter::default(), &block, mx)?;
    update_modes(&block, mx, above_modes, left_modes);
    Ok(block)
}

fn write_header_prefix(
    sink: &mut impl BoolSink,
    segments: SegmentConfig,
    deltas: Deltas,
) -> Result<(), EncodeError> {
    sink.bit(false)?; // YUV color space.
    sink.bit(false)?; // Decoder clamps output pixels.
    segments.write_header(sink)?;
    sink.bit(false)?; // Normal loop filter.
    sink.literal(0, 6)?; // No loop filtering during this experiment.
    sink.literal(0, 3)?;
    sink.bit(false)?; // Macroblock filter deltas disabled.
    sink.literal(0, 2)?; // One coefficient partition.
    sink.literal(segments.base_qindex as u32, 7)?;
    for delta in [
        deltas.y1_dc,
        deltas.y2_dc,
        deltas.y2_ac,
        deltas.uv_dc,
        deltas.uv_ac,
    ] {
        write_quantizer_delta(sink, delta)?;
    }
    sink.bit(false)?; // Entropy updates not retained.
    Ok(())
}

fn write_quantizer_delta(sink: &mut impl BoolSink, delta: i8) -> Result<(), EncodeError> {
    let magnitude = delta.unsigned_abs();
    if magnitude > 15 {
        return Err(EncodeError::InvalidInput);
    }
    sink.bit(delta != 0)?;
    if delta != 0 {
        sink.literal(u32::from(magnitude), 4)?;
        sink.bit(delta < 0)?;
    }
    Ok(())
}

fn write_header_suffix(sink: &mut impl BoolSink) -> Result<(), EncodeError> {
    sink.bit(true)?; // Macroblock coefficient skip flags enabled.
    sink.literal(128, 8)
}

fn write_updates(
    sink: &mut impl BoolSink,
    model: Option<&Model>,
    start: usize,
    end: usize,
) -> Result<(), EncodeError> {
    for index in start..end {
        let updated =
            model.is_some_and(|model| model.updated(index).expect("valid coefficient node"));
        sink.write(super::COEFF_UPDATE_PROBS[index], updated)?;
        if updated {
            sink.literal(
                model.expect("updated model").probabilities()[index] as u32,
                8,
            )?;
        }
    }
    Ok(())
}

struct StatsSink<'a>(&'a mut Statistics);

impl BoolSink for StatsSink<'_> {
    fn write(&mut self, _probability: u8, _bit: bool) -> Result<(), EncodeError> {
        Ok(())
    }
    fn write_coeff(
        &mut self,
        index: usize,
        _probability: u8,
        bit: bool,
    ) -> Result<(), EncodeError> {
        self.0.observe(index, bit)
    }
}

struct ModelSink<'a, S> {
    inner: &'a mut S,
    model: Option<&'a Model>,
}

impl<S: BoolSink> BoolSink for ModelSink<'_, S> {
    fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
        self.inner.write(probability, bit)
    }
    fn write_coeff(&mut self, index: usize, probability: u8, bit: bool) -> Result<(), EncodeError> {
        debug_assert_eq!(
            probability,
            crate::default_coeff_probs::DEFAULT_COEFF_PROBS[index]
        );
        self.inner.write(
            self.model.map_or(probability, |m| m.probabilities()[index]),
            bit,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn write_macroblock(
    header: &mut impl BoolSink,
    token: &mut impl BoolSink,
    contexts: &mut CoeffContexts,
    above_modes: &mut [u8],
    left_modes: &mut [u8; 4],
    mx: usize,
    block: &Macroblock,
    segments: SegmentConfig,
) -> Result<(), EncodeError> {
    segments.write_id(header, block.segment_id)?;
    header.write(128, block.skip())?;
    write_y_mode(header, block.i16, block.y_mode)?;
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
                write_bmode(header, a, l, block.b_modes[index])?;
            }
        }
    }
    write_uv_mode(header, block.uv_mode)?;
    contexts.encode_coefficients(token, block, mx)?;
    update_modes(block, mx, above_modes, left_modes);
    Ok(())
}

#[cfg(test)]
fn emit_frame(
    blocks: &[Macroblock],
    width: usize,
    height: usize,
    qindex: usize,
) -> Result<Vec<u8>, EncodeError> {
    emit_segmented_frame(
        blocks,
        width,
        height,
        SegmentConfig::nonsegmented(qindex),
        Deltas::default(),
    )
}

fn emit_segmented_frame(
    blocks: &[Macroblock],
    width: usize,
    height: usize,
    segments: SegmentConfig,
    deltas: Deltas,
) -> Result<Vec<u8>, EncodeError> {
    let blocks_x = width.div_ceil(16);
    let blocks_y = height.div_ceil(16);
    let model = model_frozen(blocks, blocks_x, blocks_y)?;
    let default_sizes = count_partitions(blocks, blocks_x, blocks_y, segments, deltas, None)?;
    let modeled_sizes =
        count_partitions(blocks, blocks_x, blocks_y, segments, deltas, Some(&model))?;
    let use_model = modeled_sizes.0 <= 0x7ffff
        && modeled_sizes.0 + modeled_sizes.1 < default_sizes.0 + default_sizes.1;
    let selected = if use_model {
        modeled_sizes
    } else {
        default_sizes
    };
    let total = 10usize
        .checked_add(selected.0)
        .and_then(|n| n.checked_add(selected.1))
        .ok_or(EncodeError::OutputLimit)?;
    if selected.0 > 0x7ffff || total > MAX_OUTPUT_BYTES {
        return Err(EncodeError::OutputLimit);
    }
    let selected_model = use_model.then_some(&model);
    let mut header = BoolWriter::with_capacity(selected.0)?;
    let mut token = BoolWriter::with_capacity(selected.1)?;
    code_partitions(
        blocks,
        blocks_x,
        blocks_y,
        segments,
        deltas,
        selected_model,
        &mut header,
        &mut token,
    )?;
    let first = header.finish()?;
    let second = token.finish()?;
    if first.len() != selected.0 || second.len() != selected.1 {
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

fn model_frozen(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
) -> Result<Model, EncodeError> {
    let mut stats = Statistics::new();
    let mut contexts = CoeffContexts::new(blocks_x);
    for my in 0..blocks_y {
        contexts.row();
        for mx in 0..blocks_x {
            let block = &blocks[my * blocks_x + mx];
            contexts.encode_coefficients(&mut StatsSink(&mut stats), block, mx)?;
        }
    }
    let mut model = Model::new();
    for start in (0..NODE_COUNT).step_by(64) {
        model.optimize_range(
            &stats,
            start,
            (NODE_COUNT - start).min(64),
            &probability_cost,
        )?;
    }
    Ok(model)
}

#[allow(clippy::too_many_arguments)]
fn code_partitions(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    model: Option<&Model>,
    header: &mut impl BoolSink,
    token: &mut impl BoolSink,
) -> Result<(), EncodeError> {
    write_header_prefix(header, segments, deltas)?;
    write_updates(header, model, 0, NODE_COUNT)?;
    write_header_suffix(header)?;
    let mut contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    for my in 0..blocks_y {
        contexts.row();
        left_modes.fill(0);
        for mx in 0..blocks_x {
            let block = &blocks[my * blocks_x + mx];
            write_macroblock(
                header,
                &mut ModelSink {
                    inner: token,
                    model,
                },
                &mut contexts,
                &mut above_modes,
                &mut left_modes,
                mx,
                block,
                segments,
            )?;
        }
    }
    Ok(())
}

fn count_partitions(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    model: Option<&Model>,
) -> Result<(usize, usize), EncodeError> {
    let mut first = CountingBoolSink::default();
    let mut second = CountingBoolSink::default();
    code_partitions(
        blocks,
        blocks_x,
        blocks_y,
        segments,
        deltas,
        model,
        &mut first,
        &mut second,
    )?;
    Ok((first.finish_size()?, second.finish_size()?))
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
enum Stage {
    Initialize = 0,
    Color = 1,
    Analyze = 2,
    CountPrefix = 3,
    CountUpdates = 4,
    CountSuffix = 5,
    CountBlocks = 6,
    EmitPrefix = 7,
    EmitUpdates = 8,
    EmitSuffix = 9,
    EmitBlocks = 10,
    FinalizeHeader = 11,
    FinalizeTokens = 12,
    Assemble = 13,
    Done = 14,
    CollectStats = 15,
    Optimize = 16,
    PrepareOutput = 17,
    Classify = 18,
}

/// One step initializes at most 64 KiB, converts one YUV row pair, analyzes
/// one macroblock, codes one macroblock, or assembles at most 64 KiB. The host
/// owns scheduling and cancellation between calls.
pub(crate) struct FrameEncoder {
    request: Request,
    plan: ResourcePlan,
    input: Vec<u8>,
    source_y: Vec<u8>,
    source_u: Vec<u8>,
    source_v: Vec<u8>,
    reconstructed_y: Vec<u8>,
    reconstructed_u: Vec<u8>,
    reconstructed_v: Vec<u8>,
    blocks: Vec<Macroblock>,
    smooth_count: usize,
    segments: SegmentConfig,
    contexts: CoeffContexts,
    above_modes: Vec<u8>,
    left_modes: [u8; 4],
    count_header: CountingBoolSink,
    count_token: CountingBoolSink,
    stats: Statistics,
    model: Model,
    model_count_pass: bool,
    use_model: bool,
    default_sizes: (u32, u32),
    default_frame_bytes: u32,
    selected_frame_bytes: u32,
    update_count: u32,
    header: Option<BoolWriter>,
    token: Option<BoolWriter>,
    pending_header: OpBuffer,
    pending_token: OpBuffer,
    first: Vec<u8>,
    second: Vec<u8>,
    output: Vec<u8>,
    stage: Stage,
    cursor: usize,
    init_plane: usize,
}

fn encode_status(error: EncodeError) -> Status {
    match error {
        EncodeError::InvalidInput => Status::InvalidInput,
        EncodeError::UnsupportedPixels => Status::UnsupportedPixels,
        EncodeError::OutputLimit => Status::OutputLimit,
    }
}

impl FrameEncoder {
    pub(crate) fn new(
        request: Request,
        input: Vec<u8>,
        plan: ResourcePlan,
    ) -> Result<Self, Status> {
        let input_capacity =
            u32::try_from(input.capacity()).map_err(|_| Status::MemoryAdmission)?;
        if input_capacity > plan.input_reservation_bytes {
            return Err(Status::MemoryAdmission);
        }
        let fresh = ResourcePlan::checked(request)?.with_input_capacity(input_capacity)?;
        if fresh.with_capacity_floor(plan.linear_capacity_bytes)? != plan {
            return Err(Status::InvalidInput);
        }
        if input.len() != request.input_bytes as usize {
            return Err(Status::InvalidInput);
        }
        let blocks_x = plan.padded_width as usize / 16;
        let mut blocks = Vec::new();
        blocks
            .try_reserve_exact(plan.macroblock_count as usize)
            .map_err(|_| Status::MemoryAdmission)?;
        if blocks.capacity() * std::mem::size_of::<Macroblock>() > plan.coefficient_bytes as usize {
            return Err(Status::MemoryAdmission);
        }
        let mut above_modes = Vec::new();
        above_modes
            .try_reserve_exact(blocks_x * 4)
            .map_err(|_| Status::MemoryAdmission)?;
        above_modes.resize(blocks_x * 4, 0);
        Ok(Self {
            request,
            plan,
            input,
            source_y: Vec::new(),
            source_u: Vec::new(),
            source_v: Vec::new(),
            reconstructed_y: Vec::new(),
            reconstructed_u: Vec::new(),
            reconstructed_v: Vec::new(),
            blocks,
            smooth_count: 0,
            segments: SegmentConfig::nonsegmented(crate::presets::qindex(request.quality)),
            contexts: CoeffContexts::try_new(blocks_x)?,
            above_modes,
            left_modes: [0; 4],
            count_header: CountingBoolSink::default(),
            count_token: CountingBoolSink::default(),
            stats: Statistics::new(),
            model: Model::new(),
            model_count_pass: false,
            use_model: false,
            default_sizes: (0, 0),
            default_frame_bytes: 0,
            selected_frame_bytes: 0,
            update_count: 0,
            header: None,
            token: None,
            pending_header: OpBuffer::new().map_err(|_| Status::MemoryAdmission)?,
            pending_token: OpBuffer::new().map_err(|_| Status::MemoryAdmission)?,
            first: Vec::new(),
            second: Vec::new(),
            output: Vec::new(),
            stage: Stage::Initialize,
            cursor: 0,
            init_plane: 0,
        })
    }

    pub(crate) fn plan(&self) -> ResourcePlan {
        self.plan
    }

    pub(crate) fn stage(&self) -> u32 {
        self.stage as u32
    }

    pub(crate) fn progress(&self) -> (u32, u32) {
        let blocks = self.plan.macroblock_count;
        let pairs = self.plan.padded_height / 2;
        match self.stage {
            Stage::Initialize => {
                let done = self.source_y.len()
                    + self.source_u.len()
                    + self.source_v.len()
                    + self.reconstructed_y.len()
                    + self.reconstructed_u.len()
                    + self.reconstructed_v.len();
                (done as u32, self.plan.yuv_plane_set_bytes * 2)
            }
            Stage::Color => (self.cursor as u32, pairs),
            Stage::Classify
            | Stage::Analyze
            | Stage::CollectStats
            | Stage::CountBlocks
            | Stage::EmitBlocks => (self.cursor as u32, blocks),
            Stage::Optimize => (self.cursor as u32, NODE_COUNT as u32),
            Stage::CountUpdates | Stage::EmitUpdates => {
                (self.cursor as u32, super::COEFF_UPDATE_PROBS.len() as u32)
            }
            Stage::Assemble => (self.output.len() as u32, self.plan.frame_bytes),
            Stage::Done => (1, 1),
            _ => (0, 1),
        }
    }

    pub(crate) fn output(&self) -> &[u8] {
        if self.stage == Stage::Done {
            &self.output
        } else {
            &[]
        }
    }

    #[allow(dead_code)] // Read by the ABI metrics record after lane integration.
    pub(crate) fn update_count(&self) -> u32 {
        self.update_count
    }
    #[allow(dead_code)] // Read by the ABI metrics record after lane integration.
    pub(crate) fn default_frame_bytes(&self) -> u32 {
        self.default_frame_bytes
    }
    #[allow(dead_code)] // Read by the ABI metrics record after lane integration.
    pub(crate) fn selected_frame_bytes(&self) -> u32 {
        self.selected_frame_bytes
    }

    pub(crate) fn take_input(&mut self) -> Vec<u8> {
        if self.stage == Stage::Done {
            std::mem::take(&mut self.input)
        } else {
            Vec::new()
        }
    }

    #[cfg(test)]
    fn reconstruction(&self) -> (&[u8], &[u8], &[u8], usize) {
        (
            &self.reconstructed_y,
            &self.reconstructed_u,
            &self.reconstructed_v,
            self.plan.padded_width as usize,
        )
    }

    fn initialize_one_chunk(&mut self) -> Result<(), Status> {
        let y_size = self.plan.padded_width as usize * self.plan.padded_height as usize;
        let target = if self.init_plane.is_multiple_of(3) {
            y_size
        } else {
            y_size / 4
        };
        let plane = match self.init_plane {
            0 => &mut self.source_y,
            1 => &mut self.source_u,
            2 => &mut self.source_v,
            3 => &mut self.reconstructed_y,
            4 => &mut self.reconstructed_u,
            _ => &mut self.reconstructed_v,
        };
        if plane.capacity() == 0 {
            plane
                .try_reserve_exact(target)
                .map_err(|_| Status::MemoryAdmission)?;
        }
        let end = plane.len().saturating_add(65_536).min(target);
        plane.resize(end, 0);
        if end == target {
            self.init_plane += 1;
            if self.init_plane == 6 {
                self.cursor = 0;
                self.stage = Stage::Color;
            }
        }
        Ok(())
    }

    fn color_one_pair(&mut self) -> Result<(), Status> {
        let width = self.request.width as usize;
        let height = self.request.height as usize;
        let stride = self.request.stride as usize;
        let layout = self.request.layout;
        let bpp = if layout == 4 { 3 } else { 4 };
        let y_stride = self.plan.padded_width as usize;
        let uv_stride = y_stride / 2;
        let cy = self.cursor;
        for cx in 0..uv_stride {
            let mut rgb = [[0u8; 3]; 4];
            for dy in 0..2 {
                for dx in 0..2 {
                    let x = (cx * 2 + dx).min(width - 1);
                    let y = (cy * 2 + dy).min(height - 1);
                    let at = y * stride + x * bpp;
                    if layout <= 1 && self.input[at + 3] != 255 {
                        return Err(Status::UnsupportedPixels);
                    }
                    let (r, g, b) = match layout {
                        0 | 2 | 4 => (self.input[at], self.input[at + 1], self.input[at + 2]),
                        _ => (self.input[at + 2], self.input[at + 1], self.input[at]),
                    };
                    rgb[dy * 2 + dx] = [r, g, b];
                }
            }
            let (luma, u, v) = crate::color::convert_2x2(rgb);
            for dy in 0..2 {
                for dx in 0..2 {
                    self.source_y[(cy * 2 + dy) * y_stride + cx * 2 + dx] = luma[dy * 2 + dx];
                }
            }
            self.source_u[cy * uv_stride + cx] = u;
            self.source_v[cy * uv_stride + cx] = v;
        }
        self.cursor += 1;
        if self.cursor == self.plan.padded_height as usize / 2 {
            self.cursor = 0;
            self.stage = Stage::Classify;
        }
        Ok(())
    }

    fn reset_coding_state(&mut self) {
        self.contexts.reset();
        self.above_modes.fill(0);
        self.left_modes.fill(0);
        self.cursor = 0;
    }

    fn classify_one_step(&mut self) {
        let blocks_x = self.plan.padded_width as usize / 16;
        let mx = self.cursor % blocks_x;
        let my = self.cursor / blocks_x;
        let segment_id = segmentation::classify(
            &self.source_y,
            &self.source_u,
            &self.source_v,
            self.plan.padded_width as usize,
            mx,
            my,
        );
        self.smooth_count += usize::from(segment_id == segmentation::SMOOTH);
        self.blocks.push(Macroblock {
            segment_id,
            ..Macroblock::default()
        });
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            self.segments = SegmentConfig::from_counts(
                self.request.quality,
                self.smooth_count,
                self.blocks.len(),
            );
            self.cursor = 0;
            self.stage = Stage::Analyze;
        }
    }

    fn analyze_one_step(&mut self) -> Result<(), Status> {
        let blocks_x = self.plan.padded_width as usize / 16;
        let mx = self.cursor % blocks_x;
        let my = self.cursor / blocks_x;
        if mx == 0 {
            self.contexts.row();
            self.left_modes.fill(0);
        }
        let segment_id = self.blocks[self.cursor].segment_id;
        let qindex = self.segments.qindex_for(segment_id);
        let deltas = crate::presets::deltas(self.request.quality);
        let y_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y1);
        let uv_steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
        let y2_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y2);
        let lambda = crate::presets::lambda_for_q(qindex);
        let block = analyze_one(
            &self.source_y,
            &self.source_u,
            &self.source_v,
            &mut self.reconstructed_y,
            &mut self.reconstructed_u,
            &mut self.reconstructed_v,
            self.plan.padded_width as usize,
            self.plan.padded_width as usize / 2,
            mx,
            my,
            y_steps,
            uv_steps,
            y2_steps,
            &mut self.contexts,
            &mut self.above_modes,
            &mut self.left_modes,
            lambda,
            0,
            segment_id,
            self.segments,
        )
        .map_err(encode_status)?;
        self.blocks[self.cursor] = block;
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            self.reset_coding_state();
            self.stage = Stage::CollectStats;
        }
        Ok(())
    }

    fn code_one_step(&mut self, counting: bool) -> Result<(), Status> {
        let blocks_x = self.plan.padded_width as usize / 16;
        let mx = self.cursor % blocks_x;
        if mx == 0 {
            self.contexts.row();
            self.left_modes.fill(0);
        }
        let block = &self.blocks[self.cursor];
        if counting {
            write_macroblock(
                &mut self.count_header,
                &mut ModelSink {
                    inner: &mut self.count_token,
                    model: self.model_count_pass.then_some(&self.model),
                },
                &mut self.contexts,
                &mut self.above_modes,
                &mut self.left_modes,
                mx,
                block,
                self.segments,
            )
            .map_err(encode_status)?;
        } else {
            write_macroblock(
                &mut self.pending_header,
                &mut ModelSink {
                    inner: &mut self.pending_token,
                    model: self.use_model.then_some(&self.model),
                },
                &mut self.contexts,
                &mut self.above_modes,
                &mut self.left_modes,
                mx,
                block,
                self.segments,
            )
            .map_err(encode_status)?;
        }
        self.cursor += 1;
        if self.cursor == self.blocks.len() {
            self.cursor = 0;
            if counting {
                let first = self.count_header.finish_size().map_err(encode_status)?;
                let second = self.count_token.finish_size().map_err(encode_status)?;
                let first = u32::try_from(first).map_err(|_| Status::PartitionLimit)?;
                let second = u32::try_from(second).map_err(|_| Status::OutputLimit)?;
                if !self.model_count_pass {
                    self.default_sizes = (first, second);
                    self.default_frame_bytes = first
                        .checked_add(second)
                        .and_then(|n| n.checked_add(10))
                        .ok_or(Status::OutputLimit)?;
                    self.count_header = CountingBoolSink::default();
                    self.count_token = CountingBoolSink::default();
                    self.model_count_pass = true;
                    self.stage = Stage::CountPrefix;
                    return Ok(());
                }
                let proposed_total = first
                    .checked_add(second)
                    .and_then(|n| n.checked_add(10))
                    .ok_or(Status::OutputLimit)?;
                self.use_model = first <= 0x7ffff && proposed_total < self.default_frame_bytes;
                let (first, second) = if self.use_model {
                    (first, second)
                } else {
                    self.default_sizes
                };
                self.selected_frame_bytes = if self.use_model {
                    proposed_total
                } else {
                    self.default_frame_bytes
                };
                self.update_count = if self.use_model {
                    (0..NODE_COUNT)
                        .filter(|&i| self.model.updated(i).expect("valid coefficient node"))
                        .count() as u32
                } else {
                    0
                };
                self.plan = self.plan.with_output_sizes(first, second)?;
                // Publish the final plan before any partition or frame reserve.
                // The host can reserve its concurrent budget at this step boundary.
                self.stage = Stage::PrepareOutput;
            } else {
                self.stage = Stage::FinalizeHeader;
            }
        }
        Ok(())
    }

    fn drain_one(
        ops: &mut OpBuffer,
        writer: &mut BoolWriter,
        symbols: &mut usize,
        carry_bytes: &mut usize,
    ) -> Result<(), Status> {
        while *symbols > 0 {
            let Some((probability, bit)) = ops.next() else {
                break;
            };
            if !writer
                .write_step(probability, bit, carry_bytes)
                .map_err(encode_status)?
            {
                break;
            }
            ops.advance();
            *symbols -= 1;
        }
        Ok(())
    }

    fn drain_pending(&mut self) -> Result<bool, Status> {
        let mut symbols = 1_024;
        let mut carry_bytes = 65_536;
        if self.pending_header.pending() {
            Self::drain_one(
                &mut self.pending_header,
                self.header.as_mut().ok_or(Status::InvalidInput)?,
                &mut symbols,
                &mut carry_bytes,
            )?;
        }
        if !self.pending_header.pending() && self.pending_token.pending() {
            Self::drain_one(
                &mut self.pending_token,
                self.token.as_mut().ok_or(Status::InvalidInput)?,
                &mut symbols,
                &mut carry_bytes,
            )?;
        }
        Ok(!self.pending_header.pending() && !self.pending_token.pending())
    }

    pub(crate) fn step(&mut self) -> Result<bool, Status> {
        if self.pending_header.pending() || self.pending_token.pending() {
            self.drain_pending()?;
            return Ok(false);
        }
        match self.stage {
            Stage::Initialize => self.initialize_one_chunk()?,
            Stage::Color => self.color_one_pair()?,
            Stage::Classify => self.classify_one_step(),
            Stage::Analyze => self.analyze_one_step()?,
            Stage::CollectStats => {
                let blocks_x = self.plan.padded_width as usize / 16;
                let mx = self.cursor % blocks_x;
                if mx == 0 {
                    self.contexts.row();
                }
                self.contexts
                    .encode_coefficients(
                        &mut StatsSink(&mut self.stats),
                        &self.blocks[self.cursor],
                        mx,
                    )
                    .map_err(encode_status)?;
                self.cursor += 1;
                if self.cursor == self.blocks.len() {
                    self.cursor = 0;
                    self.stage = Stage::Optimize;
                }
            }
            Stage::Optimize => {
                let count = (NODE_COUNT - self.cursor).min(64);
                self.model
                    .optimize_range(&self.stats, self.cursor, count, &probability_cost)
                    .map_err(encode_status)?;
                self.cursor += count;
                if self.cursor == NODE_COUNT {
                    self.cursor = 0;
                    self.stage = Stage::CountPrefix;
                }
            }
            Stage::CountPrefix => {
                write_header_prefix(
                    &mut self.count_header,
                    self.segments,
                    crate::presets::deltas(self.request.quality),
                )
                .map_err(encode_status)?;
                self.stage = Stage::CountUpdates;
            }
            Stage::CountUpdates => {
                let end = (self.cursor + 64).min(NODE_COUNT);
                write_updates(
                    &mut self.count_header,
                    self.model_count_pass.then_some(&self.model),
                    self.cursor,
                    end,
                )
                .map_err(encode_status)?;
                self.cursor = end;
                if end == super::COEFF_UPDATE_PROBS.len() {
                    self.cursor = 0;
                    self.stage = Stage::CountSuffix;
                }
            }
            Stage::CountSuffix => {
                write_header_suffix(&mut self.count_header).map_err(encode_status)?;
                self.reset_coding_state();
                self.stage = Stage::CountBlocks;
            }
            Stage::CountBlocks => self.code_one_step(true)?,
            Stage::PrepareOutput => {
                let header = BoolWriter::with_capacity(self.plan.first_partition_bytes as usize)
                    .map_err(|_| Status::MemoryAdmission)?;
                let token =
                    BoolWriter::with_capacity(self.plan.coefficient_partition_bytes as usize)
                        .map_err(|_| Status::MemoryAdmission)?;
                self.output
                    .try_reserve_exact(self.plan.frame_bytes as usize)
                    .map_err(|_| Status::MemoryAdmission)?;
                self.header = Some(header);
                self.token = Some(token);
                self.stage = Stage::EmitPrefix;
            }
            Stage::EmitPrefix => {
                write_header_prefix(
                    &mut self.pending_header,
                    self.segments,
                    crate::presets::deltas(self.request.quality),
                )
                .map_err(encode_status)?;
                self.stage = Stage::EmitUpdates;
            }
            Stage::EmitUpdates => {
                let end = (self.cursor + 64).min(NODE_COUNT);
                write_updates(
                    &mut self.pending_header,
                    self.use_model.then_some(&self.model),
                    self.cursor,
                    end,
                )
                .map_err(encode_status)?;
                self.cursor = end;
                if end == super::COEFF_UPDATE_PROBS.len() {
                    self.cursor = 0;
                    self.stage = Stage::EmitSuffix;
                }
            }
            Stage::EmitSuffix => {
                write_header_suffix(&mut self.pending_header).map_err(encode_status)?;
                self.reset_coding_state();
                self.stage = Stage::EmitBlocks;
            }
            Stage::EmitBlocks => self.code_one_step(false)?,
            Stage::FinalizeHeader => {
                let header = self.header.as_mut().ok_or(Status::InvalidInput)?;
                if !header.finish_step(&mut 65_536).map_err(encode_status)? {
                    return Ok(false);
                }
                self.first = header.take_finished().ok_or(Status::InvalidInput)?;
                self.header = None;
                if self.first.len() != self.plan.first_partition_bytes as usize {
                    return Err(Status::PartitionLimit);
                }
                self.stage = Stage::FinalizeTokens;
            }
            Stage::FinalizeTokens => {
                let token = self.token.as_mut().ok_or(Status::InvalidInput)?;
                if !token.finish_step(&mut 65_536).map_err(encode_status)? {
                    return Ok(false);
                }
                self.second = token.take_finished().ok_or(Status::InvalidInput)?;
                self.token = None;
                if self.second.len() != self.plan.coefficient_partition_bytes as usize {
                    return Err(Status::OutputLimit);
                }
                let tag = (self.plan.first_partition_bytes << 5) | 0x10;
                self.output.extend_from_slice(&tag.to_le_bytes()[..3]);
                self.output.extend_from_slice(&[0x9d, 0x01, 0x2a]);
                self.output
                    .extend_from_slice(&(self.request.width as u16).to_le_bytes());
                self.output
                    .extend_from_slice(&(self.request.height as u16).to_le_bytes());
                self.stage = Stage::Assemble;
            }
            Stage::Assemble => {
                let payload_at = self.output.len() - 10;
                let end = (payload_at + 65_536).min(self.first.len() + self.second.len());
                if payload_at < self.first.len() {
                    let first_end = end.min(self.first.len());
                    self.output
                        .extend_from_slice(&self.first[payload_at..first_end]);
                    if end > first_end {
                        self.output
                            .extend_from_slice(&self.second[..end - first_end]);
                    }
                } else {
                    let token_at = payload_at - self.first.len();
                    self.output
                        .extend_from_slice(&self.second[token_at..end - self.first.len()]);
                }
                if self.output.len() == self.plan.frame_bytes as usize {
                    self.stage = Stage::Done;
                }
            }
            Stage::Done => return Ok(true),
        }
        Ok(self.stage == Stage::Done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn mixed_segment_input() -> Vec<u8> {
        let mut pixels = Vec::with_capacity(32 * 16 * 4);
        let mut seed = 0x501u32;
        for y in 0..16 {
            for x in 0..32 {
                let rgb = if x < 16 {
                    [80 + x as u8 + y as u8; 3]
                } else {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    [seed as u8, (seed >> 8) as u8, (seed >> 16) as u8]
                };
                pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        pixels
    }

    #[test]
    fn mixed_segment_map_and_fresh_frames_are_deterministic() {
        let input = mixed_segment_input();
        let request = engine_request(32, 16, 0, &input, 128);
        let plan = ResourcePlan::checked(request).unwrap();
        let first = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
        assert!(first.segments.enabled);
        assert_eq!(first.smooth_count, 1);
        assert_eq!(
            first.segments.qindex,
            [
                crate::presets::SMOOTH_QINDEX,
                crate::presets::textured_qindex(request.quality)
            ]
        );
        assert_eq!(first.segments.map_probability, 128);
        assert_eq!(
            first
                .blocks
                .iter()
                .map(|b| b.segment_id)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        assert_eq!(
            first.output(),
            encode_textured(&input, 32, 16, 128, 0, 75).unwrap()
        );
        let repeated = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert_eq!(repeated.output(), first.output());

        let smooth = [128, 128, 128, 255].repeat(16 * 16);
        let smooth_request = engine_request(16, 16, 0, &smooth, 64);
        let smooth_plan = ResourcePlan::checked(smooth_request).unwrap();
        let after_mixed =
            run_engine(FrameEncoder::new(smooth_request, smooth.clone(), smooth_plan).unwrap());
        let fresh =
            run_engine(FrameEncoder::new(smooth_request, smooth.clone(), smooth_plan).unwrap());
        assert!(!after_mixed.segments.enabled);
        assert_eq!(
            after_mixed.segments.base_qindex,
            crate::presets::SMOOTH_QINDEX
        );
        assert_eq!(after_mixed.output(), fresh.output());
        assert_eq!(
            after_mixed.output(),
            encode_textured(&smooth, 16, 16, 64, 0, 75).unwrap()
        );
    }

    #[test]
    fn segment_header_and_map_precede_skip_bits() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let segments = SegmentConfig::from_counts(75, 1, 2);
        let mut header = Operations(Vec::new());
        write_header_prefix(&mut header, segments, crate::presets::deltas(75)).unwrap();
        assert_eq!(
            &header.0[..6],
            &[
                (128, false),
                (128, false),
                (128, true),
                (128, true),
                (128, true),
                (128, true)
            ]
        );
        let mut header = Operations(Vec::new());
        let mut token = Operations(Vec::new());
        let block = Macroblock {
            segment_id: segmentation::TEXTURED,
            ..Macroblock::default()
        };
        write_macroblock(
            &mut header,
            &mut token,
            &mut CoeffContexts::new(1),
            &mut [0; 4],
            &mut [0; 4],
            0,
            &block,
            segments,
        )
        .unwrap();
        assert_eq!(&header.0[..3], &[(255, false), (128, true), (128, true)]);
    }

    #[test]
    fn quantizer_header_signals_signed_uv_deltas() {
        struct Operations(Vec<bool>);
        impl BoolSink for Operations {
            fn write(&mut self, _probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push(bit);
                Ok(())
            }
        }
        for (quality, expected) in [(60, 0), (75, -7), (85, 0)] {
            let deltas = crate::presets::deltas(quality);
            assert_eq!(deltas.uv_dc, expected);
            assert_eq!(deltas.uv_ac, expected);
            assert_eq!(deltas.y1_dc, 0);
            assert_eq!(deltas.y2_dc, 0);
            assert_eq!(deltas.y2_ac, 0);
        }
        let mut header = Operations(Vec::new());
        write_header_prefix(
            &mut header,
            SegmentConfig::nonsegmented(23),
            crate::presets::deltas(75),
        )
        .unwrap();
        assert_eq!(
            &header.0[header.0.len() - 16..],
            &[
                false, false, false, // Y1 DC, Y2 DC and Y2 AC absent.
                true, false, true, true, true, true, // UV DC: magnitude 7, negative.
                true, false, true, true, true, true,  // UV AC: magnitude 7, negative.
                false, // Entropy updates not retained.
            ]
        );
        let mut positive = Operations(Vec::new());
        write_quantizer_delta(&mut positive, 7).unwrap();
        assert_eq!(positive.0, [true, false, true, true, true, false]);
        assert_eq!(
            write_quantizer_delta(&mut positive, 16),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(
            write_quantizer_delta(&mut positive, -16),
            Err(EncodeError::InvalidInput)
        );
    }

    #[test]
    fn frozen_frame_adopts_only_a_smaller_complete_model() {
        let small = vec![Macroblock::default()];
        let small_model = model_frozen(&small, 1, 1).unwrap();
        assert!((0..NODE_COUNT).all(|i| !small_model.updated(i).unwrap()));
        let small_default = count_partitions(
            &small,
            1,
            1,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            emit_frame(&small, 16, 16, 22).unwrap().len(),
            10 + small_default.0 + small_default.1
        );

        let blocks: Vec<_> = (0..256)
            .map(|_| {
                let mut block = Macroblock::default();
                block.y[0][0] = 1;
                block.u[0][0] = 1;
                block.v[0][0] = -1;
                block
            })
            .collect();
        let model = model_frozen(&blocks, 16, 16).unwrap();
        assert!((0..NODE_COUNT).any(|i| model.updated(i).unwrap()));
        let default = count_partitions(
            &blocks,
            16,
            16,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            None,
        )
        .unwrap();
        let proposed = count_partitions(
            &blocks,
            16,
            16,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            Some(&model),
        )
        .unwrap();
        assert!(proposed.0 <= 0x7ffff);
        assert!(proposed.0 + proposed.1 < default.0 + default.1);
        let frame = emit_frame(&blocks, 256, 256, 22).unwrap();
        assert_eq!(frame.len(), 10 + proposed.0 + proposed.1);
        assert_eq!(
            ((u32::from(frame[0]) | u32::from(frame[1]) << 8 | u32::from(frame[2]) << 16) >> 5)
                as usize,
            proposed.0
        );
        assert_eq!(frame, emit_frame(&blocks, 256, 256, 22).unwrap());
    }

    #[test]
    fn unchanged_model_preserves_all_coefficient_tree_probabilities() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let mut block = Macroblock::default();
        let magnitudes = [1, 2, 3, 4, 5, 6, 7, 10, 11, 18, 19, 34, 35, 66, 67, 2114];
        for (position, magnitude) in magnitudes.into_iter().enumerate() {
            block.y[0][residual::SCAN[position]] = magnitude;
            block.u[0][residual::SCAN[position]] = -magnitude;
        }
        let mut plain = Operations(Vec::new());
        let mut modeled = Operations(Vec::new());
        CoeffContexts::new(1)
            .encode_coefficients(&mut plain, &block, 0)
            .unwrap();
        CoeffContexts::new(1)
            .encode_coefficients(
                &mut ModelSink {
                    inner: &mut modeled,
                    model: Some(&Model::new()),
                },
                &block,
                0,
            )
            .unwrap();
        assert_eq!(modeled.0, plain.0);
    }

    #[test]
    fn coefficient_update_header_roundtrip() {
        let mut stats = Statistics::new();
        for _ in 0..8 {
            stats.observe(528, true).unwrap();
        }
        let mut model = Model::new();
        model.optimize_one(&stats, 528, &probability_cost).unwrap();
        assert!(model.updated(528).unwrap());
        let mut header = BoolWriter::new();
        write_header_prefix(
            &mut header,
            SegmentConfig::nonsegmented(8),
            Deltas::default(),
        )
        .unwrap();
        write_updates(&mut header, Some(&model), 0, NODE_COUNT).unwrap();
        write_header_suffix(&mut header).unwrap();
        let bytes = header.finish().unwrap();
        let mut value = (u32::from(bytes[0]) << 8) | u32::from(bytes[1]);
        let (mut offset, mut range, mut count) = (2, 255, 0);
        let mut read = |probability: u8| {
            let split = 1 + (((range - 1) * u32::from(probability)) >> 8);
            let bit = value >= split << 8;
            if bit {
                value -= split << 8;
                range -= split;
            } else {
                range = split;
            }
            while range < 128 {
                range <<= 1;
                value <<= 1;
                count += 1;
                if count == 8 {
                    count = 0;
                    value |= u32::from(bytes[offset]);
                    offset += 1;
                }
            }
            bit
        };
        for _ in 0..16 {
            read(128);
        }
        for shift in (0..7).rev() {
            assert_eq!(read(128), 8 & (1 << shift) != 0);
        }
        for _ in 0..6 {
            read(128);
        }
        for index in 0..NODE_COUNT {
            let updated = read(super::super::COEFF_UPDATE_PROBS[index]);
            assert_eq!(updated, index == 528, "index={index}");
            if updated {
                for shift in (0..8).rev() {
                    assert_eq!(read(128), model.probabilities()[index] & (1 << shift) != 0);
                }
            }
        }
        assert!(read(128));
    }

    #[test]
    fn engine_yields_inside_a_long_carry_and_a_symbol_batch() {
        let input = vec![128, 128, 128, 255];
        let request = engine_request(1, 1, 0, &input, 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input, plan).unwrap();
        let mut writer = BoolWriter::new();
        writer.bytes = vec![255; 131_073];
        writer.bytes[0] = 7;
        writer.range = 1;
        writer.bottom = 1 << 31;
        engine.header = Some(writer);
        engine.pending_header.write(128, false).unwrap();
        assert!(!engine.step().unwrap());
        assert_eq!(engine.stage(), Stage::Initialize as u32);
        assert!(engine.pending_header.pending());
        assert_eq!(engine.header.as_ref().unwrap().carry_cursor, Some(65_537));
        assert!(engine.output().is_empty());
        assert!(!engine.step().unwrap());
        assert!(engine.pending_header.pending());
        assert!(!engine.step().unwrap());
        assert!(!engine.pending_header.pending());
        assert_eq!(engine.header.as_ref().unwrap().bytes[0], 8);

        engine.header = Some(BoolWriter::new());
        for _ in 0..3_000 {
            engine.pending_header.write(128, false).unwrap();
        }
        assert!(!engine.step().unwrap());
        assert!(engine.pending_header.pending());
        assert!(!engine.step().unwrap());
        assert!(engine.pending_header.pending());
        assert!(!engine.step().unwrap());
        assert!(!engine.pending_header.pending());
        assert_eq!(engine.stage(), Stage::Initialize as u32);
    }

    #[test]
    fn one_macroblock_operation_buffers_cover_maximum_coefficient_categories() {
        for i16 in [false, true] {
            let block = Macroblock {
                y: [[2114; 16]; 16],
                y2: [2114; 16],
                i16,
                u: [[2114; 16]; 4],
                v: [[2114; 16]; 4],
                ..Macroblock::default()
            };
            let mut header = OpBuffer::new().unwrap();
            let mut token = OpBuffer::new().unwrap();
            write_macroblock(
                &mut header,
                &mut token,
                &mut CoeffContexts::new(1),
                &mut [0; 4],
                &mut [0; 4],
                0,
                &block,
                SegmentConfig::nonsegmented(22),
            )
            .unwrap();
            assert!(header.pending());
            assert!(token.pending());
        }
    }

    fn engine_request(
        width: usize,
        height: usize,
        layout: u32,
        input: &[u8],
        stride: usize,
    ) -> Request {
        Request {
            version: 2,
            width: width as u32,
            height: height as u32,
            stride: stride as u32,
            layout,
            quality: 75,
            input_bytes: input.len() as u32,
            output_limit: 96 * 1024 * 1024,
            generation: 1,
            frame: 1,
            external_live_bytes: 0,
            retained_output_bytes: 0,
        }
    }

    fn run_engine(mut engine: FrameEncoder) -> FrameEncoder {
        let mut steps = 0;
        loop {
            let stage = engine.stage();
            let (before, _) = engine.progress();
            let done = engine.step().unwrap();
            steps += 1;
            assert!(steps < 100_000);
            if !done {
                assert!(engine.output().is_empty());
            }
            if stage == engine.stage() {
                let (after, _) = engine.progress();
                let bound = match stage {
                    0 | 13 => 65_536,
                    4 | 8 | 16 => 64,
                    _ => 1,
                };
                assert!(after >= before && after - before <= bound, "stage={stage}");
            }
            if done {
                return engine;
            }
        }
    }

    #[test]
    fn final_plan_is_visible_before_output_reservations() {
        let input = vec![37, 119, 203, 255];
        let expected = encode_textured(&input, 1, 1, 4, 0, 75).unwrap();
        let request = engine_request(1, 1, 0, &input, 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input, plan).unwrap();
        for _ in 0..100 {
            if engine.stage == Stage::PrepareOutput {
                break;
            }
            assert!(!engine.step().unwrap());
        }
        assert!(engine.stage == Stage::PrepareOutput);
        assert!(engine.plan.frame_bytes > 0);
        assert!(engine.plan.first_partition_bytes > 0);
        assert!(engine.plan.coefficient_partition_bytes > 0);
        assert_eq!(engine.plan.frame_bytes, engine.selected_frame_bytes());
        assert!(engine.header.is_none());
        assert!(engine.token.is_none());
        assert_eq!(engine.output.capacity(), 0);
        assert_eq!(engine.first.capacity(), 0);
        assert_eq!(engine.second.capacity(), 0);
        assert!(engine.output().is_empty());

        let admitted = engine.plan;
        assert!(!engine.step().unwrap());
        assert!(engine.stage == Stage::EmitPrefix);
        assert_eq!(engine.plan, admitted);
        assert!(
            engine.header.as_ref().unwrap().bytes.capacity()
                >= admitted.first_partition_bytes as usize
        );
        assert!(
            engine.token.as_ref().unwrap().bytes.capacity()
                >= admitted.coefficient_partition_bytes as usize
        );
        assert!(engine.output.capacity() >= admitted.frame_bytes as usize);
        assert!(engine.output().is_empty());
        let complete = run_engine(engine);
        assert_eq!(complete.output().len(), admitted.frame_bytes as usize);
        assert_eq!(complete.output(), expected);
    }

    #[test]
    fn resumable_engine_matches_sync_for_layouts_edges_and_recovery() {
        for (width, height) in [(1, 33), (33, 1), (31, 33)] {
            let mut rgba = Vec::new();
            for i in 0..width * height {
                rgba.extend_from_slice(&[(i * 37) as u8, (i * 13) as u8, (i * 71) as u8, 255]);
            }
            let expected = encode_textured(
                &rgba,
                width as u32,
                height as u32,
                (width * 4) as u32,
                0,
                75,
            )
            .unwrap();
            for layout in 0..=4 {
                let bpp = if layout == 4 { 3 } else { 4 };
                let stride = width * bpp + 3;
                let mut input = Vec::with_capacity(height * stride);
                for row in 0..height {
                    for col in 0..width {
                        let at = (row * width + col) * 4;
                        let [r, g, b, _] = rgba[at..at + 4].try_into().unwrap();
                        match layout {
                            0 | 2 => input.extend_from_slice(&[
                                r,
                                g,
                                b,
                                if layout == 0 { 255 } else { 7 },
                            ]),
                            1 | 3 => input.extend_from_slice(&[
                                b,
                                g,
                                r,
                                if layout == 1 { 255 } else { 7 },
                            ]),
                            _ => input.extend_from_slice(&[r, g, b]),
                        }
                    }
                    input.extend_from_slice(&[42; 3]);
                }
                let request = engine_request(width, height, layout, &input, stride);
                let plan = ResourcePlan::checked(request).unwrap();
                let mut engine = FrameEncoder::new(request, input, plan).unwrap();
                assert!(engine.take_input().is_empty());
                for _ in 0..3 {
                    engine.step().unwrap();
                }
                drop(engine);
                let input = {
                    let mut input = Vec::with_capacity(height * stride);
                    for row in 0..height {
                        for col in 0..width {
                            let at = (row * width + col) * 4;
                            let [r, g, b, _] = rgba[at..at + 4].try_into().unwrap();
                            match layout {
                                0 | 2 => input.extend_from_slice(&[
                                    r,
                                    g,
                                    b,
                                    if layout == 0 { 255 } else { 7 },
                                ]),
                                1 | 3 => input.extend_from_slice(&[
                                    b,
                                    g,
                                    r,
                                    if layout == 1 { 255 } else { 7 },
                                ]),
                                _ => input.extend_from_slice(&[r, g, b]),
                            }
                        }
                        input.extend_from_slice(&[42; 3]);
                    }
                    input
                };
                let mut engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
                assert_eq!(
                    engine.output(),
                    expected,
                    "{width}x{height} layout={layout}"
                );
                assert_eq!(engine.plan().frame_bytes as usize, expected.len());
                assert_eq!(engine.selected_frame_bytes() as usize, expected.len());
                assert!(engine.default_frame_bytes() >= engine.selected_frame_bytes());
                assert_eq!(
                    engine.update_count() == 0,
                    engine.default_frame_bytes() == engine.selected_frame_bytes()
                );
                assert!(engine.plan().first_partition_bytes > 0);
                assert!(engine.plan().coefficient_partition_bytes > 0);
                assert_eq!(engine.take_input().len(), request.input_bytes as usize);
                assert!(engine.take_input().is_empty());
                assert_eq!(engine.output(), expected);
            }
        }
    }

    #[test]
    fn resumable_engine_rejects_plan_mismatch_transparency_and_output_limit() {
        let input = vec![128, 128, 128, 255];
        let request = engine_request(1, 1, 0, &input, 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let wrong = ResourcePlan::checked(Request {
            width: 2,
            stride: 8,
            input_bytes: 8,
            ..request
        })
        .unwrap();
        assert!(matches!(
            FrameEncoder::new(request, input.clone(), wrong),
            Err(Status::InvalidInput)
        ));
        let mut transparent = input.clone();
        transparent[3] = 254;
        let mut job = FrameEncoder::new(request, transparent, plan).unwrap();
        while job.stage() == 0 {
            job.step().unwrap();
        }
        assert_eq!(job.step(), Err(Status::UnsupportedPixels));
        assert!(job.output().is_empty());
        let tight = Request {
            output_limit: 1,
            ..request
        };
        let mut job =
            FrameEncoder::new(tight, input, ResourcePlan::checked(tight).unwrap()).unwrap();
        let mut result = Ok(false);
        for _ in 0..100 {
            result = job.step();
            if result.is_err() {
                break;
            }
        }
        assert_eq!(result, Err(Status::OutputLimit));
        assert!(job.output().is_empty());
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_mixed_segment_reconstruction() {
        assert_eq!(crate::presets::deltas(75).uv_dc, -7);
        assert_eq!(crate::presets::deltas(75).uv_ac, -7);
        let input = mixed_segment_input();
        let request = engine_request(32, 16, 0, &input, 128);
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert!(engine.segments.enabled);
        let (y, u, v, padded_w) = engine.reconstruction();
        let mut expected = Vec::new();
        for (plane, stride, width, height) in [
            (y, padded_w, 32, 16),
            (u, padded_w / 2, 16, 8),
            (v, padded_w / 2, 16, 8),
        ] {
            for row in 0..height {
                expected.extend_from_slice(&plane[row * stride..row * stride + width]);
            }
        }
        assert_decodes(
            engine.output(),
            32,
            16,
            &expected,
            "mixed absolute quantizer segments with negative UV deltas",
        );
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_resumable_engine_reconstruction() {
        for (width, height) in [(1, 33), (33, 1), (31, 33), (64, 48)] {
            let mut input = Vec::with_capacity(width * height * 4);
            for i in 0..width * height {
                input.extend_from_slice(&[(i * 37) as u8, (i * 13) as u8, (i * 71) as u8, 255]);
            }
            let request = engine_request(width, height, 0, &input, width * 4);
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
            let (y, u, v, padded_w) = engine.reconstruction();
            let mut expected = Vec::new();
            for (plane, stride, w, h) in [
                (y, padded_w, width, height),
                (u, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
                (v, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
            ] {
                for row in 0..h {
                    expected.extend_from_slice(&plane[row * stride..row * stride + w]);
                }
            }
            assert_decodes(
                engine.output(),
                width,
                height,
                &expected,
                "resumable ABI2 engine",
            );
        }
    }

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
