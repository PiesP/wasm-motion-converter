// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{
    bmode_probs::BMODE_PROBS,
    display_rgb,
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

#[derive(Debug, Default, PartialEq, Eq)]
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
    visible_error: u64,
    refinement: Option<RefinementChange>,
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

const REFINEMENT_SLAB_LEN: usize = 256;
const _: () = assert!(std::mem::size_of::<RefinementEdit>() <= 12);

/// Bounded slabs avoid a frame-sized relocation during an ABI work unit.
#[derive(Default)]
struct RefinementLog {
    slabs: Vec<Vec<RefinementEdit>>,
    len: usize,
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

impl RefinementLog {
    fn reserve_one(&mut self, max_edits: usize) -> Result<(), Status> {
        if self.len >= max_edits {
            return Err(Status::MemoryAdmission);
        }
        if self.len == self.slabs.len() * REFINEMENT_SLAB_LEN {
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
    fn observe(&mut self, analyzed: &AnalyzedBlock) -> Result<(), EncodeError> {
        self.visible_error = self
            .visible_error
            .checked_add(analyzed.visible_error)
            .ok_or(EncodeError::OutputLimit)?;
        Ok(())
    }

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

fn visible_error<const N: usize, const LEN: usize>(
    source: &[u8],
    stride: usize,
    x: usize,
    y: usize,
    visible_width: usize,
    visible_height: usize,
    tile: &[u8; LEN],
) -> u64 {
    let mut result = 0u64;
    for row in 0..visible_height.saturating_sub(y).min(N) {
        for col in 0..visible_width.saturating_sub(x).min(N) {
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
#[derive(Clone, Copy)]
enum UvRatePolicy {
    TexturedAcTail,
    FlatDcZero,
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
        for by in 0..2 {
            for bx in 0..2 {
                let predictor = prediction_patch::<8, 64>(&predicted, bx, by);
                let baseline =
                    code_predicted_block(source, stride, x + bx * 4, y + by * 4, &predictor, steps);
                let (coeff, patch) = if let Some((rdo, lambda)) = rdo.and_then(|rdo| {
                    rdo.block_lambda(x + bx * 4, y + by * 4)
                        .map(|lambda| (rdo, lambda))
                }) {
                    let context = usize::from(local_above[bx]) + usize::from(local_left[by]);
                    match rdo.policy {
                        UvRatePolicy::TexturedAcTail => optimize_uv_block(
                            source,
                            stride,
                            x + bx * 4,
                            y + by * 4,
                            &predictor,
                            steps,
                            context,
                            lambda,
                            baseline,
                        ),
                        UvRatePolicy::FlatDcZero => optimize_uv_dc_zero(
                            source,
                            stride,
                            x + bx * 4,
                            y + by * 4,
                            &predictor,
                            context,
                            baseline,
                        ),
                    }
                } else {
                    baseline
                };
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
) -> Result<Option<RefinementChange>, EncodeError> {
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
        Some(RefinementChange {
            plane: plane as u8,
            patch: index as u8,
            coefficient: coefficient_index as u8,
            old,
            new: level,
        })
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
            if quality == 60 {
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
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let id = segmentation::classify(&source_y, &source_u, &source_v, padded_w, mx, my);
            class_counts[id as usize] += 1;
            segment_ids.push(id);
        }
    }
    let high_chroma_loss =
        crate::presets::high_chroma_loss(quality, rgb_error_sum, width as u32, height as u32);
    let original_segments =
        SegmentConfig::from_counts(quality, class_counts, count, neutral_chroma);
    let original_deltas = if high_chroma_loss {
        crate::presets::original_high_chroma_loss_deltas()
    } else {
        crate::presets::frame_deltas(quality, rgb_error_sum, width as u32, height as u32)
    };
    let mut coeff_contexts = CoeffContexts::new(blocks_x);
    let mut above_modes = vec![0u8; blocks_x * 4];
    let mut left_modes = [0u8; 4];
    let mut refinement_log = RefinementLog::default();
    let mut run_profile = |segments: SegmentConfig,
                           deltas: Deltas,
                           score_required: bool|
     -> Result<u64, EncodeError> {
        reconstructed_y.fill(0);
        reconstructed_u.fill(0);
        reconstructed_v.fill(0);
        blocks.clear();
        refinement_log = RefinementLog::default();
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
        for my in 0..blocks_y {
            coeff_contexts.row();
            left_modes.fill(0);
            for mx in 0..blocks_x {
                let segment_id = segment_ids[my * blocks_x + mx];
                let qindex = segments.qindex_for(segment_id);
                let y_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y1);
                let uv_steps = ac_quant::steps(qindex as u8, deltas, Plane::UV);
                let y2_steps = ac_quant::steps(qindex as u8, deltas, Plane::Y2);
                let lambda = crate::presets::lambda_for_quality(qindex, quality);
                if !high_chroma_loss {
                    refinement_log
                        .reserve_one(count)
                        .map_err(|_| EncodeError::OutputLimit)?;
                }
                let analyzed = analyze_one(
                    &source_y,
                    &source_u,
                    &source_v,
                    Some(display_rgb::Original {
                        pixels,
                        stride,
                        layout: format,
                    }),
                    high_chroma_loss,
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
                    score_required,
                    luma_policy,
                    segment_id,
                    segments,
                    &mut header_budget,
                )?;
                if score_required {
                    comparison.observe(&analyzed)?;
                }
                if let Some(change) = analyzed.refinement {
                    refinement_log
                        .push_reserved(RefinementEdit {
                            block: (my * blocks_x + mx) as u32,
                            change,
                        })
                        .map_err(|_| EncodeError::OutputLimit)?;
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
        comparison.score(
            estimated_profile_header_rate(segments, deltas, filter, &model, skip_probability)?,
            original_segments.base_qindex,
            quality,
        )
    };
    let mut segments = original_segments;
    let mut deltas = original_deltas;
    if high_chroma_loss {
        let original_score = run_profile(original_segments, original_deltas, true)?;
        let reduced_segments = original_segments.with_high_chroma_loss_luma(true);
        let reduced_deltas =
            crate::presets::frame_deltas(quality, rgb_error_sum, width as u32, height as u32);
        let reduced_score = run_profile(reduced_segments, reduced_deltas, true)?;
        if reduced_profile_wins(original_score, reduced_score) {
            segments = reduced_segments;
            deltas = reduced_deltas;
        } else {
            run_profile(original_segments, original_deltas, false)?;
        }
    } else {
        run_profile(original_segments, original_deltas, false)?;
    }
    drop(run_profile);
    if !refinement_log.is_empty() {
        let refined_sizes =
            count_frozen_variant(&blocks, blocks_x, blocks_y, segments, deltas, filter)?.sizes;
        for index in (0..refinement_log.len).rev() {
            replay_edit_state(
                &mut blocks,
                &mut reconstructed_u,
                &mut reconstructed_v,
                padded_w,
                segments,
                deltas,
                refinement_log.get(index).ok_or(EncodeError::InvalidInput)?,
                false,
            )
            .map_err(|_| EncodeError::InvalidInput)?;
        }
        let base_sizes =
            count_frozen_variant(&blocks, blocks_x, blocks_y, segments, deltas, filter)?.sizes;
        let refined_total = 10 + refined_sizes.0 + refined_sizes.1;
        let base_total = 10 + base_sizes.0 + base_sizes.1;
        if refined_sizes.0 <= 0x7ffff
            && refined_total <= MAX_OUTPUT_BYTES
            && (base_sizes.0 > 0x7ffff
                || base_total > MAX_OUTPUT_BYTES
                || refined_total <= base_total)
        {
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
    score_visible: bool,
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
    let uv_policy = match (quality, segment_id) {
        (60, segmentation::TEXTURED) => Some(UvRatePolicy::TexturedAcTail),
        (75, segmentation::CHROMATIC_FLAT) => Some(UvRatePolicy::FlatDcZero),
        _ => None,
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
                uv_policy.map(|policy| UvRdo {
                    contexts: coeff_contexts,
                    mx,
                    lambda,
                    visible_width: visible_width.div_ceil(2),
                    visible_height: visible_height.div_ceil(2),
                    policy,
                }),
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
    if !high_chroma_loss {
        if let Some(original) = original_rgb {
            refinement = refine_selected_uv(
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
        }
    }
    let visible_uv_width = visible_width.div_ceil(2);
    let visible_uv_height = visible_height.div_ceil(2);
    let visible_error = if score_visible {
        visible_error::<16, 256>(
            source_y,
            padded_w,
            x,
            y,
            visible_width,
            visible_height,
            &selected_luma.tile,
        ) + visible_error::<8, 64>(
            source_u,
            uv_w,
            mx * 8,
            my * 8,
            visible_uv_width,
            visible_uv_height,
            &selected_uv.u_tile,
        ) + visible_error::<8, 64>(
            source_v,
            uv_w,
            mx * 8,
            my * 8,
            visible_uv_width,
            visible_uv_height,
            &selected_uv.v_tile,
        )
    } else {
        0
    };
    header_budget.commit(&block, mx, above_modes, left_modes, segments)?;
    commit_tile::<16, 256>(reconstructed_y, padded_w, x, y, &selected_luma.tile);
    commit_tile::<8, 64>(reconstructed_u, uv_w, mx * 8, my * 8, &selected_uv.u_tile);
    commit_tile::<8, 64>(reconstructed_v, uv_w, mx * 8, my * 8, &selected_uv.v_tile);
    coeff_contexts.encode_coefficients(&mut RateCounter::default(), &block, mx)?;
    update_modes(&block, mx, above_modes, left_modes);
    Ok(AnalyzedBlock {
        block,
        visible_error,
        refinement,
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
    ReverseRefinements = 27,
    ReapplyRefinements = 28,
    ReleaseRefinements = 35,
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
}

fn choose_refined_variant(
    refined_bytes: u32,
    refined_legality: Result<(), Status>,
    base_bytes: u32,
    base_legality: Result<(), Status>,
) -> Result<bool, Status> {
    for legality in [refined_legality, base_legality] {
        if let Err(error) = legality {
            if !matches!(error, Status::OutputLimit | Status::PartitionLimit) {
                return Err(error);
            }
        }
    }
    match (refined_legality, base_legality) {
        (Ok(()), Ok(())) => Ok(refined_bytes <= base_bytes),
        (Ok(()), Err(_)) => Ok(true),
        (Err(_), Ok(())) => Ok(false),
        (Err(_), Err(error)) => Err(error),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PreviewTrial {
    None,
    Original,
    Reduced,
    FinalOriginal,
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
    refinement_log: RefinementLog,
    refined_checkpoint: Option<RefinedCheckpoint>,
    base_count: bool,
    replay_index: usize,
    pending_output_sizes: Option<(u32, u32)>,
    #[cfg(test)]
    disable_refinement: bool,
    class_counts: [usize; 4],
    neutral_chroma: bool,
    rgb_error_sum: u64,
    high_chroma_loss: bool,
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
        + 2 * crate::rate::MAX_BUFFERED_OPS * 2
        + 65_536
        + std::mem::size_of::<FrameEncoder>()
        + 1024 * 1024
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
            refined_checkpoint: None,
            base_count: false,
            replay_index: 0,
            pending_output_sizes: None,
            #[cfg(test)]
            disable_refinement: false,
            class_counts: [0; 4],
            neutral_chroma: true,
            rgb_error_sum: 0,
            high_chroma_loss: false,
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
            Stage::ReverseRefinements => (
                (self.refinement_log.len - self.replay_index) as u32,
                self.refinement_log.len as u32,
            ),
            Stage::ReapplyRefinements => (self.replay_index as u32, self.refinement_log.len as u32),
            Stage::ReleaseRefinements => (
                (self.refinement_log.len.div_ceil(REFINEMENT_SLAB_LEN)
                    - self.refinement_log.slabs.len()) as u32,
                self.refinement_log.len.div_ceil(REFINEMENT_SLAB_LEN) as u32,
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
            if self.request.quality == 60 {
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

    fn replay_one_refinement(&mut self, forward: bool) -> Result<(), Status> {
        let index = if forward {
            self.replay_index
        } else {
            self.replay_index
                .checked_sub(1)
                .ok_or(Status::InvalidInput)?
        };
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
        )?;
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
                    self.reset_coding_state();
                    self.stage = Stage::CountPrefix;
                } else {
                    self.segments = original;
                    self.deltas = crate::presets::original_high_chroma_loss_deltas();
                    self.preview_trial = PreviewTrial::FinalOriginal;
                    self.begin_preview_reset();
                }
            }
            _ => return Err(Status::InvalidInput),
        }
        Ok(())
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
        let lambda = crate::presets::lambda_for_quality(qindex, self.request.quality);
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
                .reserve_one(self.plan.macroblock_count as usize)?;
        }
        let analyzed = analyze_one(
            &self.source_y,
            &self.source_u,
            &self.source_v,
            original_rgb,
            self.high_chroma_loss,
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
            matches!(
                self.preview_trial,
                PreviewTrial::Original | PreviewTrial::Reduced
            ),
            0,
            segment_id,
            self.segments,
            &mut self.header_budget,
        )
        .map_err(encode_status)?;
        if matches!(
            self.preview_trial,
            PreviewTrial::Original | PreviewTrial::Reduced
        ) {
            self.preview_comparison
                .observe(&analyzed)
                .map_err(encode_status)?;
        }
        if let Some(change) = analyzed.refinement {
            self.refinement_log.push_reserved(RefinementEdit {
                block: self.cursor as u32,
                change,
            })?;
        }
        self.blocks[self.cursor] = analyzed.block;
        self.cursor += 1;
        if self.cursor == self.plan.macroblock_count as usize {
            if self.refinement_log.is_empty() {
                self.refinement_log = RefinementLog::default();
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
            self.finish_preview()?;
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
                if self.refinement_log.is_empty() {
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
                    });
                    self.replay_index = self.refinement_log.len;
                    self.stage = Stage::ReverseRefinements;
                } else {
                    let base_legality = match self.plan.with_output_sizes(first, second) {
                        Ok(_) => Ok(()),
                        Err(error @ (Status::PartitionLimit | Status::OutputLimit)) => Err(error),
                        Err(error) => return Err(error),
                    };
                    self.pending_output_sizes = Some((first, second));
                    let refined = self
                        .refined_checkpoint
                        .as_ref()
                        .ok_or(Status::InvalidInput)?;
                    let choose_refined = choose_refined_variant(
                        refined.selected_frame_bytes,
                        refined.legality,
                        self.selected_frame_bytes,
                        base_legality,
                    )?;
                    if choose_refined {
                        self.stage = Stage::ReapplyRefinements;
                        self.replay_index = 0;
                    } else {
                        self.refined_checkpoint = None;
                        self.stage = Stage::ReleaseRefinements;
                    }
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
            Stage::ReverseRefinements => {
                self.replay_one_refinement(false)?;
                if self.replay_index == 0 {
                    self.reset_variant_count();
                    self.base_count = true;
                    self.stage = Stage::CollectStats;
                }
            }
            Stage::ReapplyRefinements => {
                self.replay_one_refinement(true)?;
                if self.replay_index == self.refinement_log.len {
                    let refined = self.refined_checkpoint.take().ok_or(Status::InvalidInput)?;
                    if refined.legality.is_err() {
                        return Err(Status::InvalidInput);
                    }
                    self.model.restore_emission(&refined.emission);
                    self.skip_probability = refined.skip_probability;
                    self.default_frame_bytes = refined.default_frame_bytes;
                    self.selected_frame_bytes = refined.selected_frame_bytes;
                    self.update_count = refined.update_count;
                    self.use_model = refined.use_model;
                    self.pending_output_sizes = Some(refined.sizes);
                    self.reset_coding_state();
                    self.stage = Stage::ReleaseRefinements;
                }
            }
            Stage::ReleaseRefinements => {
                self.refinement_log
                    .slabs
                    .pop()
                    .ok_or(Status::InvalidInput)?;
                if self.refinement_log.slabs.is_empty() {
                    self.refinement_log = RefinementLog::default();
                    let (first, second) = self
                        .pending_output_sizes
                        .take()
                        .ok_or(Status::InvalidInput)?;
                    self.plan = self.plan.with_output_sizes(first, second)?;
                    self.stage = Stage::PrepareOutput;
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
    fn exact_variant_choice_prefers_legal_smaller_or_tied_refinement() {
        assert_eq!(choose_refined_variant(100, Ok(()), 100, Ok(())), Ok(true));
        assert_eq!(choose_refined_variant(101, Ok(()), 100, Ok(())), Ok(false));
        assert_eq!(choose_refined_variant(99, Ok(()), 100, Ok(())), Ok(true));
        assert_eq!(
            choose_refined_variant(100, Ok(()), 99, Err(Status::OutputLimit)),
            Ok(true)
        );
        assert_eq!(
            choose_refined_variant(99, Err(Status::PartitionLimit), 100, Ok(())),
            Ok(false)
        );
        assert_eq!(
            choose_refined_variant(
                99,
                Err(Status::OutputLimit),
                100,
                Err(Status::PartitionLimit)
            ),
            Err(Status::PartitionLimit)
        );
        assert_eq!(
            choose_refined_variant(99, Err(Status::MemoryAdmission), 100, Ok(())),
            Err(Status::MemoryAdmission)
        );
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
        for block in 0..plan.macroblock_count {
            log.reserve_one(plan.macroblock_count as usize).unwrap();
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
        assert_eq!(log.len, 40_280);
        assert!(log.capacity_bytes() <= REFINEMENT_LOG_BUDGET_BYTES);
        assert_eq!(log.slabs.len(), 40_280usize.div_ceil(REFINEMENT_SLAB_LEN));
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
            let expected_refined = choose_refined_variant(
                refined_bytes,
                refined_legality,
                selected.selected_frame_bytes,
                base_legality,
            )
            .unwrap();
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
                    false,
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
                    false,
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
                assert!(changed_coefficients <= 1);
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
        assert_eq!(chosen.unwrap().new, 2);
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
    fn preview_comparison_uses_visible_support_and_strict_improvement() {
        assert!(!reduced_profile_wins(7, 7));
        assert!(!reduced_profile_wins(7, 8));
        assert!(reduced_profile_wins(7, 6));

        let source_y = [0u8; 256];
        let mut tile_y = [0u8; 256];
        tile_y[15 * 16 + 15] = 255;
        assert_eq!(
            visible_error::<16, 256>(&source_y, 16, 0, 0, 3, 7, &tile_y),
            0
        );
        tile_y[6 * 16 + 2] = 3;
        assert_eq!(
            visible_error::<16, 256>(&source_y, 16, 0, 0, 3, 7, &tile_y),
            9
        );

        let source_uv = [0u8; 64];
        let mut tile_uv = [0u8; 64];
        tile_uv[4 * 8 + 1] = 255;
        assert_eq!(
            visible_error::<8, 64>(&source_uv, 8, 0, 0, 2, 4, &tile_uv),
            0
        );
        tile_uv[3 * 8 + 1] = 2;
        assert_eq!(
            visible_error::<8, 64>(&source_uv, 8, 0, 0, 2, 4, &tile_uv),
            4
        );

        let analyzed = AnalyzedBlock {
            block: Macroblock::default(),
            visible_error: 9,
            refinement: None,
        };
        let mut comparison = ProfileComparison::default();
        comparison.observe(&analyzed).unwrap();
        comparison.add_rate(10, 32, 60).unwrap();
        assert_eq!(comparison.score(7, 32, 60).unwrap(), 9 * 256 + 17 * 480);
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
                        for i in 0..4 {
                            contexts.y[i] = flag(i + 1);
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
                    false,
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
                let reduced = engine.preview_trial == PreviewTrial::Reduced;
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

    #[test]
    fn high_loss_profile_preview_selects_by_content_and_resets_before_final_analysis() {
        for (width, height, reduced) in [(3usize, 7usize, false), (373, 263, true)] {
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
            while engine.stage != Stage::Done {
                let previous = engine.stage;
                let (before, _) = engine.progress();
                engine.step().unwrap();
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
            assert_eq!(preview_resets, if reduced { 1 } else { 2 });
            assert!(reset_steps >= 8, "width={width} reset_steps={reset_steps}");
            assert_eq!(engine.preview_trial == PreviewTrial::Reduced, reduced);
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
            PreviewTrial::Reduced | PreviewTrial::FinalOriginal
        ));
        assert!(engine.neutral_chroma);
        assert_eq!(
            engine.segments.qindex_for(segmentation::TEXTURED),
            if engine.preview_trial == PreviewTrial::Reduced {
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
                None,
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
        let steps = ac_quant::steps(19, deltas, Plane::UV);
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
