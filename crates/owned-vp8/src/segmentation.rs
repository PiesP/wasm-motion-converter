// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Four absolute VP8 quantizer segments. Bit syntax follows RFC 6386 section 9.3
// and the reference decoder's SEGMENT_ABSDATA=1 definition.

use crate::{
    ac_quant::{steps, Deltas, Plane},
    presets,
    rate::{BoolSink, RateCounter},
    EncodeError,
};

pub(crate) const FINE_SMOOTH: u8 = 0;
pub(crate) const CHROMATIC_FLAT: u8 = 1;
pub(crate) const CHROMATIC_RAMP: u8 = 2;
pub(crate) const TEXTURED: u8 = 3;
pub(crate) const CURVATURE_CUTOFF: u64 = 2;
const Y_DIFFERENCES_PER_BLOCK: u64 = 448;
const UV_DIFFERENCES_PER_BLOCK: u64 = 96;
// Existing absolute size allowance, in RateCounter units of 1/256 bit.
const MAP_RATE_ALLOWANCE: u64 = 128 * 8 * 256;

pub(crate) fn smooth_pair_only(counts: [usize; 4]) -> bool {
    counts[FINE_SMOOTH as usize] > 0
        && counts[CHROMATIC_FLAT as usize] > 0
        && counts[CHROMATIC_RAMP as usize] == 0
        && counts[TEXTURED as usize] == 0
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(crate) struct CurvatureTotals {
    pub sums: [u64; 3],
}

impl CurvatureTotals {
    pub(crate) fn within_cutoff(self, blocks: usize) -> bool {
        let blocks = blocks as u64;
        blocks > 0
            && self.sums[0] <= CURVATURE_CUTOFF * Y_DIFFERENCES_PER_BLOCK * blocks
            && self.sums[1] <= CURVATURE_CUTOFF * UV_DIFFERENCES_PER_BLOCK * blocks
            && self.sums[2] <= CURVATURE_CUTOFF * UV_DIFFERENCES_PER_BLOCK * blocks
    }

    pub(crate) fn only_chroma_exceeds_cutoff(self, blocks: usize) -> bool {
        blocks > 0
            && self.sums[0] <= CURVATURE_CUTOFF * Y_DIFFERENCES_PER_BLOCK * blocks as u64
            && !self.within_cutoff(blocks)
    }

    pub(crate) fn only_luma_exceeds_cutoff(self, blocks: usize) -> bool {
        let blocks = blocks as u64;
        self.sums[0] > CURVATURE_CUTOFF * Y_DIFFERENCES_PER_BLOCK * blocks
            && self.sums[1].max(self.sums[2])
                <= CURVATURE_CUTOFF * UV_DIFFERENCES_PER_BLOCK * blocks
            && blocks > 0
    }

    pub(crate) fn luma_dominates(self) -> bool {
        let [y, u, v] = self.sums;
        // All planes use the same number of macroblocks. Compare their means
        // exactly after canceling that count, without rounding near equality.
        u128::from(u.max(v)) * u128::from(Y_DIFFERENCES_PER_BLOCK)
            <= u128::from(y) * u128::from(UV_DIFFERENCES_PER_BLOCK)
    }

    pub(crate) fn one_chroma_plane_leads_rough_luma(self, blocks: usize) -> bool {
        let blocks = blocks as u64;
        let [y, u, v] = self.sums;
        let chroma_cutoff = CURVATURE_CUTOFF * UV_DIFFERENCES_PER_BLOCK * blocks;
        blocks > 0
            && y > CURVATURE_CUTOFF * Y_DIFFERENCES_PER_BLOCK * blocks
            && u.min(v) <= chroma_cutoff
            && !self.luma_dominates()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub enabled: bool,
    pub base_qindex: usize,
    pub qindex: [usize; 4],
    pub map_probabilities: [u8; 3],
    active: [bool; 4],
    alias_textured_to_ramp: bool,
    pub neutral_smooth_grid: bool,
}

impl Config {
    pub(crate) fn nonsegmented(qindex: usize) -> Self {
        Self {
            enabled: false,
            base_qindex: qindex,
            qindex: [qindex; 4],
            map_probabilities: [255; 3],
            active: [false; 4],
            neutral_smooth_grid: false,
            alias_textured_to_ramp: false,
        }
    }

    pub(crate) fn from_counts(
        quality: u32,
        counts: [usize; 4],
        total: usize,
        neutral_chroma: bool,
    ) -> Self {
        Self::from_frame_counts(quality, counts, total, neutral_chroma, false)
    }

    pub(crate) fn from_frame_counts(
        quality: u32,
        counts: [usize; 4],
        total: usize,
        neutral_chroma: bool,
        near_neutral_smooth: bool,
    ) -> Self {
        debug_assert_eq!(counts.iter().sum::<usize>(), total);
        let mut qindex = class_qindices(quality, neutral_chroma);
        let [fine, flat, ramp, _] = counts;
        let neutral_smooth_grid = near_neutral_smooth && fine > 0 && flat == 0 && ramp == 0;
        if neutral_smooth_grid {
            // Apply the midpoint to the fine class. Mixed maps keep both luma mode families.
            let index = FINE_SMOOTH as usize;
            qindex[index] = (qindex[index] + presets::textured_qindex(quality, true)).div_ceil(2);
        }
        let enabled = counts.iter().filter(|&&count| count > 0).count() > 1;
        let base_qindex = qindex[counts.iter().position(|&count| count > 0).unwrap_or(3)];
        let map_probabilities = if enabled {
            Self::map_probabilities(counts, total)
        } else {
            [255; 3]
        };
        Self {
            enabled,
            base_qindex,
            qindex,
            map_probabilities,
            active: counts.map(|count| count > 0),
            neutral_smooth_grid,
            alias_textured_to_ramp: false,
        }
    }

    fn map_probabilities(counts: [usize; 4], total: usize) -> [u8; 3] {
        let probability = |numerator: usize, denominator: usize| {
            (numerator * 256 + denominator / 2)
                .checked_div(denominator)
                .unwrap_or(255)
                .clamp(1, 255) as u8
        };
        [
            probability(counts[0] + counts[1], total),
            probability(counts[0], counts[0] + counts[1]),
            probability(counts[2], counts[2] + counts[3]),
        ]
    }

    pub(crate) fn mixed_q60_wire_alias(
        self,
        mut counts: [usize; 4],
        selected: bool,
    ) -> Option<Self> {
        let ramp = CHROMATIC_RAMP as usize;
        let textured = TEXTURED as usize;
        if !selected
            || !self.enabled
            || !self.active[ramp]
            || !self.active[textured]
            || self.qindex[ramp] != self.qindex[textured]
        {
            return None;
        }
        // Both occupied classes already receive the same absolute filter level.
        // Map only the wire ID. The source class and its rate rules stay intact.
        counts[ramp] += counts[textured];
        counts[textured] = 0;
        let mut active = self.active;
        active[textured] = false;
        Some(Self {
            map_probabilities: Self::map_probabilities(counts, counts.iter().sum()),
            active,
            alias_textured_to_ramp: true,
            ..self
        })
    }

    pub(crate) fn qindex_for(self, id: u8) -> usize {
        self.qindex[id as usize]
    }

    pub(crate) fn with_high_chroma_loss_luma(mut self, high_loss: bool) -> Self {
        if high_loss {
            let reduction = presets::HIGH_CHROMA_LOSS_QINDEX_REDUCTION;
            self.base_qindex = self
                .base_qindex
                .checked_sub(reduction)
                .expect("q60 base preset is at least four");
            self.qindex = self.qindex.map(|qindex| {
                qindex
                    .checked_sub(reduction)
                    .expect("q60 segment presets are at least four")
            });
        }
        self
    }

    pub(crate) fn with_medium_textured_luma(mut self, selected: bool) -> Self {
        if selected {
            let reduction = presets::medium_luma_reduction();
            self.base_qindex -= reduction;
            self.qindex = self.qindex.map(|qindex| qindex - reduction);
        }
        self
    }

    pub(crate) fn with_photo_q60_rebase(mut self, selected: bool) -> Self {
        if selected {
            self.base_qindex = self
                .base_qindex
                .checked_sub(4)
                .expect("q60 base preset is at least four");
            self.qindex = self.qindex.map(|qindex| {
                qindex
                    .checked_sub(4)
                    .expect("q60 segment presets are at least four")
            });
        }
        self
    }

    fn with_raised_qindices(mut self) -> Self {
        self.base_qindex += presets::MIXED_Y1_AC_QINDEX_INCREASE;
        self.qindex = self
            .qindex
            .map(|qindex| qindex + presets::MIXED_Y1_AC_QINDEX_INCREASE);
        self
    }

    pub(crate) fn with_mixed_q60_allocation(self, counts: [usize; 4], selected: bool) -> Self {
        if !selected {
            return self;
        }
        let raised = self.with_raised_qindices();
        if smooth_pair_only(counts) || raised.map_exceeds_rate_allowance(counts) {
            raised.with_uniform_qindex(counts, presets::chromatic_ramp_qindex(60))
        } else {
            raised
        }
    }

    pub(crate) fn with_mixed_q75_allocation(self, counts: [usize; 4]) -> Self {
        self.with_raised_qindices()
            .with_uniform_qindex(counts, presets::chromatic_ramp_qindex(75))
    }

    pub(crate) fn with_q85_smooth_pair_allocation(
        self,
        counts: [usize; 4],
        deltas: Deltas,
    ) -> Self {
        let [fine, flat, ramp, textured] = counts;
        debug_assert!(fine > 0 && flat > 0 && ramp == 0 && textured == 0);
        let total = fine + flat;
        debug_assert!(total <= 1024 * 1024);
        let fine_qindex = self.qindex_for(FINE_SMOOTH);
        let flat_qindex = self.qindex_for(CHROMATIC_FLAT);
        debug_assert!(fine_qindex <= 127 && flat_qindex <= 127);
        // Each admitted VP8 axis has at most 1024 macroblocks. Even with
        // the largest legal indices, the weighted sum plus half the count
        // is below 2^27 and fits wasm32 usize.
        let weighted = fine * fine_qindex + flat * flat_qindex;
        let mean = (weighted + total / 2) / total;
        let uv_dc_step = |qindex: usize| steps(qindex as u8, deltas, Plane::UV).dc;
        let initial = uv_dc_step(mean);
        let finest = fine_qindex.min(flat_qindex);
        let coarsest = fine_qindex.max(flat_qindex);
        let shares_step = (mean > finest && uv_dc_step(mean - 1) == initial)
            || (mean < coarsest && uv_dc_step(mean + 1) == initial);
        // Keep an unambiguous rounded index. Treat every member of a repeated
        // DC step alike so selection stays monotonic across the plateau.
        let selected = if shares_step {
            (mean + 1..=coarsest)
                .find(|&qindex| uv_dc_step(qindex) > initial)
                .unwrap_or(mean)
        } else {
            mean
        };
        Self::nonsegmented(selected)
    }

    pub(crate) fn map_exceeds_rate_allowance(self, counts: [usize; 4]) -> bool {
        self.enabled && self.map_rate_cost(counts) > MAP_RATE_ALLOWANCE
    }

    fn map_rate_cost(self, counts: [usize; 4]) -> u64 {
        let mut cost = 0;
        for (id, count) in counts.into_iter().enumerate() {
            if count == 0 {
                continue;
            }
            let mut rate = RateCounter::default();
            self.write_id(&mut rate, id as u8)
                .expect("four class counts have valid segment IDs");
            // The VP8 axis limit permits at most 1024² macroblocks. A
            // two-symbol class path uses at most 8192 cost units.
            cost += rate.cost * count as u64;
        }
        cost
    }

    pub(crate) fn with_uniform_qindex(self, counts: [usize; 4], minimum_qindex: usize) -> Self {
        let mut weighted_indices =
            std::array::from_fn::<_, 4, _>(|id| (self.qindex[id], counts[id]));
        weighted_indices.sort_unstable_by_key(|&(qindex, _)| qindex);
        // Equal qindices contribute the same result regardless of their order.
        // This one-based rank chooses the lower weighted median for even totals.
        let midpoint = counts.into_iter().sum::<usize>().div_ceil(2);
        debug_assert!(midpoint > 0);
        let mut cumulative = 0;
        for (qindex, count) in weighted_indices {
            cumulative += count;
            if cumulative >= midpoint {
                return Self::nonsegmented(qindex.max(minimum_qindex));
            }
        }
        unreachable!("weighted rank must fall within classified macroblocks");
    }

    pub(crate) fn write_header(
        self,
        sink: &mut impl BoolSink,
        filter_level: u8,
    ) -> Result<(), EncodeError> {
        if filter_level > 63 {
            return Err(EncodeError::InvalidInput);
        }
        sink.bit(self.enabled)?;
        if !self.enabled {
            return Ok(());
        }
        sink.bit(true)?; // Fresh keyframe segmentation map.
        sink.bit(true)?; // Fresh segment feature data.
        sink.bit(true)?; // Absolute quantizer values (SEGMENT_ABSDATA).
        for (id, &qindex) in self.qindex.iter().enumerate() {
            let write_quantizer = !(self.alias_textured_to_ramp && id == TEXTURED as usize);
            sink.bit(write_quantizer)?;
            if write_quantizer {
                sink.literal(qindex as u32, 7)?;
                sink.bit(false)?; // Positive value.
            }
        }
        // Absolute segmentation replaces the frame's filter level. Signal
        // the same level for each active ID, leaving unused IDs at zero.
        for &segment_active in &self.active {
            let active = segment_active && filter_level > 0;
            sink.bit(active)?;
            if active {
                sink.literal(u32::from(filter_level), 6)?;
                sink.bit(false)?; // Positive absolute value.
            }
        }
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[0]), 8)?; // IDs 0/1 versus 2/3.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[1]), 8)?; // IDs 0 versus 1.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[2]), 8)?; // IDs 2 versus 3.
        Ok(())
    }

    pub(crate) fn write_id(self, sink: &mut impl BoolSink, id: u8) -> Result<(), EncodeError> {
        if self.enabled {
            if id > TEXTURED {
                return Err(EncodeError::InvalidInput);
            }
            let id = if self.alias_textured_to_ramp && id == TEXTURED {
                CHROMATIC_RAMP
            } else {
                id
            };
            sink.write(self.map_probabilities[0], id >= CHROMATIC_RAMP)?;
            if id >= CHROMATIC_RAMP {
                sink.write(self.map_probabilities[2], id == TEXTURED)?;
            } else {
                sink.write(self.map_probabilities[1], id == CHROMATIC_FLAT)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn class_qindices(quality: u32, neutral_chroma: bool) -> [usize; 4] {
    [
        presets::smooth_qindex(quality),
        presets::chromatic_flat_qindex(quality),
        presets::chromatic_ramp_qindex(quality),
        presets::textured_qindex(quality, neutral_chroma),
    ]
}

/// Curvature selects smooth tiles. Chroma neutrality or three constant planes
/// select the finest class; otherwise range separates flat colors from ramps. Tile
/// boundaries are excluded so padding cannot create edges.
#[cfg(test)]
pub(crate) fn classify(y: &[u8], u: &[u8], v: &[u8], y_stride: usize, mx: usize, my: usize) -> u8 {
    classify_with_curvature(y, u, v, y_stride, mx, my, None)
}

pub(crate) fn classify_with_curvature(
    y: &[u8],
    u: &[u8],
    v: &[u8],
    y_stride: usize,
    mx: usize,
    my: usize,
    totals: Option<&mut CurvatureTotals>,
) -> u8 {
    fn smooth_tile(
        plane: &[u8],
        stride: usize,
        x: usize,
        y: usize,
        size: usize,
        sum: Option<&mut u64>,
    ) -> bool {
        let mut tile_sum = 0u64;
        let mut smooth = true;
        for row in 0..size {
            for col in 1..size - 1 {
                let at = (y + row) * stride + x + col;
                let curvature =
                    i32::from(plane[at - 1]) - 2 * i32::from(plane[at]) + i32::from(plane[at + 1]);
                if curvature.unsigned_abs() as u64 > CURVATURE_CUTOFF {
                    smooth = false;
                    if sum.is_none() {
                        return false;
                    }
                }
                tile_sum += u64::from(curvature.unsigned_abs());
            }
        }
        for row in 1..size - 1 {
            for col in 0..size {
                let at = (y + row) * stride + x + col;
                let curvature = i32::from(plane[at - stride]) - 2 * i32::from(plane[at])
                    + i32::from(plane[at + stride]);
                if curvature.unsigned_abs() as u64 > CURVATURE_CUTOFF {
                    smooth = false;
                    if sum.is_none() {
                        return false;
                    }
                }
                tile_sum += u64::from(curvature.unsigned_abs());
            }
        }
        if let Some(sum) = sum {
            // At most 448 terms for Y or 96 for U/V, each at most 510.
            // The owned path's MAX_DIMENSION=16,383 bounds a frame to
            // 1,024^2 macroblocks, keeping each u64 frame sum below 2^38.
            *sum += tile_sum;
        }
        smooth
    }
    fn tile_range(plane: &[u8], stride: usize, x: usize, y: usize, size: usize) -> u8 {
        let mut minimum = u8::MAX;
        let mut maximum = u8::MIN;
        for row in 0..size {
            for col in 0..size {
                let value = plane[(y + row) * stride + x + col];
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
        }
        maximum - minimum
    }
    let mut sums = [0u64; 3];
    let collecting = totals.is_some();
    let y_smooth = smooth_tile(
        y,
        y_stride,
        mx * 16,
        my * 16,
        16,
        collecting.then_some(&mut sums[0]),
    );
    let u_smooth = if collecting || y_smooth {
        smooth_tile(
            u,
            y_stride / 2,
            mx * 8,
            my * 8,
            8,
            collecting.then_some(&mut sums[1]),
        )
    } else {
        false
    };
    let v_smooth = if collecting || (y_smooth && u_smooth) {
        smooth_tile(
            v,
            y_stride / 2,
            mx * 8,
            my * 8,
            8,
            collecting.then_some(&mut sums[2]),
        )
    } else {
        false
    };
    if let Some(totals) = totals {
        for (frame, tile) in totals.sums.iter_mut().zip(sums) {
            *frame += tile;
        }
    }
    if y_smooth && u_smooth && v_smooth {
        let uv_stride = y_stride / 2;
        let mut neutral = true;
        'chroma: for row in 0..8 {
            for col in 0..8 {
                let at = (my * 8 + row) * uv_stride + mx * 8 + col;
                if u[at].abs_diff(128) > 1 || v[at].abs_diff(128) > 1 {
                    neutral = false;
                    break 'chroma;
                }
            }
        }
        if neutral {
            FINE_SMOOTH
        } else {
            let ranges = [
                tile_range(y, y_stride, mx * 16, my * 16, 16),
                tile_range(u, uv_stride, mx * 8, my * 8, 8),
                tile_range(v, uv_stride, mx * 8, my * 8, 8),
            ];
            if ranges == [0; 3] {
                FINE_SMOOTH
            } else if ranges.iter().all(|&range| range <= 1) {
                CHROMATIC_FLAT
            } else {
                CHROMATIC_RAMP
            }
        }
    } else {
        TEXTURED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_q60_uniform_floors_the_weighted_lower_median_at_the_ramp_index() {
        let original = Config::from_counts(60, [1, 1, 1, 1], 4, false);
        assert_eq!(original.base_qindex, 6);
        assert_eq!(original.qindex, [6, 18, 32, 32]);
        let shifted = original.with_mixed_q60_allocation([1, 1, 1, 1], true);
        assert!(shifted.enabled);
        assert_eq!(shifted.base_qindex, 10);
        assert_eq!(shifted.qindex, [10, 22, 36, 36]);
        let ramp = presets::chromatic_ramp_qindex(60);
        for (counts, qindex) in [
            ([1, 1, 1, 1], ramp),
            ([3, 0, 3, 0], ramp),
            ([0, 3, 1, 1], ramp),
            ([1, 2, 2, 2], 36),
        ] {
            let selected = shifted.with_uniform_qindex(counts, ramp);
            assert!(!selected.enabled);
            assert_eq!(selected.base_qindex, qindex);
            assert_eq!(selected.qindex, [qindex; 4]);
            let mut symbols = crate::rate::SymbolCounter::default();
            selected.write_header(&mut symbols, 6).unwrap();
            for id in 0..4 {
                selected.write_id(&mut symbols, id).unwrap();
            }
            assert_eq!(symbols.count, 1);
        }
        let unordered = Config {
            qindex: [36, 10, 36, 22],
            ..shifted
        };
        assert_eq!(
            unordered
                .with_uniform_qindex([1, 4, 3, 0], ramp)
                .base_qindex,
            ramp
        );
        assert_eq!(
            unordered
                .with_uniform_qindex([1, 3, 4, 0], ramp)
                .base_qindex,
            36
        );
        let inactive = original.with_mixed_q60_allocation([1, 1, 1, 1], false);
        assert!(inactive.enabled);
        assert_eq!(inactive.qindex, original.qindex);
        assert_eq!(inactive.map_probabilities, original.map_probabilities);
    }

    #[test]
    fn mixed_q60_uniform_with_only_fine_smooth_and_chromatic_flat() {
        for counts in [[1, 1, 0, 0], [1, 2, 0, 0], [2, 1, 0, 0]] {
            let source = Config::from_counts(60, counts, counts.iter().sum(), false);
            assert!(!source.map_exceeds_rate_allowance(counts));
            let wire = source.with_mixed_q60_allocation(counts, true);
            assert!(!wire.enabled);
            assert_eq!(wire.qindex, [presets::chromatic_ramp_qindex(60); 4]);
            assert_eq!(source.qindex, [6, 18, 32, 32]);
            let inactive = source.with_mixed_q60_allocation(counts, false);
            assert!(inactive.enabled);
            assert_eq!(inactive.qindex, source.qindex);
        }
    }

    #[test]
    fn mixed_q60_single_ramp_or_textured_macroblock_keeps_original_cheap_map_bytes() {
        for counts in [[1, 2, 1, 0], [1, 2, 0, 1], [1, 0, 1, 0], [0, 1, 0, 1]] {
            let source = Config::from_counts(60, counts, counts.iter().sum(), false);
            assert!(!source.map_exceeds_rate_allowance(counts));
            let chosen = source.with_mixed_q60_allocation(counts, true);
            let previous = source.with_raised_qindices();
            let emit = |config: Config| {
                let mut writer = crate::BoolWriter::new();
                config.write_header(&mut writer, 6).unwrap();
                for (id, count) in counts.into_iter().enumerate() {
                    for _ in 0..count {
                        config.write_id(&mut writer, id as u8).unwrap();
                    }
                }
                writer.finish().unwrap()
            };
            assert!(chosen.enabled);
            assert_eq!(emit(chosen), emit(previous));
            assert_eq!(chosen.base_qindex, previous.base_qindex);
            assert_eq!(chosen.qindex, previous.qindex);
        }
    }

    #[test]
    fn mixed_q75_uniform_allocation_uses_the_raised_lower_median_with_the_ramp_floor() {
        for (counts, expected) in [
            ([256, 256, 256, 256], 27),
            ([256, 255, 257, 256], 31),
            ([128, 128, 128, 640], 32),
        ] {
            let original = Config::from_counts(75, counts, counts.iter().sum(), false);
            assert_eq!(original.qindex, [6, 19, 27, 28]);
            assert!(original.map_exceeds_rate_allowance(counts));
            let selected = original.with_mixed_q75_allocation(counts);
            assert!(!selected.enabled);
            assert_eq!(selected.base_qindex, expected);
            assert_eq!(selected.qindex, [expected; 4]);
        }
    }

    #[test]
    fn q85_smooth_pair_advances_only_a_repeated_uv_dc_step() {
        let deltas = presets::deltas(85);
        for (counts, mean, expected) in [
            ([1, 1, 0, 0], 11, 12),
            ([5, 4, 0, 0], 10, 12),
            ([3, 1, 0, 0], 8, 8),
            ([1, 3, 0, 0], 13, 13),
            ([113, 287, 0, 0], 12, 12),
            ([1, 31, 0, 0], 15, 15),
        ] {
            let original = Config::from_counts(85, counts, counts.iter().sum(), false);
            assert!(original.enabled && !original.map_exceeds_rate_allowance(counts));
            assert_eq!(
                (
                    original.qindex_for(FINE_SMOOTH),
                    original.qindex_for(CHROMATIC_FLAT)
                ),
                (6, 15)
            );
            let selected = original.with_q85_smooth_pair_allocation(counts, deltas);
            assert!(!selected.enabled);
            assert_eq!(selected.base_qindex, expected);
            assert_eq!(selected.qindex, [expected; 4]);
            let dc_at = |index| steps(index, deltas, Plane::UV).dc;
            assert!((mean..expected).all(|index| dc_at(index as u8) == dc_at(mean as u8)));
            if expected > mean {
                assert!(dc_at(expected as u8) > dc_at(mean as u8));
            }
            let mut header = crate::rate::SymbolCounter::default();
            selected.write_header(&mut header, 4).unwrap();
            for id in [FINE_SMOOTH, CHROMATIC_FLAT] {
                selected.write_id(&mut header, id).unwrap();
            }
            assert_eq!(header.count, 1);
        }
    }

    #[test]
    fn q85_smooth_pair_allocation_is_monotonic_across_the_dc_plateau() {
        let mut previous = 0;
        for flat in 1..100 {
            let counts = [100 - flat, flat, 0, 0];
            let original = Config::from_counts(85, counts, 100, false);
            let selected = original.with_q85_smooth_pair_allocation(counts, presets::deltas(85));
            let mean = (6 * counts[0] + 15 * flat + 50) / 100;
            let expected = if (10..=11).contains(&mean) { 12 } else { mean };
            assert_eq!(selected.base_qindex, expected);
            assert!(selected.base_qindex >= previous);
            previous = selected.base_qindex;
        }
    }

    #[test]
    fn q85_smooth_pair_rounding_fits_the_vp8_macroblock_bound() {
        let counts = [524_288, 524_288, 0, 0];
        let original = Config {
            qindex: [126, 127, 0, 0],
            ..Config::nonsegmented(0)
        };
        assert_eq!(
            original
                .with_q85_smooth_pair_allocation(counts, presets::deltas(85))
                .base_qindex,
            127
        );
    }

    #[test]
    fn q75_raised_qindices_only_coarsen_y1_ac_and_keep_the_map() {
        use crate::ac_quant::{steps, Deltas, Plane};

        for counts in [[136; 4], [512, 0, 512, 0]] {
            let original = Config::from_counts(75, counts, counts.iter().sum(), false);
            let raised = original.with_raised_qindices();
            let deltas = presets::deltas(75);
            let compensated = presets::medium_y1_ac_deltas(deltas);
            assert_eq!(original.qindex, [6, 19, 27, 28]);
            assert_eq!(raised.qindex, [10, 23, 31, 32]);
            assert_eq!(raised.base_qindex, original.base_qindex + 4);
            assert_eq!(raised.active, original.active);
            assert_eq!(raised.map_probabilities, original.map_probabilities);
            assert!(raised.enabled);
            assert_eq!(original.map_rate_cost(counts), raised.map_rate_cost(counts));
            assert_eq!(
                compensated,
                Deltas {
                    y1_dc: -4,
                    y2_dc: -4,
                    y2_ac: -4,
                    uv_dc: -13,
                    uv_ac: -13,
                }
            );
            for (before, after) in original.qindex.into_iter().zip(raised.qindex) {
                let (before, after) = (before as u8, after as u8);
                let y1 = steps(before, deltas, Plane::Y1);
                let raised_y1 = steps(after, compensated, Plane::Y1);
                assert_eq!(y1.dc, raised_y1.dc);
                assert!(raised_y1.ac > y1.ac);
                for plane in [Plane::Y2, Plane::UV] {
                    assert_eq!(
                        steps(before, deltas, plane),
                        steps(after, compensated, plane)
                    );
                }
                for (old, new) in [
                    (deltas.y1_dc, compensated.y1_dc),
                    (deltas.y2_dc, compensated.y2_dc),
                    (deltas.y2_ac, compensated.y2_ac),
                    (deltas.uv_dc, compensated.uv_dc),
                    (deltas.uv_ac, compensated.uv_ac),
                ] {
                    assert_eq!(
                        i16::from(before) + i16::from(old),
                        i16::from(after) + i16::from(new)
                    );
                }
            }
        }
    }

    #[test]
    fn mixed_q60_wire_alias_requires_both_equivalent_occupied_classes() {
        let counts = [120, 240, 180, 60];
        let source = Config::from_counts(60, counts, 600, false);
        // Set the original absolute qindices directly; this test isolates
        // wire construction from the preceding eligibility decision.
        let coding = Config {
            qindex: [10, 22, 36, 36],
            base_qindex: 10,
            ..source
        };
        let aliased = coding.mixed_q60_wire_alias(counts, true).unwrap();
        assert_eq!(aliased.map_probabilities, [154, 85, 255]);
        assert_eq!(aliased.active, [true, true, true, false]);
        assert_eq!(aliased.qindex, coding.qindex);
        assert_eq!(aliased.base_qindex, coding.base_qindex);
        assert!(aliased.enabled);
        assert_eq!(coding.map_probabilities, [154, 85, 192]);
        assert_eq!(coding.active, [true; 4]);

        assert!(coding.mixed_q60_wire_alias(counts, false).is_none());
        let uniform = Config::nonsegmented(36);
        assert!(uniform.mixed_q60_wire_alias(counts, true).is_none());
        let unequal = Config {
            qindex: [10, 22, 36, 37],
            ..coding
        };
        assert!(unequal.mixed_q60_wire_alias(counts, true).is_none());
        for incomplete in [[120, 240, 0, 240], [120, 240, 240, 0]] {
            let missing = Config::from_counts(60, incomplete, 600, false);
            assert!(missing.mixed_q60_wire_alias(incomplete, true).is_none());
        }
    }

    #[test]
    fn map_rate_matches_repeated_id_writes() {
        for counts in [[0, 0, 0, 5], [512, 0, 512, 0], [1, 49, 4, 512]] {
            let segments = Config::from_counts(60, counts, counts.iter().sum(), false);
            let mut repeated = RateCounter::default();
            for (id, count) in counts.into_iter().enumerate() {
                for _ in 0..count {
                    segments.write_id(&mut repeated, id as u8).unwrap();
                }
            }
            assert_eq!(segments.map_rate_cost(counts), repeated.cost);
        }
    }

    #[test]
    fn mixed_q60_keeps_the_map_at_the_exact_rate_limit() {
        // Two equiprobable bits per ID make 512 macroblocks cost exactly 128
        // bytes in the rate estimator, independent of their classification.
        for (total, enabled) in [(511, true), (512, true), (513, false)] {
            let counts = [256, 0, total - 256, 0];
            let original = Config {
                map_probabilities: [128; 3],
                ..Config::from_counts(60, counts, total, false)
            };
            let cost = original.map_rate_cost(counts);
            assert_eq!(cost, (total * 2 * 256) as u64);
            assert_eq!(original.map_exceeds_rate_allowance(counts), !enabled);
            let selected = original.with_mixed_q60_allocation(counts, true);
            assert_eq!(selected.enabled, enabled);
            if enabled {
                assert_eq!(selected.base_qindex, 10);
                assert_eq!(selected.qindex, [10, 22, 36, 36]);
                assert_eq!(selected.map_probabilities, original.map_probabilities);
                assert_eq!(selected.active, original.active);
            } else {
                assert_eq!(cost, MAP_RATE_ALLOWANCE + 512);
                assert_eq!(selected.qindex, [36; 4]);
            }
        }
    }

    #[test]
    fn frame_mean_curvature_uses_each_plane_and_inclusive_cutoff() {
        let mut y = vec![0; 16 * 16];
        let mut u = vec![0; 8 * 8];
        let mut v = vec![0; 8 * 8];
        for row in 0..16 {
            for col in 0..16 {
                y[row * 16 + col] = ((row + col) % 2) as u8;
            }
        }
        for row in 0..8 {
            for col in 0..8 {
                u[row * 8 + col] = ((row + col) % 2) as u8;
                v[row * 8 + col] = ((row + col) % 2) as u8;
            }
        }
        let mut totals = CurvatureTotals::default();
        let class = classify_with_curvature(&y, &u, &v, 16, 0, 0, Some(&mut totals));
        assert_eq!(class, classify(&y, &u, &v, 16, 0, 0));
        assert_eq!(totals.sums, [896, 192, 192]);
        assert!(totals.within_cutoff(1));
        for plane in 0..3 {
            let mut changed = [y.clone(), u.clone(), v.clone()];
            let size = if plane == 0 { 16 } else { 8 };
            changed[plane][3 * size + 4] += 1;
            let mut above = CurvatureTotals::default();
            let id = classify_with_curvature(
                &changed[0],
                &changed[1],
                &changed[2],
                16,
                0,
                0,
                Some(&mut above),
            );
            assert_eq!(
                id,
                classify(&changed[0], &changed[1], &changed[2], 16, 0, 0)
            );
            assert!(above.sums[plane] > totals.sums[plane]);
            assert!(!above.within_cutoff(1));
        }
    }

    #[test]
    fn luma_dominance_normalizes_both_chroma_planes_without_rounding() {
        for (sums, expected) in [
            ([448, 96, 96], true),
            ([448, 97, 0], false),
            ([448, 0, 97], false),
            ([447, 96, 96], false),
            ([449, 96, 96], true),
            ([0, 0, 0], true),
        ] {
            assert_eq!(
                CurvatureTotals { sums }.luma_dominates(),
                expected,
                "{sums:?}"
            );
        }
        // Even frame sums outside the admitted geometry cannot wrap the comparison.
        let y = u64::MAX;
        let chroma = (u128::from(y) * 96 / 448) as u64;
        assert!(CurvatureTotals {
            sums: [y, chroma, chroma]
        }
        .luma_dominates());
        assert!(!CurvatureTotals {
            sums: [y, 0, chroma + 1]
        }
        .luma_dominates());
    }

    #[test]
    fn curvature_accounts_for_maximum_second_difference_across_blocks() {
        let mut y = vec![0; 32 * 16];
        let uv = vec![0; 16 * 8];
        for x in [0, 16] {
            y[3 * 32 + x + 3] = 255;
        }
        let mut totals = CurvatureTotals::default();
        for mx in 0..2 {
            assert_eq!(
                classify_with_curvature(&y, &uv, &uv, 32, mx, 0, Some(&mut totals)),
                classify(&y, &uv, &uv, 32, mx, 0),
            );
        }
        // Each isolated spike contributes two 510 center terms and four 255 neighbors.
        assert_eq!(totals.sums, [4080, 0, 0]);
        assert!(!totals.within_cutoff(2));
        let at_cutoff = [1792, 384, 384];
        assert!(CurvatureTotals { sums: at_cutoff }.within_cutoff(2));
        for plane in 0..3 {
            let mut above = at_cutoff;
            above[plane] += 1;
            assert!(!CurvatureTotals { sums: above }.within_cutoff(2));
        }
    }

    #[test]
    fn frame_class_counts_collapse_or_signal_four_absolute_qindices() {
        for (quality, flat, ramp, textured) in
            [(60, 18, 32, 32), (75, 19, 27, 28), (85, 15, 15, 14)]
        {
            for (id, qindex) in [presets::smooth_qindex(quality), flat, ramp, textured]
                .into_iter()
                .enumerate()
            {
                let mut counts = [0; 4];
                counts[id] = 4;
                let single = Config::from_counts(quality, counts, 4, false);
                assert!(!single.enabled);
                assert_eq!(single.base_qindex, qindex);
            }
            let mixed = Config::from_counts(quality, [1, 1, 1, 1], 4, false);
            assert!(mixed.enabled);
            assert_eq!(
                mixed.qindex,
                [presets::smooth_qindex(quality), flat, ramp, textured]
            );
            assert_eq!(mixed.map_probabilities, [128, 128, 128]);
        }
    }

    #[test]
    fn neutral_chroma_selects_textured_precision_per_preset() {
        for (quality, chromatic, neutral) in [(60, 32, 34), (75, 28, 27), (85, 14, 14)] {
            for counts in [[0, 0, 0, 1], [1, 1, 1, 1]] {
                let total = counts.iter().sum();
                let color = Config::from_counts(quality, counts, total, false);
                let mono = Config::from_counts(quality, counts, total, true);
                assert_eq!(color.qindex[TEXTURED as usize], chromatic);
                assert_eq!(mono.qindex[TEXTURED as usize], neutral);
                assert_eq!(
                    color.qindex[..TEXTURED as usize],
                    mono.qindex[..TEXTURED as usize]
                );
                assert_eq!(color.enabled, mono.enabled);
                assert_eq!(color.map_probabilities, mono.map_probabilities);
            }
        }
    }

    #[test]
    fn photo_rebase_signals_active_quantizers_and_retains_original_rate_reference() {
        use crate::ac_quant::{self, Plane};
        let original = Config::from_counts(60, [0, 0, 0, 4], 4, false);
        let selected = original.with_photo_q60_rebase(true);
        let deltas = presets::photo_allocation_deltas(presets::deltas(60), true, false);
        assert!(!selected.enabled);
        assert_eq!(selected.base_qindex, 28);
        assert_eq!(selected.qindex, original.qindex.map(|q| q - 4));
        assert_eq!(selected.map_probabilities, original.map_probabilities);
        assert_eq!(selected.active, original.active);
        assert_eq!(
            original.with_photo_q60_rebase(false).qindex,
            original.qindex
        );
        let q = selected.qindex_for(TEXTURED) as u8;
        assert_eq!(ac_quant::steps(q, deltas, Plane::Y1).dc, 29);
        assert_eq!(ac_quant::steps(q, deltas, Plane::Y1).ac, 32);
        assert_eq!(ac_quant::steps(q, deltas, Plane::Y2).dc, 58);
        assert_eq!(ac_quant::steps(q, deltas, Plane::Y2).ac, 55);
        assert_eq!(ac_quant::steps(q, deltas, Plane::UV).dc, 16);
        assert_eq!(ac_quant::steps(q, deltas, Plane::UV).ac, 25);
        assert_eq!(
            presets::lambda_for_quality(original.qindex_for(TEXTURED), 60),
            480
        );
        assert_eq!(
            presets::lambda_for_quality(selected.qindex_for(TEXTURED), 60),
            388
        );
    }

    #[test]
    fn high_loss_luma_shift_preserves_segment_map_and_uv_steps() {
        use crate::ac_quant::{self, Deltas, Plane};

        for neutral in [false, true] {
            for counts in [
                [1, 1, 1, 1],
                [4, 0, 0, 0],
                [0, 4, 0, 0],
                [0, 0, 4, 0],
                [0, 0, 0, 4],
            ] {
                let original = Config::from_counts(60, counts, 4, neutral);
                let selected = original.with_high_chroma_loss_luma(true);
                assert!(original.qindex.iter().all(|&qindex| qindex >= 6));
                assert_eq!(selected.base_qindex, original.base_qindex - 4);
                assert_eq!(selected.qindex, original.qindex.map(|qindex| qindex - 4));
                assert_eq!(selected.map_probabilities, original.map_probabilities);
                assert_eq!(selected.enabled, original.enabled);
                assert_eq!(selected.active, original.active);
                assert_eq!(
                    original.with_high_chroma_loss_luma(false).qindex,
                    original.qindex
                );
                let old_deltas = Deltas {
                    uv_dc: -13,
                    uv_ac: 0,
                    ..Deltas::default()
                };
                let new_deltas = crate::presets::frame_deltas(60, 4096 * 3 * 5 * 3 + 1, 5, 3);
                for id in 0..4 {
                    let original_steps =
                        ac_quant::steps(original.qindex[id] as u8, old_deltas, Plane::UV);
                    let selected_steps =
                        ac_quant::steps(selected.qindex[id] as u8, new_deltas, Plane::UV);
                    assert_eq!(original_steps, selected_steps);
                }
                if counts == [0, 0, 0, 4] && !neutral {
                    assert!(!selected.enabled);
                    assert_eq!(selected.base_qindex, 28);
                }
            }
        }
    }

    #[test]
    fn medium_textured_shift_preserves_all_segment_uv_steps_and_map() {
        use crate::ac_quant::{self, Plane};

        for neutral in [false, true] {
            for counts in [
                [1, 1, 1, 1],
                [4, 0, 0, 0],
                [0, 4, 0, 0],
                [0, 0, 4, 0],
                [0, 0, 0, 4],
            ] {
                let original = Config::from_counts(75, counts, 4, neutral);
                let selected = original.with_medium_textured_luma(true);
                assert_eq!(selected.base_qindex, original.base_qindex - 2);
                assert_eq!(selected.qindex, original.qindex.map(|qindex| qindex - 2));
                assert_eq!(selected.enabled, original.enabled);
                assert_eq!(selected.active, original.active);
                assert_eq!(selected.map_probabilities, original.map_probabilities);
                assert_eq!(
                    original.with_medium_textured_luma(false).qindex,
                    original.qindex
                );
                for id in 0..4 {
                    assert_eq!(
                        ac_quant::steps(
                            selected.qindex[id] as u8,
                            presets::medium_textured_deltas(presets::deltas(75)),
                            Plane::UV
                        ),
                        ac_quant::steps(original.qindex[id] as u8, presets::deltas(75), Plane::UV)
                    );
                }
            }
        }
    }

    #[test]
    fn smoothness_uses_curvature_of_all_three_source_planes() {
        let y: Vec<_> = (0..16)
            .flat_map(|row| (0..32).map(move |col| (80 + row + col) as u8))
            .collect();
        let uv = vec![128; 16 * 8];
        assert_eq!(classify(&y, &uv, &uv, 32, 0, 0), FINE_SMOOTH);
        let chromatic_u = vec![126; 16 * 8];
        assert_eq!(classify(&y, &chromatic_u, &uv, 32, 0, 0), CHROMATIC_RAMP);
        let chromatic_v = vec![130; 16 * 8];
        assert_eq!(classify(&y, &uv, &chromatic_v, 32, 0, 0), CHROMATIC_RAMP);
        let flat_y = vec![80; 32 * 16];
        assert_eq!(classify(&flat_y, &chromatic_u, &uv, 32, 0, 0), FINE_SMOOTH);
        let mut chromatic_ramp_u = chromatic_u.clone();
        for row in 0..8 {
            chromatic_ramp_u[row * 16..row * 16 + 8].fill(126 + row as u8);
        }
        assert_eq!(
            classify(&flat_y, &chromatic_ramp_u, &uv, 32, 0, 0),
            CHROMATIC_RAMP
        );
        let mut textured_y = y.clone();
        textured_y[8 * 32 + 8] = 0;
        assert_eq!(classify(&textured_y, &uv, &uv, 32, 0, 0), TEXTURED);
        let mut textured_u = uv.clone();
        textured_u[4 * 16 + 4] = 0;
        assert_eq!(classify(&y, &textured_u, &uv, 32, 0, 0), TEXTURED);
        let mut textured_v = uv.clone();
        textured_v[4 * 16 + 4] = 0;
        assert_eq!(classify(&y, &uv, &textured_v, 32, 0, 0), TEXTURED);
    }

    #[test]
    fn constant_color_uses_fine_segment_but_one_level_variation_remains_flat() {
        let y = vec![80; 32 * 16];
        let u = vec![96; 16 * 8];
        let v = vec![160; 16 * 8];
        assert_eq!(classify(&y, &u, &v, 32, 0, 0), FINE_SMOOTH);
        for plane in 0..3 {
            let mut varied_y = y.clone();
            let mut varied_u = u.clone();
            let mut varied_v = v.clone();
            match plane {
                0 => varied_y[8 * 32 + 8] += 1,
                1 => varied_u[4 * 16 + 4] += 1,
                _ => varied_v[4 * 16 + 4] += 1,
            }
            assert_eq!(
                classify(&varied_y, &varied_u, &varied_v, 32, 0, 0),
                CHROMATIC_FLAT
            );
            // Neighboring tile and repeated calls do not inherit another tile's range.
            assert_eq!(
                classify(&varied_y, &varied_u, &varied_v, 32, 1, 0),
                FINE_SMOOTH
            );
            assert_eq!(classify(&y, &u, &v, 32, 0, 0), FINE_SMOOTH);
        }
    }

    #[test]
    fn all_four_ids_use_the_signaled_map_tree() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let config = Config::from_counts(75, [1, 1, 1, 1], 4, false);
        for (id, expected) in [
            (FINE_SMOOTH, [(128, false), (128, false)]),
            (CHROMATIC_FLAT, [(128, false), (128, true)]),
            (CHROMATIC_RAMP, [(128, true), (128, false)]),
            (TEXTURED, [(128, true), (128, true)]),
        ] {
            let mut operations = Operations(Vec::new());
            config.write_id(&mut operations, id).unwrap();
            assert_eq!(operations.0, expected);
        }
        assert_eq!(
            config.write_id(&mut Operations(Vec::new()), 4),
            Err(EncodeError::InvalidInput)
        );
    }

    #[test]
    fn absolute_segments_signal_filter_level_for_active_ids() {
        struct Bits(Vec<bool>);
        impl BoolSink for Bits {
            fn write(&mut self, _probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push(bit);
                Ok(())
            }
        }
        let config = Config::from_counts(75, [1, 0, 0, 1], 2, false);
        let mut bits = Bits(Vec::new());
        config.write_header(&mut bits, 6).unwrap();
        // Four control bits and four quantizer feature records precede the
        // per-segment filter strengths.
        assert_eq!(
            &bits.0[40..58],
            &[
                true, false, false, false, true, true, false, false, false, false, true, false,
                false, false, true, true, false, false,
            ]
        );
        let mut disabled = Bits(Vec::new());
        config.write_header(&mut disabled, 0).unwrap();
        assert_eq!(&disabled.0[40..44], &[false; 4]);
        assert_eq!(
            config.write_header(&mut Bits(Vec::new()), 64),
            Err(EncodeError::InvalidInput)
        );
    }
}
