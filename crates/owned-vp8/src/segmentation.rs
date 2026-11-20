// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Four absolute VP8 quantizer segments. Bit syntax follows RFC 6386 section 9.3
// and the reference decoder's SEGMENT_ABSDATA=1 definition.

use crate::{presets, rate::BoolSink, EncodeError};

pub(crate) const FINE_SMOOTH: u8 = 0;
pub(crate) const CHROMATIC_FLAT: u8 = 1;
pub(crate) const CHROMATIC_RAMP: u8 = 2;
pub(crate) const TEXTURED: u8 = 3;
pub(crate) const CURVATURE_CUTOFF: u64 = 2;
const Y_DIFFERENCES_PER_BLOCK: u64 = 448;
const UV_DIFFERENCES_PER_BLOCK: u64 = 96;

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
}

#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub enabled: bool,
    pub base_qindex: usize,
    pub qindex: [usize; 4],
    pub map_probabilities: [u8; 3],
    active: [bool; 4],
}

impl Config {
    pub(crate) fn nonsegmented(qindex: usize) -> Self {
        Self {
            enabled: false,
            base_qindex: qindex,
            qindex: [qindex; 4],
            map_probabilities: [255; 3],
            active: [false; 4],
        }
    }

    pub(crate) fn from_counts(
        quality: u32,
        counts: [usize; 4],
        total: usize,
        neutral_chroma: bool,
    ) -> Self {
        debug_assert_eq!(counts.iter().sum::<usize>(), total);
        let qindex = [
            presets::smooth_qindex(quality),
            presets::chromatic_flat_qindex(quality),
            presets::chromatic_ramp_qindex(quality),
            presets::textured_qindex(quality, neutral_chroma),
        ];
        let enabled = counts.iter().filter(|&&count| count > 0).count() > 1;
        let base_qindex = qindex[counts.iter().position(|&count| count > 0).unwrap_or(3)];
        let probability = |numerator: usize, denominator: usize| {
            (numerator * 256 + denominator / 2)
                .checked_div(denominator)
                .unwrap_or(255)
                .clamp(1, 255) as u8
        };
        let map_probabilities = if enabled {
            [
                probability(counts[0] + counts[1], total),
                probability(counts[0], counts[0] + counts[1]),
                probability(counts[2], counts[2] + counts[3]),
            ]
        } else {
            [255; 3]
        };
        Self {
            enabled,
            base_qindex,
            qindex,
            map_probabilities,
            active: counts.map(|count| count > 0),
        }
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

    pub(crate) fn with_mixed_q60_uniform(self, counts: [usize; 4], selected: bool) -> Self {
        if !selected {
            return self;
        }
        let mut weighted_indices = std::array::from_fn::<_, 4, _>(|id| {
            (
                self.qindex[id] + presets::MIXED_Y1_AC_QINDEX_INCREASE,
                counts[id],
            )
        });
        weighted_indices.sort_unstable_by_key(|&(qindex, _)| qindex);
        // Equal qindices contribute the same result regardless of their order.
        // This one-based rank chooses the lower weighted median for even totals.
        let midpoint = counts.into_iter().sum::<usize>().div_ceil(2);
        debug_assert!(midpoint > 0);
        let mut cumulative = 0;
        for (qindex, count) in weighted_indices {
            cumulative += count;
            if cumulative >= midpoint {
                return Self::nonsegmented(qindex.max(presets::chromatic_ramp_qindex(60)));
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
        for &qindex in &self.qindex {
            sink.bit(true)?;
            sink.literal(qindex as u32, 7)?;
            sink.bit(false)?; // Positive value.
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
        let ramp = presets::chromatic_ramp_qindex(60);
        for (counts, qindex) in [
            ([1, 1, 1, 1], ramp),
            ([3, 0, 3, 0], ramp),
            ([0, 3, 1, 1], ramp),
            ([1, 2, 2, 2], 36),
        ] {
            let selected = original.with_mixed_q60_uniform(counts, true);
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
            qindex: [32, 6, 32, 18],
            ..original
        };
        assert_eq!(
            unordered
                .with_mixed_q60_uniform([1, 4, 3, 0], true)
                .base_qindex,
            ramp
        );
        assert_eq!(
            unordered
                .with_mixed_q60_uniform([1, 3, 4, 0], true)
                .base_qindex,
            36
        );
        let inactive = original.with_mixed_q60_uniform([1, 1, 1, 1], false);
        assert!(inactive.enabled);
        assert_eq!(inactive.qindex, original.qindex);
        assert_eq!(inactive.map_probabilities, original.map_probabilities);
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
