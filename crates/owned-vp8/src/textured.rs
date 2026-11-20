// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{
    bmode_probs::BMODE_PROBS,
    display_rgb, filter,
    limits::{
        Request, ResourcePlan, Status, MAX_DIMENSION, MAX_FIRST_PARTITION_BYTES,
        REFINEMENT_LOG_BUDGET_BYTES, SCRATCH_ALLOWANCE_BYTES,
    },
    prediction::{self, LargeMode, SmallMode},
    probability::{EmissionModel, Model, Statistics, NODE_COUNT},
    rate::{probability_cost, BoolSink, CountingBoolSink, OpBuffer, RateCounter, SymbolCounter},
    residual,
    segmentation::{self, Config as SegmentConfig},
    transform,
};

#[allow(clippy::too_many_arguments)]
fn filter_completed_one(
    y: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
    padded_w: usize,
    padded_h: usize,
    index: usize,
    blocks: &[Macroblock],
    config: FilterConfig,
) -> Result<(), EncodeError> {
    let block = blocks.get(index).ok_or(EncodeError::InvalidInput)?;
    let mut planes = filter::Planes {
        y: filter::Plane {
            data: y,
            width: padded_w,
            height: padded_h,
            stride: padded_w,
        },
        u: filter::Plane {
            data: u,
            width: padded_w / 2,
            height: padded_h / 2,
            stride: padded_w / 2,
        },
        v: filter::Plane {
            data: v,
            width: padded_w / 2,
            height: padded_h / 2,
            stride: padded_w / 2,
        },
    };
    filter::filter_macroblock(
        &mut planes,
        index % (padded_w / 16),
        index / (padded_w / 16),
        filter::FilterParams {
            level: config.level,
            sharpness: config.sharpness,
            simple: config.simple,
            i4: !block.i16,
            has_coefficients: !block.skip(),
        },
    )
    .map_err(|_| EncodeError::InvalidInput)
}

#[allow(clippy::too_many_arguments)]
fn score_completed_sync(
    work_y: &mut [u8],
    work_u: &mut [u8],
    work_v: &mut [u8],
    reconstructed_y: &[u8],
    reconstructed_u: &[u8],
    reconstructed_v: &[u8],
    padded_w: usize,
    padded_h: usize,
    width: usize,
    height: usize,
    original: display_rgb::Original<'_>,
    blocks: &[Macroblock],
    config: FilterConfig,
) -> Result<f64, EncodeError> {
    work_y.copy_from_slice(reconstructed_y);
    work_u.copy_from_slice(reconstructed_u);
    work_v.copy_from_slice(reconstructed_v);
    for index in 0..blocks.len() {
        filter_completed_one(
            work_y, work_u, work_v, padded_w, padded_h, index, blocks, config,
        )?;
    }
    let view = display_rgb::CompleteFrame::checked(
        width, height, padded_w, original, work_y, work_u, work_v,
    )
    .ok_or(EncodeError::InvalidInput)?;
    let mut score =
        display_rgb::CompleteScore::new(width, height).ok_or(EncodeError::OutputLimit)?;
    while !score.initialized() {
        if !score.initialize_chunk() {
            return Err(EncodeError::OutputLimit);
        }
    }
    while score.progress().0 < score.progress().1 {
        score.advance(&view);
    }
    score.finish().ok_or(EncodeError::InvalidInput)
}

#[path = "joint_refinement.rs"]
mod joint_refinement;
use joint_refinement::{extra_quota, JointSearch};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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

fn quantize_y1_zero_bin(transformed: &[i32; 16], steps: Steps, enabled: bool) -> [i16; 16] {
    let mut coefficients = ac_quant::quantize_block(transformed, steps);
    if enabled {
        // Only marginal Y1 AC units change. Wide products also admit i32::MIN
        // fixture values without overflowing their unsigned magnitude.
        let threshold = 5 * u64::try_from(steps.ac).expect("positive Y1 AC step");
        for index in 1..16 {
            if coefficients[index].unsigned_abs() == 1
                && 8 * u64::from(transformed[index].unsigned_abs()) < threshold
            {
                coefficients[index] = 0;
            }
        }
    }
    coefficients
}

fn transform_predicted_block(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
) -> [i32; 16] {
    let mut residual = [0i16; 16];
    for row in 0..4 {
        for col in 0..4 {
            residual[row * 4 + col] = (i32::from(source[(y + row) * stride + x + col])
                - i32::from(predictor[row * 4 + col])) as i16;
        }
    }
    transform::forward(&residual)
}

fn code_predicted_block(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    steps: Steps,
    y1_zero_bin: bool,
) -> ([i16; 16], [u8; 16]) {
    let transformed = transform_predicted_block(source, stride, x, y, predictor);
    let coefficients = quantize_y1_zero_bin(&transformed, steps, y1_zero_bin);
    let inverse = transform::inverse(&ac_quant::dequantize_block(&coefficients, steps));
    let mut reconstructed = [0u8; 16];
    for i in 0..16 {
        reconstructed[i] = clamp(i32::from(predictor[i]) + i32::from(inverse[i]));
    }
    (coefficients, reconstructed)
}

fn reconstructed_patch(coefficients: &[i16; 16], predictor: &[u8; 16], steps: Steps) -> [u8; 16] {
    let inverse = transform::inverse(&ac_quant::dequantize_block(coefficients, steps));
    std::array::from_fn(|i| clamp(i32::from(predictor[i]) + i32::from(inverse[i])))
}

fn patch_error(source: &[u8], stride: usize, x: usize, y: usize, patch: &[u8; 16]) -> u64 {
    let mut distortion = 0u64;
    for row in 0..4 {
        for col in 0..4 {
            let diff =
                i32::from(source[(y + row) * stride + x + col]) - i32::from(patch[row * 4 + col]);
            distortion += (diff * diff) as u64;
        }
    }
    distortion
}

#[allow(clippy::too_many_arguments)]
fn optimize_uv_block(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    steps: Steps,
    context: usize,
    lambda: u64,
    baseline: ([i16; 16], [u8; 16]),
) -> ([i16; 16], [u8; 16]) {
    let Some(last_ac) = (1..16)
        .rev()
        .find(|&position| baseline.0[residual::SCAN[position]] != 0)
    else {
        return baseline;
    };
    let index = residual::SCAN[last_ac];
    if baseline.0[index].unsigned_abs() != 1 {
        return baseline;
    }
    let mut alternative = baseline.0;
    alternative[index] = 0;
    let mut baseline_rate = RateCounter::default();
    let mut alternative_rate = RateCounter::default();
    residual::encode_block(&mut baseline_rate, &baseline.0, 2, context).unwrap();
    residual::encode_block(&mut alternative_rate, &alternative, 2, context).unwrap();
    if alternative_rate.cost >= baseline_rate.cost {
        return baseline;
    }
    let alternative_patch = reconstructed_patch(&alternative, predictor, steps);
    let baseline_score =
        patch_error(source, stride, x, y, &baseline.1) * 256 + lambda * baseline_rate.cost;
    let alternative_score = patch_error(source, stride, x, y, &alternative_patch) * 256
        + lambda * alternative_rate.cost;
    if alternative_score < baseline_score {
        (alternative, alternative_patch)
    } else {
        baseline
    }
}

#[allow(clippy::too_many_arguments)]
fn optimize_uv_dc_zero(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    context: usize,
    baseline: ([i16; 16], [u8; 16]),
) -> ([i16; 16], [u8; 16]) {
    if baseline.0[0].unsigned_abs() != 1 || baseline.0[1..].iter().any(|&value| value != 0) {
        return baseline;
    }
    if patch_error(source, stride, x, y, predictor) > patch_error(source, stride, x, y, &baseline.1)
    {
        return baseline;
    }
    let zero = [0i16; 16];
    let mut baseline_rate = RateCounter::default();
    let mut zero_rate = RateCounter::default();
    residual::encode_block(&mut baseline_rate, &baseline.0, 2, context).unwrap();
    residual::encode_block(&mut zero_rate, &zero, 2, context).unwrap();
    if zero_rate.cost < baseline_rate.cost {
        (zero, *predictor)
    } else {
        baseline
    }
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
    #[cfg(test)]
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
    fn measure_luma(&self, block: &Macroblock, mx: usize) -> Result<u64, EncodeError> {
        let mut rate = RateCounter::default();
        if block.i16 {
            let context = usize::from(self.y2[mx]) + usize::from(self.left_y2);
            residual::encode_block(&mut rate, &block.y2, 1, context)?;
        }
        let mut y = [false; 4];
        y.copy_from_slice(&self.y[mx * 4..mx * 4 + 4]);
        let mut left_y = self.left_y;
        encode_macroblock_coeffs(
            &mut rate,
            &block.y,
            if block.i16 { 0 } else { 3 },
            &mut y,
            &mut left_y,
            0,
            4,
        )?;
        Ok(rate.cost)
    }
    fn measure_uv(&self, block: &Macroblock, mx: usize) -> Result<u64, EncodeError> {
        let mut rate = RateCounter::default();
        let mut u = [false; 2];
        u.copy_from_slice(&self.u[mx * 2..mx * 2 + 2]);
        let mut v = [false; 2];
        v.copy_from_slice(&self.v[mx * 2..mx * 2 + 2]);
        let mut left_u = self.left_u;
        let mut left_v = self.left_v;
        encode_macroblock_coeffs(&mut rate, &block.u, 2, &mut u, &mut left_u, 0, 2)?;
        encode_macroblock_coeffs(&mut rate, &block.v, 2, &mut v, &mut left_v, 0, 2)?;
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
struct AnalyzedBlock {
    block: Macroblock,
    refinement: Option<RefinementChange>,
    refinement_gain: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RefinementChange {
    plane: u8,
    patch: u8,
    coefficient: u8,
    old: i16,
    new: i16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RefinementEdit {
    block: u32,
    change: RefinementChange,
}

#[derive(Clone, Copy)]
struct BaselineOverride {
    block: u32,
    start: u32,
    len: u8,
    baseline: Option<RefinementChange>,
}

const BASELINE_OVERRIDE_BUDGET_BYTES: usize = 8 * 1024;
const _: () =
    assert!(128 * std::mem::size_of::<BaselineOverride>() <= BASELINE_OVERRIDE_BUDGET_BYTES);

const REFINEMENT_SLAB_LEN: usize = 256;
const _: () = assert!(std::mem::size_of::<RefinementEdit>() <= 12);

/// Bounded slabs avoid a frame-sized relocation during an ABI work unit.
#[derive(Default)]
struct RefinementLog {
    slabs: Vec<Vec<RefinementEdit>>,
    len: usize,
}

fn is_overridden(
    overrides: &[BaselineOverride],
    edit: RefinementEdit,
    index: usize,
) -> Result<bool, Status> {
    let Ok(position) = overrides.binary_search_by_key(&edit.block, |item| item.block) else {
        return Ok(false);
    };
    let item = overrides[position];
    if index < item.start as usize || index >= item.start as usize + usize::from(item.len) {
        return Err(Status::InvalidInput);
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn replay_edit_state(
    blocks: &mut [Macroblock],
    reconstructed_u: &mut [u8],
    reconstructed_v: &mut [u8],
    padded_w: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    edit: RefinementEdit,
    forward: bool,
) -> Result<(), Status> {
    let blocks_x = padded_w / 16;
    let mx = edit.block as usize % blocks_x;
    let my = edit.block as usize / blocks_x;
    let block = blocks
        .get_mut(edit.block as usize)
        .ok_or(Status::InvalidInput)?;
    let change = edit.change;
    let patch_index = usize::from(change.patch);
    let coefficient_index = usize::from(change.coefficient);
    if patch_index >= 4 || coefficient_index >= 16 {
        return Err(Status::InvalidInput);
    }
    let (coefficients, reconstructed) = match change.plane {
        0 => (&mut block.u[patch_index], reconstructed_u),
        1 => (&mut block.v[patch_index], reconstructed_v),
        _ => return Err(Status::InvalidInput),
    };
    let (expected, replacement) = if forward {
        (change.old, change.new)
    } else {
        (change.new, change.old)
    };
    if coefficients[coefficient_index] != expected {
        return Err(Status::InvalidInput);
    }
    let stride = padded_w / 2;
    let x = mx * 8;
    let y = my * 8;
    let (top, left, corner) = edge::<8>(reconstructed, stride, x, y);
    let predicted = prediction::predict_uv(
        &top,
        &left,
        corner,
        y > 0,
        x > 0,
        mode_from_u8(block.uv_mode),
    );
    let bx = patch_index % 2;
    let by = patch_index / 2;
    let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
    let qindex = segments.qindex_for(block.segment_id);
    let steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
    let expected_patch = reconstructed_patch(coefficients, &predictor, steps);
    for row in 0..4 {
        let at = (y + by * 4 + row) * stride + x + bx * 4;
        if reconstructed[at..at + 4] != expected_patch[row * 4..row * 4 + 4] {
            return Err(Status::InvalidInput);
        }
    }
    let mut changed = *coefficients;
    changed[coefficient_index] = replacement;
    let patch = reconstructed_patch(&changed, &predictor, steps);
    *coefficients = changed;
    for row in 0..4 {
        let at = (y + by * 4 + row) * stride + x + bx * 4;
        reconstructed[at..at + 4].copy_from_slice(&patch[row * 4..row * 4 + 4]);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn replay_sync_edit(
    blocks: &mut [Macroblock],
    u: &mut [u8],
    v: &mut [u8],
    padded_w: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    edit: RefinementEdit,
    forward: bool,
) -> Result<(), EncodeError> {
    replay_edit_state(blocks, u, v, padded_w, segments, deltas, edit, forward)
        .map_err(|_| EncodeError::InvalidInput)
}

impl RefinementLog {
    fn reserve_one(&mut self, max_edits: usize) -> Result<(), Status> {
        self.reserve_additional(1, max_edits)
    }

    fn reserve_additional(&mut self, additional: usize, max_edits: usize) -> Result<(), Status> {
        let target = self
            .len
            .checked_add(additional)
            .ok_or(Status::MemoryAdmission)?;
        if target > max_edits {
            return Err(Status::MemoryAdmission);
        }
        while self.slabs.len() < target.div_ceil(REFINEMENT_SLAB_LEN) {
            if self.slabs.is_empty() {
                self.slabs
                    .try_reserve_exact(max_edits.div_ceil(REFINEMENT_SLAB_LEN))
                    .map_err(|_| Status::MemoryAdmission)?;
            }
            let mut slab = Vec::new();
            slab.try_reserve_exact(REFINEMENT_SLAB_LEN)
                .map_err(|_| Status::MemoryAdmission)?;
            self.slabs.push(slab);
        }
        if self.capacity_bytes() > REFINEMENT_LOG_BUDGET_BYTES {
            return Err(Status::MemoryAdmission);
        }
        Ok(())
    }

    fn pop_last(&mut self) -> Option<RefinementEdit> {
        let last = self.len.checked_sub(1)?;
        let edit = self.slabs.get_mut(last / REFINEMENT_SLAB_LEN)?.pop()?;
        self.len = last;
        Some(edit)
    }

    fn capacity_bytes(&self) -> usize {
        self.slabs.capacity() * std::mem::size_of::<Vec<RefinementEdit>>()
            + self
                .slabs
                .iter()
                .map(|slab| slab.capacity() * std::mem::size_of::<RefinementEdit>())
                .sum::<usize>()
    }

    fn push_reserved(&mut self, edit: RefinementEdit) -> Result<(), Status> {
        let slab = self
            .slabs
            .get_mut(self.len / REFINEMENT_SLAB_LEN)
            .ok_or(Status::MemoryAdmission)?;
        if slab.len() == slab.capacity() {
            return Err(Status::MemoryAdmission);
        }
        slab.push(edit);
        self.len += 1;
        Ok(())
    }

    fn get(&self, index: usize) -> Option<RefinementEdit> {
        self.slabs
            .get(index / REFINEMENT_SLAB_LEN)?
            .get(index % REFINEMENT_SLAB_LEN)
            .copied()
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }
}

#[derive(Default)]
struct ProfileComparison {
    visible_error: u64,
    weighted_rate: u64,
}

impl ProfileComparison {
    fn add_rate(
        &mut self,
        rate: u64,
        original_qindex: usize,
        quality: u32,
    ) -> Result<(), EncodeError> {
        let weighted = crate::presets::lambda_for_quality(original_qindex, quality)
            .checked_mul(rate)
            .ok_or(EncodeError::OutputLimit)?;
        self.weighted_rate = self
            .weighted_rate
            .checked_add(weighted)
            .ok_or(EncodeError::OutputLimit)?;
        Ok(())
    }

    fn score(
        &self,
        header_rate: u64,
        original_base_qindex: usize,
        quality: u32,
    ) -> Result<u64, EncodeError> {
        let weighted_header = crate::presets::lambda_for_quality(original_base_qindex, quality)
            .checked_mul(header_rate)
            .ok_or(EncodeError::OutputLimit)?;
        self.visible_error
            .checked_mul(256)
            .and_then(|error| error.checked_add(self.weighted_rate))
            .and_then(|score| score.checked_add(weighted_header))
            .ok_or(EncodeError::OutputLimit)
    }
}

fn reduced_profile_wins(original: u64, reduced: u64) -> bool {
    reduced < original
}

fn estimated_profile_header_rate(
    segments: SegmentConfig,
    deltas: Deltas,
    filter: FilterConfig,
    model: &Model,
    skip_probability: Option<u8>,
) -> Result<u64, EncodeError> {
    let mut rate = RateCounter::default();
    write_header_prefix(&mut rate, segments, deltas, filter)?;
    for start in (0..NODE_COUNT).step_by(64) {
        write_updates(&mut rate, Some(model), start, (start + 64).min(NODE_COUNT))?;
    }
    write_header_suffix(&mut rate, skip_probability)?;
    Ok(rate.cost)
}

#[allow(clippy::too_many_arguments)]
fn estimated_block_rate(
    block: &Macroblock,
    mx: usize,
    contexts: &mut CoeffContexts,
    above_modes: &mut [u8],
    left_modes: &mut [u8; 4],
    segments: SegmentConfig,
    model: &Model,
    skip_probability: Option<u8>,
) -> Result<u64, EncodeError> {
    let mut header = RateCounter::default();
    let mut token = RateCounter::default();
    write_macroblock(
        &mut header,
        &mut ModelSink {
            inner: &mut token,
            model: Some(model),
        },
        contexts,
        above_modes,
        left_modes,
        mx,
        block,
        segments,
        skip_probability,
    )?;
    Ok(header.cost + token.cost)
}
#[derive(Clone)]
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

fn read_tile<const N: usize, const LEN: usize>(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
) -> [u8; LEN] {
    let mut tile = [0; LEN];
    for row in 0..N {
        tile[row * N..row * N + N]
            .copy_from_slice(&source[(y + row) * stride + x..(y + row) * stride + x + N]);
    }
    tile
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
    y1_zero_bin: bool,
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
            block.y[index] = quantize_y1_zero_bin(&transformed, y_steps, y1_zero_bin);
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

#[derive(Clone, Copy)]
struct I4AcChoice {
    coefficients: [i16; 16],
    patch: [u8; 16],
    distortion: u64,
    token_rate: u64,
}

struct I4ModeChoice {
    coefficients: [i16; 16],
    patch: [u8; 16],
    predictor: [u8; 16],
    mode: u8,
    mode_cost: u64,
    token_rate: u64,
    score: u64,
}

// Each AC trial starts from the same selected-mode coefficients. Scan order is
// ascending; equal scores keep the baseline or the first admitted trial.
#[allow(clippy::too_many_arguments)]
fn choose_i4_selected_ac_neighbor(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    steps: Steps,
    context: usize,
    trial_lambda: u64,
    coefficients: [i16; 16],
    patch: [u8; 16],
    baseline_rate: u64,
) -> I4AcChoice {
    let baseline = I4AcChoice {
        coefficients,
        patch,
        distortion: patch_error(source, stride, x, y, &patch),
        token_rate: baseline_rate,
    };
    let baseline_score = baseline.distortion * 256 + trial_lambda * baseline_rate;
    let mut best = baseline;
    let mut best_score = baseline_score;
    for position in 1..16 {
        let index = residual::SCAN[position];
        let level = coefficients[index];
        if level == 0
            || (level.unsigned_abs() == 1
                && coefficients
                    .iter()
                    .enumerate()
                    .all(|(other, &value)| other == index || value == 0))
        {
            continue;
        }
        let mut trial = coefficients;
        trial[index] = if level > 0 { level - 1 } else { level + 1 };
        let mut rate = RateCounter::default();
        residual::encode_block(&mut rate, &trial, 3, context).unwrap();
        if rate.cost >= baseline_rate {
            continue;
        }
        let trial_patch = reconstructed_patch(&trial, predictor, steps);
        let distortion = patch_error(source, stride, x, y, &trial_patch);
        if !i4_ac_tail_within_ssd_budget(distortion, baseline.distortion) {
            continue;
        }
        let score = distortion * 256 + trial_lambda * rate.cost;
        if score < baseline_score && score < best_score {
            best = I4AcChoice {
                coefficients: trial,
                patch: trial_patch,
                distortion,
                token_rate: rate.cost,
            };
            best_score = score;
        }
    }
    best
}

fn i4_ac_tail_within_ssd_budget(trial: u64, baseline: u64) -> bool {
    // A 4x4 u8 patch has SSD at most 16 * 255^2, so both products fit u64.
    10 * trial <= 11 * baseline
}

// Historical single-tail control used by the retained full/half-weight tests.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn choose_i4_ac_tail(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: &[u8; 16],
    steps: Steps,
    context: usize,
    lambda: u64,
    coefficients: [i16; 16],
    patch: [u8; 16],
) -> I4AcChoice {
    let mut baseline_rate = RateCounter::default();
    residual::encode_block(&mut baseline_rate, &coefficients, 3, context).unwrap();
    let baseline = I4AcChoice {
        coefficients,
        patch,
        distortion: patch_error(source, stride, x, y, &patch),
        token_rate: baseline_rate.cost,
    };
    let Some(last_ac) = (1..16)
        .rev()
        .find(|&position| coefficients[residual::SCAN[position]] != 0)
    else {
        return baseline;
    };
    let tail = residual::SCAN[last_ac];
    if coefficients[tail].unsigned_abs() != 1
        || !coefficients
            .iter()
            .enumerate()
            .any(|(index, &level)| index != tail && level != 0)
    {
        return baseline;
    }
    let mut trial = coefficients;
    trial[tail] = 0;
    let mut trial_rate = RateCounter::default();
    residual::encode_block(&mut trial_rate, &trial, 3, context).unwrap();
    if trial_rate.cost >= baseline.token_rate {
        return baseline;
    }
    let trial_patch = reconstructed_patch(&trial, predictor, steps);
    let trial_distortion = patch_error(source, stride, x, y, &trial_patch);
    if i4_ac_tail_within_ssd_budget(trial_distortion, baseline.distortion)
        && trial_distortion * 256 + lambda * trial_rate.cost
            < baseline.distortion * 256 + lambda * baseline.token_rate
    {
        I4AcChoice {
            coefficients: trial,
            patch: trial_patch,
            distortion: trial_distortion,
            token_rate: trial_rate.cost,
        }
    } else {
        baseline
    }
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
    i4_ac_tail_rdo: bool,
    y1_zero_bin: bool,
) -> LumaCandidate {
    make_i4_with_pruning::<true>(
        source,
        reconstructed,
        stride,
        mx,
        my,
        y_steps,
        above_modes,
        left_modes,
        contexts,
        lambda,
        i4_ac_tail_rdo,
        y1_zero_bin,
    )
    .0
}

#[allow(clippy::too_many_arguments)]
fn make_i4_with_pruning<const PRUNE: bool>(
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
    i4_ac_tail_rdo: bool,
    y1_zero_bin: bool,
) -> (LumaCandidate, u64) {
    let mut tile = [0u8; 256];
    let mut block = Macroblock::default();
    let mut selected_score = 0u64;
    // Keep full lambda for mode selection and the returned macroblock score.
    let neighbor_lambda = lambda / 2;
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
            let mut best: Option<I4ModeChoice> = None;
            for mode in 0..10u8 {
                let mut trial = RateCounter::default();
                write_bmode(&mut trial, above, left_mode, mode).unwrap();
                let mode_cost = trial.cost;
                // Distortion and residual token costs cannot lower this score.
                // A tie retains the earlier mode under the strict comparison.
                if PRUNE
                    && best
                        .as_ref()
                        .is_some_and(|last| lambda * mode_cost >= last.score)
                {
                    continue;
                }
                let predicted = prediction::predict_i4(&top, &left, corner, bmode_from_u8(mode));
                let (coeff, patch) =
                    code_predicted_block(source, stride, x, y, &predicted, y_steps, y1_zero_bin);
                let distortion = patch_error(source, stride, x, y, &patch);
                if PRUNE
                    && best
                        .as_ref()
                        .is_some_and(|last| distortion * 256 + lambda * mode_cost >= last.score)
                {
                    continue;
                }
                let context = usize::from(local_above[bx]) + usize::from(local_left[by]);
                residual::encode_block(&mut trial, &coeff, 3, context).unwrap();
                let score = distortion * 256 + lambda * trial.cost;
                if best.as_ref().is_none_or(|last| score < last.score) {
                    best = Some(I4ModeChoice {
                        coefficients: coeff,
                        patch,
                        predictor: predicted,
                        mode,
                        mode_cost,
                        token_rate: trial.cost - mode_cost,
                        score,
                    });
                }
            }
            let best = best.unwrap();
            let mut coeff = best.coefficients;
            let mut patch = best.patch;
            let mut score = best.score;
            if i4_ac_tail_rdo {
                let context = usize::from(local_above[bx]) + usize::from(local_left[by]);
                let choice = choose_i4_selected_ac_neighbor(
                    source,
                    stride,
                    x,
                    y,
                    &best.predictor,
                    y_steps,
                    context,
                    neighbor_lambda,
                    coeff,
                    patch,
                    best.token_rate,
                );
                coeff = choice.coefficients;
                patch = choice.patch;
                score = choice.distortion * 256 + lambda * (best.mode_cost + choice.token_rate);
            }
            selected_score += score;
            block.y[index] = coeff;
            block.b_modes[index] = best.mode;
            store_patch::<16, 256>(&mut tile, bx, by, &patch);
            let nonzero = coeff.iter().any(|&c| c != 0);
            local_above[bx] = nonzero;
            local_left[by] = nonzero;
        }
    }
    (
        LumaCandidate {
            block,
            tile,
            distortion: squared_error::<16, 256>(source, stride, mx * 16, my * 16, &tile),
        },
        selected_score,
    )
}
#[derive(Clone, Copy)]
enum UvRatePolicy {
    TexturedAcTail,
    FlatDcZero,
}

impl UvRatePolicy {
    fn for_source_class(quality: u32, source_class: u8) -> Option<Self> {
        match (quality, source_class) {
            (60, segmentation::TEXTURED) => Some(Self::TexturedAcTail),
            (75, segmentation::CHROMATIC_FLAT) => Some(Self::FlatDcZero),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
struct UvRdo<'a> {
    contexts: &'a CoeffContexts,
    mx: usize,
    lambda: u64,
    visible_width: usize,
    visible_height: usize,
    policy: UvRatePolicy,
}

impl UvRdo<'_> {
    fn block_lambda(self, x: usize, y: usize) -> Option<u64> {
        let width = self.visible_width.saturating_sub(x).min(4);
        let height = self.visible_height.saturating_sub(y).min(4);
        let samples = width * height;
        // Padded samples do not receive their own rate allowance. Keep hidden
        // patches unchanged because filtering can couple them to visible edges.
        (samples > 0).then_some(
            self.lambda * samples as u64 / (16 * crate::presets::UV_COEFFICIENT_RATE_DIVISOR),
        )
    }
}

fn uv_dc_error(source: &[u8], stride: usize, x: usize, y: usize, patch: &[u8; 16]) -> i32 {
    let mut error = 0;
    for (row, patch_row) in patch.as_chunks::<4>().0.iter().enumerate() {
        for (col, &reconstructed) in patch_row.iter().enumerate() {
            error += i32::from(source[(y + row) * stride + x + col]) - i32::from(reconstructed);
        }
    }
    error
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
    rdo: Option<UvRdo<'_>>,
    diffuse_dc_error: bool,
) -> UvCandidate {
    let mut coeffs = [[[0i16; 16]; 4]; 2];
    let mut tiles = [[0u8; 64]; 2];
    for (index, (source, reconstructed)) in
        [(source_u, reconstructed_u), (source_v, reconstructed_v)]
            .into_iter()
            .enumerate()
    {
        let (mut local_above, mut local_left) = if let Some(UvRdo { contexts, mx, .. }) = rdo {
            let (above, left) = if index == 0 {
                (&contexts.u, contexts.left_u)
            } else {
                (&contexts.v, contexts.left_v)
            };
            ([above[mx * 2], above[mx * 2 + 1]], left)
        } else {
            ([false; 2], [false; 2])
        };
        let (top, left, corner) = edge::<8>(reconstructed, stride, x, y);
        let predicted =
            prediction::predict_uv(&top, &left, corner, y > 0, x > 0, mode_from_u8(mode));
        // Keep trial state within this plane and mode. Source-minus-reconstruction
        // sums project to forward DC at half scale. Divide by four to send
        // half of each neighbor's error into this patch.
        let mut above_dc_error = [0; 2];
        for by in 0..2 {
            let mut left_dc_error = 0;
            for bx in 0..2 {
                let patch_x = x + bx * 4;
                let patch_y = y + by * 4;
                let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
                let mut transformed =
                    transform_predicted_block(source, stride, patch_x, patch_y, &predictor);
                if diffuse_dc_error {
                    let correction = (above_dc_error[bx] + left_dc_error) / 4;
                    transformed[0] += correction.clamp(-steps.dc, steps.dc);
                }
                let coefficients = ac_quant::quantize_block(&transformed, steps);
                let baseline = (
                    coefficients,
                    reconstructed_patch(&coefficients, &predictor, steps),
                );
                let (coeff, patch) = if let Some((rdo, lambda)) = rdo.and_then(|rdo| {
                    rdo.block_lambda(patch_x, patch_y)
                        .map(|lambda| (rdo, lambda))
                }) {
                    let context = usize::from(local_above[bx]) + usize::from(local_left[by]);
                    match rdo.policy {
                        UvRatePolicy::TexturedAcTail => optimize_uv_block(
                            source, stride, patch_x, patch_y, &predictor, steps, context, lambda,
                            baseline,
                        ),
                        UvRatePolicy::FlatDcZero => optimize_uv_dc_zero(
                            source, stride, patch_x, patch_y, &predictor, context, baseline,
                        ),
                    }
                } else {
                    baseline
                };
                if diffuse_dc_error && (bx == 0 || by == 0) {
                    let error = uv_dc_error(source, stride, patch_x, patch_y, &patch);
                    above_dc_error[bx] = error;
                    left_dc_error = error;
                }
                coeffs[index][by * 2 + bx] = coeff;
                store_patch::<8, 64>(&mut tiles[index], bx, by, &patch);
                let nonzero = coeff.iter().any(|&coefficient| coefficient != 0);
                local_above[bx] = nonzero;
                local_left[by] = nonzero;
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
    skip_probability: Option<u8>,
) -> Result<(), EncodeError> {
    let skipped = block.skip();
    if skip_probability.is_none() && skipped {
        return Err(EncodeError::InvalidInput);
    }
    segments.write_id(sink, block.segment_id)?;
    if let Some(probability) = skip_probability {
        sink.write(probability, skipped)?;
    }
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
    luma_cost: &mut Option<u64>,
    uv_cost: &mut Option<u64>,
) -> Result<Option<u64>, EncodeError> {
    let mut header = HeaderRateCounter::default();
    // Mode search precedes frozen frame statistics; its skip rate proposal is
    // the current syntax default, while counting and emission share the final.
    write_macroblock_header(&mut header, block, mx, above, left, segments, Some(128))?;
    if block.i16 && header.symbols.count > MAX_I16_HEADER_SYMBOLS {
        return Err(EncodeError::InvalidInput);
    }
    if !budget.fits_symbols(header.symbols.count)? {
        return Ok(None);
    }
    // The whole macroblock skip suppresses every coefficient token. Otherwise
    // even an all-zero plane pays for its EOB tokens, independently of the
    // other plane. Cache only after the header has passed its budget guard.
    let coefficient_cost = if block.skip() {
        0
    } else {
        let y = match *luma_cost {
            Some(cost) => cost,
            None => {
                let cost = contexts.measure_luma(block, mx)?;
                *luma_cost = Some(cost);
                cost
            }
        };
        let uv = match *uv_cost {
            Some(cost) => cost,
            None => {
                let cost = contexts.measure_uv(block, mx)?;
                *uv_cost = Some(cost);
                cost
            }
        };
        y + uv
    };
    let cost = header.rate.cost + coefficient_cost;
    Ok(Some(distortion * 256 + lambda * cost))
}

fn adjacent_level(value: i16, step: i32, direction: i32) -> Option<i16> {
    let proposed = i32::from(value) + direction;
    let limit = (i32::from(i16::MAX) / step).min(2047);
    (proposed.abs() <= limit).then_some(proposed as i16)
}

fn uv_future_consumers(mx: usize, my: usize, padded_w: usize, padded_h: usize) -> (bool, bool) {
    (mx + 1 < padded_w / 16, my + 1 < padded_h / 16)
}

// Preserve only the UV state read by later macroblocks. The current patch is
// reconstructed and clamped before this check: changed coefficients can still
// leave the outgoing predictor samples byte-identical.
#[allow(clippy::too_many_arguments)]
fn uv_frontier_preserved(
    baseline_tile: &[u8; 64],
    trial_patch: &[u8; 16],
    baseline_coefficients: &[i16; 16],
    trial_coefficients: &[i16; 16],
    bx: usize,
    by: usize,
    has_right: bool,
    has_below: bool,
    baseline_skip: bool,
    trial_skip: bool,
) -> bool {
    if baseline_skip != trial_skip {
        return false;
    }
    if bx == 1
        && has_right
        && (0..4).any(|row| trial_patch[row * 4 + 3] != baseline_tile[(by * 4 + row) * 8 + 7])
    {
        return false;
    }
    if by == 1
        && has_below
        && (0..4).any(|col| trial_patch[12 + col] != baseline_tile[7 * 8 + bx * 4 + col])
    {
        return false;
    }
    if (bx == 1 && has_right || by == 1 && has_below)
        && baseline_coefficients.iter().any(|&level| level != 0)
            != trial_coefficients.iter().any(|&level| level != 0)
    {
        return false;
    }
    true
}

// A single selected UV coefficient may change. Local rate checks syntax and
// header legality; complete independently modeled frame bytes decide admission.
#[allow(clippy::too_many_arguments)]
fn refine_selected_uv(
    block: &mut Macroblock,
    uv: &mut UvCandidate,
    y_tile: &[u8; 256],
    source: display_rgb::Original<'_>,
    source_y: &[u8],
    source_u: &[u8],
    source_v: &[u8],
    reconstructed_y: &[u8],
    reconstructed_u: &[u8],
    reconstructed_v: &[u8],
    padded_w: usize,
    width: usize,
    height: usize,
    mx: usize,
    my: usize,
    steps: Steps,
    contexts: &CoeffContexts,
    above_modes: &[u8],
    left_modes: &[u8; 4],
    segments: SegmentConfig,
    budget: &HeaderBudget,
) -> Result<Option<(RefinementChange, f64)>, EncodeError> {
    let mut luma_cost = None;
    let mut uv_cost = None;
    selected_cost(
        block,
        mx,
        contexts,
        above_modes,
        left_modes,
        0,
        1,
        segments,
        budget,
        &mut luma_cost,
        &mut uv_cost,
    )?
    .ok_or(EncodeError::OutputLimit)?;
    let baseline_skip = block.skip();
    let (has_right, has_below) =
        uv_future_consumers(mx, my, padded_w, reconstructed_y.len() / padded_w);
    let frame = display_rgb::Frame {
        width,
        height,
        stride_y: padded_w,
        original: source,
        source_y,
        source_u,
        source_v,
        reconstructed_y,
        reconstructed_u,
        reconstructed_v,
        tile_y: y_tile,
        tile_u: &uv.u_tile,
        tile_v: &uv.v_tile,
        mx,
        my,
    };
    let mut cache = None;
    let mut best_gain = 0.0f64;
    let mut best = None;
    for plane in 0..2 {
        let reconstructed = if plane == 0 {
            reconstructed_u
        } else {
            reconstructed_v
        };
        let x = mx * 8;
        let y = my * 8;
        let (top, left, corner) = edge::<8>(reconstructed, padded_w / 2, x, y);
        let predicted = prediction::predict_uv(
            &top,
            &left,
            corner,
            y > 0,
            x > 0,
            mode_from_u8(block.uv_mode),
        );
        for by in 0..2 {
            for bx in 0..2 {
                let index = by * 2 + bx;
                let coefficients = if plane == 0 {
                    block.u[index]
                } else {
                    block.v[index]
                };
                let last_ac = (1..16)
                    .rev()
                    .find(|&position| coefficients[residual::SCAN[position]] != 0)
                    .map(|position| residual::SCAN[position]);
                let positions = [Some(0), last_ac];
                if !frame.has_affected_windows(bx, by) {
                    continue;
                }
                let bounds = frame.affected(bx, by);
                let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
                for coefficient_index in positions.into_iter().flatten() {
                    let step = if coefficient_index == 0 {
                        steps.dc
                    } else {
                        steps.ac
                    };
                    let old = coefficients[coefficient_index];
                    for direction in [-1, 1] {
                        let Some(level) = adjacent_level(old, step, direction) else {
                            continue;
                        };
                        if plane == 0 {
                            block.u[index][coefficient_index] = level;
                        } else {
                            block.v[index][coefficient_index] = level;
                        }
                        let mut trial_uv_cost = None;
                        let rate = selected_cost(
                            block,
                            mx,
                            contexts,
                            above_modes,
                            left_modes,
                            0,
                            1,
                            segments,
                            budget,
                            &mut luma_cost,
                            &mut trial_uv_cost,
                        );
                        let trial_skip = block.skip();
                        if plane == 0 {
                            block.u[index][coefficient_index] = old;
                        } else {
                            block.v[index][coefficient_index] = old;
                        }
                        if rate?.is_none() {
                            continue;
                        }
                        let mut trial_coefficients = coefficients;
                        trial_coefficients[coefficient_index] = level;
                        let patch = reconstructed_patch(&trial_coefficients, &predictor, steps);
                        let baseline_tile = if plane == 0 { &uv.u_tile } else { &uv.v_tile };
                        if !uv_frontier_preserved(
                            baseline_tile,
                            &patch,
                            &coefficients,
                            &trial_coefficients,
                            bx,
                            by,
                            has_right,
                            has_below,
                            baseline_skip,
                            trial_skip,
                        ) {
                            continue;
                        }
                        let cache =
                            cache.get_or_insert_with(|| display_rgb::LocalCache::new(&frame));
                        let change = display_rgb::Change {
                            plane,
                            bx,
                            by,
                            patch: &patch,
                        };
                        let gain = cache.score(&frame, change, bounds);
                        if gain > best_gain {
                            best_gain = gain;
                            best = Some((plane, index, coefficient_index, old, level, patch));
                        }
                    }
                }
            }
        }
    }
    let refinement = if let Some((plane, index, coefficient_index, old, level, patch)) = best {
        if plane == 0 {
            block.u[index][coefficient_index] = level;
            uv.u[index][coefficient_index] = level;
            store_patch::<8, 64>(&mut uv.u_tile, index % 2, index / 2, &patch);
        } else {
            block.v[index][coefficient_index] = level;
            uv.v[index][coefficient_index] = level;
            store_patch::<8, 64>(&mut uv.v_tile, index % 2, index / 2, &patch);
        }
        Some((
            RefinementChange {
                plane: plane as u8,
                patch: index as u8,
                coefficient: coefficient_index as u8,
                old,
                new: level,
            },
            best_gain,
        ))
    } else {
        None
    };
    Ok(refinement)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn selected_cost_reference(
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
    write_macroblock_header(&mut header, block, mx, above, left, segments, Some(128))?;
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
    let mut rgb_error_sum = 0u64;
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
            if quality == 60 || quality == 75 {
                rgb_error_sum += crate::color::nearest_chroma_rgb_error(
                    rgb,
                    luma,
                    u,
                    v,
                    width.saturating_sub(cx * 2).min(2),
                    height.saturating_sub(cy * 2).min(2),
                );
            }
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
    let mut curvature = segmentation::CurvatureTotals::default();
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let id = segmentation::classify_with_curvature(
                &source_y,
                &source_u,
                &source_v,
                padded_w,
                mx,
                my,
                (quality == 60).then_some(&mut curvature),
            );
            class_counts[id as usize] += 1;
            segment_ids.push(id);
        }
    }
    let high_chroma_loss =
        crate::presets::high_chroma_loss(quality, rgb_error_sum, width as u32, height as u32);
    let original_segments =
        SegmentConfig::from_counts(quality, class_counts, count, neutral_chroma);
    let medium_textured_luma = crate::presets::medium_textured_luma(
        quality,
        class_counts,
        count,
        rgb_error_sum,
        width as u32,
        height as u32,
    );
    let photo_q60 = crate::presets::photo_q60_all_texture(
        quality,
        class_counts,
        count,
        neutral_chroma,
        high_chroma_loss,
        curvature.within_cutoff(count),
    );
    let mixed_y1_ac = crate::presets::mixed_y1_ac_profile(
        quality,
        class_counts,
        neutral_chroma,
        high_chroma_loss,
        curvature.within_cutoff(count),
    );
    let photo_q75 = medium_textured_luma && !neutral_chroma;
    let original_deltas = if high_chroma_loss {
        crate::presets::original_high_chroma_loss_deltas()
    } else {
        crate::presets::frame_deltas(quality, rgb_error_sum, width as u32, height as u32)
    };
    let mut coeff_contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    let mut refinement_log = RefinementLog::default();
    let mut baseline_overrides = Vec::new();
    let mut run_profile = |segments: SegmentConfig,
                           deltas: Deltas,
                           score_required: bool|
     -> Result<u64, EncodeError> {
        reconstructed_y.fill(0);
        reconstructed_u.fill(0);
        reconstructed_v.fill(0);
        blocks.clear();
        refinement_log = RefinementLog::default();
        baseline_overrides.clear();
        coeff_contexts.reset();
        above_modes.fill(0);
        left_modes.fill(0);
        let mut header_budget = HeaderBudget::new(
            count,
            segments,
            deltas,
            filter,
            MAX_FIRST_PARTITION_BYTES as usize,
        )?;
        let mut comparison = ProfileComparison::default();
        let mut extra_used = 0usize;
        for my in 0..blocks_y {
            coeff_contexts.row();
            left_modes.fill(0);
            for mx in 0..blocks_x {
                let segment_id = segment_ids[my * blocks_x + mx];
                let qindex = segments.qindex_for(segment_id);
                let y_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y1);
                let uv_steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
                let y2_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y2);
                let rate_qindex = if medium_textured_luma || photo_q60 || mixed_y1_ac {
                    original_segments.qindex_for(segment_id)
                } else {
                    qindex
                };
                let lambda = crate::presets::lambda_for_quality(rate_qindex, quality);
                if !high_chroma_loss {
                    refinement_log
                        .reserve_one(count + 128)
                        .map_err(|_| EncodeError::OutputLimit)?;
                }
                let mut analyzed = analyze_one(
                    &source_y,
                    &source_u,
                    &source_v,
                    Some(display_rgb::Original {
                        pixels,
                        stride,
                        layout: format,
                    }),
                    high_chroma_loss,
                    mixed_y1_ac,
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
                    quality,
                    width,
                    height,
                    luma_policy,
                    segment_id,
                    segments,
                    &mut header_budget,
                )?;
                if let Some(change) = analyzed.refinement {
                    refinement_log
                        .push_reserved(RefinementEdit {
                            block: (my * blocks_x + mx) as u32,
                            change,
                        })
                        .map_err(|_| EncodeError::OutputLimit)?;
                }
                let quota = if high_chroma_loss {
                    0
                } else {
                    extra_quota(my * blocks_x + mx, count)
                };
                if quota > 0 {
                    let x = mx * 16;
                    let y = my * 16;
                    let tile_y = read_tile::<16, 256>(&reconstructed_y, padded_w, x, y);
                    let tile_u = read_tile::<8, 64>(&reconstructed_u, uv_w, mx * 8, my * 8);
                    let tile_v = read_tile::<8, 64>(&reconstructed_v, uv_w, mx * 8, my * 8);
                    let frame = display_rgb::Frame {
                        width,
                        height,
                        stride_y: padded_w,
                        original: display_rgb::Original {
                            pixels,
                            stride,
                            layout: format,
                        },
                        source_y: &source_y,
                        source_u: &source_u,
                        source_v: &source_v,
                        reconstructed_y: &reconstructed_y,
                        reconstructed_u: &reconstructed_u,
                        reconstructed_v: &reconstructed_v,
                        tile_y: &tile_y,
                        tile_u: &tile_u,
                        tile_v: &tile_v,
                        mx,
                        my,
                    };
                    if let Some(mut search) = JointSearch::new(
                        &frame,
                        &analyzed.block,
                        analyzed
                            .refinement
                            .map(|change| (change, analyzed.refinement_gain)),
                        &reconstructed_u,
                        &reconstructed_v,
                        uv_steps,
                        quota,
                    )? {
                        if baseline_overrides.capacity() == 0 {
                            baseline_overrides
                                .try_reserve_exact(count.min(128))
                                .map_err(|_| EncodeError::OutputLimit)?;
                            if baseline_overrides.capacity()
                                * std::mem::size_of::<BaselineOverride>()
                                > BASELINE_OVERRIDE_BUDGET_BYTES
                            {
                                return Err(EncodeError::OutputLimit);
                            }
                        }
                        let (right, below) = uv_future_consumers(mx, my, padded_w, padded_h);
                        while !search.done() {
                            search.step(&frame, uv_steps, right, below)?;
                        }
                        extra_used += search.used();
                        if extra_used > 128 {
                            return Err(EncodeError::InvalidInput);
                        }
                        let result = search.result(uv_steps)?;
                        let prior = usize::from(analyzed.refinement.is_some());
                        let start = refinement_log.len - prior;
                        let differs = match analyzed.refinement {
                            Some(change) => result.len != 1 || result.changes[0] != change,
                            None => result.len != 0,
                        };
                        let target = refinement_log.len - prior + result.len;
                        refinement_log
                            .reserve_additional(
                                target.saturating_sub(refinement_log.len),
                                count + 128,
                            )
                            .map_err(|_| EncodeError::OutputLimit)?;
                        if prior != 0 {
                            let old = refinement_log.pop_last().ok_or(EncodeError::InvalidInput)?;
                            if old.block as usize != my * blocks_x + mx {
                                return Err(EncodeError::InvalidInput);
                            }
                        }
                        for &change in &result.changes[..result.len] {
                            refinement_log
                                .push_reserved(RefinementEdit {
                                    block: (my * blocks_x + mx) as u32,
                                    change,
                                })
                                .map_err(|_| EncodeError::OutputLimit)?;
                        }
                        if differs {
                            if baseline_overrides.len() == baseline_overrides.capacity() {
                                return Err(EncodeError::OutputLimit);
                            }
                            baseline_overrides.push(BaselineOverride {
                                block: (my * blocks_x + mx) as u32,
                                start: start as u32,
                                len: result.len as u8,
                                baseline: analyzed.refinement,
                            });
                        }
                        analyzed.block = result.block;
                        commit_tile::<8, 64>(&mut reconstructed_u, uv_w, mx * 8, my * 8, &result.u);
                        commit_tile::<8, 64>(&mut reconstructed_v, uv_w, mx * 8, my * 8, &result.v);
                    }
                }
                blocks.push(analyzed.block);
            }
        }
        if !score_required {
            return Ok(0);
        }
        let mut stats = Statistics::new();
        let mut skips = SkipStats::default();
        coeff_contexts.reset();
        for my in 0..blocks_y {
            coeff_contexts.row();
            for mx in 0..blocks_x {
                let block = &blocks[my * blocks_x + mx];
                skips.observe(block.skip())?;
                coeff_contexts.encode_coefficients(&mut StatsSink(&mut stats), block, mx)?;
            }
        }
        let skip_probability = skips.frozen_syntax();
        let mut model = Model::new();
        for start in (0..NODE_COUNT).step_by(64) {
            model.optimize_range(
                &stats,
                start,
                (NODE_COUNT - start).min(64),
                &probability_cost,
            )?;
        }
        coeff_contexts.reset();
        above_modes.fill(0);
        left_modes.fill(0);
        for my in 0..blocks_y {
            coeff_contexts.row();
            left_modes.fill(0);
            for mx in 0..blocks_x {
                let block = &blocks[my * blocks_x + mx];
                let rate = estimated_block_rate(
                    block,
                    mx,
                    &mut coeff_contexts,
                    &mut above_modes,
                    &mut left_modes,
                    segments,
                    &model,
                    skip_probability,
                )?;
                comparison.add_rate(
                    rate,
                    original_segments.qindex_for(block.segment_id),
                    quality,
                )?;
            }
        }
        for index in 0..blocks.len() {
            filter_completed_one(
                &mut reconstructed_y,
                &mut reconstructed_u,
                &mut reconstructed_v,
                padded_w,
                padded_h,
                index,
                &blocks,
                filter,
            )?;
        }
        let view = display_rgb::CompleteFrame::checked(
            width,
            height,
            padded_w,
            display_rgb::Original {
                pixels,
                stride,
                layout: format,
            },
            &reconstructed_y,
            &reconstructed_u,
            &reconstructed_v,
        )
        .ok_or(EncodeError::InvalidInput)?;
        for start in (0..width * height).step_by(1_024) {
            comparison.visible_error = comparison
                .visible_error
                .checked_add(view.squared_error_chunk(start, (width * height - start).min(1_024)))
                .ok_or(EncodeError::OutputLimit)?;
        }
        comparison.score(
            estimated_profile_header_rate(segments, deltas, filter, &model, skip_probability)?,
            original_segments.base_qindex,
            quality,
        )
    };
    let mut segments = original_segments
        .with_medium_textured_luma(medium_textured_luma)
        .with_photo_q60_rebase(photo_q60)
        .with_mixed_q60_uniform(class_counts, mixed_y1_ac);
    let mut deltas = if medium_textured_luma {
        crate::presets::medium_textured_deltas(original_deltas)
    } else {
        original_deltas
    };
    deltas = crate::presets::photo_allocation_deltas(deltas, photo_q60, photo_q75);
    deltas = crate::presets::mixed_y1_ac_deltas(deltas, mixed_y1_ac);
    if high_chroma_loss {
        let original_score = run_profile(original_segments, original_deltas, true)?;
        let reduced_segments = original_segments.with_high_chroma_loss_luma(true);
        let reduced_deltas =
            crate::presets::frame_deltas(quality, rgb_error_sum, width as u32, height as u32);
        let reduced_score = run_profile(reduced_segments, reduced_deltas, true)?;
        if reduced_profile_wins(original_score, reduced_score) {
            segments = reduced_segments;
            deltas = reduced_deltas;
            run_profile(reduced_segments, reduced_deltas, false)?;
        } else {
            run_profile(original_segments, original_deltas, false)?;
        }
    } else {
        run_profile(segments, deltas, false)?;
    }
    drop(run_profile);
    if !refinement_log.is_empty() || !baseline_overrides.is_empty() {
        let extended_sizes =
            count_frozen_variant(&blocks, blocks_x, blocks_y, segments, deltas, filter)?.sizes;
        let original = display_rgb::Original {
            pixels,
            stride,
            layout: format,
        };
        let extended_quality = score_completed_sync(
            &mut source_y,
            &mut source_u,
            &mut source_v,
            &reconstructed_y,
            &reconstructed_u,
            &reconstructed_v,
            padded_w,
            padded_h,
            width,
            height,
            original,
            &blocks,
            filter,
        )?;
        let mut baseline_quality = None;
        let baseline_sizes = if baseline_overrides.is_empty() {
            None
        } else {
            for index in (0..refinement_log.len).rev() {
                let edit = refinement_log.get(index).ok_or(EncodeError::InvalidInput)?;
                if is_overridden(&baseline_overrides, edit, index)
                    .map_err(|_| EncodeError::InvalidInput)?
                {
                    replay_sync_edit(
                        &mut blocks,
                        &mut reconstructed_u,
                        &mut reconstructed_v,
                        padded_w,
                        segments,
                        deltas,
                        edit,
                        false,
                    )?;
                }
            }
            for item in &baseline_overrides {
                if let Some(change) = item.baseline {
                    replay_sync_edit(
                        &mut blocks,
                        &mut reconstructed_u,
                        &mut reconstructed_v,
                        padded_w,
                        segments,
                        deltas,
                        RefinementEdit {
                            block: item.block,
                            change,
                        },
                        true,
                    )?;
                }
            }
            let sizes =
                count_frozen_variant(&blocks, blocks_x, blocks_y, segments, deltas, filter)?.sizes;
            baseline_quality = Some(score_completed_sync(
                &mut source_y,
                &mut source_u,
                &mut source_v,
                &reconstructed_y,
                &reconstructed_u,
                &reconstructed_v,
                padded_w,
                padded_h,
                width,
                height,
                original,
                &blocks,
                filter,
            )?);
            for item in baseline_overrides.iter().rev() {
                if let Some(change) = item.baseline {
                    replay_sync_edit(
                        &mut blocks,
                        &mut reconstructed_u,
                        &mut reconstructed_v,
                        padded_w,
                        segments,
                        deltas,
                        RefinementEdit {
                            block: item.block,
                            change,
                        },
                        false,
                    )?;
                }
            }
            Some(sizes)
        };
        for index in (0..refinement_log.len).rev() {
            let edit = refinement_log.get(index).ok_or(EncodeError::InvalidInput)?;
            if !is_overridden(&baseline_overrides, edit, index)
                .map_err(|_| EncodeError::InvalidInput)?
            {
                replay_sync_edit(
                    &mut blocks,
                    &mut reconstructed_u,
                    &mut reconstructed_v,
                    padded_w,
                    segments,
                    deltas,
                    edit,
                    false,
                )?;
            }
        }
        let base_sizes =
            count_frozen_variant(&blocks, blocks_x, blocks_y, segments, deltas, filter)?.sizes;
        let base_quality = score_completed_sync(
            &mut source_y,
            &mut source_u,
            &mut source_v,
            &reconstructed_y,
            &reconstructed_u,
            &reconstructed_v,
            padded_w,
            padded_h,
            width,
            height,
            original,
            &blocks,
            filter,
        )?;
        let legal = |sizes: (usize, usize)| {
            sizes.0 <= 0x7ffff && 10 + sizes.0 + sizes.1 <= MAX_OUTPUT_BYTES
        };
        let bytes = |sizes: (usize, usize)| 10 + sizes.0 + sizes.1;
        let legality = |sizes| {
            if legal(sizes) {
                Ok(())
            } else if sizes.0 > 0x7ffff {
                Err(Status::PartitionLimit)
            } else {
                Err(Status::OutputLimit)
            }
        };
        let choice = choose_scored_variants(
            (
                bytes(extended_sizes) as u32,
                legality(extended_sizes),
                extended_quality,
            ),
            baseline_sizes
                .zip(baseline_quality)
                .map(|(sizes, quality)| (bytes(sizes) as u32, legality(sizes), quality)),
            (bytes(base_sizes) as u32, legality(base_sizes), base_quality),
        )
        .map_err(|error| match error {
            Status::PartitionLimit => EncodeError::OutputLimit,
            Status::OutputLimit => EncodeError::OutputLimit,
            _ => EncodeError::InvalidInput,
        })?;
        if choice != VariantChoice::Base {
            for index in 0..refinement_log.len {
                replay_edit_state(
                    &mut blocks,
                    &mut reconstructed_u,
                    &mut reconstructed_v,
                    padded_w,
                    segments,
                    deltas,
                    refinement_log.get(index).ok_or(EncodeError::InvalidInput)?,
                    true,
                )
                .map_err(|_| EncodeError::InvalidInput)?;
            }
            if choice == VariantChoice::Baseline {
                for index in (0..refinement_log.len).rev() {
                    let edit = refinement_log.get(index).ok_or(EncodeError::InvalidInput)?;
                    if is_overridden(&baseline_overrides, edit, index)
                        .map_err(|_| EncodeError::InvalidInput)?
                    {
                        replay_edit_state(
                            &mut blocks,
                            &mut reconstructed_u,
                            &mut reconstructed_v,
                            padded_w,
                            segments,
                            deltas,
                            edit,
                            false,
                        )
                        .map_err(|_| EncodeError::InvalidInput)?;
                    }
                }
                for item in &baseline_overrides {
                    if let Some(change) = item.baseline {
                        replay_edit_state(
                            &mut blocks,
                            &mut reconstructed_u,
                            &mut reconstructed_v,
                            padded_w,
                            segments,
                            deltas,
                            RefinementEdit {
                                block: item.block,
                                change,
                            },
                            true,
                        )
                        .map_err(|_| EncodeError::InvalidInput)?;
                    }
                }
            }
        }
    }
    drop(refinement_log);
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
    original_rgb: Option<display_rgb::Original<'_>>,
    high_chroma_loss: bool,
    mixed_y1_ac: bool,
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
    quality: u32,
    visible_width: usize,
    visible_height: usize,
    luma_policy: u8,
    segment_id: u8,
    segments: SegmentConfig,
    header_budget: &mut HeaderBudget,
) -> Result<AnalyzedBlock, EncodeError> {
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
                mixed_y1_ac,
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
            mixed_y1_ac,
            mixed_y1_ac,
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
                    mixed_y1_ac,
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
            mixed_y1_ac,
            mixed_y1_ac,
        )]
    };
    let uv_policy = UvRatePolicy::for_source_class(quality, segment_id);
    let uv_width = visible_width.div_ceil(2);
    let uv_height = visible_height.div_ceil(2);
    let diffuse_uv_dc_error = mixed_y1_ac && mx * 8 + 8 <= uv_width && my * 8 + 8 <= uv_height;
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
                uv_policy.map(|policy| UvRdo {
                    contexts: coeff_contexts,
                    mx,
                    lambda,
                    visible_width: uv_width,
                    visible_height: uv_height,
                    policy,
                }),
                diffuse_uv_dc_error,
            )
        })
        .collect();
    let mut best: Option<(u64, usize, usize)> = None;
    let mut luma_costs = [None; 5];
    let mut uv_costs = [None; 4];
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
                &mut luma_costs[li],
                &mut uv_costs[ui],
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
    let mut selected_uv = uv[ui].clone();
    let mut block = Macroblock {
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
    let mut refinement = None;
    let mut refinement_gain = 0.0;
    if !high_chroma_loss {
        if let Some(original) = original_rgb {
            let selected = refine_selected_uv(
                &mut block,
                &mut selected_uv,
                &selected_luma.tile,
                original,
                source_y,
                source_u,
                source_v,
                reconstructed_y,
                reconstructed_u,
                reconstructed_v,
                padded_w,
                visible_width,
                visible_height,
                mx,
                my,
                uv_steps,
                coeff_contexts,
                above_modes,
                left_modes,
                segments,
                header_budget,
            )?;
            if let Some((change, gain)) = selected {
                refinement = Some(change);
                refinement_gain = gain;
            }
        }
    }
    header_budget.commit(&block, mx, above_modes, left_modes, segments)?;
    commit_tile::<16, 256>(reconstructed_y, padded_w, x, y, &selected_luma.tile);
    commit_tile::<8, 64>(reconstructed_u, uv_w, mx * 8, my * 8, &selected_uv.u_tile);
    commit_tile::<8, 64>(reconstructed_v, uv_w, mx * 8, my * 8, &selected_uv.v_tile);
    coeff_contexts.encode_coefficients(&mut RateCounter::default(), &block, mx)?;
    update_modes(&block, mx, above_modes, left_modes);
    Ok(AnalyzedBlock {
        block,
        refinement,
        refinement_gain,
    })
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

fn write_header_suffix(
    sink: &mut impl BoolSink,
    skip_probability: Option<u8>,
) -> Result<(), EncodeError> {
    sink.bit(skip_probability.is_some())?;
    if let Some(probability) = skip_probability {
        sink.literal(u32::from(probability), 8)?;
    }
    Ok(())
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

    fn frozen_syntax(self) -> Option<u8> {
        (self.skipped != 0).then(|| self.frozen_probability())
    }
}

// I16 signals at most two segment-map bits, skip, three Y-mode bits and
// three UV-mode bits. I4 additionally signals sixteen B modes, each at most
// seven bits. A Boolean symbol can emit no more than one arithmetic byte.
const MAX_I16_HEADER_SYMBOLS: usize = 9;
const FINAL_TAIL_BYTES: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
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
        write_header_suffix(&mut fixed, Some(128))?;
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
        write_macroblock_header(&mut symbols, block, mx, above, left, segments, Some(128))?;
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
    skip_probability: Option<u8>,
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
    let FrozenVariant {
        model,
        skip_probability,
        sizes: selected,
        use_model,
    } = count_frozen_variant(blocks, blocks_x, blocks_y, segments, deltas, filter)?;
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

struct FrozenVariant {
    model: Model,
    skip_probability: Option<u8>,
    sizes: (usize, usize),
    use_model: bool,
}

#[allow(clippy::too_many_arguments)]
fn count_frozen_variant(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
    segments: SegmentConfig,
    deltas: Deltas,
    filter: FilterConfig,
) -> Result<FrozenVariant, EncodeError> {
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
        && (default_sizes.0 > 0x7ffff
            || modeled_sizes.0 + modeled_sizes.1 < default_sizes.0 + default_sizes.1);
    let selected = if use_model {
        modeled_sizes
    } else {
        default_sizes
    };
    Ok(FrozenVariant {
        model,
        skip_probability,
        sizes: selected,
        use_model,
    })
}

fn model_frozen(
    blocks: &[Macroblock],
    blocks_x: usize,
    blocks_y: usize,
) -> Result<(Model, Option<u8>), EncodeError> {
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
    Ok((model, skips.frozen_syntax()))
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
    skip_probability: Option<u8>,
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
    skip_probability: Option<u8>,
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
    PreviewPrefix = 19,
    PreviewUpdates = 20,
    PreviewSuffix = 21,
    PreviewReset = 22,
    PreviewCollectStats = 23,
    PreviewOptimize = 24,
    PreviewRateBlocks = 25,
    PreviewResetMetadata = 26,
    PreviewFilter = 54,
    PreviewRgbError = 55,
    ReverseRefinements = 27,
    ReapplyRefinements = 28,
    ReleaseRefinements = 35,
    JointRefine = 36,
    ReverseToBaseline = 37,
    ApplyBaseline = 38,
    ReverseBaseline = 39,
    ReverseUnchanged = 40,
    QualityInit = 41,
    QualityCopy = 42,
    QualityFilter = 43,
    QualityMetric = 44,
    QualityRelease = 53,
}

struct RefinedCheckpoint {
    emission: EmissionModel,
    skip_probability: Option<u8>,
    sizes: (u32, u32),
    default_frame_bytes: u32,
    selected_frame_bytes: u32,
    update_count: u32,
    use_model: bool,
    legality: Result<(), Status>,
    quality: f64,
}

fn aligned_payload_cost(bytes: u32) -> u64 {
    (u64::from(bytes) + 1) & !1
}

fn choose_scored_variants(
    extended: (u32, Result<(), Status>, f64),
    baseline: Option<(u32, Result<(), Status>, f64)>,
    base: (u32, Result<(), Status>, f64),
) -> Result<VariantChoice, Status> {
    let entries = [
        (VariantChoice::Extended, Some(extended)),
        (VariantChoice::Baseline, baseline),
        (VariantChoice::Base, Some(base)),
    ];
    for (_, entry) in entries {
        if let Some((_, legality, score)) = entry {
            if !score.is_finite() {
                return Err(Status::InvalidInput);
            }
            if let Err(error) = legality {
                if !matches!(error, Status::OutputLimit | Status::PartitionLimit) {
                    return Err(error);
                }
            }
        }
    }
    let base_cost = aligned_payload_cost(base.0);
    let mut best_within_base: Option<f64> = None;
    if base.1.is_ok() {
        for (_, entry) in entries {
            if let Some((bytes, Ok(()), score)) = entry {
                if aligned_payload_cost(bytes) <= base_cost
                    && best_within_base.is_none_or(|best| score > best)
                {
                    best_within_base = Some(score);
                }
            }
        }
    }
    let mut best = None;
    for (choice, entry) in entries {
        if let Some((bytes, Ok(()), score)) = entry {
            let eligible = base.1.is_err()
                || aligned_payload_cost(bytes) <= base_cost
                || (choice != VariantChoice::Base
                    && aligned_payload_cost(bytes) == base_cost + 2
                    && best_within_base.is_some_and(|within| score > within));
            if eligible && best.is_none_or(|(_, value)| score > value) {
                best = Some((choice, score));
            }
        }
    }
    best.map(|(choice, _)| choice)
        .ok_or_else(|| base.1.unwrap_err())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VariantChoice {
    Extended,
    Baseline,
    Base,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreviewTrial {
    None,
    Original,
    Reduced,
    FinalOriginal,
    FinalReduced,
}

/// One step initializes or copies at most 64 KiB, converts one YUV row pair,
/// analyzes or filters one macroblock, scores at most 1,024 profile pixels
/// or 64 moment blocks, codes
/// one macroblock, or assembles at most 64 KiB. Quality-cache chunks are
/// allocated and released at most 64 KiB per step. The host owns scheduling
/// and cancellation between calls.
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
    refinement_log: RefinementLog,
    baseline_overrides: Vec<BaselineOverride>,
    joint_search: Vec<JointSearch>,
    joint_baseline: bool,
    joint_used_total: usize,
    refined_checkpoint: Option<RefinedCheckpoint>,
    baseline_checkpoint: Option<RefinedCheckpoint>,
    base_count: bool,
    baseline_count: bool,
    baseline_reapply: bool,
    quality_variant: VariantChoice,
    quality_score: Option<display_rgb::CompleteScore>,
    base_quality: f64,
    base_legality: Result<(), Status>,
    quality_copy_plane: usize,
    override_cursor: usize,
    replay_index: usize,
    pending_output_sizes: Option<(u32, u32)>,
    release_total_slabs: usize,
    #[cfg(test)]
    disable_refinement: bool,
    class_counts: [usize; 4],
    curvature: segmentation::CurvatureTotals,
    photo_q60: bool,
    mixed_y1_ac: bool,
    neutral_chroma: bool,
    rgb_error_sum: u64,
    high_chroma_loss: bool,
    medium_textured_luma: bool,
    preview_trial: PreviewTrial,
    preview_comparison: ProfileComparison,
    preview_header_rate: RateCounter,
    preview_original_score: u64,
    reset_plane: usize,
    deltas: Deltas,
    segments: SegmentConfig,
    header_budget: HeaderBudget,
    contexts: CoeffContexts,
    above_modes: Vec<u8>,
    left_modes: [u8; 4],
    count_header: CountingBoolSink,
    count_token: CountingBoolSink,
    stats: Statistics,
    skip_stats: SkipStats,
    skip_probability: Option<u8>,
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

// Metadata reset clears fixed arrays plus one column of coefficient/mode
// context. Large reconstruction and macroblock storage is reset separately.
const _: () = assert!(
    std::mem::size_of::<FrameEncoder>() + 13 * (MAX_DIMENSION as usize).div_ceil(16) <= 65_536
);
// The shared 8 MiB scratch charge covers the bounded log, two Boolean op
// buffers, display cache, fixed engine state and an allocator margin.
const _: () = assert!(
    REFINEMENT_LOG_BUDGET_BYTES
        + BASELINE_OVERRIDE_BUDGET_BYTES
        + 2 * crate::rate::MAX_BUFFERED_OPS * 2
        + 65_536
        + 3 * std::mem::size_of::<i32>() // Local chroma DC feedback.
        + std::mem::size_of::<FrameEncoder>()
        + 1024 * 1024
        + display_rgb::MAX_QUALITY_CACHE_BYTES
        <= SCRATCH_ALLOWANCE_BYTES as usize
);

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
            refinement_log: RefinementLog::default(),
            baseline_overrides: Vec::new(),
            joint_search: Vec::new(),
            joint_baseline: false,
            joint_used_total: 0,
            refined_checkpoint: None,
            baseline_checkpoint: None,
            base_count: false,
            baseline_count: false,
            baseline_reapply: false,
            quality_variant: VariantChoice::Extended,
            quality_score: None,
            base_quality: 0.0,
            base_legality: Ok(()),
            quality_copy_plane: 0,
            override_cursor: 0,
            replay_index: 0,
            pending_output_sizes: None,
            release_total_slabs: 0,
            #[cfg(test)]
            disable_refinement: false,
            class_counts: [0; 4],
            curvature: segmentation::CurvatureTotals::default(),
            photo_q60: false,
            mixed_y1_ac: false,
            neutral_chroma: true,
            rgb_error_sum: 0,
            high_chroma_loss: false,
            medium_textured_luma: false,
            preview_trial: PreviewTrial::None,
            preview_comparison: ProfileComparison::default(),
            preview_header_rate: RateCounter::default(),
            preview_original_score: 0,
            reset_plane: 0,
            deltas: crate::presets::deltas(request.quality),
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
            skip_probability: Some(128),
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
        // ABI2 diagnostics distinguish the two scored profiles without
        // changing the internal filter/metric state machine or record layout.
        if matches!(
            self.preview_trial,
            PreviewTrial::Original | PreviewTrial::Reduced
        ) {
            let profile = if self.preview_trial == PreviewTrial::Original {
                0
            } else {
                2
            };
            match self.stage {
                Stage::PreviewFilter => return 54 + profile,
                Stage::PreviewRgbError => return 55 + profile,
                _ => {}
            }
        }
        if matches!(
            self.stage,
            Stage::QualityInit | Stage::QualityCopy | Stage::QualityFilter | Stage::QualityMetric
        ) {
            let variant = match self.quality_variant {
                VariantChoice::Extended => 0,
                VariantChoice::Baseline => 1,
                VariantChoice::Base => 2,
            };
            return self.stage as u32 + variant * 4;
        }
        if self.base_count {
            match self.stage {
                Stage::CollectStats => return 29,
                Stage::Optimize => return 30,
                Stage::CountPrefix => return 31,
                Stage::CountUpdates => return 32,
                Stage::CountSuffix => return 33,
                Stage::CountBlocks => return 34,
                _ => {}
            }
        }
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
            | Stage::PreviewCollectStats
            | Stage::PreviewRateBlocks
            | Stage::CountBlocks
            | Stage::EmitBlocks => (self.cursor as u32, blocks),
            Stage::Optimize | Stage::PreviewOptimize => (self.cursor as u32, NODE_COUNT as u32),
            Stage::CountUpdates | Stage::EmitUpdates | Stage::PreviewUpdates => {
                (self.cursor as u32, super::COEFF_UPDATE_PROBS.len() as u32)
            }
            Stage::PreviewReset => {
                let plane_bytes = self.reconstructed_y.len()
                    + self.reconstructed_u.len()
                    + self.reconstructed_v.len();
                let block_bytes = self.blocks.len() * std::mem::size_of::<Macroblock>();
                let done = match self.reset_plane {
                    0 => self.cursor,
                    1 => self.reconstructed_y.len() + self.cursor,
                    2 => self.reconstructed_y.len() + self.reconstructed_u.len() + self.cursor,
                    _ => plane_bytes + self.cursor * std::mem::size_of::<Macroblock>(),
                };
                (done as u32, (plane_bytes + block_bytes) as u32)
            }
            Stage::Assemble => (self.output.len() as u32, self.plan.frame_bytes),
            Stage::QualityInit => self.quality_score.as_ref().map_or((0, 1), |score| {
                let (done, total) = score.initialization_progress();
                (done as u32, total as u32)
            }),
            Stage::QualityCopy => {
                let previous = match self.quality_copy_plane {
                    0 => 0,
                    1 => self.source_y.len(),
                    2 => self.source_y.len() + self.source_u.len(),
                    _ => self.plan.yuv_plane_set_bytes as usize,
                };
                (
                    (previous + self.cursor) as u32,
                    self.plan.yuv_plane_set_bytes,
                )
            }
            Stage::QualityFilter => (self.cursor as u32, blocks),
            Stage::PreviewFilter => (self.cursor as u32, blocks),
            Stage::PreviewRgbError => {
                (self.cursor as u32, self.request.width * self.request.height)
            }
            Stage::QualityMetric => self.quality_score.as_ref().map_or((0, 1), |score| {
                let (done, total) = score.progress();
                (done as u32, total as u32)
            }),
            Stage::QualityRelease => self.quality_score.as_ref().map_or((1, 1), |score| {
                let (done, total) = score.release_progress();
                (done as u32, total as u32)
            }),
            Stage::ReverseRefinements => (
                (self.refinement_log.len - self.replay_index) as u32,
                self.refinement_log.len as u32,
            ),
            Stage::ReapplyRefinements => (self.replay_index as u32, self.refinement_log.len as u32),
            Stage::ReleaseRefinements => (
                self.release_total_slabs
                    .saturating_sub(self.refinement_log.slabs.len()) as u32,
                self.release_total_slabs as u32,
            ),
            Stage::JointRefine => self.joint_search.first().map_or((0, 1), |search| {
                (search.used() as u32, search.quota() as u32)
            }),
            Stage::ReverseToBaseline | Stage::ReverseUnchanged => (
                (self.refinement_log.len - self.replay_index) as u32,
                self.refinement_log.len as u32,
            ),
            Stage::ApplyBaseline => (
                self.override_cursor as u32,
                self.baseline_overrides.len() as u32,
            ),
            Stage::ReverseBaseline => (
                (self.baseline_overrides.len() - self.override_cursor) as u32,
                self.baseline_overrides.len() as u32,
            ),
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
            if self.request.quality == 60 || self.request.quality == 75 {
                self.rgb_error_sum += crate::color::nearest_chroma_rgb_error(
                    rgb,
                    luma,
                    u,
                    v,
                    width.saturating_sub(cx * 2).min(2),
                    height.saturating_sub(cy * 2).min(2),
                );
            }
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
            self.high_chroma_loss = crate::presets::high_chroma_loss(
                self.request.quality,
                self.rgb_error_sum,
                self.request.width,
                self.request.height,
            );
            self.preview_trial = if self.high_chroma_loss {
                PreviewTrial::Original
            } else {
                PreviewTrial::None
            };
            self.deltas = if self.high_chroma_loss {
                crate::presets::original_high_chroma_loss_deltas()
            } else {
                crate::presets::frame_deltas(
                    self.request.quality,
                    self.rgb_error_sum,
                    self.request.width,
                    self.request.height,
                )
            };
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

    fn reset_variant_count(&mut self) {
        self.reset_coding_state();
        self.stats = Statistics::new();
        self.skip_stats = SkipStats::default();
        self.skip_probability = Some(128);
        self.model = Model::new();
        self.model_count_pass = false;
        self.use_model = false;
        self.default_sizes = (0, 0);
        self.default_frame_bytes = 0;
        self.selected_frame_bytes = 0;
        self.update_count = 0;
        self.count_header = CountingBoolSink::default();
        self.count_token = CountingBoolSink::default();
    }

    fn begin_quality(&mut self, variant: VariantChoice) -> Result<(), Status> {
        self.quality_variant = variant;
        if let Some(score) = &mut self.quality_score {
            score.reset();
        } else {
            self.quality_score = Some(
                display_rgb::CompleteScore::new(
                    self.request.width as usize,
                    self.request.height as usize,
                )
                .ok_or(Status::MemoryAdmission)?,
            );
        }
        self.cursor = 0;
        self.quality_copy_plane = 0;
        self.stage = Stage::QualityInit;
        Ok(())
    }

    fn quality_one_step(&mut self) -> Result<(), Status> {
        match self.stage {
            Stage::QualityInit => {
                let score = self.quality_score.as_mut().ok_or(Status::InvalidInput)?;
                if !score.initialized() && !score.initialize_chunk() {
                    return Err(Status::MemoryAdmission);
                }
                if score.initialized() {
                    self.stage = Stage::QualityCopy;
                }
            }
            Stage::QualityCopy => {
                let (src, dst) = match self.quality_copy_plane {
                    0 => (&self.reconstructed_y, &mut self.source_y),
                    1 => (&self.reconstructed_u, &mut self.source_u),
                    2 => (&self.reconstructed_v, &mut self.source_v),
                    _ => return Err(Status::InvalidInput),
                };
                let end = (self.cursor + 65_536).min(src.len());
                dst.get_mut(self.cursor..end)
                    .ok_or(Status::InvalidInput)?
                    .copy_from_slice(&src[self.cursor..end]);
                self.cursor = end;
                if end == src.len() {
                    self.quality_copy_plane += 1;
                    if self.quality_copy_plane == 3 {
                        self.cursor = 0;
                        self.stage = Stage::QualityFilter;
                    } else {
                        self.cursor = 0;
                    }
                }
            }
            Stage::QualityFilter => {
                let count = self.blocks.len();
                let end = (self.cursor + 1).min(count);
                for index in self.cursor..end {
                    filter_completed_one(
                        &mut self.source_y,
                        &mut self.source_u,
                        &mut self.source_v,
                        self.plan.padded_width as usize,
                        self.plan.padded_height as usize,
                        index,
                        &self.blocks,
                        self.filter,
                    )
                    .map_err(encode_status)?;
                }
                self.cursor = end;
                if end == count {
                    self.cursor = 0;
                    self.stage = Stage::QualityMetric;
                }
            }
            Stage::QualityMetric => {
                let view = display_rgb::CompleteFrame::checked(
                    self.request.width as usize,
                    self.request.height as usize,
                    self.plan.padded_width as usize,
                    display_rgb::Original {
                        pixels: &self.input,
                        stride: self.request.stride as usize,
                        layout: self.request.layout,
                    },
                    &self.source_y,
                    &self.source_u,
                    &self.source_v,
                )
                .ok_or(Status::InvalidInput)?;
                let score = self.quality_score.as_mut().ok_or(Status::InvalidInput)?;
                score.advance(&view);
                if score.progress().0 == score.progress().1 {
                    let value = score.finish().ok_or(Status::InvalidInput)?;
                    self.finish_quality(value)?;
                }
            }
            _ => return Err(Status::InvalidInput),
        }
        Ok(())
    }

    fn finish_quality(&mut self, value: f64) -> Result<(), Status> {
        match self.quality_variant {
            VariantChoice::Extended => {
                self.refined_checkpoint
                    .as_mut()
                    .ok_or(Status::InvalidInput)?
                    .quality = value;
                self.replay_index = self.refinement_log.len;
                self.stage = if self.baseline_overrides.is_empty() {
                    Stage::ReverseRefinements
                } else {
                    Stage::ReverseToBaseline
                };
            }
            VariantChoice::Baseline => {
                self.baseline_checkpoint
                    .as_mut()
                    .ok_or(Status::InvalidInput)?
                    .quality = value;
                self.override_cursor = self.baseline_overrides.len();
                self.stage = Stage::ReverseBaseline;
            }
            VariantChoice::Base => {
                self.base_quality = value;
                self.choose_completed_quality()?;
            }
        }
        Ok(())
    }

    fn choose_completed_quality(&mut self) -> Result<(), Status> {
        let refined = self
            .refined_checkpoint
            .as_ref()
            .ok_or(Status::InvalidInput)?;
        let baseline = self.baseline_checkpoint.as_ref().map(|checkpoint| {
            (
                checkpoint.selected_frame_bytes,
                checkpoint.legality,
                checkpoint.quality,
            )
        });
        let choice = choose_scored_variants(
            (
                refined.selected_frame_bytes,
                refined.legality,
                refined.quality,
            ),
            baseline,
            (
                self.selected_frame_bytes,
                self.base_legality,
                self.base_quality,
            ),
        )?;
        match choice {
            VariantChoice::Extended | VariantChoice::Baseline => {
                self.baseline_reapply = choice == VariantChoice::Baseline;
                self.stage = Stage::ReapplyRefinements;
                self.replay_index = 0;
            }
            VariantChoice::Base => {
                self.refined_checkpoint = None;
                self.baseline_checkpoint = None;
                self.begin_refinement_release();
            }
        }
        Ok(())
    }

    fn begin_refinement_release(&mut self) {
        self.release_total_slabs = self.refinement_log.slabs.len();
        self.baseline_overrides = Vec::new();
        self.stage = Stage::ReleaseRefinements;
    }

    fn restore_selected_checkpoint(&mut self, checkpoint: RefinedCheckpoint) -> Result<(), Status> {
        if checkpoint.legality.is_err() {
            return Err(Status::InvalidInput);
        }
        self.model.restore_emission(&checkpoint.emission);
        self.skip_probability = checkpoint.skip_probability;
        self.default_frame_bytes = checkpoint.default_frame_bytes;
        self.selected_frame_bytes = checkpoint.selected_frame_bytes;
        self.update_count = checkpoint.update_count;
        self.use_model = checkpoint.use_model;
        self.pending_output_sizes = Some(checkpoint.sizes);
        self.reset_coding_state();
        self.begin_refinement_release();
        Ok(())
    }

    fn replay_at(&mut self, index: usize, forward: bool) -> Result<(), Status> {
        let edit = self.refinement_log.get(index).ok_or(Status::InvalidInput)?;
        replay_edit_state(
            &mut self.blocks,
            &mut self.reconstructed_u,
            &mut self.reconstructed_v,
            self.plan.padded_width as usize,
            self.segments,
            self.deltas,
            edit,
            forward,
        )
    }

    fn replay_baseline_override(&mut self, index: usize, forward: bool) -> Result<(), Status> {
        let item = *self
            .baseline_overrides
            .get(index)
            .ok_or(Status::InvalidInput)?;
        if let Some(change) = item.baseline {
            replay_edit_state(
                &mut self.blocks,
                &mut self.reconstructed_u,
                &mut self.reconstructed_v,
                self.plan.padded_width as usize,
                self.segments,
                self.deltas,
                RefinementEdit {
                    block: item.block,
                    change,
                },
                forward,
            )?;
        }
        Ok(())
    }

    fn reverse_to_baseline_one_step(&mut self) -> Result<(), Status> {
        if self.replay_index > 0 {
            let index = self.replay_index - 1;
            let edit = self.refinement_log.get(index).ok_or(Status::InvalidInput)?;
            if is_overridden(&self.baseline_overrides, edit, index)? {
                self.replay_at(index, false)?;
            }
            self.replay_index = index;
        }
        if self.replay_index == 0 {
            self.override_cursor = 0;
            self.stage = Stage::ApplyBaseline;
        }
        Ok(())
    }

    fn apply_baseline_one_step(&mut self) -> Result<(), Status> {
        if self.override_cursor < self.baseline_overrides.len() {
            self.replay_baseline_override(self.override_cursor, true)?;
            self.override_cursor += 1;
        }
        if self.override_cursor == self.baseline_overrides.len() {
            if self.baseline_reapply {
                self.baseline_reapply = false;
                let baseline = self
                    .baseline_checkpoint
                    .take()
                    .ok_or(Status::InvalidInput)?;
                self.refined_checkpoint = None;
                self.restore_selected_checkpoint(baseline)?;
            } else {
                self.reset_variant_count();
                self.base_count = true;
                self.baseline_count = true;
                self.stage = Stage::CollectStats;
            }
        }
        Ok(())
    }

    fn reverse_baseline_one_step(&mut self) -> Result<(), Status> {
        if self.override_cursor > 0 {
            self.override_cursor -= 1;
            self.replay_baseline_override(self.override_cursor, false)?;
        }
        if self.override_cursor == 0 {
            self.replay_index = self.refinement_log.len;
            self.stage = Stage::ReverseUnchanged;
        }
        Ok(())
    }

    fn reverse_unchanged_one_step(&mut self) -> Result<(), Status> {
        if self.replay_index > 0 {
            let index = self.replay_index - 1;
            let edit = self.refinement_log.get(index).ok_or(Status::InvalidInput)?;
            if !is_overridden(&self.baseline_overrides, edit, index)? {
                self.replay_at(index, false)?;
            }
            self.replay_index = index;
        }
        if self.replay_index == 0 {
            self.reset_variant_count();
            self.baseline_count = false;
            self.stage = Stage::CollectStats;
        }
        Ok(())
    }

    fn replay_one_refinement(&mut self, forward: bool) -> Result<(), Status> {
        let index = if forward {
            self.replay_index
        } else {
            self.replay_index
                .checked_sub(1)
                .ok_or(Status::InvalidInput)?
        };
        self.replay_at(index, forward)?;
        if forward {
            self.replay_index += 1;
        } else {
            self.replay_index -= 1;
        }
        Ok(())
    }

    fn original_segments(&self) -> SegmentConfig {
        SegmentConfig::from_counts(
            self.request.quality,
            self.class_counts,
            self.blocks.len(),
            self.neutral_chroma,
        )
    }

    fn begin_preview_reset(&mut self) {
        self.reset_plane = 0;
        self.cursor = 0;
        self.stage = Stage::PreviewReset;
    }

    fn reset_preview_one_step(&mut self) -> Result<(), Status> {
        if self.reset_plane < 3 {
            let plane = match self.reset_plane {
                0 => &mut self.reconstructed_y,
                1 => &mut self.reconstructed_u,
                _ => &mut self.reconstructed_v,
            };
            let end = (self.cursor + 65_536).min(plane.len());
            plane[self.cursor..end].fill(0);
            self.cursor = end;
            if end == plane.len() {
                self.reset_plane += 1;
                self.cursor = 0;
            }
            return Ok(());
        }
        let count = (65_536 / std::mem::size_of::<Macroblock>()).max(1);
        let end = (self.cursor + count).min(self.blocks.len());
        for block in &mut self.blocks[self.cursor..end] {
            let segment_id = block.segment_id;
            *block = Macroblock {
                segment_id,
                ..Macroblock::default()
            };
        }
        self.cursor = end;
        if end == self.blocks.len() {
            self.stage = Stage::PreviewResetMetadata;
        }
        Ok(())
    }

    fn reset_preview_metadata(&mut self) -> Result<(), Status> {
        self.reset_coding_state();
        self.header_budget = HeaderBudget::new(
            self.blocks.len(),
            self.segments,
            self.deltas,
            self.filter,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .map_err(encode_status)?;
        self.preview_comparison = ProfileComparison::default();
        self.preview_header_rate = RateCounter::default();
        self.stats = Statistics::new();
        self.skip_stats = SkipStats::default();
        self.model = Model::new();
        self.count_header = CountingBoolSink::default();
        self.count_token = CountingBoolSink::default();
        self.skip_probability = Some(128);
        self.model_count_pass = false;
        self.use_model = false;
        self.stage = Stage::Analyze;
        Ok(())
    }

    fn finish_preview(&mut self) -> Result<(), Status> {
        let original = self.original_segments();
        let score = self
            .preview_comparison
            .score(
                self.preview_header_rate.cost,
                original.base_qindex,
                self.request.quality,
            )
            .map_err(encode_status)?;
        match self.preview_trial {
            PreviewTrial::Original => {
                self.preview_original_score = score;
                self.segments = original.with_high_chroma_loss_luma(true);
                self.deltas = crate::presets::frame_deltas(
                    self.request.quality,
                    self.rgb_error_sum,
                    self.request.width,
                    self.request.height,
                );
                self.preview_trial = PreviewTrial::Reduced;
                self.begin_preview_reset();
            }
            PreviewTrial::Reduced => {
                if reduced_profile_wins(self.preview_original_score, score) {
                    self.preview_trial = PreviewTrial::FinalReduced;
                } else {
                    self.segments = original;
                    self.deltas = crate::presets::original_high_chroma_loss_deltas();
                    self.preview_trial = PreviewTrial::FinalOriginal;
                }
                self.begin_preview_reset();
            }
            _ => return Err(Status::InvalidInput),
        }
        Ok(())
    }

    fn classify_one_step(&mut self) -> Result<(), Status> {
        let blocks_x = self.plan.padded_width as usize / 16;
        let mx = self.cursor % blocks_x;
        let my = self.cursor / blocks_x;
        let segment_id = segmentation::classify_with_curvature(
            &self.source_y,
            &self.source_u,
            &self.source_v,
            self.plan.padded_width as usize,
            mx,
            my,
            (self.request.quality == 60).then_some(&mut self.curvature),
        );
        self.class_counts[segment_id as usize] += 1;
        self.blocks.push(Macroblock {
            segment_id,
            ..Macroblock::default()
        });
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            self.medium_textured_luma = crate::presets::medium_textured_luma(
                self.request.quality,
                self.class_counts,
                self.blocks.len(),
                self.rgb_error_sum,
                self.request.width,
                self.request.height,
            );
            self.segments = SegmentConfig::from_counts(
                self.request.quality,
                self.class_counts,
                self.blocks.len(),
                self.neutral_chroma,
            )
            .with_medium_textured_luma(self.medium_textured_luma);
            self.photo_q60 = crate::presets::photo_q60_all_texture(
                self.request.quality,
                self.class_counts,
                self.blocks.len(),
                self.neutral_chroma,
                self.high_chroma_loss,
                self.curvature.within_cutoff(self.blocks.len()),
            );
            self.mixed_y1_ac = crate::presets::mixed_y1_ac_profile(
                self.request.quality,
                self.class_counts,
                self.neutral_chroma,
                self.high_chroma_loss,
                self.curvature.within_cutoff(self.blocks.len()),
            );
            self.segments = self
                .segments
                .with_photo_q60_rebase(self.photo_q60)
                .with_mixed_q60_uniform(self.class_counts, self.mixed_y1_ac);
            if self.medium_textured_luma {
                self.deltas = crate::presets::medium_textured_deltas(self.deltas);
            }
            self.deltas = crate::presets::photo_allocation_deltas(
                self.deltas,
                self.photo_q60,
                self.medium_textured_luma && !self.neutral_chroma,
            );
            self.deltas = crate::presets::mixed_y1_ac_deltas(self.deltas, self.mixed_y1_ac);
            self.header_budget = HeaderBudget::new(
                self.blocks.len(),
                self.segments,
                self.deltas,
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
        let quota = if self.high_chroma_loss {
            0
        } else {
            extra_quota(self.cursor, self.plan.macroblock_count as usize)
        };
        #[cfg(test)]
        let quota = if self.disable_refinement { 0 } else { quota };
        if mx == 0 {
            self.contexts.row();
            self.left_modes.fill(0);
        }
        let segment_id = self.blocks[self.cursor].segment_id;
        let qindex = self.segments.qindex_for(segment_id);
        let deltas = self.deltas;
        let y_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y1);
        let uv_steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
        let y2_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y2);
        let rate_qindex = if self.medium_textured_luma || self.photo_q60 || self.mixed_y1_ac {
            self.original_segments().qindex_for(segment_id)
        } else {
            qindex
        };
        let lambda = crate::presets::lambda_for_quality(rate_qindex, self.request.quality);
        let original_rgb = Some(display_rgb::Original {
            pixels: &self.input,
            stride: self.request.stride as usize,
            layout: self.request.layout,
        });
        #[cfg(test)]
        let original_rgb = if self.disable_refinement {
            None
        } else {
            original_rgb
        };
        if !self.high_chroma_loss {
            self.refinement_log
                .reserve_one(self.plan.macroblock_count as usize + 128)?;
        }
        let analyzed = analyze_one(
            &self.source_y,
            &self.source_u,
            &self.source_v,
            original_rgb,
            self.high_chroma_loss,
            self.mixed_y1_ac,
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
            self.request.quality,
            self.request.width as usize,
            self.request.height as usize,
            0,
            segment_id,
            self.segments,
            &mut self.header_budget,
        )
        .map_err(encode_status)?;
        if let Some(change) = analyzed.refinement {
            self.refinement_log.push_reserved(RefinementEdit {
                block: self.cursor as u32,
                change,
            })?;
        }
        self.blocks[self.cursor] = analyzed.block;
        if quota > 0 && !analyzed.block.skip() {
            let padded_w = self.plan.padded_width as usize;
            let x = mx * 16;
            let y = my * 16;
            let tile_y = read_tile::<16, 256>(&self.reconstructed_y, padded_w, x, y);
            let tile_u = read_tile::<8, 64>(&self.reconstructed_u, padded_w / 2, mx * 8, my * 8);
            let tile_v = read_tile::<8, 64>(&self.reconstructed_v, padded_w / 2, mx * 8, my * 8);
            let frame = display_rgb::Frame {
                width: self.request.width as usize,
                height: self.request.height as usize,
                stride_y: padded_w,
                original: display_rgb::Original {
                    pixels: &self.input,
                    stride: self.request.stride as usize,
                    layout: self.request.layout,
                },
                source_y: &self.source_y,
                source_u: &self.source_u,
                source_v: &self.source_v,
                reconstructed_y: &self.reconstructed_y,
                reconstructed_u: &self.reconstructed_u,
                reconstructed_v: &self.reconstructed_v,
                tile_y: &tile_y,
                tile_u: &tile_u,
                tile_v: &tile_v,
                mx,
                my,
            };
            if let Some(search) = JointSearch::new(
                &frame,
                &analyzed.block,
                analyzed
                    .refinement
                    .map(|change| (change, analyzed.refinement_gain)),
                &self.reconstructed_u,
                &self.reconstructed_v,
                uv_steps,
                quota,
            )
            .map_err(encode_status)?
            {
                if self.joint_search.capacity() == 0 {
                    self.joint_search
                        .try_reserve_exact(1)
                        .map_err(|_| Status::MemoryAdmission)?;
                    if self.joint_search.capacity() * std::mem::size_of::<JointSearch>() > 65_536 {
                        return Err(Status::MemoryAdmission);
                    }
                }
                if self.baseline_overrides.capacity() == 0 {
                    self.baseline_overrides
                        .try_reserve_exact((self.plan.macroblock_count as usize).min(128))
                        .map_err(|_| Status::MemoryAdmission)?;
                    if self.baseline_overrides.capacity() * std::mem::size_of::<BaselineOverride>()
                        > BASELINE_OVERRIDE_BUDGET_BYTES
                    {
                        return Err(Status::MemoryAdmission);
                    }
                }
                self.joint_search.push(search);
                self.joint_baseline = analyzed.refinement.is_some();
                self.stage = Stage::JointRefine;
                return Ok(());
            }
        }
        self.finish_analyzed_block();
        Ok(())
    }

    fn finish_analyzed_block(&mut self) {
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            self.joint_search = Vec::new();
            if self.refinement_log.is_empty() {
                self.refinement_log = RefinementLog::default();
            }
            if self.baseline_overrides.is_empty() {
                self.baseline_overrides = Vec::new();
            }
            self.reset_coding_state();
            self.stage = if matches!(
                self.preview_trial,
                PreviewTrial::Original | PreviewTrial::Reduced
            ) {
                Stage::PreviewCollectStats
            } else {
                Stage::CollectStats
            };
        } else {
            self.stage = Stage::Analyze;
        }
    }

    fn joint_one_step(&mut self) -> Result<(), Status> {
        let padded_w = self.plan.padded_width as usize;
        let blocks_x = padded_w / 16;
        let mx = self.cursor % blocks_x;
        let my = self.cursor / blocks_x;
        let block = &self.blocks[self.cursor];
        let qindex = self.segments.qindex_for(block.segment_id);
        let steps = ac_quant::steps(qindex as u8, self.deltas, Plane::UV);
        if self.joint_search.first().is_none_or(JointSearch::done) {
            let search = self.joint_search.pop().ok_or(Status::InvalidInput)?;
            let result = search.result(steps).map_err(encode_status)?;
            let prior = usize::from(self.joint_baseline);
            let start = self
                .refinement_log
                .len
                .checked_sub(prior)
                .ok_or(Status::InvalidInput)?;
            let baseline = if self.joint_baseline {
                let edit = self.refinement_log.get(start).ok_or(Status::InvalidInput)?;
                if edit.block as usize != self.cursor {
                    return Err(Status::InvalidInput);
                }
                Some(edit.change)
            } else {
                None
            };
            let differs = match baseline {
                Some(change) => result.len != 1 || result.changes[0] != change,
                None => result.len != 0,
            };
            if differs && self.baseline_overrides.len() == self.baseline_overrides.capacity() {
                return Err(Status::MemoryAdmission);
            }
            let target = self
                .refinement_log
                .len
                .checked_sub(prior)
                .and_then(|len| len.checked_add(result.len))
                .ok_or(Status::MemoryAdmission)?;
            self.refinement_log.reserve_additional(
                target.saturating_sub(self.refinement_log.len),
                self.plan.macroblock_count as usize + 128,
            )?;
            if self.joint_baseline {
                let old = self.refinement_log.pop_last().ok_or(Status::InvalidInput)?;
                if old.block as usize != self.cursor {
                    return Err(Status::InvalidInput);
                }
            }
            for &change in &result.changes[..result.len] {
                self.refinement_log.push_reserved(RefinementEdit {
                    block: self.cursor as u32,
                    change,
                })?;
            }
            if differs {
                self.baseline_overrides.push(BaselineOverride {
                    block: self.cursor as u32,
                    start: start as u32,
                    len: result.len as u8,
                    baseline,
                });
            }
            self.blocks[self.cursor] = result.block;
            commit_tile::<8, 64>(
                &mut self.reconstructed_u,
                padded_w / 2,
                mx * 8,
                my * 8,
                &result.u,
            );
            commit_tile::<8, 64>(
                &mut self.reconstructed_v,
                padded_w / 2,
                mx * 8,
                my * 8,
                &result.v,
            );
            self.joint_baseline = false;
            self.finish_analyzed_block();
            return Ok(());
        }
        let tile_y = read_tile::<16, 256>(&self.reconstructed_y, padded_w, mx * 16, my * 16);
        let tile_u = read_tile::<8, 64>(&self.reconstructed_u, padded_w / 2, mx * 8, my * 8);
        let tile_v = read_tile::<8, 64>(&self.reconstructed_v, padded_w / 2, mx * 8, my * 8);
        let frame = display_rgb::Frame {
            width: self.request.width as usize,
            height: self.request.height as usize,
            stride_y: padded_w,
            original: display_rgb::Original {
                pixels: &self.input,
                stride: self.request.stride as usize,
                layout: self.request.layout,
            },
            source_y: &self.source_y,
            source_u: &self.source_u,
            source_v: &self.source_v,
            reconstructed_y: &self.reconstructed_y,
            reconstructed_u: &self.reconstructed_u,
            reconstructed_v: &self.reconstructed_v,
            tile_y: &tile_y,
            tile_u: &tile_u,
            tile_v: &tile_v,
            mx,
            my,
        };
        let (right, below) =
            uv_future_consumers(mx, my, padded_w, self.plan.padded_height as usize);
        let used_before = self.joint_search[0].used();
        self.joint_search[0]
            .step(&frame, steps, right, below)
            .map_err(encode_status)?;
        self.joint_used_total += self.joint_search[0].used() - used_before;
        if self.joint_used_total > 128 {
            return Err(Status::InvalidInput);
        }
        Ok(())
    }

    fn preview_rate_one_step(&mut self) -> Result<(), Status> {
        let blocks_x = self.plan.padded_width as usize / 16;
        let mx = self.cursor % blocks_x;
        if mx == 0 {
            self.contexts.row();
            self.left_modes.fill(0);
        }
        let block = &self.blocks[self.cursor];
        let original_qindex = self.original_segments().qindex_for(block.segment_id);
        let rate = estimated_block_rate(
            block,
            mx,
            &mut self.contexts,
            &mut self.above_modes,
            &mut self.left_modes,
            self.segments,
            &self.model,
            self.skip_probability,
        )
        .map_err(encode_status)?;
        self.preview_comparison
            .add_rate(rate, original_qindex, self.request.quality)
            .map_err(encode_status)?;
        self.cursor += 1;
        if self.cursor == self.blocks.len() {
            self.reset_coding_state();
            self.stage = Stage::PreviewFilter;
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
                self.use_model = first <= MAX_FIRST_PARTITION_BYTES as u32
                    && (self.default_sizes.0 > MAX_FIRST_PARTITION_BYTES as u32
                        || proposed_total < self.default_frame_bytes);
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
                if self.refinement_log.is_empty() && self.baseline_overrides.is_empty() {
                    self.plan = self.plan.with_output_sizes(first, second)?;
                    self.stage = Stage::PrepareOutput;
                } else if !self.base_count {
                    let legality = match self.plan.with_output_sizes(first, second) {
                        Ok(_) => Ok(()),
                        Err(error @ (Status::PartitionLimit | Status::OutputLimit)) => Err(error),
                        Err(error) => return Err(error),
                    };
                    self.refined_checkpoint = Some(RefinedCheckpoint {
                        emission: self.model.emission(),
                        skip_probability: self.skip_probability,
                        sizes: (first, second),
                        default_frame_bytes: self.default_frame_bytes,
                        selected_frame_bytes: self.selected_frame_bytes,
                        update_count: self.update_count,
                        use_model: self.use_model,
                        legality,
                        quality: 0.0,
                    });
                    self.begin_quality(VariantChoice::Extended)?;
                } else if self.baseline_count {
                    let legality = match self.plan.with_output_sizes(first, second) {
                        Ok(_) => Ok(()),
                        Err(error @ (Status::PartitionLimit | Status::OutputLimit)) => Err(error),
                        Err(error) => return Err(error),
                    };
                    self.baseline_checkpoint = Some(RefinedCheckpoint {
                        emission: self.model.emission(),
                        skip_probability: self.skip_probability,
                        sizes: (first, second),
                        default_frame_bytes: self.default_frame_bytes,
                        selected_frame_bytes: self.selected_frame_bytes,
                        update_count: self.update_count,
                        use_model: self.use_model,
                        legality,
                        quality: 0.0,
                    });
                    self.begin_quality(VariantChoice::Baseline)?;
                } else {
                    let base_legality = match self.plan.with_output_sizes(first, second) {
                        Ok(_) => Ok(()),
                        Err(error @ (Status::PartitionLimit | Status::OutputLimit)) => Err(error),
                        Err(error) => return Err(error),
                    };
                    self.pending_output_sizes = Some((first, second));
                    self.base_legality = base_legality;
                    self.begin_quality(VariantChoice::Base)?;
                }
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
            Stage::JointRefine => self.joint_one_step()?,
            Stage::PreviewPrefix => {
                self.preview_header_rate = RateCounter::default();
                write_header_prefix(
                    &mut self.preview_header_rate,
                    self.segments,
                    self.deltas,
                    self.filter,
                )
                .map_err(encode_status)?;
                self.stage = Stage::PreviewUpdates;
            }
            Stage::PreviewUpdates => {
                let end = (self.cursor + 64).min(NODE_COUNT);
                write_updates(
                    &mut self.preview_header_rate,
                    Some(&self.model),
                    self.cursor,
                    end,
                )
                .map_err(encode_status)?;
                self.cursor = end;
                if end == NODE_COUNT {
                    self.cursor = 0;
                    self.stage = Stage::PreviewSuffix;
                }
            }
            Stage::PreviewSuffix => {
                write_header_suffix(&mut self.preview_header_rate, self.skip_probability)
                    .map_err(encode_status)?;
                self.reset_coding_state();
                self.stage = Stage::PreviewRateBlocks;
            }
            Stage::PreviewReset => self.reset_preview_one_step()?,
            Stage::PreviewResetMetadata => self.reset_preview_metadata()?,
            Stage::PreviewCollectStats => {
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
                    self.skip_probability = self.skip_stats.frozen_syntax();
                    self.cursor = 0;
                    self.stage = Stage::PreviewOptimize;
                }
            }
            Stage::PreviewOptimize => {
                let count = (NODE_COUNT - self.cursor).min(64);
                self.model
                    .optimize_range(&self.stats, self.cursor, count, &probability_cost)
                    .map_err(encode_status)?;
                self.cursor += count;
                if self.cursor == NODE_COUNT {
                    self.cursor = 0;
                    self.stage = Stage::PreviewPrefix;
                }
            }
            Stage::PreviewRateBlocks => self.preview_rate_one_step()?,
            Stage::PreviewFilter => {
                filter_completed_one(
                    &mut self.reconstructed_y,
                    &mut self.reconstructed_u,
                    &mut self.reconstructed_v,
                    self.plan.padded_width as usize,
                    self.plan.padded_height as usize,
                    self.cursor,
                    &self.blocks,
                    self.filter,
                )
                .map_err(encode_status)?;
                self.cursor += 1;
                if self.cursor == self.blocks.len() {
                    self.cursor = 0;
                    self.stage = Stage::PreviewRgbError;
                }
            }
            Stage::PreviewRgbError => {
                let width = self.request.width as usize;
                let total = width * self.request.height as usize;
                let count = (total - self.cursor).min(1_024);
                let view = display_rgb::CompleteFrame::checked(
                    width,
                    self.request.height as usize,
                    self.plan.padded_width as usize,
                    display_rgb::Original {
                        pixels: &self.input,
                        stride: self.request.stride as usize,
                        layout: self.request.layout,
                    },
                    &self.reconstructed_y,
                    &self.reconstructed_u,
                    &self.reconstructed_v,
                )
                .ok_or(Status::InvalidInput)?;
                self.preview_comparison.visible_error = self
                    .preview_comparison
                    .visible_error
                    .checked_add(view.squared_error_chunk(self.cursor, count))
                    .ok_or(Status::OutputLimit)?;
                self.cursor += count;
                if self.cursor == total {
                    self.reset_coding_state();
                    self.finish_preview()?;
                }
            }
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
                    self.skip_probability = self.skip_stats.frozen_syntax();
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
                    self.deltas,
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
            Stage::QualityInit
            | Stage::QualityCopy
            | Stage::QualityFilter
            | Stage::QualityMetric => self.quality_one_step()?,
            Stage::QualityRelease => {
                let score = self.quality_score.as_mut().ok_or(Status::InvalidInput)?;
                if score.release_one_chunk() {
                    self.quality_score = None;
                    self.stage = Stage::PrepareOutput;
                }
            }
            Stage::ReverseRefinements => {
                self.replay_one_refinement(false)?;
                if self.replay_index == 0 {
                    self.reset_variant_count();
                    self.base_count = true;
                    self.stage = Stage::CollectStats;
                }
            }
            Stage::ReverseToBaseline => self.reverse_to_baseline_one_step()?,
            Stage::ApplyBaseline => self.apply_baseline_one_step()?,
            Stage::ReverseBaseline => self.reverse_baseline_one_step()?,
            Stage::ReverseUnchanged => self.reverse_unchanged_one_step()?,
            Stage::ReapplyRefinements => {
                if self.replay_index < self.refinement_log.len {
                    self.replay_one_refinement(true)?;
                }
                if self.replay_index == self.refinement_log.len {
                    if self.baseline_reapply {
                        self.stage = Stage::ReverseToBaseline;
                    } else {
                        let refined = self.refined_checkpoint.take().ok_or(Status::InvalidInput)?;
                        self.baseline_checkpoint = None;
                        self.restore_selected_checkpoint(refined)?;
                    }
                }
            }
            Stage::ReleaseRefinements => {
                self.refinement_log.slabs.pop();
                if self.refinement_log.slabs.is_empty() {
                    self.refinement_log = RefinementLog::default();
                    let (first, second) = self
                        .pending_output_sizes
                        .take()
                        .ok_or(Status::InvalidInput)?;
                    self.plan = self.plan.with_output_sizes(first, second)?;
                    self.stage = if self.quality_score.is_some() {
                        Stage::QualityRelease
                    } else {
                        Stage::PrepareOutput
                    };
                }
            }
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
                    self.deltas,
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

    #[test]
    fn y1_zero_bin_uses_exact_five_eighths_boundary_for_both_signs() {
        let deltas = crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true);
        for (qindex, expected_step, first_nonzero) in
            [(10u8, 14i32, 9i32), (22, 26, 17), (36, 40, 25)]
        {
            let steps = ac_quant::steps(qindex, deltas, Plane::Y1);
            assert_eq!(steps.ac, expected_step);
            for sign in [-1i32, 1] {
                for magnitude in [
                    0,
                    expected_step / 2,
                    first_nonzero - 1,
                    first_nonzero,
                    first_nonzero + 1,
                    expected_step * 2,
                ] {
                    let mut transformed = [0i32; 16];
                    transformed[0] = 37;
                    transformed[1] = sign * magnitude;
                    transformed[2] = sign * expected_step * 2;
                    transformed[3] = i32::MIN;
                    let canonical = ac_quant::quantize_block(&transformed, steps);
                    assert_eq!(quantize_y1_zero_bin(&transformed, steps, false), canonical);
                    let chosen = quantize_y1_zero_bin(&transformed, steps, true);
                    assert_eq!(chosen[0], canonical[0]);
                    assert_eq!(chosen[2..], canonical[2..]);
                    if magnitude < first_nonzero {
                        assert_eq!(chosen[1], 0);
                    } else {
                        assert_eq!(chosen[1], canonical[1]);
                        assert_ne!(chosen[1], 0);
                    }
                }
            }
        }
        let steps = ac_quant::steps(36, deltas, Plane::Y1);
        let mut transformed = [0i32; 16];
        transformed[1] = 24;
        assert_eq!(quantize_y1_zero_bin(&transformed, steps, true)[1], 0);
        transformed[1] = 25; // Exact 5/8 equality retains the canonical +1.
        assert_eq!(quantize_y1_zero_bin(&transformed, steps, true)[1], 1);
        transformed[1] = -25;
        assert_eq!(quantize_y1_zero_bin(&transformed, steps, true)[1], -1);
    }

    #[test]
    fn y1_zero_bin_disabled_preserves_canonical_coefficients_across_presets() {
        let transformed = [
            i32::MIN,
            i32::MIN,
            i32::MAX,
            -60,
            -26,
            -13,
            -1,
            0,
            1,
            13,
            26,
            60,
            127,
            -127,
            1024,
            -1024,
        ];
        for quality in [60u32, 75, 85] {
            let deltas = crate::presets::deltas(quality);
            for qindex in [0u8, 6, 10, 22, 36, 80, 127] {
                let steps = ac_quant::steps(qindex, deltas, Plane::Y1);
                assert_eq!(
                    quantize_y1_zero_bin(&transformed, steps, false),
                    ac_quant::quantize_block(&transformed, steps),
                    "quality={quality} qindex={qindex}"
                );
            }
        }
    }

    #[test]
    fn y1_zero_bin_final_coefficients_feed_skip_and_contexts() {
        let steps = Steps { dc: 20, ac: 40 };
        let mut transformed = [0i32; 16];
        transformed[residual::SCAN[1]] = 24;
        let canonical = quantize_y1_zero_bin(&transformed, steps, false);
        let biased = quantize_y1_zero_bin(&transformed, steps, true);
        assert_eq!(canonical[residual::SCAN[1]], 1);
        assert_eq!(biased, [0i16; 16]);
        let mut before = Macroblock::default();
        before.y[15] = canonical;
        let mut after = before;
        after.y[15] = biased;
        assert!(!before.skip());
        assert!(after.skip());
        let mut before_contexts = CoeffContexts::new(1);
        let mut after_contexts = CoeffContexts::new(1);
        before_contexts
            .encode_coefficients(&mut RateCounter::default(), &before, 0)
            .unwrap();
        after_contexts
            .encode_coefficients(&mut RateCounter::default(), &after, 0)
            .unwrap();
        assert!(before_contexts.y[3]);
        assert!(before_contexts.left_y[3]);
        assert!(!after_contexts.y[3]);
        assert!(!after_contexts.left_y[3]);
    }

    #[test]
    fn y1_zero_bin_changes_source_bound_i4_and_i16_reconstruction() {
        let deltas = crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true);
        let y_steps = ac_quant::steps(22, deltas, Plane::Y1);
        let y2_steps = ac_quant::steps(22, deltas, Plane::Y2);
        let predictor = [128u8; 16];
        let mut i4_found = false;
        let mut i4_mode_found = false;
        let mut i16_found = false;
        for magnitude in 1u8..=64 {
            let mut patch_source = [128u8; 16];
            patch_source[0] += magnitude;
            let (canonical, canonical_patch) =
                code_predicted_block(&patch_source, 4, 0, 0, &predictor, y_steps, false);
            let (biased, biased_patch) =
                code_predicted_block(&patch_source, 4, 0, 0, &predictor, y_steps, true);
            if canonical != biased {
                assert_eq!(biased[0], canonical[0]);
                assert_eq!(
                    biased_patch,
                    reconstructed_patch(&biased, &predictor, y_steps)
                );
                assert_ne!(canonical_patch, biased_patch);
                i4_found = true;
            }

            let mut source = [128u8; 256];
            source[0] += magnitude;
            let reconstruction = [128u8; 256];
            let contexts = CoeffContexts::new(1);
            let above = [0u8; 4];
            let left = [0u8; 4];
            let before_i4 = make_i4(
                &source,
                &reconstruction,
                16,
                0,
                0,
                y_steps,
                &above,
                &left,
                &contexts,
                225,
                false,
                false,
            );
            let after_i4 = make_i4(
                &source,
                &reconstruction,
                16,
                0,
                0,
                y_steps,
                &above,
                &left,
                &contexts,
                225,
                false,
                true,
            );
            if before_i4.block.y != after_i4.block.y {
                assert_ne!(before_i4.tile, after_i4.tile);
                i4_mode_found = true;
            }
            let before = make_i16(
                &source,
                &reconstruction,
                16,
                0,
                0,
                0,
                y_steps,
                y2_steps,
                false,
            );
            let after = make_i16(
                &source,
                &reconstruction,
                16,
                0,
                0,
                0,
                y_steps,
                y2_steps,
                true,
            );
            if before.block.y != after.block.y {
                assert_eq!(before.block.y2, after.block.y2);
                assert_ne!(before.tile, after.tile);
                i16_found = true;
            }
            if i4_found && i4_mode_found && i16_found {
                break;
            }
        }
        assert!(
            i4_found,
            "I4 source patch did not activate the Y1 AC zero bin"
        );
        assert!(
            i4_mode_found,
            "I4 mode trial did not activate the Y1 AC zero bin"
        );
        assert!(
            i16_found,
            "I16 source patch did not activate the Y1 AC zero bin"
        );
    }

    #[test]
    fn i4_selected_ac_neighbors_match_independent_single_edit_enumeration() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        let mut coefficients = [0i16; 16];
        coefficients[0] = 3;
        coefficients[residual::SCAN[1]] = 2;
        coefficients[residual::SCAN[4]] = -2;
        coefficients[residual::SCAN[10]] = 1;
        coefficients[residual::SCAN[15]] = -1;
        let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
        for context in 0usize..=2 {
            let mut baseline_rate = RateCounter::default();
            residual::encode_block(&mut baseline_rate, &coefficients, 3, context).unwrap();
            for source in [
                baseline_patch,
                reconstructed_patch(
                    &{
                        let mut trial = coefficients;
                        trial[residual::SCAN[1]] -= 1;
                        trial
                    },
                    &predictor,
                    steps,
                ),
                [128u8; 16],
            ] {
                for trial_lambda in [0u64, 1, 101, 2048] {
                    let mut expected = coefficients;
                    let mut expected_patch = baseline_patch;
                    let mut expected_distortion = patch_error(&source, 4, 0, 0, &baseline_patch);
                    let mut expected_rate = baseline_rate.cost;
                    let baseline_distortion = expected_distortion;
                    let baseline_score = expected_distortion * 256 + trial_lambda * expected_rate;
                    let mut expected_score = baseline_score;
                    let mut tested = 0usize;
                    for position in 1..16 {
                        let index = residual::SCAN[position];
                        let level = coefficients[index];
                        if level == 0 {
                            continue;
                        }
                        let mut trial = coefficients;
                        trial[index] -= level.signum();
                        if trial.iter().all(|&value| value == 0) {
                            continue;
                        }
                        tested += 1;
                        let mut rate = RateCounter::default();
                        residual::encode_block(&mut rate, &trial, 3, context).unwrap();
                        let patch = reconstructed_patch(&trial, &predictor, steps);
                        let distortion = patch_error(&source, 4, 0, 0, &patch);
                        let score = distortion * 256 + trial_lambda * rate.cost;
                        if rate.cost < baseline_rate.cost
                            && 10 * distortion <= 11 * baseline_distortion
                            && score < baseline_score
                            && score < expected_score
                        {
                            expected = trial;
                            expected_patch = patch;
                            expected_distortion = distortion;
                            expected_rate = rate.cost;
                            expected_score = score;
                        }
                    }
                    assert_eq!(tested, 4);
                    let actual = choose_i4_selected_ac_neighbor(
                        &source,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        trial_lambda,
                        coefficients,
                        baseline_patch,
                        baseline_rate.cost,
                    );
                    assert_eq!(actual.coefficients, expected);
                    assert_eq!(actual.patch, expected_patch);
                    assert_eq!(actual.distortion, expected_distortion);
                    assert_eq!(actual.token_rate, expected_rate);
                    assert_eq!(
                        actual
                            .coefficients
                            .iter()
                            .zip(coefficients)
                            .filter(|(after, before)| **after != *before)
                            .count(),
                        usize::from(actual.coefficients != coefficients),
                    );
                }
            }
        }
    }

    #[test]
    fn i4_selected_ac_neighbor_preserves_nonzero_and_strict_ties() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        for context in 0usize..=2 {
            for sign in [-1i16, 1i16] {
                let mut only = [0i16; 16];
                only[residual::SCAN[15]] = sign;
                let patch = reconstructed_patch(&only, &predictor, steps);
                let mut rate = RateCounter::default();
                residual::encode_block(&mut rate, &only, 3, context).unwrap();
                let retained = choose_i4_selected_ac_neighbor(
                    &[128u8; 16],
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    context,
                    2048,
                    only,
                    patch,
                    rate.cost,
                );
                assert_eq!(retained.coefficients, only);
                let tie = choose_i4_selected_ac_neighbor(
                    &patch, 4, 0, 0, &predictor, steps, context, 0, only, patch, rate.cost,
                );
                assert_eq!(tie.coefficients, only);
                only[0] = 2;
                let patch = reconstructed_patch(&only, &predictor, steps);
                let mut reduced = only;
                reduced[residual::SCAN[15]] = 0;
                let reduced_patch = reconstructed_patch(&reduced, &predictor, steps);
                let mut rate = RateCounter::default();
                residual::encode_block(&mut rate, &only, 3, context).unwrap();
                let chosen = choose_i4_selected_ac_neighbor(
                    &reduced_patch,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    context,
                    0,
                    only,
                    patch,
                    rate.cost,
                );
                assert_eq!(chosen.coefficients, reduced);
            }
        }
    }

    #[test]
    fn i4_first_mode_winner_is_unmodified_by_neighbor_search() {
        let reconstructed = [128u8; 256];
        let above = [0u8, 1, 2, 3];
        let left = [3u8, 2, 1, 0];
        for context in 0usize..=2 {
            let mut contexts = CoeffContexts::new(1);
            contexts.y[0] = context >= 1;
            contexts.left_y[0] = context == 2;
            for seed in 0usize..8 {
                let source: Vec<u8> = (0usize..256)
                    .map(|index| ((index * 37 + index / 16 * 11 + seed * 29) & 255) as u8)
                    .collect();
                for lambda in [0u64, 1, 225] {
                    for y1_zero_bin in [false, true] {
                        let plain = make_i4_with_pruning::<false>(
                            &source,
                            &reconstructed,
                            16,
                            0,
                            0,
                            ac_quant::steps(22, Deltas::default(), Plane::Y1),
                            &above,
                            &left,
                            &contexts,
                            lambda,
                            false,
                            y1_zero_bin,
                        );
                        let neighbors = make_i4_with_pruning::<false>(
                            &source,
                            &reconstructed,
                            16,
                            0,
                            0,
                            ac_quant::steps(22, Deltas::default(), Plane::Y1),
                            &above,
                            &left,
                            &contexts,
                            lambda,
                            true,
                            y1_zero_bin,
                        );
                        assert_eq!(neighbors.0.block.b_modes[0], plain.0.block.b_modes[0]);
                    }
                }
            }
        }
    }

    #[test]
    fn i4_selected_ac_neighbor_rejects_non_decreasing_rate_and_half_rd_tie() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        let mut coefficients = [0i16; 16];
        coefficients[residual::SCAN[1]] = 2;
        coefficients[residual::SCAN[2]] = 1;
        let patch = reconstructed_patch(&coefficients, &predictor, steps);
        let mut reduced = coefficients;
        reduced[residual::SCAN[2]] = 0;
        let reduced_patch = reconstructed_patch(&reduced, &predictor, steps);
        let mut rate = RateCounter::default();
        let mut reduced_rate = RateCounter::default();
        residual::encode_block(&mut rate, &coefficients, 3, 0).unwrap();
        residual::encode_block(&mut reduced_rate, &reduced, 3, 0).unwrap();
        assert!(reduced_rate.cost >= rate.cost);
        let choice = choose_i4_selected_ac_neighbor(
            &reduced_patch,
            4,
            0,
            0,
            &predictor,
            steps,
            0,
            0,
            coefficients,
            patch,
            rate.cost,
        );
        assert_ne!(choice.coefficients, reduced);

        let saturated_predictor = [255u8; 16];
        let mut saturated = [0i16; 16];
        saturated[0] = 1000;
        saturated[residual::SCAN[15]] = -1;
        let saturated_patch = reconstructed_patch(&saturated, &saturated_predictor, steps);
        let mut reduced = saturated;
        reduced[residual::SCAN[15]] = 0;
        assert_eq!(
            saturated_patch,
            reconstructed_patch(&reduced, &saturated_predictor, steps)
        );
        let mut rate = RateCounter::default();
        let mut reduced_rate = RateCounter::default();
        residual::encode_block(&mut rate, &saturated, 3, 2).unwrap();
        residual::encode_block(&mut reduced_rate, &reduced, 3, 2).unwrap();
        assert!(reduced_rate.cost < rate.cost);
        let tie = choose_i4_selected_ac_neighbor(
            &saturated_patch,
            4,
            0,
            0,
            &saturated_predictor,
            steps,
            2,
            0,
            saturated,
            saturated_patch,
            rate.cost,
        );
        assert_eq!(tie.coefficients, saturated);
    }

    #[test]
    fn i4_selected_ac_neighbor_reduces_both_signs_above_unit() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        for context in 0usize..=2 {
            for level in [-2i16, 2i16] {
                let mut coefficients = [0i16; 16];
                coefficients[0] = 2;
                coefficients[residual::SCAN[15]] = level;
                let mut reduced = coefficients;
                reduced[residual::SCAN[15]] -= level.signum();
                let patch = reconstructed_patch(&coefficients, &predictor, steps);
                let reduced_patch = reconstructed_patch(&reduced, &predictor, steps);
                assert_ne!(patch, reduced_patch);
                let mut rate = RateCounter::default();
                let mut reduced_rate = RateCounter::default();
                residual::encode_block(&mut rate, &coefficients, 3, context).unwrap();
                residual::encode_block(&mut reduced_rate, &reduced, 3, context).unwrap();
                assert!(reduced_rate.cost < rate.cost);
                let chosen = choose_i4_selected_ac_neighbor(
                    &reduced_patch,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    context,
                    0,
                    coefficients,
                    patch,
                    rate.cost,
                );
                assert_eq!(chosen.coefficients, reduced);
                assert_eq!(chosen.patch, reduced_patch);
                assert_eq!(chosen.distortion, 0);
            }
        }
    }

    #[test]
    fn i4_selected_ac_neighbor_keeps_first_equal_trial_and_replaces_with_strictly_better() {
        let steps = ac_quant::steps(
            22,
            crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true),
            Plane::Y1,
        );
        assert_eq!(steps, Steps { dc: 20, ac: 26 });
        let predictor = [255u8; 16];
        let source = [255u8; 16];
        let trial_lambda = 101u64;
        for context in 0usize..=2 {
            for (first_level, expect_first) in [(6i16, true), (8i16, false)] {
                let mut baseline = [0i16; 16];
                baseline[0] = 1000;
                baseline[residual::SCAN[1]] = first_level;
                baseline[residual::SCAN[2]] = 6;
                let baseline_patch = reconstructed_patch(&baseline, &predictor, steps);
                assert_eq!(baseline_patch, source);
                let mut baseline_rate = RateCounter::default();
                residual::encode_block(&mut baseline_rate, &baseline, 3, context).unwrap();
                let mut single_edit_rates = [0u64; 2];
                for (trial_index, position) in [1usize, 2].into_iter().enumerate() {
                    let mut trial = baseline;
                    trial[residual::SCAN[position]] -= 1;
                    assert_eq!(reconstructed_patch(&trial, &predictor, steps), source);
                    let mut rate = RateCounter::default();
                    residual::encode_block(&mut rate, &trial, 3, context).unwrap();
                    assert!(rate.cost < baseline_rate.cost);
                    assert!(
                        trial_lambda * rate.cost < trial_lambda * baseline_rate.cost,
                        "position={position} context={context}"
                    );
                    single_edit_rates[trial_index] = rate.cost;
                }
                if expect_first {
                    assert_eq!(single_edit_rates[0], single_edit_rates[1]);
                } else {
                    assert!(single_edit_rates[1] < single_edit_rates[0]);
                }
                let choice = choose_i4_selected_ac_neighbor(
                    &source,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    context,
                    trial_lambda,
                    baseline,
                    baseline_patch,
                    baseline_rate.cost,
                );
                let selected_position = if expect_first { 1 } else { 2 };
                let mut expected = baseline;
                expected[residual::SCAN[selected_position]] -= 1;
                assert_eq!(choice.coefficients, expected);
                assert_eq!(choice.patch, source);
                assert_eq!(choice.distortion, 0);
                assert_eq!(choice.token_rate, single_edit_rates[selected_position - 1]);
            }
        }
    }

    #[test]
    fn i4_ac_tail_requires_a_remaining_coefficient_and_strict_rate_distortion_gain() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        let tail = residual::SCAN[15];
        for context in 0..=2 {
            for sign in [-1, 1] {
                for keeper in [0, residual::SCAN[1]] {
                    let mut coefficients = [0i16; 16];
                    coefficients[keeper] = 2;
                    coefficients[tail] = sign;
                    let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
                    let mut shortened = coefficients;
                    shortened[tail] = 0;
                    let shorter_patch = reconstructed_patch(&shortened, &predictor, steps);
                    assert_ne!(baseline_patch, shorter_patch);
                    let mut baseline_rate = RateCounter::default();
                    let mut shorter_rate = RateCounter::default();
                    residual::encode_block(&mut baseline_rate, &coefficients, 3, context).unwrap();
                    residual::encode_block(&mut shorter_rate, &shortened, 3, context).unwrap();
                    assert!(shorter_rate.cost < baseline_rate.cost);

                    // A source equal to the shortened reconstruction makes the
                    // improvement independent of lambda and sign.
                    let chosen = choose_i4_ac_tail(
                        &shorter_patch,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        0,
                        coefficients,
                        baseline_patch,
                    );
                    assert_eq!(chosen.coefficients, shortened);
                    assert_eq!(chosen.patch, shorter_patch);
                    assert_eq!(chosen.distortion, 0);
                    assert_eq!(chosen.token_rate, shorter_rate.cost);

                    // A source equal to the baseline reconstruction cannot
                    // improve distortion when lambda is zero; ties retain it.
                    let retained = choose_i4_ac_tail(
                        &baseline_patch,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        0,
                        coefficients,
                        baseline_patch,
                    );
                    assert_eq!(retained.coefficients, coefficients);
                    assert_eq!(retained.patch, baseline_patch);
                    assert_eq!(retained.token_rate, baseline_rate.cost);

                    // The previous baseline-distortion prune would skip the
                    // improving candidate at this bound.
                    let old_bound = patch_error(&shorter_patch, 4, 0, 0, &baseline_patch) * 256;
                    assert!(old_bound > 1);
                    let previous_best = old_bound - 1;
                    assert!(old_bound >= previous_best);
                    assert!(chosen.distortion * 256 < previous_best);
                }
            }
            for coefficients in [
                [0i16; 16],
                {
                    let mut values = [0i16; 16];
                    values[tail] = 1;
                    values
                },
                {
                    let mut values = [0i16; 16];
                    values[0] = 2;
                    values[tail] = 2;
                    values
                },
            ] {
                let patch = reconstructed_patch(&coefficients, &predictor, steps);
                let choice = choose_i4_ac_tail(
                    &patch,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    context,
                    1024,
                    coefficients,
                    patch,
                );
                assert_eq!(choice.coefficients, coefficients);
                assert_eq!(choice.patch, patch);
            }
        }
    }

    #[test]
    fn i4_ac_tail_equal_reconstruction_keeps_zero_lambda_tie_but_accepts_rate_gain() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [255u8; 16];
        let source = [255u8; 16];
        let mut coefficients = [0i16; 16];
        coefficients[0] = 1000;
        coefficients[residual::SCAN[15]] = 1;
        let mut shortened = coefficients;
        shortened[residual::SCAN[15]] = 0;
        let patch = reconstructed_patch(&coefficients, &predictor, steps);
        assert_eq!(patch, source);
        assert_eq!(patch, reconstructed_patch(&shortened, &predictor, steps));
        let mut baseline_rate = RateCounter::default();
        let mut shorter_rate = RateCounter::default();
        residual::encode_block(&mut baseline_rate, &coefficients, 3, 2).unwrap();
        residual::encode_block(&mut shorter_rate, &shortened, 3, 2).unwrap();
        assert!(shorter_rate.cost < baseline_rate.cost);
        let choice = choose_i4_ac_tail(
            &source,
            4,
            0,
            0,
            &predictor,
            steps,
            2,
            0,
            coefficients,
            patch,
        );
        assert_eq!(choice.coefficients, coefficients);
        assert_eq!(choice.token_rate, baseline_rate.cost);
        let rate_choice = choose_i4_ac_tail(
            &source,
            4,
            0,
            0,
            &predictor,
            steps,
            2,
            1,
            coefficients,
            patch,
        );
        assert_eq!(rate_choice.coefficients, shortened);
        assert_eq!(rate_choice.patch, patch);
        assert_eq!(rate_choice.distortion, 0);
        assert_eq!(rate_choice.token_rate, shorter_rate.cost);
    }

    #[test]
    fn i4_ac_tail_ssd_budget_has_exact_inclusive_and_zero_boundaries() {
        assert!(i4_ac_tail_within_ssd_budget(0, 0));
        assert!(!i4_ac_tail_within_ssd_budget(1, 0));
        assert!(i4_ac_tail_within_ssd_budget(10, 10));
        assert!(i4_ac_tail_within_ssd_budget(11, 10));
        assert!(!i4_ac_tail_within_ssd_budget(12, 10));
        assert!(i4_ac_tail_within_ssd_budget(1_040_400, 1_040_400));
    }

    #[test]
    fn i4_ac_tail_accepts_a_production_weight_trial_with_bounded_ssd_increase() {
        let steps = ac_quant::steps(
            22,
            crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true),
            Plane::Y1,
        );
        assert_eq!(steps, Steps { dc: 20, ac: 26 });
        let predictor = [128u8; 16];
        let source = [
            145, 142, 146, 143, 142, 150, 139, 146, 146, 139, 149, 142, 143, 146, 142, 145,
        ];
        let mut coefficients = [0i16; 16];
        coefficients[0] = 2;
        coefficients[residual::SCAN[15]] = 1;
        let mut shortened = coefficients;
        shortened[residual::SCAN[15]] = 0;
        let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
        let shorter_patch = reconstructed_patch(&shortened, &predictor, steps);
        assert_eq!(
            baseline_patch,
            [134, 131, 135, 132, 131, 139, 128, 135, 135, 128, 138, 131, 132, 135, 131, 134]
        );
        assert_eq!(shorter_patch, [133; 16]);
        let baseline_ssd = patch_error(&source, 4, 0, 0, &baseline_patch);
        let trial_ssd = patch_error(&source, 4, 0, 0, &shorter_patch);
        assert_eq!((baseline_ssd, trial_ssd), (1936, 2105));
        assert!(trial_ssd > baseline_ssd); // The rejected hard guard retained it.
        assert!(i4_ac_tail_within_ssd_budget(trial_ssd, baseline_ssd));
        let mut baseline_rate = RateCounter::default();
        let mut trial_rate = RateCounter::default();
        residual::encode_block(&mut baseline_rate, &coefficients, 3, 0).unwrap();
        residual::encode_block(&mut trial_rate, &shortened, 3, 0).unwrap();
        assert_eq!((baseline_rate.cost, trial_rate.cost), (6130, 2372));
        let trial_lambda = crate::presets::lambda_for_quality(18, 60) / 2;
        assert_eq!(trial_lambda, 101);
        assert!(
            trial_ssd * 256 + trial_lambda * trial_rate.cost
                < baseline_ssd * 256 + trial_lambda * baseline_rate.cost
        );
        let choice = choose_i4_ac_tail(
            &source,
            4,
            0,
            0,
            &predictor,
            steps,
            0,
            trial_lambda,
            coefficients,
            baseline_patch,
        );
        assert_eq!(choice.coefficients, shortened);
        assert_eq!(choice.patch, shorter_patch);
        assert_eq!(choice.distortion, trial_ssd);
        assert_eq!(choice.token_rate, trial_rate.cost);
    }

    #[test]
    fn i4_ac_tail_retains_a_rate_favored_tail_beyond_the_ssd_budget() {
        let steps = ac_quant::steps(
            22,
            crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true),
            Plane::Y1,
        );
        assert_eq!(steps, Steps { dc: 20, ac: 26 });
        let predictor = [128u8; 16];
        let trial_lambda = crate::presets::lambda_for_quality(18, 60) / 2;
        assert_eq!(trial_lambda, 101);
        for context in 0..=2 {
            for sign in [-1, 1] {
                let mut coefficients = [0i16; 16];
                coefficients[0] = 2;
                coefficients[residual::SCAN[15]] = sign;
                let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
                let mut shortened = coefficients;
                shortened[residual::SCAN[15]] = 0;
                let shorter_patch = reconstructed_patch(&shortened, &predictor, steps);
                let mut baseline_rate = RateCounter::default();
                let mut shorter_rate = RateCounter::default();
                residual::encode_block(&mut baseline_rate, &coefficients, 3, context).unwrap();
                residual::encode_block(&mut shorter_rate, &shortened, 3, context).unwrap();
                assert!(shorter_rate.cost < baseline_rate.cost);
                for source in [baseline_patch, baseline_patch.map(|value| value + 1)] {
                    let baseline_ssd = patch_error(&source, 4, 0, 0, &baseline_patch);
                    let trial_ssd = patch_error(&source, 4, 0, 0, &shorter_patch);
                    assert!(trial_ssd > baseline_ssd);
                    assert!(!i4_ac_tail_within_ssd_budget(trial_ssd, baseline_ssd));
                    assert!(
                        trial_ssd * 256 + trial_lambda * shorter_rate.cost
                            < baseline_ssd * 256 + trial_lambda * baseline_rate.cost,
                        "context={context} sign={sign} baseline_ssd={baseline_ssd}"
                    );
                    let choice = choose_i4_ac_tail(
                        &source,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        trial_lambda,
                        coefficients,
                        baseline_patch,
                    );
                    assert_eq!(choice.coefficients, coefficients);
                    assert_eq!(choice.patch, baseline_patch);
                    assert_eq!(choice.distortion, baseline_ssd);
                    assert_eq!(choice.token_rate, baseline_rate.cost);
                }
            }
        }
    }

    #[test]
    fn i4_ac_tail_never_trades_higher_token_rate_for_lower_distortion() {
        let steps = ac_quant::steps(22, Deltas::default(), Plane::Y1);
        let predictor = [128u8; 16];
        let mut coefficients = [0i16; 16];
        coefficients[residual::SCAN[1]] = 2;
        coefficients[residual::SCAN[2]] = 1;
        let mut shortened = coefficients;
        shortened[residual::SCAN[2]] = 0;
        let patch = reconstructed_patch(&coefficients, &predictor, steps);
        let shorter_patch = reconstructed_patch(&shortened, &predictor, steps);
        assert_ne!(patch, shorter_patch);
        let mut baseline_rate = RateCounter::default();
        let mut shorter_rate = RateCounter::default();
        residual::encode_block(&mut baseline_rate, &coefficients, 3, 0).unwrap();
        residual::encode_block(&mut shorter_rate, &shortened, 3, 0).unwrap();
        assert!(shorter_rate.cost >= baseline_rate.cost);
        let choice = choose_i4_ac_tail(
            &shorter_patch,
            4,
            0,
            0,
            &predictor,
            steps,
            0,
            0,
            coefficients,
            patch,
        );
        assert_eq!(choice.coefficients, coefficients);
        assert_eq!(choice.patch, patch);
        assert_eq!(choice.token_rate, baseline_rate.cost);
    }

    #[test]
    fn i4_ac_tail_historical_full_and_half_rd_decisions_remain_distinct() {
        let steps = ac_quant::steps(
            22,
            crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true),
            Plane::Y1,
        );
        assert_eq!(steps, Steps { dc: 20, ac: 26 });
        let predictor: [u8; 16] = [128; 16];
        let source: [u8; 16] = [
            151, 114, 152, 115, 114, 156, 111, 152, 152, 111, 155, 114, 115, 152, 114, 151,
        ];
        let mut coefficients = [0i16; 16];
        coefficients[0] = 2;
        coefficients[residual::SCAN[15]] = 1;
        let mut shortened = coefficients;
        shortened[residual::SCAN[15]] = 0;
        let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
        let shorter_patch = reconstructed_patch(&shortened, &predictor, steps);
        assert_eq!(
            baseline_patch,
            [134, 131, 135, 132, 131, 139, 128, 135, 135, 128, 138, 131, 132, 135, 131, 134]
        );
        assert_eq!(shorter_patch, [133; 16]);
        let baseline_ssd = patch_error(&source, 4, 0, 0, &baseline_patch);
        let shorter_ssd = patch_error(&source, 4, 0, 0, &shorter_patch);
        assert_eq!((baseline_ssd, shorter_ssd), (4624, 6165));
        let mut baseline_rate = RateCounter::default();
        let mut shorter_rate = RateCounter::default();
        residual::encode_block(&mut baseline_rate, &coefficients, 3, 0).unwrap();
        residual::encode_block(&mut shorter_rate, &shortened, 3, 0).unwrap();
        assert_eq!((baseline_rate.cost, shorter_rate.cost), (6130, 2372));

        // Original q18 mode weight stays full; only this coefficient trial
        // receives its integer half.
        let mode_lambda: u64 = crate::presets::lambda_for_quality(18, 60);
        assert_eq!(mode_lambda, 202);
        let trial_lambda = mode_lambda / 2;
        let distortion_loss = (shorter_ssd - baseline_ssd) * 256;
        let rate_saving = baseline_rate.cost - shorter_rate.cost;
        assert!(trial_lambda * rate_saving <= distortion_loss);
        assert!(distortion_loss < mode_lambda * rate_saving);

        let full_choice = choose_i4_ac_tail(
            &source,
            4,
            0,
            0,
            &predictor,
            steps,
            0,
            mode_lambda,
            coefficients,
            baseline_patch,
        );
        // The historical full-weight RD decision removed this coefficient.
        // Both the old no-increase guard and the current 10% cap retain it.
        assert!(!i4_ac_tail_within_ssd_budget(shorter_ssd, baseline_ssd));
        assert_eq!(full_choice.coefficients, coefficients);
        assert_eq!(full_choice.patch, baseline_patch);
        assert_eq!(full_choice.token_rate, baseline_rate.cost);
        let half_choice = choose_i4_ac_tail(
            &source,
            4,
            0,
            0,
            &predictor,
            steps,
            0,
            trial_lambda,
            coefficients,
            baseline_patch,
        );
        assert_eq!(half_choice.coefficients, coefficients);
        assert_eq!(half_choice.patch, baseline_patch);
        assert_eq!(half_choice.token_rate, baseline_rate.cost);
    }

    #[test]
    fn i4_lower_bound_pruning_matches_exhaustive_mode_search() {
        let mut state = 0x5015_4d4fu32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        };
        for pattern in 0..10 {
            let mut source = vec![0u8; 32 * 32];
            let mut reconstructed = vec![0u8; 32 * 32];
            for y in 0..32 {
                for x in 0..32 {
                    let index = y * 32 + x;
                    source[index] = match pattern {
                        0 => 0,
                        1 => 255,
                        2 => ((x + y) % 2 * 255) as u8,
                        3 => (x * 7 + y * 3) as u8,
                        _ => next(),
                    };
                    reconstructed[index] = if pattern < 4 {
                        ((x * 11 + y * 19 + pattern * 23) & 255) as u8
                    } else {
                        next()
                    };
                }
            }
            let mut contexts = CoeffContexts::new(2);
            for value in &mut contexts.y {
                *value = next() & 1 != 0;
            }
            for value in &mut contexts.left_y {
                *value = next() & 1 != 0;
            }
            let above: Vec<_> = (0..8).map(|_| next() % 10).collect();
            let left = std::array::from_fn(|_| next() % 10);
            for qindex in [0, 22, 80, 127] {
                let steps = ac_quant::steps(qindex, Deltas::default(), Plane::Y1);
                for lambda in [0, 1, 225, 2048] {
                    for (tail_rdo, y1_zero_bin) in
                        [(false, false), (true, false), (false, true), (true, true)]
                    {
                        for (mx, my) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                            let pruned = make_i4_with_pruning::<true>(
                                &source,
                                &reconstructed,
                                32,
                                mx,
                                my,
                                steps,
                                &above,
                                &left,
                                &contexts,
                                lambda,
                                tail_rdo,
                                y1_zero_bin,
                            );
                            let exhaustive = make_i4_with_pruning::<false>(
                                &source,
                                &reconstructed,
                                32,
                                mx,
                                my,
                                steps,
                                &above,
                                &left,
                                &contexts,
                                lambda,
                                tail_rdo,
                                y1_zero_bin,
                            );
                            assert_eq!(pruned.0.block, exhaustive.0.block);
                            assert_eq!(pruned.0.tile, exhaustive.0.tile);
                            assert_eq!(pruned.0.distortion, exhaustive.0.distortion);
                            assert_eq!(
                                pruned.1, exhaustive.1,
                                "pattern={pattern} q={qindex} lambda={lambda} tail_rdo={tail_rdo} zero_bin={y1_zero_bin} mx={mx} my={my}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn i4_selected_score_counts_each_mode_and_selected_residual_once() {
        let source: Vec<_> = (0..16 * 16).map(|i| (i * 37 + i / 16 * 11) as u8).collect();
        let reconstructed: Vec<_> = (0..16 * 16).map(|i| (i * 19) as u8).collect();
        let mut contexts = CoeffContexts::new(1);
        contexts.y[..4].copy_from_slice(&[true, false, true, false]);
        contexts.left_y = [false, true, false, true];
        let above_modes = [0, 3, 6, 9];
        let left_modes = [9, 6, 3, 0];
        // The coefficient trial has a separate half weight; the returned
        // mode score must still use the unmodified weight.
        let mode_lambda: u64 = 225;
        for (tail_rdo, y1_zero_bin) in [(false, false), (true, false), (false, true), (true, true)]
        {
            let (candidate, score) = make_i4_with_pruning::<true>(
                &source,
                &reconstructed,
                16,
                0,
                0,
                ac_quant::steps(22, Deltas::default(), Plane::Y1),
                &above_modes,
                &left_modes,
                &contexts,
                mode_lambda,
                tail_rdo,
                y1_zero_bin,
            );
            let mut above_context = [false; 4];
            above_context.copy_from_slice(&contexts.y[..4]);
            let mut left_context = contexts.left_y;
            let mut independently_scored = 0;
            let mut distortion = 0;
            for by in 0..4 {
                for bx in 0..4 {
                    let index = by * 4 + bx;
                    let above_mode = if by == 0 {
                        above_modes[bx]
                    } else {
                        candidate.block.b_modes[index - 4]
                    };
                    let left_mode = if bx == 0 {
                        left_modes[by]
                    } else {
                        candidate.block.b_modes[index - 1]
                    };
                    let mut mode_rate = RateCounter::default();
                    let mut token_rate = RateCounter::default();
                    write_bmode(
                        &mut mode_rate,
                        above_mode,
                        left_mode,
                        candidate.block.b_modes[index],
                    )
                    .unwrap();
                    residual::encode_block(
                        &mut token_rate,
                        &candidate.block.y[index],
                        3,
                        usize::from(above_context[bx]) + usize::from(left_context[by]),
                    )
                    .unwrap();
                    let patch = prediction_patch::<16, 256>(&candidate.tile, bx, by);
                    let error = patch_error(&source, 16, bx * 4, by * 4, &patch);
                    distortion += error;
                    independently_scored +=
                        error * 256 + mode_lambda * (mode_rate.cost + token_rate.cost);
                    let nonzero = candidate.block.y[index].iter().any(|&level| level != 0);
                    above_context[bx] = nonzero;
                    left_context[by] = nonzero;
                }
            }
            assert_eq!(candidate.distortion, distortion);
            assert_eq!(score, independently_scored, "tail_rdo={tail_rdo}");
        }
    }

    fn generated_v7_tiny_rgba(width: usize, height: usize) -> Vec<u8> {
        // Same generated RGB rules as scripts/test/owned-vp8-v7-fixtures.ts.
        (0..height)
            .flat_map(|y| {
                (0..width).flat_map(move |x| {
                    let rgb = match (width, height) {
                        (2, 9) => [
                            (53 + 37 * x + 79 * y) as u8,
                            (211 + 67 * x + 31 * y) as u8,
                            (39 + 19 * x + 97 * y) as u8,
                        ],
                        (5, 1) => {
                            if (3 * x + y) % 4 == 0 {
                                [244, 29, 171]
                            } else if (2 * x + y) & 1 != 0 {
                                [35, 227, 91]
                            } else {
                                [89, 61, 239]
                            }
                        }
                        (1, 11) => [
                            (19 + 61 * x + 41 * y + 7 * x * y) as u8,
                            (173 + 29 * x + 89 * y) as u8,
                            (67 + 83 * x + 53 * y) as u8,
                        ],
                        _ => unreachable!(),
                    };
                    [rgb[0], rgb[1], rgb[2], 255]
                })
            })
            .collect()
    }

    #[test]
    fn known_tiny_joint_search_is_budgeted_and_matches_sync() {
        // The retained generated 5x1 RGB input exercises the one-MB 128-unit
        // quota. This is an encoder control, not an external quality gate.
        let rgba = generated_v7_tiny_rgba(5, 1);
        let mut request = engine_request(5, 1, 0, &rgba, 20);
        request.quality = 85;
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, rgba.clone(), plan).unwrap();
        let mut last_progress = 0;
        let mut proposals = 0;
        while engine.stage != Stage::CollectStats {
            if engine.stage == Stage::JointRefine {
                let (done, quota) = engine.progress();
                assert_eq!(quota, 128);
                assert!(done >= last_progress);
                last_progress = done;
                proposals = done;
                assert!(engine.output().is_empty());
            }
            engine.step().unwrap();
        }
        assert_eq!(proposals, 116);
        assert_eq!(engine.joint_used_total, proposals as usize);
        assert_eq!(engine.refinement_log.len, 4);
        let changes: Vec<_> = (0..4)
            .map(|i| engine.refinement_log.get(i).unwrap().change)
            .collect();
        assert_eq!(
            changes
                .iter()
                .map(|change| (
                    change.plane,
                    change.patch,
                    change.coefficient,
                    change.old,
                    change.new
                ))
                .collect::<Vec<_>>(),
            [
                (1, 0, 3, 12, 13),
                (1, 0, 2, 6, 7),
                (0, 0, 3, -6, -7),
                (0, 0, 2, -3, -4),
            ]
        );
        let expected = encode_textured(&rgba, 5, 1, 20, 0, 85).unwrap();
        assert_eq!(expected.len(), 81);
        let complete = run_engine(engine);
        assert_eq!(complete.output(), expected);
    }

    #[test]
    fn every_joint_budget_truncation_commits_only_complete_replayable_paths() {
        let input = generated_v7_tiny_rgba(5, 1);
        let mut request = engine_request(5, 1, 0, &input, 20);
        request.quality = 85;
        let plan = ResourcePlan::checked(request).unwrap();
        let mut base = FrameEncoder::new(request, input.clone(), plan).unwrap();
        base.disable_refinement = true;
        while base.stage != Stage::CollectStats {
            base.step().unwrap();
        }
        for budget in 0..=128 {
            let mut engine = FrameEncoder::new(request, input.clone(), plan).unwrap();
            while engine.stage != Stage::JointRefine {
                engine.step().unwrap();
            }
            engine.joint_search[0].limit_for_test(budget);
            while engine.stage == Stage::JointRefine {
                assert!(engine.joint_search[0].paths_have_distinct_positions());
                assert!(engine.output().is_empty());
                engine.step().unwrap();
            }
            assert!(engine.stage == Stage::CollectStats);
            assert_eq!(engine.joint_used_total, budget.min(116));
            assert!(engine.refinement_log.len <= 4);
            let mut blocks = engine.blocks.clone();
            let mut u = engine.reconstructed_u.clone();
            let mut v = engine.reconstructed_v.clone();
            for index in (0..engine.refinement_log.len).rev() {
                replay_edit_state(
                    &mut blocks,
                    &mut u,
                    &mut v,
                    plan.padded_width as usize,
                    engine.segments,
                    engine.deltas,
                    engine.refinement_log.get(index).unwrap(),
                    false,
                )
                .unwrap();
            }
            assert_eq!(blocks, base.blocks, "budget={budget}");
            assert_eq!(u, base.reconstructed_u, "budget={budget}");
            assert_eq!(v, base.reconstructed_v, "budget={budget}");
        }
    }

    #[test]
    fn skipped_macroblock_uses_no_joint_cache_or_proposals() {
        let input: Vec<_> = (0..256).flat_map(|_| [130, 130, 130, 255]).collect();
        let mut request = engine_request(16, 16, 0, &input, 64);
        request.quality = 85;
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input, plan).unwrap();
        while engine.stage != Stage::CollectStats {
            engine.step().unwrap();
        }
        assert!(engine.blocks[0].skip());
        assert_eq!(engine.joint_used_total, 0);
        assert_eq!(engine.joint_search.capacity(), 0);
        assert_eq!(engine.baseline_overrides.capacity(), 0);
    }

    #[test]
    fn generated_v7_tiny_joint_candidates_keep_positive_combined_proxy_and_exact_bytes() {
        for (width, height, quality) in [(2usize, 9usize, 60), (5, 1, 85), (1, 11, 75)] {
            let input = generated_v7_tiny_rgba(width, height);
            let mut request = engine_request(width, height, 0, &input, width * 4);
            request.quality = quality;
            let plan = ResourcePlan::checked(request).unwrap();
            let mut candidate = FrameEncoder::new(request, input.clone(), plan).unwrap();
            while candidate.stage != Stage::CollectStats {
                candidate.step().unwrap();
            }
            let mut base = FrameEncoder::new(request, input.clone(), plan).unwrap();
            base.disable_refinement = true;
            while base.stage != Stage::CollectStats {
                base.step().unwrap();
            }
            assert!(candidate.joint_used_total <= 128);
            assert!(candidate.refinement_log.len <= 4);
            assert_eq!(candidate.blocks[0].y, base.blocks[0].y);
            assert_eq!(candidate.blocks[0].uv_mode, base.blocks[0].uv_mode);
            let tile_y = read_tile::<16, 256>(&base.reconstructed_y, 16, 0, 0);
            let base_u = read_tile::<8, 64>(&base.reconstructed_u, 8, 0, 0);
            let base_v = read_tile::<8, 64>(&base.reconstructed_v, 8, 0, 0);
            let trial_u = read_tile::<8, 64>(&candidate.reconstructed_u, 8, 0, 0);
            let trial_v = read_tile::<8, 64>(&candidate.reconstructed_v, 8, 0, 0);
            let frame = display_rgb::Frame {
                width,
                height,
                stride_y: 16,
                original: display_rgb::Original {
                    pixels: &input,
                    stride: width * 4,
                    layout: 0,
                },
                source_y: &base.source_y,
                source_u: &base.source_u,
                source_v: &base.source_v,
                reconstructed_y: &base.reconstructed_y,
                reconstructed_u: &base.reconstructed_u,
                reconstructed_v: &base.reconstructed_v,
                tile_y: &tile_y,
                tile_u: &base_u,
                tile_v: &base_v,
                mx: 0,
                my: 0,
            };
            let gain = display_rgb::LocalCache::new(&frame).score_tiles(&frame, &trial_u, &trial_v);
            assert!(gain > 0.0, "{width}x{height} q{quality} proxy={gain}");
            let candidate_edits = candidate.refinement_log.len;
            let candidate = run_engine(candidate);
            let base = run_engine(base);
            let mut baseline_only = FrameEncoder::new(request, input.clone(), plan).unwrap();
            while baseline_only.stage != Stage::JointRefine {
                baseline_only.step().unwrap();
            }
            baseline_only.joint_search[0].limit_for_test(0);
            let baseline_only = run_engine(baseline_only);
            let sync = encode_textured(
                &input,
                width as u32,
                height as u32,
                (width * 4) as u32,
                0,
                quality,
            )
            .unwrap();
            assert_eq!(candidate.output(), sync);
            assert!(candidate.output().len() <= base.output().len() + 1);
            assert_ne!(
                candidate.output(),
                base.output(),
                "{width}x{height} q{quality}"
            );
            assert_eq!(
                candidate.selected_frame_bytes as usize,
                candidate.output().len()
            );
            assert_eq!(
                candidate.plan.frame_bytes as usize,
                candidate.output().len()
            );
            if (width, height) == (2, 9) {
                assert_eq!(candidate_edits, 3);
                assert!(!baseline_only.photo_q60);
                assert_eq!(baseline_only.output().len(), 98);
            }
            assert_ne!(candidate.output(), baseline_only.output());
        }
    }

    #[test]
    fn captured_baseline_variant_resets_model_and_recovers_unrefined_state() {
        let input = generated_v7_tiny_rgba(2, 9);
        let mut request = engine_request(2, 9, 0, &input, 8);
        request.quality = 60;
        let plan = ResourcePlan::checked(request).unwrap();
        let mut candidate = FrameEncoder::new(request, input.clone(), plan).unwrap();
        while candidate.stage != Stage::ReverseToBaseline {
            candidate.step().unwrap();
        }
        let extended = candidate.refined_checkpoint.as_ref().unwrap();
        assert_eq!(
            extended.sizes.0 + extended.sizes.1 + 10,
            extended.selected_frame_bytes
        );
        assert_eq!(candidate.baseline_overrides.len(), 1);
        assert_eq!(candidate.baseline_overrides[0].len, 3);
        assert!(candidate.baseline_overrides[0].baseline.is_some());
        while candidate.stage != Stage::ReverseBaseline {
            assert!(candidate.output().is_empty());
            candidate.step().unwrap();
        }
        let baseline = candidate.baseline_checkpoint.as_ref().unwrap();
        assert_eq!(
            baseline.sizes.0 + baseline.sizes.1 + 10,
            baseline.selected_frame_bytes
        );
        assert!(!candidate.photo_q60);
        assert_eq!(baseline.selected_frame_bytes, 98);
        while !(candidate.stage == Stage::CollectStats
            && candidate.base_count
            && !candidate.baseline_count)
        {
            assert!(candidate.output().is_empty());
            candidate.step().unwrap();
        }
        let mut base = FrameEncoder::new(request, input.clone(), plan).unwrap();
        base.disable_refinement = true;
        while base.stage != Stage::CollectStats {
            base.step().unwrap();
        }
        assert_eq!(candidate.blocks, base.blocks);
        assert_eq!(candidate.reconstructed_u, base.reconstructed_u);
        assert_eq!(candidate.reconstructed_v, base.reconstructed_v);
        while candidate.stage != Stage::ReapplyRefinements {
            candidate.step().unwrap();
        }
        assert!(!candidate.baseline_reapply);
        let candidate = run_engine(candidate);
        assert_eq!(candidate.output().len(), 99);
        assert_ne!(candidate.output(), run_engine(base).output());
    }

    #[test]
    fn maximum_admitted_geometry_refinement_log_fits_reserved_scratch() {
        let request = Request {
            version: 2,
            width: 625,
            height: 16_106,
            stride: 2_500,
            layout: 0,
            quality: 75,
            input_bytes: 2_500 * 16_106,
            output_limit: 96 * 1024 * 1024,
            generation: 1,
            frame: 1,
            external_live_bytes: 2_500 * 16_106,
            retained_output_bytes: 0,
        };
        let plan = ResourcePlan::checked(request).unwrap();
        assert_eq!(plan.macroblock_count, 40_280);
        assert_eq!(std::mem::size_of::<RefinementEdit>(), 12);
        let mut log = RefinementLog::default();
        let max_edits = plan.macroblock_count as usize + 128;
        for block in 0..plan.macroblock_count {
            log.reserve_one(max_edits).unwrap();
            log.push_reserved(RefinementEdit {
                block,
                change: RefinementChange {
                    plane: 0,
                    patch: 0,
                    coefficient: 0,
                    old: 0,
                    new: 1,
                },
            })
            .unwrap();
        }
        log.reserve_additional(128, max_edits).unwrap();
        for _ in 0..128 {
            log.push_reserved(RefinementEdit {
                block: plan.macroblock_count - 1,
                change: RefinementChange {
                    plane: 0,
                    patch: 0,
                    coefficient: 0,
                    old: 0,
                    new: 1,
                },
            })
            .unwrap();
        }
        assert_eq!(log.len, 40_408);
        assert_eq!(log.slabs.len(), 158);
        assert!(log.capacity_bytes() <= REFINEMENT_LOG_BUDGET_BYTES);
        assert_eq!(
            log.reserve_additional(1, max_edits),
            Err(Status::MemoryAdmission)
        );
        assert_eq!(log.len, 40_408);
        let mut overrides = Vec::new();
        overrides.try_reserve_exact(128).unwrap();
        assert!(
            overrides.capacity() * std::mem::size_of::<BaselineOverride>()
                <= BASELINE_OVERRIDE_BUDGET_BYTES
        );
        for block in 0..128 {
            overrides.push(BaselineOverride {
                block,
                start: block,
                len: 1,
                baseline: None,
            });
        }
        assert_eq!(overrides.len(), 128);
        assert_eq!(log.slabs.len(), 40_280usize.div_ceil(REFINEMENT_SLAB_LEN));
    }

    #[test]
    fn release_progress_counts_reserved_empty_slabs_at_exact_boundaries() {
        for edits in [256usize, 512] {
            for trailing_reservation in [false, true] {
                let height = (edits + 1) * 16;
                let input = vec![128u8; height * 16 * 4];
                let request = engine_request(16, height, 0, &input, 64);
                let plan = ResourcePlan::checked(request).unwrap();
                let mut engine = FrameEncoder::new(request, input, plan).unwrap();
                for block in 0..edits {
                    engine
                        .refinement_log
                        .reserve_one(plan.macroblock_count as usize)
                        .unwrap();
                    engine
                        .refinement_log
                        .push_reserved(RefinementEdit {
                            block: block as u32,
                            change: RefinementChange {
                                plane: 0,
                                patch: 0,
                                coefficient: 0,
                                old: 0,
                                new: 1,
                            },
                        })
                        .unwrap();
                }
                if trailing_reservation {
                    engine
                        .refinement_log
                        .reserve_one(plan.macroblock_count as usize)
                        .unwrap();
                    assert!(engine.refinement_log.slabs.last().unwrap().is_empty());
                }
                let allocated_slabs =
                    edits / REFINEMENT_SLAB_LEN + usize::from(trailing_reservation);
                assert_eq!(engine.refinement_log.slabs.len(), allocated_slabs);
                engine.pending_output_sizes = Some((10, 10));
                engine.begin_refinement_release();
                assert_eq!(engine.progress(), (0, allocated_slabs as u32));
                for released in 1..=allocated_slabs {
                    assert!(!engine.step().unwrap());
                    assert!(engine.output().is_empty());
                    if released < allocated_slabs {
                        assert!(engine.stage == Stage::ReleaseRefinements);
                        assert_eq!(engine.progress(), (released as u32, allocated_slabs as u32));
                    }
                }
                assert!(engine.stage == Stage::PrepareOutput);
                assert!(engine.refinement_log.slabs.is_empty());
                assert_eq!(engine.plan.first_partition_bytes, 10);
                assert_eq!(engine.plan.coefficient_partition_bytes, 10);
                assert_eq!(engine.plan.frame_bytes, 30);
            }
        }
    }

    #[test]
    fn coefficient_replay_roundtrips_uv_modes_patches_edges_and_zero_crossings() {
        let segments = SegmentConfig::nonsegmented(32);
        let deltas = Deltas::default();
        let steps = ac_quant::steps(32, deltas, Plane::UV);
        for mode in 0..4u8 {
            for block_index in 0..4u32 {
                for plane in 0..2u8 {
                    for patch_index in 0..4u8 {
                        for (old, new) in [(0, 1), (1, 2), (-1, 0)] {
                            let mut blocks: Vec<Macroblock> =
                                (0..4).map(|_| Macroblock::default()).collect();
                            let block = &mut blocks[block_index as usize];
                            block.uv_mode = mode;
                            let coefficients = if plane == 0 {
                                &mut block.u[patch_index as usize]
                            } else {
                                &mut block.v[patch_index as usize]
                            };
                            coefficients[0] = new;
                            let mut u: Vec<u8> =
                                (0..256).map(|index| 80 + (index % 71) as u8).collect();
                            let mut v: Vec<u8> =
                                (0..256).map(|index| 90 + (index % 61) as u8).collect();
                            let reconstructed = if plane == 0 { &mut u } else { &mut v };
                            let mx = block_index as usize % 2;
                            let my = block_index as usize / 2;
                            let x = mx * 8;
                            let y = my * 8;
                            let (top, left, corner) = edge::<8>(reconstructed, 16, x, y);
                            let predicted = prediction::predict_uv(
                                &top,
                                &left,
                                corner,
                                y > 0,
                                x > 0,
                                mode_from_u8(mode),
                            );
                            let bx = usize::from(patch_index % 2);
                            let by = usize::from(patch_index / 2);
                            let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
                            let refined_patch =
                                reconstructed_patch(coefficients, &predictor, steps);
                            let old_coefficients = {
                                let mut previous = *coefficients;
                                previous[0] = old;
                                previous
                            };
                            for row in 0..4 {
                                let at = (y + by * 4 + row) * 16 + x + bx * 4;
                                reconstructed[at..at + 4]
                                    .copy_from_slice(&refined_patch[row * 4..row * 4 + 4]);
                            }
                            let refined_u = u.clone();
                            let refined_v = v.clone();
                            let edit = RefinementEdit {
                                block: block_index,
                                change: RefinementChange {
                                    plane,
                                    patch: patch_index,
                                    coefficient: 0,
                                    old,
                                    new,
                                },
                            };
                            replay_edit_state(
                                &mut blocks,
                                &mut u,
                                &mut v,
                                32,
                                segments,
                                deltas,
                                edit,
                                false,
                            )
                            .unwrap();
                            let restored = if plane == 0 { &u } else { &v };
                            let old_patch =
                                reconstructed_patch(&old_coefficients, &predictor, steps);
                            for row in 0..4 {
                                let at = (y + by * 4 + row) * 16 + x + bx * 4;
                                assert_eq!(&restored[at..at + 4], &old_patch[row * 4..row * 4 + 4]);
                            }
                            replay_edit_state(
                                &mut blocks,
                                &mut u,
                                &mut v,
                                32,
                                segments,
                                deltas,
                                edit,
                                true,
                            )
                            .unwrap();
                            assert_eq!(u, refined_u);
                            assert_eq!(v, refined_v);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn global_refinement_replay_matches_fresh_unmodified_analysis_and_exact_output() {
        let (width, height) = (33, 33);
        let input = frontier_rgb_input(width, height);
        let mut exercised = 0;
        for quality in [60, 75, 85] {
            let mut request = engine_request(width, height, 0, &input, width * 4);
            request.quality = quality;
            let plan = ResourcePlan::checked(request).unwrap();
            let mut fresh = FrameEncoder::new(request, input.clone(), plan).unwrap();
            fresh.disable_refinement = true;
            while fresh.stage != Stage::CollectStats {
                fresh.step().unwrap();
            }
            let mut selected = FrameEncoder::new(request, input.clone(), plan).unwrap();
            while selected.stage != Stage::ReverseRefinements
                && selected.stage != Stage::PrepareOutput
            {
                selected.step().unwrap();
            }
            if selected.stage == Stage::PrepareOutput {
                assert!(selected.refinement_log.is_empty());
                continue;
            }
            exercised += 1;
            let refined = selected.refined_checkpoint.as_ref().unwrap();
            let refined_bytes = refined.selected_frame_bytes;
            let refined_legality = refined.legality;
            let refined_quality = refined.quality;
            let refined_u = selected.reconstructed_u.clone();
            let refined_v = selected.reconstructed_v.clone();
            let edit = selected.refinement_log.get(0).unwrap();
            let mut second = edit;
            second.change.old = edit.change.new;
            second.change.new = edit.change.new.checked_add(1).unwrap();
            replay_edit_state(
                &mut selected.blocks,
                &mut selected.reconstructed_u,
                &mut selected.reconstructed_v,
                plan.padded_width as usize,
                selected.segments,
                selected.deltas,
                second,
                true,
            )
            .unwrap();
            replay_edit_state(
                &mut selected.blocks,
                &mut selected.reconstructed_u,
                &mut selected.reconstructed_v,
                plan.padded_width as usize,
                selected.segments,
                selected.deltas,
                second,
                false,
            )
            .unwrap();
            assert_eq!(selected.reconstructed_u, refined_u);
            assert_eq!(selected.reconstructed_v, refined_v);
            second.change.old = second.change.new;
            assert_eq!(
                replay_edit_state(
                    &mut selected.blocks,
                    &mut selected.reconstructed_u,
                    &mut selected.reconstructed_v,
                    plan.padded_width as usize,
                    selected.segments,
                    selected.deltas,
                    second,
                    true,
                ),
                Err(Status::InvalidInput)
            );
            assert_eq!(selected.reconstructed_u, refined_u);
            assert_eq!(selected.reconstructed_v, refined_v);
            let mx = edit.block as usize % 3;
            let my = edit.block as usize / 3;
            let at = (my * 8 + usize::from(edit.change.patch / 2) * 4)
                * (plan.padded_width as usize / 2)
                + mx * 8
                + usize::from(edit.change.patch % 2) * 4;
            let plane = if edit.change.plane == 0 {
                &mut selected.reconstructed_u
            } else {
                &mut selected.reconstructed_v
            };
            plane[at] ^= 1;
            assert_eq!(
                replay_edit_state(
                    &mut selected.blocks,
                    &mut selected.reconstructed_u,
                    &mut selected.reconstructed_v,
                    plan.padded_width as usize,
                    selected.segments,
                    selected.deltas,
                    edit,
                    false,
                ),
                Err(Status::InvalidInput)
            );
            let plane = if edit.change.plane == 0 {
                &mut selected.reconstructed_u
            } else {
                &mut selected.reconstructed_v
            };
            plane[at] ^= 1;
            while selected.stage != Stage::CollectStats {
                selected.step().unwrap();
            }
            assert!(selected.base_count);
            assert_eq!(selected.blocks, fresh.blocks);
            assert_eq!(selected.reconstructed_y, fresh.reconstructed_y);
            assert_eq!(selected.reconstructed_u, fresh.reconstructed_u);
            assert_eq!(selected.reconstructed_v, fresh.reconstructed_v);
            while selected.stage != Stage::CountPrefix {
                selected.step().unwrap();
            }
            let (fresh_model, fresh_skip) = model_frozen(&fresh.blocks, 3, 3).unwrap();
            assert_eq!(selected.model.emission(), fresh_model.emission());
            assert_eq!(selected.skip_probability, fresh_skip);
            while !matches!(
                selected.stage,
                Stage::ReapplyRefinements | Stage::ReleaseRefinements
            ) {
                selected.step().unwrap();
            }
            let base_sizes = selected.pending_output_sizes.unwrap();
            let base_legality = selected
                .plan
                .with_output_sizes(base_sizes.0, base_sizes.1)
                .map(|_| ())
                .map_err(|error| {
                    if matches!(error, Status::OutputLimit | Status::PartitionLimit) {
                        error
                    } else {
                        panic!("unexpected base admission {error:?}")
                    }
                });
            let expected_refined = choose_scored_variants(
                (refined_bytes, refined_legality, refined_quality),
                None,
                (
                    selected.selected_frame_bytes,
                    base_legality,
                    selected.base_quality,
                ),
            )
            .unwrap()
                == VariantChoice::Extended;
            assert_eq!(
                selected.stage == Stage::ReapplyRefinements,
                expected_refined
            );
            while selected.stage != Stage::PrepareOutput {
                selected.step().unwrap();
            }
            assert!(selected.refinement_log.slabs.is_empty());
            assert!(selected.refined_checkpoint.is_none());
            assert!(selected.pending_output_sizes.is_none());
            assert!(selected.output().is_empty());
            let finished = run_engine(selected);
            assert_eq!(
                finished.output().len(),
                finished.selected_frame_bytes as usize
            );
            assert_eq!(
                finished.output(),
                encode_textured(
                    &input,
                    width as u32,
                    height as u32,
                    (width * 4) as u32,
                    0,
                    quality
                )
                .unwrap()
            );
        }
        assert!(exercised > 0);
    }

    #[test]
    fn adjacent_uv_levels_respect_signed_dequantized_domain() {
        assert_eq!(adjacent_level(0, 4, -1), Some(-1));
        assert_eq!(adjacent_level(-1, 4, 1), Some(0));
        assert_eq!(adjacent_level(2047, 4, 1), None);
        assert_eq!(adjacent_level(-2047, 4, -1), None);
        assert_eq!(adjacent_level(115, 284, 1), None);
        assert_eq!(adjacent_level(-115, 284, -1), None);
        assert_eq!(adjacent_level(114, 284, 1), Some(115));
    }

    #[test]
    fn uv_frontier_matches_all_later_predictor_inputs_on_padded_grid() {
        let odd_input = vec![0u8; 17 * 17 * 4];
        let odd_plan =
            ResourcePlan::checked(engine_request(17, 17, 0, &odd_input, 17 * 4)).unwrap();
        assert_eq!((odd_plan.padded_width, odd_plan.padded_height), (32, 32));
        let odd_w = odd_plan.padded_width as usize;
        let odd_h = odd_plan.padded_height as usize;
        assert_eq!(uv_future_consumers(0, 0, odd_w, odd_h), (true, true));
        assert_eq!(uv_future_consumers(1, 0, odd_w, odd_h), (false, true));
        assert_eq!(uv_future_consumers(0, 1, odd_w, odd_h), (true, false));
        assert_eq!(uv_future_consumers(1, 1, odd_w, odd_h), (false, false));
        let stride = 24; // Three padded macroblocks for predictor edge probes.
        let tile = std::array::from_fn(|i| (32 + (i * 17) % 181) as u8);
        let coefficients = [0i16; 16];
        for (mx, my) in [(0, 0), (2, 0), (0, 2), (2, 2), (1, 1)] {
            let (has_right, has_below) = uv_future_consumers(mx, my, 48, 48);
            let mut baseline: Vec<u8> = (0..stride * stride)
                .map(|i| (21 + (i * 37) % 211) as u8)
                .collect();
            commit_tile::<8, 64>(&mut baseline, stride, mx * 8, my * 8, &tile);
            for by in 0..2 {
                for bx in 0..2 {
                    let mut patch = prediction_patch::<8, 64>(&tile, bx, by);
                    patch[0] ^= 1; // Interior of this macroblock, never a later edge.
                    assert!(uv_frontier_preserved(
                        &tile,
                        &patch,
                        &coefficients,
                        &coefficients,
                        bx,
                        by,
                        has_right,
                        has_below,
                        false,
                        false,
                    ));
                    let mut trial = baseline.clone();
                    for row in 0..4 {
                        for col in 0..4 {
                            trial[(my * 8 + by * 4 + row) * stride + mx * 8 + bx * 4 + col] =
                                patch[row * 4 + col];
                        }
                    }
                    for (cx, cy) in [(mx + 1, my), (mx, my + 1), (mx + 1, my + 1)] {
                        if cx >= 3 || cy >= 3 {
                            continue;
                        }
                        let before = edge::<8>(&baseline, stride, cx * 8, cy * 8);
                        let after = edge::<8>(&trial, stride, cx * 8, cy * 8);
                        assert_eq!(
                            after, before,
                            "mb=({mx},{my}) patch=({bx},{by}) consumer=({cx},{cy})"
                        );
                        for mode in 0..4 {
                            assert_eq!(
                                prediction::predict_uv(
                                    &before.0,
                                    &before.1,
                                    before.2,
                                    cy > 0,
                                    cx > 0,
                                    mode_from_u8(mode)
                                ),
                                prediction::predict_uv(
                                    &after.0,
                                    &after.1,
                                    after.2,
                                    cy > 0,
                                    cx > 0,
                                    mode_from_u8(mode)
                                )
                            );
                        }
                    }
                    let mut right_edge = prediction_patch::<8, 64>(&tile, bx, by);
                    right_edge[3] ^= 1;
                    assert_eq!(
                        uv_frontier_preserved(
                            &tile,
                            &right_edge,
                            &coefficients,
                            &coefficients,
                            bx,
                            by,
                            has_right,
                            has_below,
                            false,
                            false
                        ),
                        !(bx == 1 && has_right)
                    );
                    let mut bottom_edge = prediction_patch::<8, 64>(&tile, bx, by);
                    bottom_edge[12] ^= 1;
                    assert_eq!(
                        uv_frontier_preserved(
                            &tile,
                            &bottom_edge,
                            &coefficients,
                            &coefficients,
                            bx,
                            by,
                            has_right,
                            has_below,
                            false,
                            false
                        ),
                        !(by == 1 && has_below)
                    );
                    let mut corner_edge = prediction_patch::<8, 64>(&tile, bx, by);
                    corner_edge[15] ^= 1;
                    assert_eq!(
                        uv_frontier_preserved(
                            &tile,
                            &corner_edge,
                            &coefficients,
                            &coefficients,
                            bx,
                            by,
                            has_right,
                            has_below,
                            false,
                            false
                        ),
                        !((bx == 1 && has_right) || (by == 1 && has_below))
                    );
                }
            }
        }
    }

    #[test]
    fn uv_frontier_matches_exported_contexts_and_rejects_skip_transitions() {
        let tile = [255u8; 64];
        let predictor = [255u8; 16];
        let steps = Steps { dc: 1, ac: 1 };
        for coefficient_index in [0, residual::SCAN[15]] {
            let mut baseline_coefficients = [0i16; 16];
            baseline_coefficients[coefficient_index] = 1;
            let trial_coefficients = [0i16; 16];
            let baseline_patch = reconstructed_patch(&baseline_coefficients, &predictor, steps);
            let trial_patch = reconstructed_patch(&trial_coefficients, &predictor, steps);
            assert_eq!(
                baseline_patch, trial_patch,
                "coefficient={coefficient_index}"
            );
            for plane in 0..2 {
                for by in 0..2 {
                    for bx in 0..2 {
                        let index = by * 2 + bx;
                        let mut baseline = Macroblock {
                            i16: true,
                            ..Macroblock::default()
                        };
                        baseline.y2[0] = 1;
                        if plane == 0 {
                            baseline.u[index] = baseline_coefficients;
                        } else {
                            baseline.v[index] = baseline_coefficients;
                        }
                        let mut trial = Macroblock {
                            i16: true,
                            ..Macroblock::default()
                        };
                        trial.y2[0] = 1;
                        if plane == 0 {
                            trial.u[index] = trial_coefficients;
                        } else {
                            trial.v[index] = trial_coefficients;
                        }
                        for (has_right, has_below) in
                            [(true, true), (true, false), (false, true), (false, false)]
                        {
                            let permitted = uv_frontier_preserved(
                                &tile,
                                &trial_patch,
                                &baseline_coefficients,
                                &trial_coefficients,
                                bx,
                                by,
                                has_right,
                                has_below,
                                baseline.skip(),
                                trial.skip(),
                            );
                            let mut before = CoeffContexts::new(2);
                            let mut after = before.clone();
                            before
                                .encode_coefficients(&mut RateCounter::default(), &baseline, 0)
                                .unwrap();
                            after
                                .encode_coefficients(&mut RateCounter::default(), &trial, 0)
                                .unwrap();
                            let same_export = if plane == 0 {
                                (!has_right || before.left_u == after.left_u)
                                    && (!has_below || before.u[..2] == after.u[..2])
                            } else {
                                (!has_right || before.left_v == after.left_v)
                                    && (!has_below || before.v[..2] == after.v[..2])
                            };
                            assert_eq!(
                            permitted, same_export,
                            "plane={plane} patch=({bx},{by}) right={has_right} below={has_below}"
                        );
                        }
                    }
                }
            }
        }
        let baseline = Macroblock {
            i16: true,
            ..Macroblock::default()
        };
        let mut trial = Macroblock {
            i16: true,
            ..Macroblock::default()
        };
        trial.u[3][0] = 1;
        assert!(baseline.skip());
        assert!(!trial.skip());
        assert!(!uv_frontier_preserved(
            &tile,
            &[255; 16],
            &[0; 16],
            &trial.u[3],
            1,
            1,
            false,
            false,
            baseline.skip(),
            trial.skip()
        ));
        let mut before = CoeffContexts::new(1);
        before.u[0] = true;
        before.left_u[0] = true;
        let mut after = before.clone();
        before
            .encode_coefficients(&mut RateCounter::default(), &baseline, 0)
            .unwrap();
        after
            .encode_coefficients(&mut RateCounter::default(), &trial, 0)
            .unwrap();
        assert_eq!(before.u, [false, false]);
        assert_eq!(before.left_u, [false, false]);
        assert_eq!(after.u, [false, true]);
        assert_eq!(after.left_u, [false, true]);
    }

    fn frontier_rgb_input(width: usize, height: usize) -> Vec<u8> {
        (0..height)
            .flat_map(|y| {
                (0..width).flat_map(move |x| {
                    let gray = 48 + (x * 9 + y * 13 + (x * y % 7) * 3) % 160;
                    [
                        (gray + (x * 5 + y * 3) % 17) as u8,
                        gray as u8,
                        (gray - (x * 3 + y * 7) % 13) as u8,
                        255,
                    ]
                })
            })
            .collect()
    }

    #[test]
    fn guarded_uv_refinement_preserves_later_pre_refinement_choices() {
        // 33 visible pixels make the third padded macroblock a real raster
        // consumer even though most of its samples lie beyond the image.
        let width = 33;
        let height = 33;
        let input = frontier_rgb_input(width, height);
        let mut accepted_before_final = 0;
        for quality in [60, 75, 85] {
            let mut request = engine_request(width, height, 0, &input, width * 4);
            request.quality = quality;
            let plan = ResourcePlan::checked(request).unwrap();
            let mut baseline = FrameEncoder::new(request, input.clone(), plan).unwrap();
            let mut guarded = FrameEncoder::new(request, input.clone(), plan).unwrap();
            for engine in [&mut baseline, &mut guarded] {
                while engine.stage != Stage::Analyze {
                    engine.step().unwrap();
                }
                assert!(!engine.high_chroma_loss);
                assert_eq!(engine.plan.macroblock_count, 9);
            }
            let padded_w = plan.padded_width as usize;
            let uv_w = padded_w / 2;
            for index in 0..9 {
                let mx = index % 3;
                let my = index / 3;
                if mx == 0 {
                    baseline.contexts.row();
                    baseline.left_modes.fill(0);
                    guarded.contexts.row();
                    guarded.left_modes.fill(0);
                }
                for (before, after) in [
                    (&baseline.reconstructed_u, &guarded.reconstructed_u),
                    (&baseline.reconstructed_v, &guarded.reconstructed_v),
                ] {
                    assert_eq!(
                        edge::<8>(before, uv_w, mx * 8, my * 8),
                        edge::<8>(after, uv_w, mx * 8, my * 8),
                        "quality={quality} block={index}"
                    );
                }
                assert_eq!(baseline.contexts, guarded.contexts);
                assert_eq!(baseline.above_modes, guarded.above_modes);
                assert_eq!(baseline.left_modes, guarded.left_modes);
                assert_eq!(baseline.header_budget, guarded.header_budget);

                let segment_id = baseline.blocks[index].segment_id;
                assert_eq!(segment_id, guarded.blocks[index].segment_id);
                let qindex = baseline.segments.qindex_for(segment_id);
                let y_steps = ac_quant::steps(qindex as u8, baseline.deltas, Plane::Y1);
                let uv_steps = ac_quant::steps(qindex as u8, baseline.deltas, Plane::UV);
                let y2_steps = ac_quant::steps(qindex as u8, baseline.deltas, Plane::Y2);
                let lambda = crate::presets::lambda_for_quality(qindex, quality);

                // Probe the guarded path with refinement disabled before its
                // real ABI2 step. The probe has isolated reconstruction,
                // coefficient contexts, modes and header budget.
                let mut probe_y = guarded.reconstructed_y.clone();
                let mut probe_u = guarded.reconstructed_u.clone();
                let mut probe_v = guarded.reconstructed_v.clone();
                let mut probe_contexts = guarded.contexts.clone();
                let mut probe_above = guarded.above_modes.clone();
                let mut probe_left = guarded.left_modes;
                let mut probe_budget = guarded.header_budget.clone();
                let probe = analyze_one(
                    &guarded.source_y,
                    &guarded.source_u,
                    &guarded.source_v,
                    None,
                    false,
                    false,
                    &mut probe_y,
                    &mut probe_u,
                    &mut probe_v,
                    padded_w,
                    uv_w,
                    mx,
                    my,
                    y_steps,
                    uv_steps,
                    y2_steps,
                    &mut probe_contexts,
                    &mut probe_above,
                    &mut probe_left,
                    lambda,
                    quality,
                    width,
                    height,
                    0,
                    segment_id,
                    guarded.segments,
                    &mut probe_budget,
                )
                .unwrap();
                let selected = analyze_one(
                    &baseline.source_y,
                    &baseline.source_u,
                    &baseline.source_v,
                    None,
                    false,
                    false,
                    &mut baseline.reconstructed_y,
                    &mut baseline.reconstructed_u,
                    &mut baseline.reconstructed_v,
                    padded_w,
                    uv_w,
                    mx,
                    my,
                    y_steps,
                    uv_steps,
                    y2_steps,
                    &mut baseline.contexts,
                    &mut baseline.above_modes,
                    &mut baseline.left_modes,
                    lambda,
                    quality,
                    width,
                    height,
                    0,
                    segment_id,
                    baseline.segments,
                    &mut baseline.header_budget,
                )
                .unwrap();
                assert_eq!(
                    probe.block, selected.block,
                    "quality={quality} block={index}"
                );
                assert_eq!(probe_contexts, baseline.contexts);
                assert_eq!(probe_above, baseline.above_modes);
                assert_eq!(probe_left, baseline.left_modes);
                assert_eq!(probe_budget, baseline.header_budget);
                assert_eq!(probe_y, baseline.reconstructed_y);
                for (probe_plane, baseline_plane) in [
                    (&probe_u, &baseline.reconstructed_u),
                    (&probe_v, &baseline.reconstructed_v),
                ] {
                    for row in 0..8 {
                        let at = (my * 8 + row) * uv_w + mx * 8;
                        assert_eq!(
                            &probe_plane[at..at + 8],
                            &baseline_plane[at..at + 8],
                            "quality={quality} block={index} row={row}"
                        );
                    }
                }
                baseline.blocks[index] = selected.block;
                baseline.cursor += 1;

                guarded.analyze_one_step().unwrap();
                while guarded.stage == Stage::JointRefine {
                    guarded.joint_one_step().unwrap();
                }
                let actual = &guarded.blocks[index];
                let expected = &baseline.blocks[index];
                assert_eq!(actual.y, expected.y);
                assert_eq!(actual.y2, expected.y2);
                assert_eq!(actual.i16, expected.i16);
                assert_eq!(actual.y_mode, expected.y_mode);
                assert_eq!(actual.b_modes, expected.b_modes);
                assert_eq!(actual.uv_mode, expected.uv_mode);
                assert_eq!(actual.skip(), expected.skip());
                if index + 1 < 9 {
                    // The ABI2 stage resets coding state immediately after
                    // its final analysis step for the counting pass.
                    assert_eq!(guarded.contexts, baseline.contexts);
                    assert_eq!(guarded.above_modes, baseline.above_modes);
                    assert_eq!(guarded.left_modes, baseline.left_modes);
                    assert_eq!(guarded.header_budget, baseline.header_budget);
                }
                assert_eq!(guarded.reconstructed_y, baseline.reconstructed_y);
                let changed_coefficients = actual
                    .u
                    .iter()
                    .zip(&expected.u)
                    .chain(actual.v.iter().zip(&expected.v))
                    .flat_map(|(a, b)| a.iter().zip(b))
                    .filter(|(a, b)| a != b)
                    .count();
                assert!(changed_coefficients <= 4);
                if index + 1 < 9 {
                    accepted_before_final += changed_coefficients;
                }
            }
            let abi2 = run_engine(guarded);
            let sync = encode_textured(
                &input,
                width as u32,
                height as u32,
                (width * 4) as u32,
                0,
                quality,
            )
            .unwrap();
            assert_eq!(abi2.output(), sync, "quality={quality} sync/ABI2");
        }
        assert!(
            accepted_before_final > 0,
            "fixture must exercise a guarded refinement before a later padded macroblock"
        );
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_guarded_uv_refinement_on_padded_odd_grid() {
        let width = 33;
        let height = 33;
        let input = frontier_rgb_input(width, height);
        for quality in [60, 75, 85] {
            let mut request = engine_request(width, height, 0, &input, width * 4);
            request.quality = quality;
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            let (y, u, v, padded_w) = engine.reconstruction();
            let expected = filtered_visible_yuv(
                y,
                u,
                v,
                padded_w,
                width,
                height,
                &engine.blocks,
                engine.filter,
            );
            assert_decodes(
                engine.output(),
                width,
                height,
                &expected,
                "guarded UV refinement on three-by-three padded grid",
            );
        }
    }

    #[test]
    fn uv_refinement_requires_strict_ssim_gain_and_preserved_frontier() {
        let source_y = [128u8; 256];
        let source_uv = [128u8; 64];
        let reconstructed_y = [0u8; 256];
        let reconstructed_uv = [0u8; 64];
        let y_tile = [128u8; 256];
        let steps = Steps { dc: 8, ac: 8 };
        let mut coefficients = [0i16; 16];
        coefficients[0] = 1;
        let predictor = [128u8; 16];
        let patch = reconstructed_patch(&coefficients, &predictor, steps);
        assert_ne!(patch, predictor);
        let mut uv = UvCandidate {
            u: [[0; 16]; 4],
            v: [[0; 16]; 4],
            u_tile: [128; 64],
            v_tile: [128; 64],
            distortion: 0,
        };
        uv.u[0] = coefficients;
        store_patch::<8, 64>(&mut uv.u_tile, 0, 0, &patch);
        let baseline_uv = uv.clone();
        let mut block = Macroblock {
            i16: true,
            u: uv.u,
            ..Macroblock::default()
        };
        block.y2[0] = 1;
        let contexts = CoeffContexts::new(1);
        let above = [0u8; 4];
        let left = [0u8; 4];
        let segments = SegmentConfig::nonsegmented(0);
        let budget = HeaderBudget::new(
            1,
            segments,
            Deltas::default(),
            FilterConfig::DISABLED,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap();
        let mut target = [0u8; 16 * 16 * 4];
        let neutral_uv = [128u8; 64];
        let neutral = display_rgb::Frame {
            width: 16,
            height: 16,
            stride_y: 16,
            original: display_rgb::Original {
                pixels: &[],
                stride: 0,
                layout: 0,
            },
            source_y: &source_y,
            source_u: &source_uv,
            source_v: &source_uv,
            reconstructed_y: &reconstructed_y,
            reconstructed_u: &reconstructed_uv,
            reconstructed_v: &reconstructed_uv,
            tile_y: &y_tile,
            tile_u: &neutral_uv,
            tile_v: &neutral_uv,
            mx: 0,
            my: 0,
        };
        for y in 0..16 {
            for x in 0..16 {
                let rgb = neutral.rendered(x, y, None);
                target[(y * 16 + x) * 4..(y * 16 + x) * 4 + 3].copy_from_slice(&rgb);
                target[(y * 16 + x) * 4 + 3] = 255;
            }
        }
        let before = selected_cost(
            &block, 0, &contexts, &above, &left, 0, 1, segments, &budget, &mut None, &mut None,
        )
        .unwrap()
        .unwrap();
        refine_selected_uv(
            &mut block,
            &mut uv,
            &y_tile,
            display_rgb::Original {
                pixels: &target,
                stride: 64,
                layout: 0,
            },
            &source_y,
            &source_uv,
            &source_uv,
            &reconstructed_y,
            &reconstructed_uv,
            &reconstructed_uv,
            16,
            16,
            16,
            0,
            0,
            steps,
            &contexts,
            &above,
            &left,
            segments,
            &budget,
        )
        .unwrap();
        let after = selected_cost(
            &block, 0, &contexts, &above, &left, 0, 1, segments, &budget, &mut None, &mut None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(block.u[0][0], 0);
        assert_eq!(uv.u_tile, neutral_uv);
        assert!(after <= before);
        assert_eq!(reconstructed_uv, [0; 64]);

        let mut higher_coefficients = coefficients;
        higher_coefficients[0] = 2;
        let higher_patch = reconstructed_patch(&higher_coefficients, &predictor, steps);
        let mut higher_tile = baseline_uv.u_tile;
        store_patch::<8, 64>(&mut higher_tile, 0, 0, &higher_patch);
        let higher_frame = display_rgb::Frame {
            tile_u: &higher_tile,
            ..neutral
        };
        let mut higher_target = target;
        for y in 0..16 {
            for x in 0..16 {
                higher_target[(y * 16 + x) * 4..(y * 16 + x) * 4 + 3]
                    .copy_from_slice(&higher_frame.rendered(x, y, None));
            }
        }
        let mut expensive_block = Macroblock {
            i16: true,
            u: baseline_uv.u,
            ..Macroblock::default()
        };
        expensive_block.y2[0] = 1;
        let mut expensive_uv = baseline_uv.clone();
        let higher_before = selected_cost(
            &expensive_block,
            0,
            &contexts,
            &above,
            &left,
            0,
            1,
            segments,
            &budget,
            &mut None,
            &mut None,
        )
        .unwrap()
        .unwrap();
        let chosen = refine_selected_uv(
            &mut expensive_block,
            &mut expensive_uv,
            &y_tile,
            display_rgb::Original {
                pixels: &higher_target,
                stride: 64,
                layout: 0,
            },
            &source_y,
            &source_uv,
            &source_uv,
            &reconstructed_y,
            &reconstructed_uv,
            &reconstructed_uv,
            16,
            16,
            16,
            0,
            0,
            steps,
            &contexts,
            &above,
            &left,
            segments,
            &budget,
        )
        .unwrap();
        let baseline_frame = display_rgb::Frame {
            original: display_rgb::Original {
                pixels: &higher_target,
                stride: 64,
                layout: 0,
            },
            tile_u: &baseline_uv.u_tile,
            tile_v: &baseline_uv.v_tile,
            ..neutral
        };
        let combined_gain = display_rgb::LocalCache::new(&baseline_frame).score_tiles(
            &baseline_frame,
            &expensive_uv.u_tile,
            &expensive_uv.v_tile,
        );
        assert!((chosen.unwrap().1 - combined_gain).abs() < 1e-9);
        let higher_after = selected_cost(
            &expensive_block,
            0,
            &contexts,
            &above,
            &left,
            0,
            1,
            segments,
            &budget,
            &mut None,
            &mut None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(chosen.unwrap().0.new, 2);
        assert!(higher_after > higher_before);

        let mut tie_target = target;
        let baseline = display_rgb::Frame {
            tile_u: &baseline_uv.u_tile,
            ..neutral
        };
        for y in 0..16 {
            for x in 0..16 {
                tie_target[(y * 16 + x) * 4..(y * 16 + x) * 4 + 3]
                    .copy_from_slice(&baseline.rendered(x, y, None));
            }
        }
        let mut tie_block = Macroblock {
            i16: true,
            u: baseline_uv.u,
            ..Macroblock::default()
        };
        tie_block.y2[0] = 1;
        let mut tie_uv = baseline_uv.clone();
        refine_selected_uv(
            &mut tie_block,
            &mut tie_uv,
            &y_tile,
            display_rgb::Original {
                pixels: &tie_target,
                stride: 64,
                layout: 0,
            },
            &source_y,
            &source_uv,
            &source_uv,
            &reconstructed_y,
            &reconstructed_uv,
            &reconstructed_uv,
            16,
            16,
            16,
            0,
            0,
            steps,
            &contexts,
            &above,
            &left,
            segments,
            &budget,
        )
        .unwrap();
        assert_eq!(tie_block.u[0][0], 1);

        let mut zero_block = Macroblock {
            i16: true,
            ..Macroblock::default()
        };
        let mut zero_uv = UvCandidate {
            u: [[0; 16]; 4],
            v: [[0; 16]; 4],
            u_tile: neutral_uv,
            v_tile: neutral_uv,
            distortion: 0,
        };
        let zero_rate = selected_cost(
            &zero_block,
            0,
            &contexts,
            &above,
            &left,
            0,
            1,
            segments,
            &budget,
            &mut None,
            &mut None,
        )
        .unwrap()
        .unwrap();
        assert!(zero_rate < before);
        let desired = display_rgb::Frame {
            tile_u: &zero_uv.u_tile,
            original: display_rgb::Original {
                pixels: &tie_target,
                stride: 64,
                layout: 0,
            },
            ..baseline
        };
        let gain = display_rgb::LocalCache::new(&desired).score(
            &desired,
            display_rgb::Change {
                plane: 0,
                bx: 0,
                by: 0,
                patch: &patch,
            },
            desired.affected(0, 0),
        );
        assert!(gain > 0.0);
        refine_selected_uv(
            &mut zero_block,
            &mut zero_uv,
            &y_tile,
            display_rgb::Original {
                pixels: &tie_target,
                stride: 64,
                layout: 0,
            },
            &source_y,
            &source_uv,
            &source_uv,
            &reconstructed_y,
            &reconstructed_uv,
            &reconstructed_uv,
            16,
            16,
            16,
            0,
            0,
            steps,
            &contexts,
            &above,
            &left,
            segments,
            &budget,
        )
        .unwrap();
        assert_eq!(zero_block.u[0][0], 0);
        assert_eq!(zero_uv.u_tile, neutral_uv);
    }

    #[test]
    fn preview_comparison_uses_completed_rgb_error_and_checked_rate() {
        assert!(!reduced_profile_wins(7, 7));
        assert!(!reduced_profile_wins(7, 8));
        assert!(reduced_profile_wins(7, 6));

        let mut comparison = ProfileComparison {
            visible_error: 9,
            ..ProfileComparison::default()
        };
        comparison.add_rate(10, 32, 60).unwrap();
        assert_eq!(comparison.score(7, 32, 60).unwrap(), 9 * 256 + 17 * 480);
        comparison.visible_error = u64::MAX;
        assert!(matches!(
            comparison.score(0, 32, 60),
            Err(EncodeError::OutputLimit)
        ));
        comparison.visible_error = 0;
        assert!(matches!(
            comparison.add_rate(u64::MAX, 32, 60),
            Err(EncodeError::OutputLimit)
        ));
    }

    #[test]
    fn uv_rdo_drops_only_a_profitable_last_unit_ac() {
        let predictor = [128u8; 16];
        let steps = Steps { dc: 8, ac: 20 };
        for sign in [-1, 1] {
            let mut coefficients = [0i16; 16];
            coefficients[0] = -2;
            coefficients[residual::SCAN[3]] = 2;
            coefficients[residual::SCAN[15]] = sign;
            let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
            let mut dropped = coefficients;
            dropped[residual::SCAN[15]] = 0;
            let ideal = reconstructed_patch(&dropped, &predictor, steps);
            assert_ne!(baseline_patch, ideal);
            for context in 0..=2 {
                let mut before = RateCounter::default();
                let mut after = RateCounter::default();
                residual::encode_block(&mut before, &coefficients, 2, context).unwrap();
                residual::encode_block(&mut after, &dropped, 2, context).unwrap();
                assert!(after.cost < before.cost);
                assert_eq!(
                    optimize_uv_block(
                        &ideal,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        1,
                        (coefficients, baseline_patch),
                    ),
                    (dropped, ideal)
                );
                assert_eq!(
                    optimize_uv_block(
                        &baseline_patch,
                        4,
                        0,
                        0,
                        &predictor,
                        steps,
                        context,
                        0,
                        (coefficients, baseline_patch),
                    ),
                    (coefficients, baseline_patch)
                );
            }
        }
    }

    #[test]
    fn uv_rdo_leaves_empty_dc_only_and_nonunit_ac_blocks_intact() {
        let predictor = [128u8; 16];
        let steps = Steps { dc: 8, ac: 20 };
        for coefficients in [
            [0i16; 16],
            std::array::from_fn(|i| if i == 0 { -2 } else { 0 }),
            std::array::from_fn(|i| if i == residual::SCAN[15] { -2 } else { 0 }),
        ] {
            let patch = reconstructed_patch(&coefficients, &predictor, steps);
            assert_eq!(
                optimize_uv_block(
                    &patch,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    0,
                    100,
                    (coefficients, patch),
                ),
                (coefficients, patch)
            );
        }
    }

    #[test]
    fn flat_uv_dc_zero_uses_pixel_sse_and_strict_context_rate() {
        let predictor = [128u8; 16];
        let steps = Steps { dc: 13, ac: 20 };
        for sign in [-1, 1] {
            let mut coefficients = [0i16; 16];
            coefficients[0] = sign;
            let baseline_patch = reconstructed_patch(&coefficients, &predictor, steps);
            let source = [u8::try_from(128 + sign).unwrap(); 16];
            assert_eq!(patch_error(&source, 4, 0, 0, &baseline_patch), 16);
            assert_eq!(patch_error(&source, 4, 0, 0, &predictor), 16);
            for context in 0..=2 {
                let mut before = RateCounter::default();
                let mut after = RateCounter::default();
                residual::encode_block(&mut before, &coefficients, 2, context).unwrap();
                residual::encode_block(&mut after, &[0; 16], 2, context).unwrap();
                assert!(after.cost < before.cost);
                assert_eq!(
                    optimize_uv_dc_zero(
                        &source,
                        4,
                        0,
                        0,
                        &predictor,
                        context,
                        (coefficients, baseline_patch),
                    ),
                    ([0; 16], predictor)
                );
            }
            assert_eq!(
                optimize_uv_dc_zero(
                    &baseline_patch,
                    4,
                    0,
                    0,
                    &predictor,
                    0,
                    (coefficients, baseline_patch),
                ),
                (coefficients, baseline_patch)
            );
        }
        for (predictor, dc) in [([0u8; 16], -1), ([255u8; 16], 1)] {
            let mut coefficients = [0i16; 16];
            coefficients[0] = dc;
            let patch = reconstructed_patch(&coefficients, &predictor, steps);
            assert_eq!(patch, predictor);
            assert_eq!(
                optimize_uv_dc_zero(&predictor, 4, 0, 0, &predictor, 0, (coefficients, patch)),
                ([0; 16], predictor)
            );
        }
        for coefficients in [
            [0i16; 16],
            std::array::from_fn(|i| if i == 0 { 2 } else { 0 }),
            std::array::from_fn(|i| if i <= 1 { 1 } else { 0 }),
        ] {
            let patch = reconstructed_patch(&coefficients, &predictor, steps);
            assert_eq!(
                optimize_uv_dc_zero(&predictor, 4, 0, 0, &predictor, 0, (coefficients, patch)),
                (coefficients, patch)
            );
        }
    }

    #[test]
    fn chroma_dc_feedback_corrects_signed_rounding_within_one_mode_and_plane() {
        let source_u = [130; 64];
        let source_v = [128; 64];
        let reconstructed = [0; 64];
        let steps = Steps { dc: 10, ac: 17 };
        let trial = |feedback| {
            make_uv(
                &source_u,
                &source_v,
                &reconstructed,
                &reconstructed,
                8,
                0,
                0,
                0,
                steps,
                None,
                feedback,
            )
        };
        let baseline = trial(false);
        let selected = trial(true);
        assert_eq!(baseline.u_tile, [131; 64]);
        assert_eq!(selected.u.map(|coefficients| coefficients[0]), [2, 1, 1, 2]);
        assert_eq!(selected.u[0], baseline.u[0]);
        for (before, after) in baseline.u.iter().zip(&selected.u) {
            assert_eq!(before[1..], after[1..]);
        }
        assert_eq!(
            selected
                .u_tile
                .iter()
                .map(|&sample| u32::from(sample))
                .sum::<u32>(),
            130 * 64
        );
        assert_eq!(selected.v, baseline.v);
        assert_eq!(selected.v_tile, source_v);
        assert_eq!(trial(true).u, selected.u);
        assert_eq!(trial(true).u_tile, selected.u_tile);
    }

    #[test]
    fn flat_uv_dc_zero_keeps_mode_trials_and_hidden_patches_isolated() {
        let source = [129u8; 64];
        let reconstructed = [0u8; 64];
        let mut contexts = CoeffContexts::new(1);
        contexts.u = vec![true, false];
        contexts.v = vec![false, true];
        contexts.left_u = [false, true];
        contexts.left_v = [true, false];
        let before = contexts.clone();
        let steps = ac_quant::steps(19, crate::presets::deltas(75), Plane::UV);
        let baseline = make_uv(
            &source,
            &source,
            &reconstructed,
            &reconstructed,
            8,
            0,
            0,
            0,
            steps,
            None,
            false,
        );
        assert!(baseline.u.iter().all(|coeff| coeff[0] == 1));
        assert!(baseline.v.iter().all(|coeff| coeff[0] == 1));
        let trial = |visible_width, visible_height| {
            make_uv(
                &source,
                &source,
                &reconstructed,
                &reconstructed,
                8,
                0,
                0,
                0,
                steps,
                Some(UvRdo {
                    contexts: &contexts,
                    mx: 0,
                    lambda: 1,
                    visible_width,
                    visible_height,
                    policy: UvRatePolicy::FlatDcZero,
                }),
                false,
            )
        };
        let visible = trial(8, 8);
        assert!(visible.u.iter().all(|coeff| *coeff == [0; 16]));
        assert!(visible.v.iter().all(|coeff| *coeff == [0; 16]));
        assert_eq!(visible.u_tile, [128; 64]);
        assert_eq!(visible.v_tile, [128; 64]);
        let partial = trial(1, 1);
        assert_eq!(partial.u[0], [0; 16]);
        assert_eq!(partial.v[0], [0; 16]);
        assert_eq!(partial.u[1..], baseline.u[1..]);
        assert_eq!(partial.v[1..], baseline.v[1..]);
        assert_eq!(contexts, before);
    }

    #[test]
    fn higher_preset_frames_remain_deterministic_and_match_abi2() {
        let pixels: Vec<_> = (0..16 * 16 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    255
                } else {
                    ((i / 4 * 37 + i / 4 / 16 * 19 + i % 4 * 47) & 255) as u8
                }
            })
            .collect();
        // The pre-refinement c901c052 payload fingerprints are retained in
        // source history; coefficient refinement intentionally changes them.
        for quality in [75, 85] {
            let bytes = encode_textured(&pixels, 16, 16, 64, 0, quality).unwrap();
            assert_eq!(
                encode_textured(&pixels, 16, 16, 64, 0, quality).unwrap(),
                bytes
            );
            let request = Request {
                quality,
                ..engine_request(16, 16, 0, &pixels, 64)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, pixels.clone(), plan).unwrap());
            assert_eq!(engine.output(), bytes);
        }
    }

    #[test]
    fn partial_uv_rate_allowance_preserves_tiny_sync_and_abi2_frames() {
        let input: Vec<u8> = [
            [53u8, 178, 89],
            [124, 201, 150],
            [72, 215, 106],
            [143, 238, 167],
            [91, 252, 123],
            [162, 19, 184],
            [110, 33, 140],
            [181, 56, 201],
            [129, 70, 157],
            [200, 93, 218],
        ]
        .into_iter()
        .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
        .collect();
        let contexts = CoeffContexts::new(1);
        let rdo = UvRdo {
            contexts: &contexts,
            mx: 0,
            lambda: 480,
            visible_width: 1,
            visible_height: 3,
            policy: UvRatePolicy::TexturedAcTail,
        };
        assert_eq!(rdo.block_lambda(0, 0), Some(1));
        assert_eq!(rdo.block_lambda(0, 4), None);
        assert_eq!(rdo.block_lambda(4, 0), None);
        let sync = encode_textured(&input, 2, 5, 8, 0, 60).unwrap();
        // The retained c901c052 payload was 86 bytes with FNV-1a
        // 0x2ba7_7544_8b00_1ee3 before this refinement.
        assert_eq!(encode_textured(&input, 2, 5, 8, 0, 60).unwrap(), sync);
        for frame in [1, 2] {
            let request = Request {
                quality: 60,
                frame,
                ..engine_request(2, 5, 0, &input, 8)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            assert_eq!(engine.output(), sync);
        }
    }

    #[test]
    fn q60_uv_mode_trials_keep_neighbor_contexts_isolated() {
        let mut contexts = CoeffContexts::new(1);
        contexts.u = vec![true, false];
        contexts.v = vec![false, true];
        contexts.left_u = [false, true];
        contexts.left_v = [true, false];
        let before = contexts.clone();
        let reconstructed = [0u8; 64];
        let steps = ac_quant::steps(34, crate::presets::deltas(60), Plane::UV);
        let lambda = crate::presets::lambda_for_quality(34, 60);
        let mut changed = false;
        for seed in 0..128 {
            let source: [u8; 64] = std::array::from_fn(|i| {
                (96 + (i * 37 + i / 8 * 11 + seed * 17 + i * seed * 3) % 65) as u8
            });
            for mode in 0..4 {
                let baseline = make_uv(
                    &source,
                    &source,
                    &reconstructed,
                    &reconstructed,
                    8,
                    0,
                    0,
                    mode,
                    steps,
                    None,
                    false,
                );
                let trial = make_uv(
                    &source,
                    &source,
                    &reconstructed,
                    &reconstructed,
                    8,
                    0,
                    0,
                    mode,
                    steps,
                    Some(UvRdo {
                        contexts: &contexts,
                        mx: 0,
                        lambda,
                        visible_width: 8,
                        visible_height: 8,
                        policy: UvRatePolicy::TexturedAcTail,
                    }),
                    false,
                );
                assert_eq!(contexts, before);
                for (original, selected) in baseline.u.iter().zip(&trial.u) {
                    if original != selected {
                        changed = true;
                        let position = (1..16)
                            .rev()
                            .find(|&position| original[residual::SCAN[position]] != 0)
                            .unwrap();
                        let mut dropped = *original;
                        assert_eq!(dropped[residual::SCAN[position]].unsigned_abs(), 1);
                        dropped[residual::SCAN[position]] = 0;
                        assert_eq!(*selected, dropped);
                    }
                }
            }
            if changed {
                break;
            }
        }
        assert!(changed, "deterministic UV trial must exercise one AC drop");
    }

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
    fn factored_rate_matrix_matches_reference_scores_and_decisions() {
        fn candidate(li: usize, ui: usize, segment_id: u8) -> Macroblock {
            let mut block = Macroblock {
                i16: li != 4,
                y_mode: (li % 4) as u8,
                b_modes: std::array::from_fn(|i| ((i * 3 + li) % 10) as u8),
                uv_mode: ui as u8,
                segment_id,
                ..Macroblock::default()
            };
            match li {
                1 => {
                    block.y2[0] = -5;
                    block.y2[15] = 67;
                }
                2 => {
                    block.y[0][0] = 1;
                    block.y[9][7] = -2114;
                }
                3 => {
                    block.y2[4] = 19;
                    block.y[3][8] = -35;
                    block.y[15][15] = 2;
                }
                4 => {
                    block.y[0][0] = 7;
                    block.y[7][3] = -11;
                    block.y[15][15] = 2114;
                }
                _ => {}
            }
            match ui {
                1 => {
                    block.u[0][0] = 1;
                    block.u[3][15] = -2;
                }
                2 => {
                    block.v[1][9] = 2114;
                    block.v[2][4] = -67;
                }
                3 => {
                    block.u[2][5] = 35;
                    block.v[3][15] = -19;
                }
                _ => {}
            }
            block
        }

        for policy in [0, 1, 2] {
            let luma_indices: &[usize] = match policy {
                0 => &[0, 1, 2, 3, 4],
                1 => &[0, 1, 2, 3],
                _ => &[4],
            };
            for pattern in 0..4 {
                for segmented in [false, true] {
                    for (slack, lambda) in [(9, 0), (9, 225), (200, 225)] {
                        let segments = if segmented {
                            SegmentConfig::from_counts(75, [1; 4], 4, false)
                        } else {
                            SegmentConfig::nonsegmented(23)
                        };
                        let segment_id = if segmented { pattern as u8 } else { 0 };
                        let mut contexts = CoeffContexts::new(2);
                        let flag = |i: usize| match pattern {
                            0 => false,
                            1 => true,
                            2 => i.is_multiple_of(2),
                            _ => i.is_multiple_of(3),
                        };
                        contexts.y2[0] = flag(0);
                        for (i, value) in contexts.y[..4].iter_mut().enumerate() {
                            *value = flag(i + 1);
                        }
                        for i in 0..2 {
                            contexts.u[i] = flag(i + 5);
                            contexts.v[i] = flag(i + 7);
                        }
                        contexts.left_y2 = flag(9);
                        contexts.left_y = std::array::from_fn(|i| flag(i + 10));
                        contexts.left_u = std::array::from_fn(|i| flag(i + 14));
                        contexts.left_v = std::array::from_fn(|i| flag(i + 16));
                        let before = contexts.clone();
                        let above = [pattern as u8; 8];
                        let left = [pattern as u8; 4];
                        let mut budget = HeaderBudget::new(
                            2,
                            segments,
                            Deltas::default(),
                            FilterConfig::DISABLED,
                            MAX_FIRST_PARTITION_BYTES as usize,
                        )
                        .unwrap();
                        budget.limit =
                            budget.fixed_symbols_and_tail + MAX_I16_HEADER_SYMBOLS + slack;
                        let mut luma_costs = [None; 5];
                        let mut uv_costs = [None; 4];
                        let mut factored_best = None;
                        let mut reference_best = None;
                        for (li, &source_li) in luma_indices.iter().enumerate() {
                            for (ui, uv_cost) in uv_costs.iter_mut().enumerate() {
                                let block = candidate(source_li, ui, segment_id);
                                let distortion = if lambda == 0 {
                                    0
                                } else {
                                    ((li * 7 + ui * 11 + pattern) % 13) as u64
                                };
                                let reference = selected_cost_reference(
                                    &block, 0, &contexts, &above, &left, distortion, lambda,
                                    segments, &budget,
                                );
                                let factored = selected_cost(
                                    &block,
                                    0,
                                    &contexts,
                                    &above,
                                    &left,
                                    distortion,
                                    lambda,
                                    segments,
                                    &budget,
                                    &mut luma_costs[li],
                                    uv_cost,
                                );
                                assert_eq!(factored, reference, "policy={policy} pattern={pattern} segmented={segmented} slack={slack} li={li} ui={ui}");
                                if let Some(score) = reference.unwrap() {
                                    if reference_best
                                        .is_none_or(|best: (u64, usize, usize)| score < best.0)
                                    {
                                        reference_best = Some((score, source_li, ui));
                                    }
                                }
                                if let Some(score) = factored.unwrap() {
                                    if factored_best
                                        .is_none_or(|best: (u64, usize, usize)| score < best.0)
                                    {
                                        factored_best = Some((score, source_li, ui));
                                    }
                                }
                            }
                        }
                        assert_eq!(factored_best, reference_best);
                        assert_eq!(contexts, before, "trials changed committed contexts");
                    }
                }
            }
        }
    }

    #[test]
    fn factored_rate_preserves_budget_rejection_before_invalid_tokens() {
        let segments = SegmentConfig::nonsegmented(23);
        let mut block = Macroblock {
            b_modes: [9; 16],
            ..Macroblock::default()
        };
        block.v[0][0] = 2115;
        let contexts = CoeffContexts::new(1);
        let above = [0; 4];
        let left = [0; 4];
        let mut budget = HeaderBudget::new(
            2,
            segments,
            Deltas::default(),
            FilterConfig::DISABLED,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap();
        budget.limit = budget.fixed_symbols_and_tail + 2 * MAX_I16_HEADER_SYMBOLS;
        let mut luma_cost = None;
        let mut uv_cost = None;
        let evaluate =
            |budget: &HeaderBudget, luma_cost: &mut Option<u64>, uv_cost: &mut Option<u64>| {
                (
                    selected_cost_reference(
                        &block, 0, &contexts, &above, &left, 0, 225, segments, budget,
                    ),
                    selected_cost(
                        &block, 0, &contexts, &above, &left, 0, 225, segments, budget, luma_cost,
                        uv_cost,
                    ),
                )
            };
        assert_eq!(
            evaluate(&budget, &mut luma_cost, &mut uv_cost),
            (Ok(None), Ok(None))
        );
        assert_eq!((luma_cost, uv_cost), (None, None));
        budget.limit = MAX_FIRST_PARTITION_BYTES as usize;
        assert_eq!(
            evaluate(&budget, &mut luma_cost, &mut uv_cost),
            (
                Err(EncodeError::InvalidInput),
                Err(EncodeError::InvalidInput)
            )
        );
        assert_eq!(contexts, CoeffContexts::new(1));
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
                    None,
                    false,
                    false,
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
                    75,
                    32,
                    16,
                    if mx == 0 { 2 } else { 0 },
                    0,
                    segments,
                    &mut budget,
                )
                .unwrap();
                blocks.push(block.block);
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

    fn mixed_low_curvature_input() -> Vec<u8> {
        let mut pixels = Vec::with_capacity(32 * 16 * 4);
        for _y in 0..16 {
            for x in 0usize..32 {
                let step = x.saturating_sub(16) as u8;
                pixels.extend_from_slice(&[40 + step, 80 + step, 120 + step, 255]);
            }
        }
        pixels
    }

    #[test]
    fn y1_zero_bin_activates_on_selected_eligible_block_and_excludes_q75() {
        for (quality, eligible) in [(60u32, true), (75, false)] {
            let mut witnessed = false;
            let mut eligible_attempts = 0usize;
            'sources: for magnitude in 1u8..=32 {
                for x in [0usize, 3, 8, 15, 16, 20, 24, 31] {
                    let mut input = mixed_low_curvature_input();
                    let at = x * 4;
                    for channel in &mut input[at..at + 3] {
                        *channel = channel.saturating_add(magnitude);
                    }
                    let request = Request {
                        quality,
                        ..engine_request(32, 16, 0, &input, 128)
                    };
                    let plan = ResourcePlan::checked(request).unwrap();
                    let mut engine = FrameEncoder::new(request, input, plan).unwrap();
                    engine.disable_refinement = true;
                    while engine.stage != Stage::Analyze {
                        engine.step().unwrap();
                    }
                    if engine.mixed_y1_ac != eligible {
                        continue;
                    }
                    eligible_attempts += 1;
                    while engine.stage == Stage::Analyze {
                        engine.step().unwrap();
                    }
                    let stride = engine.plan.padded_width as usize;
                    for (index, block) in engine.blocks.iter().enumerate() {
                        if !block.i16 {
                            continue;
                        }
                        let mx = index % (stride / 16);
                        let my = index / (stride / 16);
                        let qindex = engine.segments.qindex_for(block.segment_id) as u8;
                        let y_steps = ac_quant::steps(qindex, engine.deltas, Plane::Y1);
                        let y2_steps = ac_quant::steps(qindex, engine.deltas, Plane::Y2);
                        let original_qindex =
                            engine.original_segments().qindex_for(block.segment_id) as u8;
                        if eligible {
                            let original_deltas = crate::presets::deltas(60);
                            assert_eq!(
                                engine.deltas,
                                crate::presets::mixed_y1_ac_deltas(original_deltas, true)
                            );
                            assert!(!engine.segments.enabled);
                            assert_eq!(qindex, engine.segments.base_qindex as u8);
                        } else {
                            assert_eq!(qindex, original_qindex);
                            assert_eq!(engine.deltas, crate::presets::deltas(75));
                        }
                        let canonical = make_i16(
                            &engine.source_y,
                            &engine.reconstructed_y,
                            stride,
                            mx * 16,
                            my * 16,
                            block.y_mode,
                            y_steps,
                            y2_steps,
                            false,
                        );
                        let biased = make_i16(
                            &engine.source_y,
                            &engine.reconstructed_y,
                            stride,
                            mx * 16,
                            my * 16,
                            block.y_mode,
                            y_steps,
                            y2_steps,
                            true,
                        );
                        if canonical.block.y == biased.block.y {
                            continue;
                        }
                        assert_eq!(canonical.block.y2, biased.block.y2);
                        assert_eq!(block.y2, canonical.block.y2);
                        assert_eq!(
                            read_tile::<16, 256>(&engine.reconstructed_y, stride, mx * 16, my * 16),
                            if eligible {
                                biased.tile
                            } else {
                                canonical.tile
                            },
                        );
                        assert_eq!(
                            block.y,
                            if eligible {
                                biased.block.y
                            } else {
                                canonical.block.y
                            },
                        );
                        witnessed = true;
                        break 'sources;
                    }
                }
            }
            assert!(
                witnessed,
                "quality={quality} eligible={eligible} attempts={eligible_attempts}: no selected I16 marginal Y1 AC witness"
            );
        }
    }

    #[test]
    fn mixed_y1_ac_profile_matches_sync_resumable_and_repeated_frames() {
        let mixed = mixed_low_curvature_input();
        let textured = mixed_segment_input();
        let photo = low_curvature_photo_input();
        let neutral = [128, 128, 128, 255].repeat(32 * 16);
        let mut first_mixed = None;
        for (input, width, quality, expected_profile) in [
            (&mixed, 32, 60, true),
            (&textured, 64, 60, false),
            (&mixed, 32, 75, false),
            (&mixed, 32, 85, false),
            (&neutral, 32, 60, false),
            (&photo, 16, 60, false),
            (&mixed, 32, 60, true),
        ] {
            for frame in 1..=2 {
                let request = Request {
                    quality,
                    frame,
                    ..engine_request(width, 16, 0, input, width * 4)
                };
                let plan = ResourcePlan::checked(request).unwrap();
                let engine =
                    run_engine(FrameEncoder::new(request, (*input).clone(), plan).unwrap());
                assert_eq!(engine.mixed_y1_ac, expected_profile);
                if expected_profile {
                    assert!(!engine.segments.enabled);
                    assert!(
                        !engine.photo_q60 && !engine.high_chroma_loss && !engine.neutral_chroma
                    );
                    assert!(engine.curvature.within_cutoff(engine.blocks.len()));
                    assert_eq!(engine.segments.qindex, [10; 4]);
                    assert_eq!(engine.segments.base_qindex, 10);
                    assert_eq!(engine.original_segments().qindex, [6, 18, 32, 32]);
                    assert_eq!(
                        engine.deltas,
                        crate::presets::mixed_y1_ac_deltas(crate::presets::deltas(60), true)
                    );
                    assert_eq!(engine.filter.level, 6);
                }
                let sync = encode_textured(input, width as u32, 16, (width * 4) as u32, 0, quality)
                    .unwrap();
                assert_eq!(
                    engine.output(),
                    sync,
                    "width={width} quality={quality} frame={frame}"
                );
                if expected_profile {
                    if let Some(first) = &first_mixed {
                        assert_eq!(&sync, first);
                    } else {
                        first_mixed = Some(sync);
                    }
                }
            }
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoders_reconstruct_uniform_mixed_q60_with_retained_source_classes() {
        let mut input = mixed_low_curvature_input();
        // An isolated luminance peak makes the right block textured while
        // leaving the frame within the mixed low-curvature profile.
        let peak = (8 * 32 + 24) * 4;
        for channel in &mut input[peak..peak + 3] {
            *channel += 12;
        }
        let request = Request {
            quality: 60,
            ..engine_request(32, 16, 0, &input, 128)
        };
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert!(engine.mixed_y1_ac);
        assert!(!engine.segments.enabled);
        assert_eq!(engine.segments.qindex, [10; 4]);
        assert_eq!(engine.blocks[0].segment_id, segmentation::FINE_SMOOTH);
        assert_eq!(engine.blocks[1].segment_id, segmentation::TEXTURED);
        assert!(UvRatePolicy::for_source_class(60, engine.blocks[0].segment_id).is_none());
        assert!(matches!(
            UvRatePolicy::for_source_class(60, engine.blocks[1].segment_id),
            Some(UvRatePolicy::TexturedAcTail),
        ));
        assert_eq!(
            engine
                .original_segments()
                .qindex_for(engine.blocks[0].segment_id),
            6
        );
        assert_eq!(
            engine
                .original_segments()
                .qindex_for(engine.blocks[1].segment_id),
            32
        );
        let (y, u, v, padded_w) = engine.reconstruction();
        let expected =
            filtered_visible_yuv(y, u, v, padded_w, 32, 16, &engine.blocks, engine.filter);
        assert_decodes(
            engine.output(),
            32,
            16,
            &expected,
            "uniform mixed q60 quantizer",
        );
    }

    #[test]
    fn mixed_segment_map_and_fresh_frames_are_deterministic() {
        let input = mixed_segment_input();
        let request = engine_request(64, 16, 0, &input, 256);
        let plan = ResourcePlan::checked(request).unwrap();
        let first = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
        assert!(first.segments.enabled);
        assert_eq!(first.class_counts, [1, 1, 1, 1]);
        assert!(!first.medium_textured_luma);
        assert_eq!(first.deltas, crate::presets::deltas(75));
        assert_eq!(
            first.segments.qindex,
            [
                crate::presets::smooth_qindex(request.quality),
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
            crate::presets::smooth_qindex(request.quality)
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
            crate::presets::smooth_qindex(request.quality)
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
            Some(128),
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
        for (quality, expected_dc, expected_ac) in [(60, -4, -11), (75, -9, -9), (85, -4, -4)] {
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
    fn uniform_mixed_q60_header_admits_three_signed_y_deltas() {
        let original = SegmentConfig::nonsegmented(6);
        let selected = SegmentConfig::from_counts(60, [1, 0, 1, 0], 2, false)
            .with_mixed_q60_uniform([1, 0, 1, 0], true);
        let before_deltas = crate::presets::deltas(60);
        let after_deltas = crate::presets::mixed_y1_ac_deltas(before_deltas, true);
        let filter = FilterConfig::for_quality(60);
        let before = HeaderBudget::new(
            2,
            original,
            before_deltas,
            filter,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap();
        let after = HeaderBudget::new(
            2,
            selected,
            after_deltas,
            filter,
            MAX_FIRST_PARTITION_BYTES as usize,
        )
        .unwrap();
        assert_eq!(
            after.fixed_symbols_and_tail,
            before.fixed_symbols_and_tail + 15
        );
        struct Bits(Vec<bool>);
        impl BoolSink for Bits {
            fn write(&mut self, _probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push(bit);
                Ok(())
            }
        }
        let mut baseline_header = Bits(Vec::new());
        let mut selected_header = Bits(Vec::new());
        write_header_prefix(&mut baseline_header, original, before_deltas, filter).unwrap();
        write_header_prefix(&mut selected_header, selected, after_deltas, filter).unwrap();
        assert_eq!(selected_header.0.len(), baseline_header.0.len() + 15);
        assert!(!selected_header.0[2]); // Segmentation disabled.
        assert_eq!(
            &selected_header.0[16..23],
            &[false, false, false, true, false, true, false] // Base qindex 10.
        );
        assert_eq!(
            &selected_header.0[selected_header.0.len() - 31..],
            &[
                true, false, true, false, false, true, // Y1 DC -4.
                true, false, true, false, false, true, // Y2 DC -4.
                true, false, true, false, false, true, // Y2 AC -4.
                true, true, false, false, false, true, // UV DC -8.
                true, true, true, true, true, true,  // UV AC -15.
                false, // Entropy updates are not retained.
            ]
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
        assert_eq!(all_skip.frozen_syntax(), Some(1));
        assert_eq!(none_skip.frozen_syntax(), None);
        assert_eq!(mixed.frozen_syntax(), Some(240));
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
        let mut disabled = Operations(Vec::new());
        write_header_suffix(&mut disabled, None).unwrap();
        assert_eq!(disabled.0, [(128, false)]);
        let mut nonzero = Macroblock::default();
        nonzero.y[0][0] = 1;
        let mut disabled_header = Operations(Vec::new());
        write_macroblock_header(
            &mut disabled_header,
            &nonzero,
            0,
            &[0; 4],
            &[0; 4],
            SegmentConfig::nonsegmented(22),
            None,
        )
        .unwrap();
        let mut enabled_header = Operations(Vec::new());
        write_macroblock_header(
            &mut enabled_header,
            &nonzero,
            0,
            &[0; 4],
            &[0; 4],
            SegmentConfig::nonsegmented(22),
            Some(255),
        )
        .unwrap();
        assert_eq!(enabled_header.0[0], (255, false));
        assert_eq!(disabled_header.0, enabled_header.0[1..]);
        assert_eq!(
            write_macroblock_header(
                &mut Operations(Vec::new()),
                &Macroblock::default(),
                0,
                &[0; 4],
                &[0; 4],
                SegmentConfig::nonsegmented(22),
                None,
            ),
            Err(EncodeError::InvalidInput)
        );
        for probability in [1, 128, 240, 255] {
            let mut suffix = Operations(Vec::new());
            write_header_suffix(&mut suffix, Some(probability)).unwrap();
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
                Some(probability),
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
        for expected_probability in [Some(240), None, Some(1)] {
            if expected_probability.is_none() {
                for block in &mut blocks {
                    block.y[0][0] = 1;
                }
            } else if expected_probability == Some(1) {
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
                Some(128),
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

    fn emit_skip_syntax_control(
        blocks: &[Macroblock],
        width: usize,
        height: usize,
        skip_probability: Option<u8>,
    ) -> Vec<u8> {
        let blocks_x = width.div_ceil(16);
        let blocks_y = height.div_ceil(16);
        assert_eq!(blocks.len(), blocks_x * blocks_y);
        let counted = count_partitions(
            blocks,
            blocks_x,
            blocks_y,
            SegmentConfig::nonsegmented(23),
            Deltas::default(),
            FilterConfig::DISABLED,
            None,
            skip_probability,
        )
        .unwrap();
        let mut header = BoolWriter::new();
        let mut token = BoolWriter::new();
        code_partitions(
            blocks,
            blocks_x,
            blocks_y,
            SegmentConfig::nonsegmented(23),
            Deltas::default(),
            FilterConfig::DISABLED,
            None,
            skip_probability,
            &mut header,
            &mut token,
        )
        .unwrap();
        let first = header.finish().unwrap();
        let second = token.finish().unwrap();
        assert_eq!(counted, (first.len(), second.len()));
        let mut frame = Vec::with_capacity(10 + first.len() + second.len());
        frame.extend_from_slice(&(((first.len() as u32) << 5) | 0x10).to_le_bytes()[..3]);
        frame.extend_from_slice(&[0x9d, 0x01, 0x2a]);
        frame.extend_from_slice(&(width as u16).to_le_bytes());
        frame.extend_from_slice(&(height as u16).to_le_bytes());
        frame.extend_from_slice(&first);
        frame.extend_from_slice(&second);
        assert_eq!(frame.len(), 10 + counted.0 + counted.1);
        frame
    }

    fn nonzero_skip_syntax_matrix() -> Vec<(usize, usize, Vec<Macroblock>)> {
        [(1, 1), (2, 1), (1, 2), (2, 2), (3, 2)]
            .into_iter()
            .flat_map(|(blocks_x, blocks_y)| {
                [1i16, -2, 5].into_iter().map(move |coefficient| {
                    let blocks = (0..blocks_x * blocks_y)
                        .map(|index| {
                            let mut block = Macroblock::default();
                            block.y[index % 16][0] = coefficient;
                            block
                        })
                        .collect();
                    (blocks_x * 16 - 1, blocks_y * 16 - 1, blocks)
                })
            })
            .collect()
    }

    #[test]
    fn disabled_skip_syntax_never_grows_bounded_nonzero_matrix() {
        for (width, height, blocks) in nonzero_skip_syntax_matrix() {
            assert!(blocks.iter().all(|block| !block.skip()));
            let disabled = emit_skip_syntax_control(&blocks, width, height, None);
            let enabled = emit_skip_syntax_control(&blocks, width, height, Some(255));
            eprintln!(
                "skip-syntax-control {width}x{height} disabled={} enabled={}",
                disabled.len(),
                enabled.len()
            );
            assert!(
                disabled.len() <= enabled.len(),
                "{width}x{height}: disabled={} enabled={}",
                disabled.len(),
                enabled.len()
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoders_match_disabled_and_enabled_nonzero_skip_controls() {
        for (width, height, blocks) in nonzero_skip_syntax_matrix()
            .into_iter()
            .filter(|(width, height, _)| matches!((width, height), (15, 15) | (31, 15) | (47, 31)))
        {
            let disabled = emit_skip_syntax_control(&blocks, width, height, None);
            let enabled = emit_skip_syntax_control(&blocks, width, height, Some(255));
            for decoder in ["vp8", "libvpx"] {
                let disabled_yuv = decode_visible_yuv(&disabled, width, height, decoder);
                let enabled_yuv = decode_visible_yuv(&enabled, width, height, decoder);
                assert!(!disabled_yuv.is_empty());
                assert_eq!(disabled_yuv, enabled_yuv, "{decoder} {width}x{height}");
            }
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
        assert_ne!(engine.skip_probability, Some(128));
        assert_eq!(engine.output(), expected);
        assert_eq!(engine.plan().frame_bytes as usize, expected.len());
    }

    #[test]
    fn disabled_skip_syntax_matches_sync_and_resumable_on_tiny_odd_repeated_frames() {
        for (width, height, quality) in [(2, 5, 60), (17, 19, 75), (33, 17, 85)] {
            let mut input = [0, 0, 0, 255].repeat(width * height);
            for y in 0..height {
                for x in 0..width {
                    let at = (y * width + x) * 4;
                    input[at] = (x * 53 + y * 19 + 17) as u8;
                    input[at + 1] = (x * 71 + y * 37 + 29) as u8;
                    input[at + 2] = (x * 11 + y * 83 + 43) as u8;
                }
            }
            let expected = encode_textured(
                &input,
                width as u32,
                height as u32,
                (width * 4) as u32,
                0,
                quality,
            )
            .unwrap();
            if width == 2 && std::env::var_os("WMC501_SKIP_SYNC_REFERENCE").is_some() {
                eprintln!("skip-sync-reference-2x5-q60: {expected:?}");
            }
            for frame in [1, 2] {
                let request = Request {
                    quality,
                    frame,
                    ..engine_request(width, height, 0, &input, width * 4)
                };
                let plan = ResourcePlan::checked(request).unwrap();
                assert!(std::mem::size_of::<Option<u8>>() <= 2);
                assert!(
                    std::mem::size_of::<FrameEncoder>() <= plan.scratch_allowance_bytes as usize
                );
                let mut engine = FrameEncoder::new(request, input.clone(), plan).unwrap();
                let mut seen_count = false;
                let mut seen_emit = false;
                for _ in 0..100_000 {
                    if engine.stage == Stage::CountPrefix {
                        assert_eq!(engine.skip_probability, None);
                        seen_count = true;
                    }
                    if engine.stage == Stage::EmitSuffix {
                        assert_eq!(engine.skip_probability, None);
                        seen_emit = true;
                    }
                    if engine.step().unwrap() {
                        break;
                    }
                    assert!(engine.output().is_empty());
                }
                assert!(engine.stage == Stage::Done);
                assert!(seen_count && seen_emit);
                assert!(
                    engine.blocks.iter().all(|block| !block.skip()),
                    "{width}x{height} q{quality}"
                );
                assert_eq!(engine.skip_probability, None);
                assert_eq!(engine.output(), expected);
                assert_eq!(engine.plan().frame_bytes as usize, expected.len());
            }
        }
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
        write_header_suffix(&mut header, Some(128)).unwrap();
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
                Some(128),
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
                    0 | 13 | 22 => 65_536,
                    4 | 8 | 16 | 20 | 24 | 30 | 32 => 64,
                    41 | 45 | 49 => 64 * 1024 / (3 * 5 * 8),
                    42 | 46 | 50 => 65_536,
                    43 | 47 | 51 => 1,
                    44 | 48 | 52 => 64,
                    53 => 64 * 1024 / (3 * 5 * 8),
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
    fn completed_quality_policy_preserves_legality_bytes_and_exact_ties() {
        let ok = Ok(());
        let limit = Err(Status::OutputLimit);
        assert_eq!(
            choose_scored_variants((99, ok, 0.6), Some((98, ok, 0.8)), (100, ok, 0.7)),
            Ok(VariantChoice::Baseline)
        );
        assert_eq!(
            choose_scored_variants((100, ok, 0.8), Some((99, ok, 0.8)), (100, ok, 0.8)),
            Ok(VariantChoice::Extended)
        );
        assert_eq!(
            choose_scored_variants((101, ok, 0.9), Some((99, ok, 0.7)), (100, ok, 0.8)),
            Ok(VariantChoice::Extended)
        );
        assert_eq!(
            choose_scored_variants((99, limit, 0.9), Some((98, ok, 0.7)), (100, ok, 0.6)),
            Ok(VariantChoice::Baseline)
        );
        assert_eq!(
            choose_scored_variants((101, ok, 0.9), Some((99, ok, 0.7)), (100, limit, 0.6)),
            Ok(VariantChoice::Extended)
        );
        assert_eq!(
            choose_scored_variants((101, limit, 0.9), Some((99, limit, 0.7)), (100, limit, 0.6)),
            Err(Status::OutputLimit)
        );
        assert_eq!(
            choose_scored_variants((99, ok, f64::NAN), None, (100, ok, 0.7)),
            Err(Status::InvalidInput)
        );
        assert_eq!(
            choose_scored_variants((99, ok, 0.9), None, (100, ok, f64::INFINITY)),
            Err(Status::InvalidInput)
        );
    }

    #[test]
    fn completed_quality_word_window_requires_strict_gain_over_best_within_base() {
        let ok = Ok(());
        // Both base parities allow exactly one additional RIFF payload word.
        for (base, within, extra, too_large) in [(100, 100, 102, 103), (99, 100, 102, 103)] {
            assert_eq!(
                choose_scored_variants((extra, ok, 0.9), Some((within, ok, 0.8)), (base, ok, 0.7)),
                Ok(VariantChoice::Extended)
            );
            for score in [0.8, 0.79] {
                assert_eq!(
                    choose_scored_variants(
                        (extra, ok, score),
                        Some((within, ok, 0.8)),
                        (base, ok, 0.7)
                    ),
                    Ok(VariantChoice::Baseline)
                );
            }
            assert_eq!(
                choose_scored_variants(
                    (too_large, ok, 0.99),
                    Some((within, ok, 0.8)),
                    (base, ok, 0.7)
                ),
                Ok(VariantChoice::Baseline)
            );
        }
        // Padding is free at the base cost, so equal scores keep normal priority.
        assert_eq!(
            choose_scored_variants((100, ok, 0.8), Some((99, ok, 0.8)), (99, ok, 0.8)),
            Ok(VariantChoice::Extended)
        );
        assert_eq!(
            choose_scored_variants((102, ok, -0.1), Some((100, ok, -0.2)), (99, ok, -0.3)),
            Ok(VariantChoice::Extended)
        );
        // u32 raw sizes are widened before alignment and the additional word.
        assert_eq!(aligned_payload_cost(u32::MAX), u64::from(u32::MAX) + 1);
        assert_eq!(
            choose_scored_variants((u32::MAX, ok, 0.9), None, (u32::MAX - 2, ok, 0.8)),
            Ok(VariantChoice::Extended)
        );
        assert_eq!(
            choose_scored_variants((u32::MAX, ok, 0.9), None, (u32::MAX - 4, ok, 0.8)),
            Ok(VariantChoice::Base)
        );
        assert_eq!(
            choose_scored_variants((101, Err(Status::InvalidInput), 0.9), None, (100, ok, 0.8)),
            Err(Status::InvalidInput)
        );
        assert_eq!(
            choose_scored_variants((102, ok, f64::NAN), None, (100, ok, 0.8)),
            Err(Status::InvalidInput)
        );
        assert_eq!(
            choose_scored_variants((101, ok, 0.8), None, (100, Err(Status::OutputLimit), 0.7)),
            Ok(VariantChoice::Extended)
        );
    }

    #[test]
    fn tiny_chroma_word_gain_selects_existing_extended_payload() {
        // Public synthetic 7x1 control, frozen independently of encoder output.
        let pixels = [
            244, 29, 171, 255, 89, 61, 239, 255, 89, 61, 239, 255, 89, 61, 239, 255, 244, 29, 171,
            255, 89, 61, 239, 255, 89, 61, 239, 255,
        ];
        let expected = [
            240, 1, 0, 157, 1, 42, 7, 0, 1, 0, 1, 0, 28, 41, 164, 2, 117, 42, 192, 65, 55, 97, 200,
            252, 0, 254, 241, 170, 137, 67, 161, 120, 232, 63, 40, 191, 254, 67, 13, 136, 162, 223,
            255, 250, 56, 223, 255, 200, 92, 92, 75, 63, 255, 163, 141, 255, 199, 111, 191, 221,
            39, 3, 254, 98, 226, 184, 189, 0, 0,
        ];
        let request = Request {
            quality: 85,
            ..engine_request(7, 1, 0, &pixels, 28)
        };
        let plan = ResourcePlan::checked(request).unwrap();
        let mut staged = FrameEncoder::new(request, pixels.to_vec(), plan).unwrap();
        while staged.stage != Stage::PrepareOutput {
            staged.step().unwrap();
            assert!(staged.output().is_empty());
        }
        assert_eq!(staged.selected_frame_bytes, expected.len() as u32);
        assert_eq!(staged.plan.frame_bytes, expected.len() as u32);
        let staged = run_engine(staged);
        assert_eq!(staged.output(), expected);
        assert_eq!(encode_textured(&pixels, 7, 1, 28, 0, 85).unwrap(), expected);
    }

    #[test]
    fn generated_gradient_q75_prefers_filtered_unrefined_frame() {
        // The frozen fresh3-gradient source formula; this is an engineering
        // control for the general selector, not a special-case input path.
        let width = 373usize;
        let height = 257usize;
        let mut input = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                input[(y * width + x) * 4..][..4].copy_from_slice(&[
                    (255 * x / (width - 1)) as u8,
                    (255 * (height - 1 - y) / (height - 1)) as u8,
                    (255 * (5 * x + 3 * y) / (5 * (width - 1) + 3 * (height - 1))) as u8,
                    255,
                ]);
            }
        }
        let request = engine_request(width, height, 0, &input, width * 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input, plan).unwrap();
        let mut refined_quality = None;
        while engine.stage != Stage::ReleaseRefinements {
            assert!(engine.output().is_empty());
            if engine.stage == Stage::QualityInit && engine.quality_variant == VariantChoice::Base {
                refined_quality = Some(engine.refined_checkpoint.as_ref().unwrap().quality);
            }
            engine.step().unwrap();
        }
        assert!(engine.joint_used_total > 0 && engine.joint_used_total <= 128);
        assert!(!engine.medium_textured_luma);
        assert_eq!(engine.deltas, crate::presets::deltas(75));
        assert!(engine.base_quality > refined_quality.unwrap());
        assert!(engine.refined_checkpoint.is_none()); // B0 won the complete filtered score.
        assert!(engine.baseline_checkpoint.is_none());
        let engine = run_engine(engine);
        assert_eq!(engine.output().len(), 1301);
    }

    #[test]
    fn staged_filtered_copy_matches_full_reference_for_every_counted_variant() {
        let (width, height) = (33, 33);
        let input = frontier_rgb_input(width, height)
            .into_boxed_slice()
            .into_vec();
        let request = engine_request(width, height, 0, &input, width * 4);
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input, plan).unwrap();
        let mut seen = [false; 3];
        while engine.stage != Stage::Done {
            if engine.stage == Stage::QualityMetric {
                let variant = match engine.quality_variant {
                    VariantChoice::Extended => 0,
                    VariantChoice::Baseline => 1,
                    VariantChoice::Base => 2,
                };
                if !seen[variant] {
                    let mut y = engine.reconstructed_y.clone();
                    let mut u = engine.reconstructed_u.clone();
                    let mut v = engine.reconstructed_v.clone();
                    let padded_w = plan.padded_width as usize;
                    let padded_h = plan.padded_height as usize;
                    let mut planes = filter::Planes {
                        y: filter::Plane {
                            data: &mut y,
                            width: padded_w,
                            height: padded_h,
                            stride: padded_w,
                        },
                        u: filter::Plane {
                            data: &mut u,
                            width: padded_w / 2,
                            height: padded_h / 2,
                            stride: padded_w / 2,
                        },
                        v: filter::Plane {
                            data: &mut v,
                            width: padded_w / 2,
                            height: padded_h / 2,
                            stride: padded_w / 2,
                        },
                    };
                    let params: Vec<_> = engine
                        .blocks
                        .iter()
                        .map(|block| filter::FilterParams {
                            level: engine.filter.level,
                            sharpness: engine.filter.sharpness,
                            simple: engine.filter.simple,
                            i4: !block.i16,
                            has_coefficients: !block.skip(),
                        })
                        .collect();
                    filter::filter_frame(&mut planes, padded_w / 16, padded_h / 16, &params)
                        .unwrap();
                    assert_eq!(engine.source_y, y);
                    assert_eq!(engine.source_u, u);
                    assert_eq!(engine.source_v, v);
                    seen[variant] = true;
                }
            }
            engine.step().unwrap();
        }
        assert!(seen[0] && seen[2]);
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

    fn photo_allocation_input() -> Vec<u8> {
        let mut pixels = textured_checker([64; 3], [192; 3]);
        let tint = near_neutral_high(127);
        for (x, y) in [(15, 14), (14, 15)] {
            let at = (y * 16 + x) * 4;
            pixels[at..at + 3].copy_from_slice(&tint);
        }
        pixels
    }

    fn low_curvature_photo_input() -> Vec<u8> {
        let mut pixels = vec![0; 16 * 16 * 4];
        for pixel in pixels.as_chunks_mut::<4>().0 {
            pixel.copy_from_slice(&[64, 84, 104, 255]);
        }
        pixels[(7 * 16 + 7) * 4..(7 * 16 + 7) * 4 + 3].copy_from_slice(&[96, 116, 136]);
        pixels
    }

    #[test]
    fn photo_allocation_profiles_match_sync_and_resumable_encoders() {
        for (input, quality, active_q, uv_dc, selected) in [
            (photo_allocation_input(), 60, 32, -4, false),
            (low_curvature_photo_input(), 60, 28, -15, true),
            (photo_allocation_input(), 75, 26, -11, false),
        ] {
            let request = Request {
                quality,
                ..engine_request(16, 16, 0, &input, 64)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            assert_eq!(engine.class_counts, [0, 0, 0, 1]);
            assert!(!engine.neutral_chroma);
            assert!(!engine.high_chroma_loss);
            assert_eq!(engine.photo_q60, selected);
            assert_eq!(engine.medium_textured_luma, quality == 75);
            assert_eq!(engine.segments.base_qindex, active_q);
            assert_eq!(engine.segments.qindex_for(segmentation::TEXTURED), active_q);
            assert_eq!(engine.deltas.uv_dc, uv_dc);
            assert_eq!(
                engine
                    .original_segments()
                    .qindex_for(segmentation::TEXTURED),
                if quality == 60 { 32 } else { 28 }
            );
            assert_eq!(
                engine.output(),
                encode_textured(&input, 16, 16, 64, 0, quality).unwrap()
            );
        }
    }

    #[test]
    fn q60_curvature_selection_does_not_leak_between_jobs() {
        let low = low_curvature_photo_input();
        let high = photo_allocation_input();
        let mut first_low = None;
        let mut first_high = None;
        for (input, selected) in [(&low, true), (&high, false), (&low, true), (&high, false)] {
            let request = Request {
                quality: 60,
                ..engine_request(16, 16, 0, input, 64)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            assert_eq!(engine.class_counts, [0, 0, 0, 1]);
            assert_eq!(engine.curvature.within_cutoff(1), selected);
            assert_eq!(engine.photo_q60, selected);
            assert_eq!(engine.segments.base_qindex, if selected { 28 } else { 32 });
            let sync = encode_textured(input, 16, 16, 64, 0, 60).unwrap();
            assert_eq!(engine.output(), sync);
            let previous = if selected {
                &mut first_low
            } else {
                &mut first_high
            };
            if let Some(previous) = previous {
                assert_eq!(&sync, previous);
            } else {
                *previous = Some(sync);
            }
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn photo_allocation_decodes_independently() {
        for (input, quality) in [
            (photo_allocation_input(), 60),
            (low_curvature_photo_input(), 60),
            (photo_allocation_input(), 75),
        ] {
            let request = Request {
                quality,
                ..engine_request(16, 16, 0, &input, 64)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            let (y, u, v, padded_w) = engine.reconstruction();
            let expected =
                filtered_visible_yuv(y, u, v, padded_w, 16, 16, &engine.blocks, engine.filter);
            assert_decodes(engine.output(), 16, 16, &expected, "photo allocation");
        }
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
            (&gray, true, 25),
            (&colored, false, 28),
            (&near_low, false, 26),
            (&near_high, false, 26),
            (&gray, true, 25),
        ]
        .into_iter()
        .enumerate()
        {
            let request = engine_request(16, 16, 0, input, 64);
            let plan = ResourcePlan::checked(request).unwrap();
            let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
            assert_eq!(engine.class_counts, [0, 0, 0, 1]);
            assert_eq!(engine.neutral_chroma, expected_neutral);
            assert_eq!(engine.medium_textured_luma, index != 1);
            assert_eq!(
                engine.deltas,
                if engine.medium_textured_luma {
                    crate::presets::photo_allocation_deltas(
                        crate::presets::medium_textured_deltas(crate::presets::deltas(75)),
                        false,
                        !engine.neutral_chroma,
                    )
                } else {
                    crate::presets::deltas(75)
                }
            );
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
            (textured_checker([64; 3], [192; 3]), 25),
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
    fn q60_chroma_loss_profile_matches_sync_across_layouts_and_frames() {
        let (width, height) = (5, 3);
        let colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255; 3]];
        let mut rgba = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let [r, g, b] = colors[(y % 2) * 2 + x % 2];
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        let expected = encode_textured(
            &rgba,
            width as u32,
            height as u32,
            (width * 4) as u32,
            0,
            60,
        )
        .unwrap();
        for layout in 0..=4 {
            let bpp = if layout == 4 { 3 } else { 4 };
            let stride = width * bpp + 3;
            let mut input = Vec::new();
            for y in 0..height {
                for x in 0..width {
                    let at = (y * width + x) * 4;
                    let [r, g, b, _] = rgba[at..at + 4].try_into().unwrap();
                    match layout {
                        0 | 2 => {
                            input.extend_from_slice(&[r, g, b, if layout == 0 { 255 } else { 7 }])
                        }
                        1 | 3 => {
                            input.extend_from_slice(&[b, g, r, if layout == 1 { 255 } else { 7 }])
                        }
                        _ => input.extend_from_slice(&[r, g, b]),
                    }
                }
                input.extend_from_slice(&[42; 3]);
            }
            let request = Request {
                quality: 60,
                ..engine_request(width, height, layout, &input, stride)
            };
            for frame in 1..=2 {
                let request = Request { frame, ..request };
                let plan = ResourcePlan::checked(request).unwrap();
                let engine = run_engine(FrameEncoder::new(request, input.clone(), plan).unwrap());
                assert!(engine.rgb_error_sum > 4096 * 3 * (width * height) as u64);
                assert!(engine.high_chroma_loss);
                let reduced = engine.preview_trial == PreviewTrial::FinalReduced;
                assert_eq!(
                    (engine.deltas.uv_dc, engine.deltas.uv_ac),
                    if reduced {
                        crate::presets::HIGH_CHROMA_LOSS_UV_DELTAS
                    } else {
                        crate::presets::HIGH_CHROMA_LOSS_ORIGINAL_UV_DELTAS
                    }
                );
                assert_eq!(
                    engine.segments.qindex,
                    if reduced {
                        [2, 14, 28, 28]
                    } else {
                        [6, 18, 32, 32]
                    }
                );
                assert!(!engine.segments.enabled);
                assert_eq!(engine.segments.base_qindex, if reduced { 28 } else { 32 });
                assert_eq!(engine.output(), expected, "layout={layout} frame={frame}");
            }
        }
        let neutral = [128, 128, 128, 255].repeat(16 * 16);
        let request = Request {
            quality: 60,
            ..engine_request(16, 16, 0, &neutral, 64)
        };
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, neutral, plan).unwrap());
        assert!(!engine.high_chroma_loss);
        assert_eq!(engine.deltas, crate::presets::deltas(60));
        assert_eq!(engine.segments.qindex_for(segmentation::FINE_SMOOTH), 6);
    }

    // Frozen synthetic V9 control. This input exposed a profile decision whose
    // source-YUV objective disagreed with completed visible RGB distortion.
    fn v9_chroma_edge() -> Vec<u8> {
        let mut pixels = Vec::with_capacity(407 * 277 * 4);
        for y in 0..277 {
            for x in 0..407 {
                let rgb = if ((13 * x + 5 * y) / 19) & 1 != 0 {
                    [221, 44, 184]
                } else {
                    [35, 207, 71]
                };
                pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        pixels
    }

    #[test]
    fn v9_chroma_edge_chooses_completed_rgb_profile_and_preserves_source() {
        let input = v9_chroma_edge();
        let request = Request {
            quality: 60,
            ..engine_request(407, 277, 0, &input, 407 * 4)
        };
        let plan = ResourcePlan::checked(request).unwrap();
        let mut engine = FrameEncoder::new(request, input.clone(), plan).unwrap();
        let mut metrics = Vec::new();
        let mut scores = Vec::new();
        let mut stage_ids = Vec::new();
        let mut source = None;
        let mut reduced_unfiltered = None;
        while engine.stage != Stage::Done {
            let previous = engine.stage;
            let before = engine.progress();
            if matches!(previous, Stage::PreviewFilter | Stage::PreviewRgbError) {
                stage_ids.push(engine.stage());
            }
            engine.step().unwrap();
            if previous == Stage::PreviewFilter && engine.stage == Stage::PreviewFilter {
                let after = engine.progress();
                assert!(after.0 > before.0 && after.0 - before.0 <= 1);
            }
            if previous == Stage::Classify && engine.stage == Stage::Analyze {
                source = Some((
                    engine.source_y.clone(),
                    engine.source_u.clone(),
                    engine.source_v.clone(),
                ));
            }
            if previous == Stage::PreviewRateBlocks
                && engine.preview_trial == PreviewTrial::Reduced
                && engine.stage == Stage::PreviewFilter
            {
                reduced_unfiltered = Some((
                    engine.reconstructed_y.clone(),
                    engine.reconstructed_u.clone(),
                    engine.reconstructed_v.clone(),
                    engine.blocks.clone(),
                ));
            }
            if previous == Stage::Analyze
                && engine.stage == Stage::CollectStats
                && engine.preview_trial == PreviewTrial::FinalReduced
            {
                let (y, u, v, blocks) = reduced_unfiltered.as_ref().unwrap();
                assert_eq!(&engine.reconstructed_y, y);
                assert_eq!(&engine.reconstructed_u, u);
                assert_eq!(&engine.reconstructed_v, v);
                assert_eq!(&engine.blocks, blocks);
            }
            if previous == Stage::PreviewRgbError {
                if engine.stage == Stage::PreviewRgbError {
                    let after = engine.progress();
                    assert_eq!(after.1, 407 * 277);
                    assert!(after.0 > before.0 && after.0 - before.0 <= 1_024);
                } else {
                    metrics.push((
                        engine.preview_comparison.visible_error,
                        engine.preview_comparison.weighted_rate,
                    ));
                    scores.push(
                        engine
                            .preview_comparison
                            .score(engine.preview_header_rate.cost, 32, 60)
                            .unwrap(),
                    );
                    let (y, u, v) = source.as_ref().unwrap();
                    assert_eq!(&engine.source_y, y);
                    assert_eq!(&engine.source_u, u);
                    assert_eq!(&engine.source_v, v);
                }
            }
            if engine.stage != Stage::Done {
                assert!(engine.output().is_empty());
            }
        }
        assert_eq!(metrics.len(), 2);
        stage_ids.sort_unstable();
        stage_ids.dedup();
        assert_eq!(stage_ids, [54, 55, 56, 57]);
        assert_eq!(metrics[0].0, 2_623_431_528);
        assert_eq!(metrics[1].0, 2_610_868_808);
        assert_eq!(scores, [710_750_621_568, 708_626_067_008]);
        assert_eq!(engine.preview_trial, PreviewTrial::FinalReduced);
        assert_eq!(engine.output().len(), 40_869);
        assert_eq!(
            engine.output(),
            encode_textured(&input, 407, 277, 407 * 4, 0, 60).unwrap()
        );
    }

    #[test]
    fn high_loss_profile_preview_selects_by_content_and_resets_before_final_analysis() {
        for (width, height) in [(3usize, 7usize), (373, 263)] {
            let mut input = Vec::with_capacity(width * height * 4);
            for y in 0..height {
                for x in 0..width {
                    let rgb = if width == 3 {
                        if (2 * x + y) % 3 == 0 {
                            [232, 34, 184]
                        } else if (x + 3 * y) & 1 == 1 {
                            [42, 201, 97]
                        } else {
                            [81, 53, 226]
                        }
                    } else if ((5 * x + 9 * y) / 13) & 1 == 1 {
                        [225, 42, 201]
                    } else {
                        [18, 231, 57]
                    };
                    input.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                }
            }
            let request = Request {
                quality: 60,
                ..engine_request(width, height, 0, &input, width * 4)
            };
            let plan = ResourcePlan::checked(request).unwrap();
            let mut engine = FrameEncoder::new(request, input.clone(), plan).unwrap();
            let mut preview_resets = 0;
            let mut reset_steps = 0;
            let mut original_unfiltered = None;
            while engine.stage != Stage::Done {
                let previous = engine.stage;
                let (before, _) = engine.progress();
                engine.step().unwrap();
                if previous == Stage::PreviewRateBlocks
                    && engine.preview_trial == PreviewTrial::Original
                    && engine.stage == Stage::PreviewFilter
                {
                    original_unfiltered = Some((
                        engine.reconstructed_y.clone(),
                        engine.reconstructed_u.clone(),
                        engine.reconstructed_v.clone(),
                        engine.blocks.clone(),
                    ));
                }
                if width == 3
                    && previous == Stage::Analyze
                    && engine.stage == Stage::CollectStats
                    && engine.preview_trial == PreviewTrial::FinalOriginal
                {
                    let (y, u, v, blocks) = original_unfiltered.as_ref().unwrap();
                    assert_eq!(&engine.reconstructed_y, y);
                    assert_eq!(&engine.reconstructed_u, u);
                    assert_eq!(&engine.reconstructed_v, v);
                    assert_eq!(&engine.blocks, blocks);
                }
                if previous == Stage::PreviewReset {
                    reset_steps += 1;
                    if engine.stage == Stage::PreviewReset {
                        let (after, _) = engine.progress();
                        assert!(after >= before && after - before <= 65_536);
                    }
                }
                if previous == Stage::PreviewResetMetadata && engine.stage == Stage::Analyze {
                    preview_resets += 1;
                    assert!(engine.reconstructed_y.iter().all(|&value| value == 0));
                    assert!(engine.reconstructed_u.iter().all(|&value| value == 0));
                    assert!(engine.reconstructed_v.iter().all(|&value| value == 0));
                    assert!(engine.blocks.iter().all(Macroblock::skip));
                }
                if engine.stage != Stage::Done {
                    assert!(engine.output().is_empty());
                }
            }
            assert!(engine.high_chroma_loss);
            assert_eq!(preview_resets, 2);
            assert!(reset_steps >= 8, "width={width} reset_steps={reset_steps}");
            let reduced = engine.preview_trial == PreviewTrial::FinalReduced;
            if width == 3 {
                assert!(!reduced);
            }
            assert!(matches!(
                engine.preview_trial,
                PreviewTrial::FinalOriginal | PreviewTrial::FinalReduced
            ));
            assert_eq!(
                engine.segments.qindex_for(segmentation::TEXTURED),
                if reduced { 28 } else { 32 }
            );
            assert_eq!(
                engine.output(),
                encode_textured(
                    &input,
                    width as u32,
                    height as u32,
                    (width * 4) as u32,
                    0,
                    60
                )
                .unwrap(),
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn q60_high_chroma_loss_decodes_independently() {
        let colors = [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255; 4],
        ];
        let mut input = Vec::new();
        for y in 0..16 {
            for x in 0..16 {
                input.extend_from_slice(&colors[(y % 2) * 2 + x % 2]);
            }
        }
        let request = Request {
            quality: 60,
            ..engine_request(16, 16, 0, &input, 64)
        };
        let plan = ResourcePlan::checked(request).unwrap();
        let engine = run_engine(FrameEncoder::new(request, input, plan).unwrap());
        assert!(matches!(
            engine.preview_trial,
            PreviewTrial::FinalReduced | PreviewTrial::FinalOriginal
        ));
        assert!(engine.neutral_chroma);
        assert_eq!(
            engine.segments.qindex_for(segmentation::TEXTURED),
            if engine.preview_trial == PreviewTrial::FinalReduced {
                30
            } else {
                34
            }
        );
        let (y, u, v, padded_width) = engine.reconstruction();
        let expected =
            filtered_visible_yuv(y, u, v, padded_width, 16, 16, &engine.blocks, engine.filter);
        assert_decodes(engine.output(), 16, 16, &expected, "q60 high chroma loss");
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
                false,
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
                true,
                false,
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
                None,
                false,
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
            assert_eq!(engine.skip_probability, Some(selected_probability));
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
                    for (position, row) in block.y.iter_mut().enumerate() {
                        row[position] = sign * magnitude;
                        if i16 {
                            row[0] = 0;
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

    fn decode_visible_yuv(frame: &[u8], width: usize, height: usize, decoder: &str) -> Vec<u8> {
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
        output.stdout
    }

    fn assert_decodes(frame: &[u8], width: usize, height: usize, expected: &[u8], label: &str) {
        for decoder in ["vp8", "libvpx"] {
            let decoded = decode_visible_yuv(frame, width, height, decoder);
            let difference = decoded.iter().zip(expected).position(|(a, b)| a != b);
            assert_eq!(decoded.len(), expected.len());
            assert!(
                difference.is_none(),
                "decoder={decoder} {width}x{height} {label} mismatch={difference:?} actual={:?} expected={:?}", difference.map(|i| &decoded[i..(i+8).min(expected.len())]), difference.map(|i| &expected[i..(i+8).min(expected.len())])
            );
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoders_reconstruct_an_asserted_uv_ac_drop() {
        let predictor = [128u8; 16];
        let deltas = Deltas::default();
        let steps = ac_quant::steps(23, deltas, Plane::UV);
        for plane in 0..2 {
            for sign in [-1, 1] {
                let mut original = [0i16; 16];
                original[0] = -2;
                original[residual::SCAN[3]] = 2;
                original[residual::SCAN[15]] = sign;
                let mut wanted = original;
                wanted[residual::SCAN[15]] = 0;
                let ideal = reconstructed_patch(&wanted, &predictor, steps);
                let (chosen, patch) = optimize_uv_block(
                    &ideal,
                    4,
                    0,
                    0,
                    &predictor,
                    steps,
                    0,
                    1,
                    (original, reconstructed_patch(&original, &predictor, steps)),
                );
                assert_eq!(
                    chosen, wanted,
                    "the independent oracle must exercise AC removal"
                );
                assert_ne!(chosen, original);
                let mut block = Macroblock {
                    i16: true,
                    ..Macroblock::default()
                };
                if plane == 0 {
                    block.u[0] = chosen;
                } else {
                    block.v[0] = chosen;
                }
                let frame = emit_segmented_frame(
                    &[block],
                    16,
                    16,
                    SegmentConfig::nonsegmented(23),
                    deltas,
                    FilterConfig::DISABLED,
                )
                .unwrap();
                let mut expected = vec![128u8; 16 * 16 + 2 * 8 * 8];
                for row in 0..4 {
                    let at = 16 * 16 + plane * 8 * 8 + row * 8;
                    expected[at..at + 4].copy_from_slice(&patch[row * 4..row * 4 + 4]);
                }
                assert_decodes(&frame, 16, 16, &expected, "asserted signed UV AC removal");
            }
        }
    }

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoders_reconstruct_an_asserted_flat_uv_dc_zero_choice() {
        let source = [129u8; 64];
        let reconstructed = [0u8; 64];
        let contexts = CoeffContexts::new(1);
        let deltas = crate::presets::deltas(75);
        let steps = ac_quant::steps(
            crate::presets::chromatic_flat_qindex(75) as u8,
            deltas,
            Plane::UV,
        );
        let baseline = make_uv(
            &source,
            &source,
            &reconstructed,
            &reconstructed,
            8,
            0,
            0,
            0,
            steps,
            None,
            false,
        );
        let chosen = make_uv(
            &source,
            &source,
            &reconstructed,
            &reconstructed,
            8,
            0,
            0,
            0,
            steps,
            Some(UvRdo {
                contexts: &contexts,
                mx: 0,
                lambda: 1,
                visible_width: 8,
                visible_height: 8,
                policy: UvRatePolicy::FlatDcZero,
            }),
            false,
        );
        assert_eq!(baseline.u[0][0], 1);
        assert_eq!(
            chosen.u[0], [0; 16],
            "the decode oracle must exercise DC removal"
        );
        assert_ne!(baseline.u[0], chosen.u[0]);
        let mut block = Macroblock {
            i16: true,
            segment_id: segmentation::CHROMATIC_FLAT,
            u: chosen.u,
            v: chosen.v,
            ..Macroblock::default()
        };
        block.v[1][0] = -2; // Keep coefficient/EOB context active after the zero U block.
        let patch = reconstructed_patch(&block.v[1], &[128; 16], steps);
        let frame = emit_segmented_frame(
            &[block],
            16,
            16,
            SegmentConfig::from_counts(75, [0, 1, 0, 0], 1, false),
            deltas,
            FilterConfig::DISABLED,
        )
        .unwrap();
        let mut expected = vec![128u8; 16 * 16 + 2 * 8 * 8];
        for row in 0..4 {
            let at = 16 * 16 + 8 * 8 + row * 8 + 4;
            expected[at..at + 4].copy_from_slice(&patch[row * 4..row * 4 + 4]);
        }
        assert_decodes(
            &frame,
            16,
            16,
            &expected,
            "asserted flat UV DC zero and EOB context",
        );
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
