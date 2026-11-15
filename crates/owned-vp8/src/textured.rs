// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{
    bmode_probs::BMODE_PROBS,
    limits::{Request, ResourcePlan, Status, MAX_FIRST_PARTITION_BYTES},
    prediction::{self, LargeMode, SmallMode},
    probability::{Model, Statistics, NODE_COUNT},
    rate::{probability_cost, BoolSink, CountingBoolSink, OpBuffer, RateCounter, SymbolCounter},
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FilterConfig {
    simple: bool,
    level: u8,
    sharpness: u8,
}

impl FilterConfig {
    #[cfg(test)]
    const DISABLED: Self = Self {
        simple: false,
        level: 0,
        sharpness: 0,
    };

    fn for_quality(quality: u32) -> Self {
        Self {
            simple: false,
            level: crate::presets::filter_level(quality),
            sharpness: 0,
        }
    }

    fn validate(self) -> Result<(), EncodeError> {
        if self.level > 63 || self.sharpness > 7 {
            return Err(EncodeError::InvalidInput);
        }
        Ok(())
    }

    fn write(self, sink: &mut impl BoolSink) -> Result<(), EncodeError> {
        self.validate()?;
        sink.bit(self.simple)?;
        sink.literal(u32::from(self.level), 6)?;
        sink.literal(u32::from(self.sharpness), 3)?;
        sink.bit(false)?; // Macroblock filter deltas disabled.
        Ok(())
    }
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
        3 => SmallMode::HorizontalEdge,
        4 => SmallMode::LeftDown,
        5 => SmallMode::RightDown,
        6 => SmallMode::VerticalRight,
        7 => SmallMode::VerticalLeft,
        8 => SmallMode::HorizontalDown,
        9 => SmallMode::HorizontalUp,
        _ => unreachable!("I4 trial modes are in 0..10"),
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
    let probs = BMODE_PROBS
        .get(above as usize)
        .and_then(|row| row.get(left as usize))
        .ok_or(EncodeError::InvalidInput)?;
    if mode > 9 {
        return Err(EncodeError::InvalidInput);
    }
    sink.write(probs[0], mode != 0)?;
    if mode != 0 {
        sink.write(probs[1], mode != 1)?;
        if mode != 1 {
            sink.write(probs[2], mode != 2)?;
            if mode != 2 {
                let left_down_branch = matches!(mode, 4 | 7 | 8 | 9);
                sink.write(probs[3], left_down_branch)?;
                if left_down_branch {
                    sink.write(probs[6], mode != 4)?;
                    if mode != 4 {
                        sink.write(probs[7], mode != 7)?;
                        if mode != 7 {
                            sink.write(probs[8], mode == 9)?;
                        }
                    }
                } else {
                    sink.write(probs[4], mode != 3)?;
                    if mode != 3 {
                        sink.write(probs[5], mode == 6)?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
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

struct CoeffContextWindow<'a> {
    y2: &'a mut [bool],
    y: &'a mut [bool],
    u: &'a mut [bool],
    v: &'a mut [bool],
    left_y2: &'a mut bool,
    left_y: &'a mut [bool; 4],
    left_u: &'a mut [bool; 2],
    left_v: &'a mut [bool; 2],
}

impl CoeffContextWindow<'_> {
    fn encode_coefficients(
        &mut self,
        sink: &mut impl BoolSink,
        block: &Macroblock,
        mx: usize,
    ) -> Result<(), EncodeError> {
        if block.skip() {
            if block.i16 {
                self.y2[mx] = false;
                *self.left_y2 = false;
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
            let context = usize::from(self.y2[mx]) + usize::from(*self.left_y2);
            let nonzero = residual::encode_block(sink, &block.y2, 1, context)?;
            self.y2[mx] = nonzero;
            *self.left_y2 = nonzero;
        }
        encode_macroblock_coeffs(
            sink,
            &block.y,
            if block.i16 { 0 } else { 3 },
            self.y,
            self.left_y,
            mx,
            4,
        )?;
        encode_macroblock_coeffs(sink, &block.u, 2, self.u, self.left_u, mx, 2)?;
        encode_macroblock_coeffs(sink, &block.v, 2, self.v, self.left_v, mx, 2)?;
        Ok(())
    }
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
        let mut y2 = [self.y2[mx]];
        let mut y = [false; 4];
        y.copy_from_slice(&self.y[mx * 4..mx * 4 + 4]);
        let mut u = [false; 2];
        u.copy_from_slice(&self.u[mx * 2..mx * 2 + 2]);
        let mut v = [false; 2];
        v.copy_from_slice(&self.v[mx * 2..mx * 2 + 2]);
        let mut left_y2 = self.left_y2;
        let mut left_y = self.left_y;
        let mut left_u = self.left_u;
        let mut left_v = self.left_v;
        let mut window = CoeffContextWindow {
            y2: &mut y2,
            y: &mut y,
            u: &mut u,
            v: &mut v,
            left_y2: &mut left_y2,
            left_y: &mut left_y,
            left_u: &mut left_u,
            left_v: &mut left_v,
        };
        let mut rate = RateCounter::default();
        window.encode_coefficients(&mut rate, block, 0)?;
        Ok(rate.cost)
    }
    fn encode_coefficients(
        &mut self,
        sink: &mut impl BoolSink,
        block: &Macroblock,
        mx: usize,
    ) -> Result<(), EncodeError> {
        CoeffContextWindow {
            y2: &mut self.y2,
            y: &mut self.y,
            u: &mut self.u,
            v: &mut self.v,
            left_y2: &mut self.left_y2,
            left_y: &mut self.left_y,
            left_u: &mut self.left_u,
            left_v: &mut self.left_v,
        }
        .encode_coefficients(sink, block, mx)
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
            for mode in 0..10u8 {
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
fn write_modes(
    sink: &mut impl BoolSink,
    block: &Macroblock,
    mx: usize,
    above: &[u8],
    left: &[u8; 4],
) -> Result<(), EncodeError> {
    write_y_mode(sink, block.i16, block.y_mode)?;
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
                write_bmode(sink, a, l, block.b_modes[index])?;
            }
        }
    }
    write_uv_mode(sink, block.uv_mode)
}

fn write_macroblock_header(
    sink: &mut impl BoolSink,
    block: &Macroblock,
    mx: usize,
    above: &[u8],
    left: &[u8; 4],
    segments: SegmentConfig,
    skip_probability: u8,
) -> Result<(), EncodeError> {
    segments.write_id(sink, block.segment_id)?;
    sink.write(skip_probability, block.skip())?;
    write_modes(sink, block, mx, above, left)
}

#[derive(Default)]
struct HeaderRateCounter {
    rate: RateCounter,
    symbols: SymbolCounter,
}

impl BoolSink for HeaderRateCounter {
    fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
        self.rate.write(probability, bit)?;
        self.symbols.write(probability, bit)
    }
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
    budget: &HeaderBudget,
) -> Result<Option<u64>, EncodeError> {
    let mut header = HeaderRateCounter::default();
    // Mode search precedes frozen frame statistics; its skip rate proposal is
    // the current syntax default, while counting and emission share the final.
    write_macroblock_header(&mut header, block, mx, above, left, segments, 128)?;
    if block.i16 && header.symbols.count > MAX_I16_HEADER_SYMBOLS {
        return Err(EncodeError::InvalidInput);
    }
    if !budget.fits_symbols(header.symbols.count)? {
        return Ok(None);
    }
    let cost = header.rate.cost + contexts.measure(block, mx)?;
    Ok(Some(distortion * 256 + lambda * cost))
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
            filter: FilterConfig::for_quality(quality),
        },
        0,
        |_, _, _, _, _| {},
    )
}

#[derive(Clone, Copy)]
struct FrameSpec {
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
    filter: FilterConfig,
}

fn encode_observed(
    pixels: &[u8],
    spec: FrameSpec,
    luma_policy: u8,
    observe: impl FnOnce(&[u8], &[u8], &[u8], usize, &[Macroblock]),
) -> Result<Vec<u8>, EncodeError> {
    let FrameSpec {
        width,
        height,
        stride,
        format,
        quality,
        filter,
    } = spec;
    filter.validate()?;
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
    let mut neutral_chroma = true;
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
            neutral_chroma &= u == 128 && v == 128;
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
    let mut class_counts = [0; 4];
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let id = segmentation::classify(&source_y, &source_u, &source_v, padded_w, mx, my);
            class_counts[id as usize] += 1;
            segment_ids.push(id);
        }
    }
    let segments = SegmentConfig::from_counts(quality, class_counts, count, neutral_chroma);
    let deltas = crate::presets::deltas(quality);
    let mut header_budget = HeaderBudget::new(
        count,
        segments,
        deltas,
        filter,
        MAX_FIRST_PARTITION_BYTES as usize,
    )?;
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
                &mut header_budget,
            )?);
        }
    }
    let result = emit_segmented_frame(&blocks, width, height, segments, deltas, filter)?;
    observe(
        &reconstructed_y,
        &reconstructed_u,
        &reconstructed_v,
        padded_w,
        &blocks,
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
    header_budget: &mut HeaderBudget,
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
            let Some(score) = selected_cost(
                &candidate,
                mx,
                coeff_contexts,
                above_modes,
                left_modes,
                distortion,
                lambda,
                segments,
                header_budget,
            )?
            else {
                continue;
            };
            if best.is_none_or(|previous| score < previous.0) {
                best = Some((score, li, ui));
            }
            // Trials own only stack/tile state. No committed neighbor,
            // context, mode or coefficient statistic changes here.
        }
    }
    let (_, li, ui) = best.ok_or(EncodeError::OutputLimit)?;
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
    header_budget.commit(&block, mx, above_modes, left_modes, segments)?;
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
    filter: FilterConfig,
) -> Result<(), EncodeError> {
    filter.validate()?;
    sink.bit(false)?; // YUV color space.
    sink.bit(false)?; // Decoder clamps output pixels.
    segments.write_header(sink, filter.level)?;
    filter.write(sink)?;
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

fn write_header_suffix(sink: &mut impl BoolSink, skip_probability: u8) -> Result<(), EncodeError> {
    sink.bit(true)?; // Macroblock coefficient skip flags enabled.
    sink.literal(u32::from(skip_probability), 8)
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

#[derive(Clone, Copy, Default)]
struct SkipStats {
    not_skipped: u32,
    skipped: u32,
}

impl SkipStats {
    fn observe(&mut self, skipped: bool) -> Result<(), EncodeError> {
        let count = if skipped {
            &mut self.skipped
        } else {
            &mut self.not_skipped
        };
        *count = count.checked_add(1).ok_or(EncodeError::InvalidInput)?;
        Ok(())
    }

    fn frozen_probability(self) -> u8 {
        let total = u64::from(self.not_skipped) + u64::from(self.skipped);
        if total == 0 {
            return 128;
        }
        let proposed =
            ((u64::from(self.not_skipped) * 256 + total / 2) / total).clamp(1, 255) as u8;
        let cost = |probability| {
            let flags = u64::from(self.not_skipped)
                * u64::from(probability_cost(probability, false))
                + u64::from(self.skipped) * u64::from(probability_cost(probability, true));
            // The probability literal is always signaled as eight equiprobable
            // bits, including when keeping 128. Keep it in both comparisons.
            flags + 8 * u64::from(probability_cost(128, false))
        };
        if cost(proposed) < cost(128) {
            proposed
        } else {
            128
        }
    }
}

// I16 signals at most two segment-map bits, skip, three Y-mode bits and
// three UV-mode bits. I4 additionally signals sixteen B modes, each at most
// seven bits. A Boolean symbol can emit no more than one arithmetic byte.
const MAX_I16_HEADER_SYMBOLS: usize = 9;
const FINAL_TAIL_BYTES: usize = 4;

struct HeaderBudget {
    limit: usize,
    fixed_symbols_and_tail: usize,
    committed_symbols: usize,
    total_blocks: usize,
    committed_blocks: usize,
}

impl HeaderBudget {
    fn new(
        total_blocks: usize,
        segments: SegmentConfig,
        deltas: Deltas,
        filter: FilterConfig,
        limit: usize,
    ) -> Result<Self, EncodeError> {
        let mut fixed = SymbolCounter::default();
        write_header_prefix(&mut fixed, segments, deltas, filter)?;
        write_header_suffix(&mut fixed, 128)?;
        // Each of the 1056 update nodes emits one flag and at most eight
        // literal bits. The model is frozen only after mode analysis.
        let fixed_symbols_and_tail = fixed
            .count
            .checked_add(NODE_COUNT.checked_mul(9).ok_or(EncodeError::OutputLimit)?)
            .and_then(|n| n.checked_add(FINAL_TAIL_BYTES))
            .ok_or(EncodeError::OutputLimit)?;
        let fallback = total_blocks
            .checked_mul(MAX_I16_HEADER_SYMBOLS)
            .and_then(|n| n.checked_add(fixed_symbols_and_tail))
            .ok_or(EncodeError::OutputLimit)?;
        if fallback > limit {
            return Err(EncodeError::OutputLimit);
        }
        Ok(Self {
            limit,
            fixed_symbols_and_tail,
            committed_symbols: 0,
            total_blocks,
            committed_blocks: 0,
        })
    }

    fn candidate_symbols(
        block: &Macroblock,
        mx: usize,
        above: &[u8],
        left: &[u8; 4],
        segments: SegmentConfig,
    ) -> Result<usize, EncodeError> {
        let mut symbols = SymbolCounter::default();
        write_macroblock_header(&mut symbols, block, mx, above, left, segments, 128)?;
        if block.i16 && symbols.count > MAX_I16_HEADER_SYMBOLS {
            return Err(EncodeError::InvalidInput);
        }
        Ok(symbols.count)
    }

    fn fits(
        &self,
        block: &Macroblock,
        mx: usize,
        above: &[u8],
        left: &[u8; 4],
        segments: SegmentConfig,
    ) -> Result<bool, EncodeError> {
        self.fits_symbols(Self::candidate_symbols(block, mx, above, left, segments)?)
    }

    fn fits_symbols(&self, symbols: usize) -> Result<bool, EncodeError> {
        let remaining = self
            .total_blocks
            .checked_sub(self.committed_blocks + 1)
            .ok_or(EncodeError::InvalidInput)?;
        let bound = self
            .fixed_symbols_and_tail
            .checked_add(self.committed_symbols)
            .and_then(|n| n.checked_add(symbols))
            .and_then(|n| {
                remaining
                    .checked_mul(MAX_I16_HEADER_SYMBOLS)?
                    .checked_add(n)
            })
            .ok_or(EncodeError::OutputLimit)?;
        Ok(bound <= self.limit)
    }

    fn commit(
        &mut self,
        block: &Macroblock,
        mx: usize,
        above: &[u8],
        left: &[u8; 4],
        segments: SegmentConfig,
    ) -> Result<(), EncodeError> {
        if !self.fits(block, mx, above, left, segments)? {
            return Err(EncodeError::OutputLimit);
        }
        self.committed_symbols = self
            .committed_symbols
            .checked_add(Self::candidate_symbols(block, mx, above, left, segments)?)
            .ok_or(EncodeError::OutputLimit)?;
        self.committed_blocks += 1;
        Ok(())
    }
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
    skip_probability: u8,
) -> Result<(), EncodeError> {
    write_macroblock_header(
        header,
        block,
        mx,
        above_modes,
        left_modes,
        segments,
        skip_probability,
    )?;
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
        FilterConfig::DISABLED,
    )
}

fn emit_segmented_frame(
    blocks: &[Macroblock],
    width: usize,
    height: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    filter: FilterConfig,
) -> Result<Vec<u8>, EncodeError> {
    filter.validate()?;
    let blocks_x = width.div_ceil(16);
    let blocks_y = height.div_ceil(16);
    let (model, skip_probability) = model_frozen(blocks, blocks_x, blocks_y)?;
    let default_sizes = count_partitions(
        blocks,
        blocks_x,
        blocks_y,
        segments,
        deltas,
        filter,
        None,
        skip_probability,
    )?;
    let modeled_sizes = count_partitions(
        blocks,
        blocks_x,
        blocks_y,
        segments,
        deltas,
        filter,
        Some(&model),
        skip_probability,
    )?;
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
        filter,
        selected_model,
        skip_probability,
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
) -> Result<(Model, u8), EncodeError> {
    let mut stats = Statistics::new();
    let mut skips = SkipStats::default();
    let mut contexts = CoeffContexts::new(blocks_x);
    for my in 0..blocks_y {
        contexts.row();
        for mx in 0..blocks_x {
            let block = &blocks[my * blocks_x + mx];
            skips.observe(block.skip())?;
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
    Ok((model, skips.frozen_probability()))
}

#[allow(clippy::too_many_arguments)]
fn code_partitions(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    filter: FilterConfig,
    model: Option<&Model>,
    skip_probability: u8,
    header: &mut impl BoolSink,
    token: &mut impl BoolSink,
) -> Result<(), EncodeError> {
    write_header_prefix(header, segments, deltas, filter)?;
    write_updates(header, model, 0, NODE_COUNT)?;
    write_header_suffix(header, skip_probability)?;
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
                skip_probability,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn count_partitions(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    filter: FilterConfig,
    model: Option<&Model>,
    skip_probability: u8,
) -> Result<(usize, usize), EncodeError> {
    let mut first = CountingBoolSink::default();
    let mut second = CountingBoolSink::default();
    code_partitions(
        blocks,
        blocks_x,
        blocks_y,
        segments,
        deltas,
        filter,
        model,
        skip_probability,
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
    filter: FilterConfig,
    input: Vec<u8>,
    source_y: Vec<u8>,
    source_u: Vec<u8>,
    source_v: Vec<u8>,
    reconstructed_y: Vec<u8>,
    reconstructed_u: Vec<u8>,
    reconstructed_v: Vec<u8>,
    blocks: Vec<Macroblock>,
    class_counts: [usize; 4],
    neutral_chroma: bool,
    segments: SegmentConfig,
    header_budget: HeaderBudget,
    contexts: CoeffContexts,
    above_modes: Vec<u8>,
    left_modes: [u8; 4],
    count_header: CountingBoolSink,
    count_token: CountingBoolSink,
    stats: Statistics,
    skip_stats: SkipStats,
    skip_probability: u8,
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
        Self::new_with_filter(
            request,
            input,
            plan,
            FilterConfig::for_quality(request.quality),
        )
    }

    fn new_with_filter(
        request: Request,
        input: Vec<u8>,
        plan: ResourcePlan,
        filter: FilterConfig,
    ) -> Result<Self, Status> {
        filter.validate().map_err(encode_status)?;
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
            filter,
            input,
            source_y: Vec::new(),
            source_u: Vec::new(),
            source_v: Vec::new(),
            reconstructed_y: Vec::new(),
            reconstructed_u: Vec::new(),
            reconstructed_v: Vec::new(),
            blocks,
            class_counts: [0; 4],
            neutral_chroma: true,
            segments: SegmentConfig::nonsegmented(crate::presets::qindex(request.quality)),
            header_budget: HeaderBudget::new(
                plan.macroblock_count as usize,
                SegmentConfig::nonsegmented(crate::presets::qindex(request.quality)),
                crate::presets::deltas(request.quality),
                filter,
                MAX_FIRST_PARTITION_BYTES as usize,
            )
            .map_err(encode_status)?,
            contexts: CoeffContexts::try_new(blocks_x)?,
            above_modes,
            left_modes: [0; 4],
            count_header: CountingBoolSink::default(),
            count_token: CountingBoolSink::default(),
            stats: Statistics::new(),
            skip_stats: SkipStats::default(),
            skip_probability: 128,
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
            self.neutral_chroma &= u == 128 && v == 128;
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

    fn classify_one_step(&mut self) -> Result<(), Status> {
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
        self.class_counts[segment_id as usize] += 1;
        self.blocks.push(Macroblock {
            segment_id,
            ..Macroblock::default()
        });
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            self.segments = SegmentConfig::from_counts(
                self.request.quality,
                self.class_counts,
                self.blocks.len(),
                self.neutral_chroma,
            );
            self.header_budget = HeaderBudget::new(
                self.blocks.len(),
                self.segments,
                crate::presets::deltas(self.request.quality),
                self.filter,
                MAX_FIRST_PARTITION_BYTES as usize,
            )
            .map_err(encode_status)?;
            self.cursor = 0;
            self.stage = Stage::Analyze;
        }
        Ok(())
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
            &mut self.header_budget,
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
                self.skip_probability,
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
                self.skip_probability,
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
            Stage::Classify => self.classify_one_step()?,
            Stage::Analyze => self.analyze_one_step()?,
            Stage::CollectStats => {
                let blocks_x = self.plan.padded_width as usize / 16;
                let mx = self.cursor % blocks_x;
                if mx == 0 {
                    self.contexts.row();
                }
                self.skip_stats
                    .observe(self.blocks[self.cursor].skip())
                    .map_err(encode_status)?;
                self.contexts
                    .encode_coefficients(
                        &mut StatsSink(&mut self.stats),
                        &self.blocks[self.cursor],
                        mx,
                    )
                    .map_err(encode_status)?;
                self.cursor += 1;
                if self.cursor == self.blocks.len() {
                    self.skip_probability = self.skip_stats.frozen_probability();
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
                    self.filter,
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
                write_header_suffix(&mut self.count_header, self.skip_probability)
                    .map_err(encode_status)?;
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
                    self.filter,
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
                write_header_suffix(&mut self.pending_header, self.skip_probability)
                    .map_err(encode_status)?;
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

    #[allow(clippy::too_many_arguments)]
    fn filtered_visible_yuv(
        y: &[u8],
        u: &[u8],
        v: &[u8],
        padded_w: usize,
        width: usize,
        height: usize,
        blocks: &[Macroblock],
        filter: FilterConfig,
    ) -> Vec<u8> {
        let padded_h = height.div_ceil(16) * 16;
        let mut y = y.to_vec();
        let mut u = u.to_vec();
        let mut v = v.to_vec();
        let mut planes = crate::filter::Planes {
            y: crate::filter::Plane {
                data: &mut y,
                width: padded_w,
                height: padded_h,
                stride: padded_w,
            },
            u: crate::filter::Plane {
                data: &mut u,
                width: padded_w / 2,
                height: padded_h / 2,
                stride: padded_w / 2,
            },
            v: crate::filter::Plane {
                data: &mut v,
                width: padded_w / 2,
                height: padded_h / 2,
                stride: padded_w / 2,
            },
        };
        let params: Vec<_> = blocks
            .iter()
            .map(|block| crate::filter::FilterParams {
                level: filter.level,
                sharpness: filter.sharpness,
                simple: filter.simple,
                i4: !block.i16,
                has_coefficients: !block.skip(),
            })
            .collect();
        crate::filter::filter_frame(&mut planes, padded_w / 16, padded_h / 16, &params).unwrap();
        let mut visible = Vec::new();
        for (plane, stride, w, h) in [
            (&y, padded_w, width, height),
            (&u, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
            (&v, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
        ] {
            for row in 0..h {
                visible.extend_from_slice(&plane[row * stride..row * stride + w]);
            }
        }
        visible
    }

    #[test]
    fn local_coefficient_trial_matches_full_context_and_preserves_state() {
        for width in [1, 2, 17, 1024] {
            for mx in [0, width / 2, width - 1] {
                for pattern in 0..4 {
                    let mut contexts = CoeffContexts::new(width);
                    let flag = |i: usize| match pattern {
                        0 => false,
                        1 => true,
                        2 => i.is_multiple_of(2),
                        _ => i.is_multiple_of(3),
                    };
                    for (i, value) in contexts.y2.iter_mut().enumerate() {
                        *value = flag(i);
                    }
                    for (i, value) in contexts.y.iter_mut().enumerate() {
                        *value = flag(i + 1);
                    }
                    for (i, value) in contexts.u.iter_mut().enumerate() {
                        *value = flag(i + 2);
                    }
                    for (i, value) in contexts.v.iter_mut().enumerate() {
                        *value = flag(i + 3);
                    }
                    contexts.left_y2 = flag(5);
                    contexts.left_y = std::array::from_fn(|i| flag(i + 6));
                    contexts.left_u = std::array::from_fn(|i| flag(i + 10));
                    contexts.left_v = std::array::from_fn(|i| flag(i + 12));
                    for variant in 0..5 {
                        let mut block = Macroblock {
                            i16: matches!(variant, 1 | 3 | 4),
                            ..Macroblock::default()
                        };
                        match variant {
                            2 => {
                                block.y[0][0] = 1;
                                block.y[3][5] = -2;
                                block.u[2][9] = 5;
                                block.v[3][15] = -67;
                            }
                            3 => {
                                block.y2[0] = -5;
                                block.y2[15] = 67;
                                for (i, coeffs) in block.y.iter_mut().enumerate() {
                                    coeffs[(i * 3) % 16] = if i % 2 == 0 { 2114 } else { -2114 };
                                }
                                block.u[0][0] = -1;
                                block.v[1][7] = 11;
                            }
                            4 => block.y2[4] = -2,
                            _ => {}
                        }
                        let before = contexts.clone();
                        let trial_rate = contexts.measure(&block, mx).unwrap();
                        assert_eq!(contexts, before, "trial mutated width={width} mx={mx} pattern={pattern} variant={variant}");
                        let mut committed = before.clone();
                        let mut rate = RateCounter::default();
                        committed
                            .encode_coefficients(&mut rate, &block, mx)
                            .unwrap();
                        assert_eq!(
                            trial_rate, rate.cost,
                            "width={width} mx={mx} pattern={pattern} variant={variant}"
                        );
                        for other in 0..width {
                            if other != mx {
                                assert_eq!(committed.y2[other], before.y2[other]);
                                assert_eq!(
                                    &committed.y[other * 4..other * 4 + 4],
                                    &before.y[other * 4..other * 4 + 4]
                                );
                                assert_eq!(
                                    &committed.u[other * 2..other * 2 + 2],
                                    &before.u[other * 2..other * 2 + 2]
                                );
                                assert_eq!(
                                    &committed.v[other * 2..other * 2 + 2],
                                    &before.v[other * 2..other * 2 + 2]
                                );
                            }
                        }
                        let mut invalid = Macroblock {
                            i16: block.i16,
                            ..Macroblock::default()
                        };
                        if invalid.i16 {
                            invalid.y2[0] = 1;
                        }
                        invalid.y[0][0] = 1;
                        invalid.u[0][0] = -1;
                        invalid.v[3][15] = 2115;
                        assert_eq!(
                            contexts.measure(&invalid, mx),
                            Err(EncodeError::InvalidInput)
                        );
                        assert_eq!(contexts, before, "failed trial mutated state");
                    }
                }
            }
        }
    }

    #[test]
    fn all_i4_modes_follow_the_normative_tree() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let paths = [
            "0", "10", "110", "11100", "11110", "111010", "111011", "111110", "1111110", "1111111",
        ];
        let nodes: [&[usize]; 10] = [
            &[0],
            &[0, 1],
            &[0, 1, 2],
            &[0, 1, 2, 3, 4],
            &[0, 1, 2, 3, 6],
            &[0, 1, 2, 3, 4, 5],
            &[0, 1, 2, 3, 4, 5],
            &[0, 1, 2, 3, 6, 7],
            &[0, 1, 2, 3, 6, 7, 8],
            &[0, 1, 2, 3, 6, 7, 8],
        ];
        for (above, left) in [(0, 0), (9, 9)] {
            for mode in 0..10u8 {
                let mut operations = Operations(Vec::new());
                write_bmode(&mut operations, above, left, mode).unwrap();
                let actual: String = operations
                    .0
                    .iter()
                    .map(|(_, bit)| if *bit { '1' } else { '0' })
                    .collect();
                assert_eq!(actual, paths[mode as usize]);
                assert_eq!(
                    operations.0.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
                    nodes[mode as usize]
                        .iter()
                        .map(|&node| BMODE_PROBS[above as usize][left as usize][node])
                        .collect::<Vec<_>>()
                );
            }
        }
        assert_eq!(
            write_bmode(&mut Operations(Vec::new()), 0, 0, 10),
            Err(EncodeError::InvalidInput)
        );
    }

    #[test]
    fn first_partition_symbol_reservation_covers_every_mode_and_admitted_geometry() {
        let nonsegmented = SegmentConfig::nonsegmented(23);
        let segmented = SegmentConfig::from_counts(75, [1; 4], 4, false);
        for segments in [nonsegmented, segmented] {
            for i16 in [true, false] {
                for y_mode in 0..4 {
                    for uv_mode in 0..4 {
                        for b_mode in 0..10 {
                            let block = Macroblock {
                                i16,
                                y_mode,
                                uv_mode,
                                b_modes: [b_mode; 16],
                                segment_id: if segments.enabled { 3 } else { 0 },
                                ..Macroblock::default()
                            };
                            for above in [0, 9] {
                                let symbols = HeaderBudget::candidate_symbols(
                                    &block,
                                    0,
                                    &[above; 4],
                                    &[above; 4],
                                    segments,
                                )
                                .unwrap();
                                assert!(symbols <= if i16 { 9 } else { 119 });
                            }
                        }
                    }
                }
            }
        }

        // The pixel/axis limits have their largest padded MB count at an
        // asymmetric size; iterating all widths keeps that bound tied to code.
        let mut maximum = 0;
        for width in 1..=crate::limits::MAX_DIMENSION as usize {
            let height = (crate::limits::MAX_PIXELS as usize / width)
                .min(crate::limits::MAX_DIMENSION as usize);
            maximum = maximum.max(width.div_ceil(16) * height.div_ceil(16));
        }
        assert_eq!(maximum, 40_280);
        let admitted = ResourcePlan::checked(Request {
            version: 2,
            width: 625,
            height: 16_106,
            stride: 625 * 3,
            layout: 4,
            quality: 75,
            input_bytes: 625 * 16_106 * 3,
            output_limit: 96 * 1024 * 1024,
            generation: 1,
            frame: 1,
            external_live_bytes: 0,
            retained_output_bytes: 0,
        })
        .unwrap();
        assert_eq!(admitted.macroblock_count as usize, maximum);
        let budget = HeaderBudget::new(
            maximum,
            segmented,
            crate::presets::deltas(75),
            FilterConfig::for_quality(75),
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap();
        assert!(budget.fixed_symbols_and_tail + maximum * MAX_I16_HEADER_SYMBOLS < budget.limit);

        let mut worst = CountingBoolSink::default();
        let mut symbols = SymbolCounter::default();
        for _ in 0..512 {
            for probability in [1, 2, 127, 254, 255] {
                worst.write(probability, false).unwrap();
                symbols.write(probability, false).unwrap();
                worst.write(probability, true).unwrap();
                symbols.write(probability, true).unwrap();
            }
        }
        assert!(worst.finish_size().unwrap() <= symbols.count + FINAL_TAIL_BYTES);
    }

    #[test]
    fn first_partition_budget_switch_preserves_future_i16_capacity() {
        let segments = SegmentConfig::from_counts(75, [1; 4], 4, false);
        let fixed = HeaderBudget::new(
            3,
            segments,
            Deltas::default(),
            FilterConfig::DISABLED,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap()
        .fixed_symbols_and_tail;
        let i4 = Macroblock {
            b_modes: [9; 16],
            segment_id: 3,
            ..Macroblock::default()
        };
        let i16 = Macroblock {
            i16: true,
            segment_id: 3,
            ..Macroblock::default()
        };
        let mut above = [0; 12];
        let mut left = [0; 4];
        let first = HeaderBudget::candidate_symbols(&i4, 0, &above, &left, segments).unwrap();
        let mut budget = HeaderBudget::new(
            3,
            segments,
            Deltas::default(),
            FilterConfig::DISABLED,
            fixed + first + 2 * MAX_I16_HEADER_SYMBOLS,
        )
        .unwrap();
        budget.commit(&i4, 0, &above, &left, segments).unwrap();
        update_modes(&i4, 0, &mut above, &mut left);
        assert!(!budget.fits(&i4, 1, &above, &left, segments).unwrap());
        assert!(budget.fits(&i16, 1, &above, &left, segments).unwrap());
        budget.commit(&i16, 1, &above, &left, segments).unwrap();
        update_modes(&i16, 1, &mut above, &mut left);
        assert_eq!(&above[4..8], &[0; 4]);
        assert_eq!(left, [0; 4]);
        assert!(budget.fits(&i16, 2, &above, &left, segments).unwrap());
    }

    fn forced_budget_frame() -> (Vec<u8>, Vec<u8>) {
        fn run(
            source_y: &[u8],
            source_uv: &[u8],
            limit: usize,
        ) -> (
            Vec<Macroblock>,
            Vec<u8>,
            Vec<u8>,
            Vec<u8>,
            HeaderBudget,
            usize,
        ) {
            let mut reconstructed_y = vec![0; 32 * 16];
            let mut reconstructed_u = vec![0; 16 * 8];
            let mut reconstructed_v = vec![0; 16 * 8];
            let mut contexts = CoeffContexts::new(2);
            let mut above = vec![0; 8];
            let mut left = [0; 4];
            let segments = SegmentConfig::nonsegmented(23);
            let mut budget = HeaderBudget::new(
                2,
                segments,
                Deltas::default(),
                FilterConfig::DISABLED,
                limit,
            )
            .unwrap();
            contexts.row();
            let mut blocks = Vec::new();
            let mut first_symbols = 0;
            for mx in 0..2 {
                let block = analyze_one(
                    source_y,
                    source_uv,
                    source_uv,
                    &mut reconstructed_y,
                    &mut reconstructed_u,
                    &mut reconstructed_v,
                    32,
                    16,
                    mx,
                    0,
                    ac_quant::steps(23, Deltas::default(), Plane::Y1),
                    ac_quant::steps(23, Deltas::default(), Plane::UV),
                    ac_quant::steps(23, Deltas::default(), Plane::Y2),
                    &mut contexts,
                    &mut above,
                    &mut left,
                    crate::presets::lambda_for_q(23),
                    if mx == 0 { 2 } else { 0 },
                    0,
                    segments,
                    &mut budget,
                )
                .unwrap();
                blocks.push(block);
                if mx == 0 {
                    first_symbols = budget.committed_symbols;
                }
            }
            (
                blocks,
                reconstructed_y,
                reconstructed_u,
                reconstructed_v,
                budget,
                first_symbols,
            )
        }
        let source_y: Vec<u8> = (0..16)
            .flat_map(|row| {
                (0..32).map(move |col| ((col * 17 + row * 31 + col * row * 7) % 256) as u8)
            })
            .collect();
        let source_uv = vec![128; 16 * 8];
        let (_, _, _, _, first_pass, first_symbols) =
            run(&source_y, &source_uv, MAX_FIRST_PARTITION_BYTES as usize);
        let limit = first_pass.fixed_symbols_and_tail + first_symbols + MAX_I16_HEADER_SYMBOLS;
        let (blocks, y, u, v, budget, _) = run(&source_y, &source_uv, limit);
        assert!(!blocks[0].i16 && blocks[1].i16);
        assert_eq!(budget.committed_blocks, 2);
        assert!(budget.fixed_symbols_and_tail + budget.committed_symbols <= limit);
        let expected = y.into_iter().chain(u).chain(v).collect();
        let frame = emit_segmented_frame(
            &blocks,
            32,
            16,
            SegmentConfig::nonsegmented(23),
            Deltas::default(),
            FilterConfig::DISABLED,
        )
        .unwrap();
        let first_partition = u32::from_le_bytes([frame[0], frame[1], frame[2], 0]) >> 5;
        assert!(first_partition as usize <= limit);
        (frame, expected)
    }

    #[test]
    fn forced_header_budget_keeps_a_decodable_frame() {
        let (frame, expected) = forced_budget_frame();
        assert_eq!(expected.len(), 32 * 16 * 3 / 2);
        assert!(frame.len() > 10);
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoders_reconstruct_forced_header_budget_switch() {
        let (frame, expected) = forced_budget_frame();
        assert_decodes(
            &frame,
            32,
            16,
            &expected,
            "first partition I4/I16 budget switch",
        );
    }

    #[test]
    fn filter_header_and_internal_controls_are_explicit() {
        struct Bits(Vec<bool>);
        impl BoolSink for Bits {
            fn write(&mut self, _probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push(bit);
                Ok(())
            }
        }
        for (quality, level) in [(60, 6), (75, 4), (85, 4)] {
            assert_eq!(FilterConfig::for_quality(quality).level, level);
        }
        let filter = FilterConfig {
            simple: true,
            level: 6,
            sharpness: 3,
        };
        let mut bits = Bits(Vec::new());
        write_header_prefix(
            &mut bits,
            SegmentConfig::nonsegmented(23),
            Deltas::default(),
            filter,
        )
        .unwrap();
        assert_eq!(
            &bits.0[3..14],
            &[true, false, false, false, true, true, false, false, true, true, false]
        );
        for invalid in [
            FilterConfig {
                level: 64,
                ..filter
            },
            FilterConfig {
                sharpness: 8,
                ..filter
            },
        ] {
            assert_eq!(
                invalid.write(&mut Bits(Vec::new())),
                Err(EncodeError::InvalidInput)
            );
            let pixels = [128, 128, 128, 255];
            let request = engine_request(1, 1, 0, &pixels, 4);
            let plan = ResourcePlan::checked(request).unwrap();
            assert!(matches!(
                FrameEncoder::new_with_filter(request, pixels.to_vec(), plan, invalid),
                Err(Status::InvalidInput)
            ));
        }
    }

    #[test]
    fn i4_top_right_uses_reconstructed_above_row_or_frame_edge() {
        let mut global = vec![0u8; 32 * 32];
        global[15 * 32 + 16..15 * 32 + 20].copy_from_slice(&[11, 22, 33, 44]);
        global[15 * 32 + 31] = 99;
        let mut tile = [0u8; 256];
        tile[3 * 16 + 12..3 * 16 + 16].copy_from_slice(&[1, 2, 3, 4]);
        tile[3 * 16 + 11] = 88;
        let (top, _, corner) = i4_edge(&global, &tile, 32, 0, 1, 3, 1);
        assert_eq!(top, [1, 2, 3, 4, 11, 22, 33, 44]);
        assert_eq!(corner, tile[3 * 16 + 11]);
        let (right_top, _, _) = i4_edge(&global, &tile, 32, 1, 1, 3, 1);
        assert_eq!(right_top, [1, 2, 3, 4, 99, 99, 99, 99]);
    }

    fn mixed_segment_input() -> Vec<u8> {
        let mut pixels = Vec::with_capacity(64 * 16 * 4);
        let mut seed = 0x501u32;
        for y in 0..16 {
            for x in 0..64 {
                let rgb = if x < 16 {
                    [80 + x as u8 + y as u8; 3]
                } else if x < 32 {
                    // One-level variation exercises flat, rather than constant/fine, tiles.
                    let step = u8::from(x >= 24);
                    [40 + step, 80 + step, 120 + step]
                } else if x < 48 {
                    let ramp = (x - 32 + y) as u8;
                    [40 + ramp, 80 + ramp, 120 + ramp]
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
        let request = engine_request(64, 16, 0, &input, 256);
        let plan = ResourcePlan::checked(request).unwrap();
        let first = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
        assert!(first.segments.enabled);
        assert_eq!(first.class_counts, [1, 1, 1, 1]);
        assert_eq!(
            first.segments.qindex,
            [
                crate::presets::SMOOTH_QINDEX,
                crate::presets::chromatic_flat_qindex(request.quality),
                crate::presets::chromatic_ramp_qindex(request.quality),
                crate::presets::textured_qindex(request.quality, false)
            ]
        );
        assert_eq!(first.segments.map_probabilities, [128, 128, 128]);
        assert_eq!(
            first
                .blocks
                .iter()
                .map(|b| b.segment_id)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        assert_eq!(
            first.output(),
            encode_textured(&input, 64, 16, 256, 0, 75).unwrap()
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

        let chromatic = [40, 80, 120, 255].repeat(16 * 16);
        let chromatic_request = engine_request(16, 16, 0, &chromatic, 64);
        let chromatic_plan = ResourcePlan::checked(chromatic_request).unwrap();
        let chromatic_engine = run_engine(
            FrameEncoder::new(chromatic_request, chromatic.clone(), chromatic_plan).unwrap(),
        );
        assert_eq!(chromatic_engine.class_counts, [1, 0, 0, 0]);
        assert!(!chromatic_engine.segments.enabled);
        assert_eq!(
            chromatic_engine.segments.base_qindex,
            crate::presets::SMOOTH_QINDEX
        );
        assert_eq!(
            chromatic_engine.output(),
            encode_textured(&chromatic, 16, 16, 64, 0, 75).unwrap()
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
        let segments = SegmentConfig::from_counts(75, [1, 1, 1, 1], 4, false);
        let mut header = Operations(Vec::new());
        write_header_prefix(
            &mut header,
            segments,
            crate::presets::deltas(75),
            FilterConfig::DISABLED,
        )
        .unwrap();
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
            128,
        )
        .unwrap();
        assert_eq!(&header.0[..3], &[(128, true), (128, true), (128, true)]);
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
        for (quality, expected_dc, expected_ac) in [(60, -4, -15), (75, -9, -9), (85, -4, -4)] {
            let deltas = crate::presets::deltas(quality);
            assert_eq!(deltas.uv_dc, expected_dc);
            assert_eq!(deltas.uv_ac, expected_ac);
            assert_eq!(deltas.y1_dc, 0);
            assert_eq!(deltas.y2_dc, 0);
            assert_eq!(deltas.y2_ac, 0);
        }
        let mut header = Operations(Vec::new());
        write_header_prefix(
            &mut header,
            SegmentConfig::nonsegmented(23),
            Deltas {
                uv_dc: -7,
                uv_ac: -7,
                ..Deltas::default()
            },
            FilterConfig::DISABLED,
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
        let (small_model, small_skip_probability) = model_frozen(&small, 1, 1).unwrap();
        assert!((0..NODE_COUNT).all(|i| !small_model.updated(i).unwrap()));
        let small_default = count_partitions(
            &small,
            1,
            1,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            FilterConfig::DISABLED,
            None,
            small_skip_probability,
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
        let (model, skip_probability) = model_frozen(&blocks, 16, 16).unwrap();
        assert!((0..NODE_COUNT).any(|i| model.updated(i).unwrap()));
        let default = count_partitions(
            &blocks,
            16,
            16,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            FilterConfig::DISABLED,
            None,
            skip_probability,
        )
        .unwrap();
        let proposed = count_partitions(
            &blocks,
            16,
            16,
            SegmentConfig::nonsegmented(22),
            Deltas::default(),
            FilterConfig::DISABLED,
            Some(&model),
            skip_probability,
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
    fn frozen_skip_probability_signals_extremes_and_pays_for_its_literal() {
        let mut all_skip = SkipStats::default();
        let mut none_skip = SkipStats::default();
        let mut mixed = SkipStats::default();
        for index in 0..256 {
            all_skip.observe(true).unwrap();
            none_skip.observe(false).unwrap();
            mixed.observe(index < 16).unwrap();
        }
        assert_eq!(SkipStats::default().frozen_probability(), 128);
        assert_eq!(all_skip.frozen_probability(), 1);
        assert_eq!(none_skip.frozen_probability(), 255);
        assert_eq!(mixed.frozen_probability(), 240);
        let mut balanced = SkipStats::default();
        balanced.observe(true).unwrap();
        balanced.observe(false).unwrap();
        assert_eq!(balanced.frozen_probability(), 128);

        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        for probability in [1, 128, 240, 255] {
            let mut suffix = Operations(Vec::new());
            write_header_suffix(&mut suffix, probability).unwrap();
            assert_eq!(suffix.0[0], (128, true));
            assert_eq!(suffix.0.len(), 9);
            for shift in (0..8).rev() {
                assert_eq!(suffix.0[8 - shift], (128, probability & (1 << shift) != 0));
            }
            let block = Macroblock::default();
            let mut header = Operations(Vec::new());
            write_macroblock_header(
                &mut header,
                &block,
                0,
                &[0; 4],
                &[0; 4],
                SegmentConfig::nonsegmented(22),
                probability,
            )
            .unwrap();
            assert_eq!(header.0[0], (probability, true));
        }
    }

    #[test]
    fn frozen_skip_probability_saves_actual_bytes_with_exact_counted_emission() {
        let mut blocks: Vec<_> = (0..256)
            .map(|index| {
                let mut block = Macroblock::default();
                if index % 16 != 0 {
                    block.y[0][0] = 1; // I4 DC, so non-skip has real tokens.
                }
                block
            })
            .collect();
        let segments = SegmentConfig::nonsegmented(22);
        for expected_probability in [240, 255, 1] {
            if expected_probability == 255 {
                for block in &mut blocks {
                    block.y[0][0] = 1;
                }
            } else if expected_probability == 1 {
                for block in &mut blocks {
                    block.y[0][0] = 0;
                }
            }
            let (model, probability) = model_frozen(&blocks, 16, 16).unwrap();
            assert_eq!(probability, expected_probability);
            let baseline = count_partitions(
                &blocks,
                16,
                16,
                segments,
                Deltas::default(),
                FilterConfig::DISABLED,
                None,
                128,
            )
            .unwrap();
            let mut sizes = [(0, 0); 2];
            for (index, coefficient_model) in [None, Some(&model)].into_iter().enumerate() {
                let counted = count_partitions(
                    &blocks,
                    16,
                    16,
                    segments,
                    Deltas::default(),
                    FilterConfig::DISABLED,
                    coefficient_model,
                    probability,
                )
                .unwrap();
                let mut header = BoolWriter::new();
                let mut token = BoolWriter::new();
                code_partitions(
                    &blocks,
                    16,
                    16,
                    segments,
                    Deltas::default(),
                    FilterConfig::DISABLED,
                    coefficient_model,
                    probability,
                    &mut header,
                    &mut token,
                )
                .unwrap();
                assert_eq!(
                    counted,
                    (
                        header.finish().unwrap().len(),
                        token.finish().unwrap().len()
                    )
                );
                sizes[index] = counted;
            }
            assert!(sizes[0].0 < baseline.0);
            let selected = if sizes[1].0 + sizes[1].1 < sizes[0].0 + sizes[0].1 {
                sizes[1]
            } else {
                sizes[0]
            };
            let frame = emit_frame(&blocks, 256, 256, 22).unwrap();
            assert_eq!(frame.len(), 10 + selected.0 + selected.1);
            assert_eq!(frame, emit_frame(&blocks, 256, 256, 22).unwrap());
        }
    }

    #[test]
    fn resumable_and_sync_encoders_share_frozen_skip_probability() {
        let width = 128;
        let height = 128;
        let input = [128, 128, 128, 255].repeat(width * height);
        let expected = encode_textured(
            &input,
            width as u32,
            height as u32,
            (width * 4) as u32,
            0,
            75,
        )
        .unwrap();
        let request = engine_request(width, height, 0, &input, width * 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert_ne!(engine.skip_probability, 128);
        assert_eq!(engine.output(), expected);
        assert_eq!(engine.plan().frame_bytes as usize, expected.len());
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
            FilterConfig::DISABLED,
        )
        .unwrap();
        write_updates(&mut header, Some(&model), 0, NODE_COUNT).unwrap();
        write_header_suffix(&mut header, 128).unwrap();
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
                128,
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

    fn textured_checker(low: [u8; 3], high: [u8; 3]) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(16 * 16 * 4);
        for y in 0..16 {
            for x in 0..16 {
                let rgb = if (x + y) % 2 == 0 { low } else { high };
                pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        pixels
    }

    fn near_neutral_high(uv_value: u8) -> [u8; 3] {
        for r in 184..=200 {
            for g in 184..=200 {
                for b in 184..=200 {
                    let high = [r, g, b];
                    let (_, u, v) = crate::color::convert_2x2([[64; 3], high, high, [64; 3]]);
                    if u.abs_diff(128) <= 1
                        && v.abs_diff(128) <= 1
                        && (u == uv_value || v == uv_value)
                    {
                        return high;
                    }
                }
            }
        }
        panic!("missing near-neutral imported chroma value {uv_value}");
    }

    #[test]
    fn exact_neutral_frame_allocation_and_repeated_frame_state() {
        let gray = textured_checker([64; 3], [192; 3]);
        let colored = textured_checker([7, 239, 117], [248, 18, 184]);
        let one_near_neutral_pair = |value| {
            let mut pixels = gray.clone();
            let tint = near_neutral_high(value);
            for (x, y) in [(15, 14), (14, 15)] {
                let at = (y * 16 + x) * 4;
                pixels[at..at + 3].copy_from_slice(&tint);
            }
            pixels
        };
        let near_low = one_near_neutral_pair(127);
        let near_high = one_near_neutral_pair(129);
        let mut first_gray = None;
        for (index, (input, expected_neutral, expected_q)) in [
            (&gray, true, 27),
            (&colored, false, 28),
            (&near_low, false, 28),
            (&near_high, false, 28),
            (&gray, true, 27),
        ]
        .into_iter()
        .enumerate()
        {
            let request = engine_request(16, 16, 0, input, 64);
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            assert_eq!(engine.class_counts, [0, 0, 0, 1]);
            assert_eq!(engine.neutral_chroma, expected_neutral);
            assert_eq!(
                engine.segments.qindex_for(segmentation::TEXTURED),
                expected_q
            );
            assert_eq!(
                engine.source_u.iter().all(|&u| u == 128)
                    && engine.source_v.iter().all(|&v| v == 128),
                expected_neutral
            );
            if index == 2 {
                assert!(engine.source_u.contains(&127) || engine.source_v.contains(&127));
            }
            if index == 3 {
                assert!(engine.source_u.contains(&129) || engine.source_v.contains(&129));
            }
            if matches!(index, 2 | 3) {
                assert_eq!(
                    engine
                        .source_u
                        .iter()
                        .zip(&engine.source_v)
                        .filter(|(u, v)| **u != 128 || **v != 128)
                        .count(),
                    1
                );
            }
            let sync = encode_textured(input, 16, 16, 64, 0, 75).unwrap();
            assert_eq!(engine.output(), sync);
            if index == 0 {
                first_gray = Some(sync);
            } else if index == 4 {
                assert_eq!(Some(sync), first_gray);
            }
        }
        for (quality, expected_q) in [(60, 34), (85, 14)] {
            let request = Request {
                quality,
                ..engine_request(16, 16, 0, &gray, 64)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, gray.clone(), plan).unwrap());
            assert_eq!(
                engine.segments.qindex_for(segmentation::TEXTURED),
                expected_q
            );
            assert_eq!(
                engine.output(),
                encode_textured(&gray, 16, 16, 64, 0, quality).unwrap()
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn neutral_and_colored_texture_decode_with_both_filter_modes() {
        for (input, expected_q) in [
            (textured_checker([64; 3], [192; 3]), 27),
            (textured_checker([7, 239, 117], [248, 18, 184]), 28),
        ] {
            let request = engine_request(16, 16, 0, &input, 64);
            let plan = ResourcePlan::checked(request).unwrap();
            for filter in [FilterConfig::DISABLED, FilterConfig::for_quality(75)] {
                let engine = run_engine(
                    FrameEncoder::new_with_filter(request, input.clone(), plan, filter).unwrap(),
                );
                assert_eq!(
                    engine.segments.qindex_for(segmentation::TEXTURED),
                    expected_q
                );
                let (y, u, v, padded_w) = engine.reconstruction();
                let expected =
                    filtered_visible_yuv(y, u, v, padded_w, 16, 16, &engine.blocks, filter);
                assert_decodes(engine.output(), 16, 16, &expected, "neutral/color texture");
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
        assert_ne!(crate::presets::deltas(75).uv_dc, 0);
        assert_ne!(crate::presets::deltas(75).uv_ac, 0);
        let input = mixed_segment_input();
        let request = engine_request(64, 16, 0, &input, 256);
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert!(engine.segments.enabled);
        assert_eq!(engine.class_counts, [1, 1, 1, 1]);
        assert_eq!(
            engine
                .blocks
                .iter()
                .map(|block| block.segment_id)
                .collect::<Vec<_>>(),
            [
                segmentation::FINE_SMOOTH,
                segmentation::CHROMATIC_FLAT,
                segmentation::CHROMATIC_RAMP,
                segmentation::TEXTURED
            ]
        );
        let (y, u, v, padded_w) = engine.reconstruction();
        let expected =
            filtered_visible_yuv(y, u, v, padded_w, 64, 16, &engine.blocks, engine.filter);
        assert_decodes(
            engine.output(),
            64,
            16,
            &expected,
            "four absolute quantizer segments with enabled filter",
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
            let engine = run_engine(
                FrameEncoder::new_with_filter(request, input, plan, FilterConfig::DISABLED)
                    .unwrap(),
            );
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
    fn independent_decoder_reconstructs_every_forced_i4_mode() {
        for mode in 0..10u8 {
            let block = Macroblock {
                b_modes: [mode; 16],
                ..Macroblock::default()
            };
            let frame = emit_frame(&[block], 16, 16, 23).unwrap();
            let global = [0u8; 256];
            let mut tile = [0u8; 256];
            for by in 0..4 {
                for bx in 0..4 {
                    let (top, left, corner) = i4_edge(&global, &tile, 16, 0, 0, bx, by);
                    let patch = prediction::predict_i4(&top, &left, corner, bmode_from_u8(mode));
                    store_patch::<16, 256>(&mut tile, bx, by, &patch);
                }
            }
            let mut expected = tile.to_vec();
            expected.extend_from_slice(&[128; 64]);
            expected.extend_from_slice(&[128; 64]);
            assert_decodes(&frame, 16, 16, &expected, &format!("forced I4 mode {mode}"));
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_i4_above_right_across_macroblocks_and_image_edge() {
        const STRIDE: usize = 48;
        const HEIGHT: usize = 29;
        const WIDTH: usize = 45;
        let steps = ac_quant::steps(23, Deltas::default(), Plane::Y1);
        for mode in 0..10u8 {
            let mut blocks = Vec::with_capacity(6);
            for my in 0..2 {
                for mx in 0..3 {
                    let mut block = Macroblock {
                        b_modes: if my == 0 {
                            std::array::from_fn(|i| ((i + mx * 3) % 10) as u8)
                        } else {
                            [mode; 16]
                        },
                        ..Macroblock::default()
                    };
                    if my == 0 {
                        for (i, coefficients) in block.y.iter_mut().enumerate() {
                            coefficients[0] = ((i * 7 + mx * 13) % 17) as i16 - 8;
                            coefficients[1] = ((i * 3 + mx * 5) % 5) as i16 - 2;
                            coefficients[4] = ((i * 5 + mx * 3) % 5) as i16 - 2;
                        }
                    }
                    blocks.push(block);
                }
            }

            let mut y = vec![0u8; STRIDE * 32];
            for my in 0..2 {
                for mx in 0..3 {
                    let block = &blocks[my * 3 + mx];
                    let mut tile = [0u8; 256];
                    for by in 0..4 {
                        for bx in 0..4 {
                            let index = by * 4 + bx;
                            let (top, left, corner) = i4_edge(&y, &tile, STRIDE, mx, my, bx, by);
                            if mode == 4 && my == 1 && mx == 1 && bx == 3 && by > 0 {
                                assert_eq!(&top[4..], &y[15 * STRIDE + 32..15 * STRIDE + 36]);
                                let mut wrong_top = top;
                                wrong_top[4..].fill(tile[(by * 4 - 1) * 16 + 15]);
                                assert_ne!(
                                    prediction::predict_i4(
                                        &top,
                                        &left,
                                        corner,
                                        SmallMode::LeftDown
                                    ),
                                    prediction::predict_i4(
                                        &wrong_top,
                                        &left,
                                        corner,
                                        SmallMode::LeftDown
                                    ),
                                    "fixture must detect local-row above-right substitution"
                                );
                            }
                            if mode == 4 && my == 1 && mx == 2 && bx == 3 && by > 0 {
                                assert_eq!(top[4..], [y[15 * STRIDE + 47]; 4]);
                            }
                            let predicted = prediction::predict_i4(
                                &top,
                                &left,
                                corner,
                                bmode_from_u8(block.b_modes[index]),
                            );
                            let residual = transform::inverse(&ac_quant::dequantize_block(
                                &block.y[index],
                                steps,
                            ));
                            let patch = std::array::from_fn(|i| {
                                clamp(i32::from(predicted[i]) + i32::from(residual[i]))
                            });
                            store_patch::<16, 256>(&mut tile, bx, by, &patch);
                        }
                    }
                    for row in 0..16 {
                        y[(my * 16 + row) * STRIDE + mx * 16
                            ..(my * 16 + row) * STRIDE + mx * 16 + 16]
                            .copy_from_slice(&tile[row * 16..row * 16 + 16]);
                    }
                }
            }
            let mut expected =
                Vec::with_capacity(WIDTH * HEIGHT + WIDTH.div_ceil(2) * HEIGHT.div_ceil(2) * 2);
            for row in 0..HEIGHT {
                expected.extend_from_slice(&y[row * STRIDE..row * STRIDE + WIDTH]);
            }
            expected.extend(std::iter::repeat_n(
                128u8,
                WIDTH.div_ceil(2) * HEIGHT.div_ceil(2) * 2,
            ));
            let frame = emit_frame(&blocks, WIDTH, HEIGHT, 23).unwrap();
            assert_decodes(
                &frame,
                WIDTH,
                HEIGHT,
                &expected,
                &format!("multi-macroblock forced I4 mode {mode}"),
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_mixed_skip_probability_matches_sync_abi2_and_visible_yuv() {
        let (width, height) = (128, 64);
        let mut pixels = [128, 128, 128, 255].repeat(width * height);
        for y in 0..16 {
            for x in 0..16 {
                let at = (y * width + x) * 4;
                pixels[at] = (x * 37 + y * 13) as u8;
                pixels[at + 1] = (x * 11 + y * 41) as u8;
                pixels[at + 2] = (x * 29 + y * 7) as u8;
            }
        }
        for filter in [FilterConfig::DISABLED, FilterConfig::for_quality(75)] {
            let mut expected = Vec::new();
            let mut selected_probability = 128;
            let frame = encode_observed(
                &pixels,
                FrameSpec {
                    width: width as u32,
                    height: height as u32,
                    stride: (width * 4) as u32,
                    format: 0,
                    quality: 75,
                    filter,
                },
                0,
                |y, u, v, padded_w, blocks| {
                    let mut counts = SkipStats::default();
                    for block in blocks {
                        counts.observe(block.skip()).unwrap();
                    }
                    assert!(counts.skipped > 0 && counts.not_skipped > 0);
                    selected_probability = counts.frozen_probability();
                    expected =
                        filtered_visible_yuv(y, u, v, padded_w, width, height, blocks, filter);
                },
            )
            .unwrap();
            assert_ne!(selected_probability, 128);
            let request = engine_request(width, height, 0, &pixels, width * 4);
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(
                FrameEncoder::new_with_filter(request, pixels.clone(), plan, filter).unwrap(),
            );
            assert_eq!(engine.skip_probability, selected_probability);
            assert_eq!(engine.output(), frame);
            assert_decodes(
                &frame,
                width,
                height,
                &expected,
                &format!("mixed skip probability={selected_probability} filter={filter:?}"),
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_enabled_filter_reconstruction_matrix() {
        let filters = [
            FilterConfig {
                simple: false,
                level: 0,
                sharpness: 0,
            },
            FilterConfig {
                simple: false,
                level: 1,
                sharpness: 0,
            },
            FilterConfig {
                simple: false,
                level: 6,
                sharpness: 3,
            },
            FilterConfig {
                simple: false,
                level: 15,
                sharpness: 7,
            },
            FilterConfig {
                simple: false,
                level: 40,
                sharpness: 0,
            },
            FilterConfig {
                simple: false,
                level: 63,
                sharpness: 3,
            },
            FilterConfig {
                simple: true,
                level: 6,
                sharpness: 0,
            },
            FilterConfig {
                simple: true,
                level: 15,
                sharpness: 3,
            },
            FilterConfig {
                simple: true,
                level: 40,
                sharpness: 7,
            },
            FilterConfig {
                simple: true,
                level: 63,
                sharpness: 0,
            },
        ];
        let dimensions = [(1, 1), (1, 33), (33, 1), (31, 33), (48, 32)];
        let mut seen = [[false; 2]; 2]; // I16/I4 by skipped/nonzero.
        for filter in filters {
            for (width, height) in dimensions {
                let mut pixels = Vec::with_capacity(width * height * 4);
                for y in 0..height {
                    for x in 0..width {
                        let rgb = if width == 1 && height == 1 {
                            [128; 3]
                        } else {
                            [
                                (x * 37 + y * 13) as u8,
                                (x * 11 + y * 41) as u8,
                                (x * 29 + y * 7) as u8,
                            ]
                        };
                        pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                    }
                }
                for policy in [1, 2] {
                    let mut expected = Vec::new();
                    let frame = encode_observed(
                        &pixels,
                        FrameSpec {
                            width: width as u32,
                            height: height as u32,
                            stride: (width * 4) as u32,
                            format: 0,
                            quality: 75,
                            filter,
                        },
                        policy,
                        |y, u, v, padded_w, blocks| {
                            for block in blocks {
                                seen[usize::from(!block.i16)][usize::from(!block.skip())] = true;
                            }
                            expected = filtered_visible_yuv(
                                y, u, v, padded_w, width, height, blocks, filter,
                            );
                            if filter.simple {
                                let y_bytes = width * height;
                                let uv_bytes = width.div_ceil(2) * height.div_ceil(2);
                                let unfiltered_u = (0..height.div_ceil(2))
                                    .flat_map(|row| {
                                        u[row * padded_w / 2
                                            ..row * padded_w / 2 + width.div_ceil(2)]
                                            .iter()
                                            .copied()
                                    })
                                    .collect::<Vec<_>>();
                                assert_eq!(&expected[y_bytes..y_bytes + uv_bytes], unfiltered_u);
                                let unfiltered_v = (0..height.div_ceil(2))
                                    .flat_map(|row| {
                                        v[row * padded_w / 2
                                            ..row * padded_w / 2 + width.div_ceil(2)]
                                            .iter()
                                            .copied()
                                    })
                                    .collect::<Vec<_>>();
                                assert_eq!(&expected[y_bytes + uv_bytes..], unfiltered_v);
                            }
                        },
                    )
                    .unwrap();
                    assert_decodes(
                        &frame,
                        width,
                        height,
                        &expected,
                        &format!("filter={filter:?} policy={policy}"),
                    );
                }
            }
            for i16 in [true, false] {
                let block = Macroblock {
                    i16,
                    ..Macroblock::default()
                };
                assert!(block.skip());
                let frame = emit_segmented_frame(
                    std::slice::from_ref(&block),
                    16,
                    16,
                    SegmentConfig::nonsegmented(23),
                    Deltas::default(),
                    filter,
                )
                .unwrap();
                let y = if i16 {
                    [128; 256]
                } else {
                    let global = [0u8; 256];
                    let mut tile = [0u8; 256];
                    for by in 0..4 {
                        for bx in 0..4 {
                            let (top, left, corner) = i4_edge(&global, &tile, 16, 0, 0, bx, by);
                            let patch = prediction::predict_i4(&top, &left, corner, SmallMode::Dc);
                            store_patch::<16, 256>(&mut tile, bx, by, &patch);
                        }
                    }
                    tile
                };
                let uv = [128; 64];
                let expected = filtered_visible_yuv(
                    &y,
                    &uv,
                    &uv,
                    16,
                    16,
                    16,
                    std::slice::from_ref(&block),
                    filter,
                );
                assert_decodes(
                    &frame,
                    16,
                    16,
                    &expected,
                    &format!("filter={filter:?} skipped i16={i16}"),
                );
                seen[usize::from(!i16)][0] = true;
            }
        }
        assert!(
            seen.into_iter()
                .all(|row| row.into_iter().all(|value| value)),
            "I16/I4 skip/nonzero coverage: {seen:?}"
        );
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
                            filter: FilterConfig::DISABLED,
                        },
                        pattern,
                        |y, u, v, padded_w, _| {
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
                                quality,
                                filter: FilterConfig::DISABLED,
                            },
                            pattern,
                            |_, _, _, _, _| {}
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
