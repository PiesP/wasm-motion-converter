// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory knobs calibrated on tuning and explicitly exposed regressions.
// Only a prospectively frozen fresh cohort can establish acceptance.
use crate::{ac_quant::Deltas, segmentation::CurvatureTotals};

pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
const SMOOTH_QINDEX: usize = 6;
const MEDIUM_LUMA_REDUCTION: usize = 2;
pub(crate) const MIXED_Y1_AC_QINDEX_INCREASE: usize = 4;

pub(crate) fn smooth_qindex(_quality: u32) -> usize {
    SMOOTH_QINDEX
}
pub(crate) const CHROMATIC_FLAT_QINDEX: [usize; 3] = [18, 19, 15];
pub(crate) const CHROMATIC_RAMP_QINDEX: [usize; 3] = [32, 27, 15];
pub(crate) const TEXTURED_QINDEX: [usize; 3] = [32, 28, 14];
pub(crate) const TEXTURED_MONO_QINDEX: [usize; 3] = [34, 27, 14];
pub(crate) const UV_DC_DELTA: [i8; 3] = [-4, -9, -4];
pub(crate) const UV_AC_DELTA: [i8; 3] = [-11, -9, -4];
pub(crate) const HIGH_CHROMA_LOSS_QINDEX_REDUCTION: usize = 4;
pub(crate) const HIGH_CHROMA_LOSS_ORIGINAL_UV_DELTAS: (i8, i8) = (-13, 0);
pub(crate) const HIGH_CHROMA_LOSS_UV_DELTAS: (i8, i8) = (-9, 4);
const CHROMA_LOSS_THRESHOLD_PER_RGB_CHANNEL: u64 = 4096;
const HIGH_IMPORT_UV_AC_QINDEX: i8 = 32;
pub(crate) const FILTER_LEVEL: [u8; 3] = [6, 4, 4];
pub(crate) const LAMBDA_NUMERATOR: u64 = 1;
pub(crate) const LAMBDA_DENOMINATOR: u64 = 1;
pub(crate) const UV_COEFFICIENT_RATE_DIVISOR: u64 = 64;
pub(crate) fn qindex(quality: u32) -> usize {
    QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn textured_qindex(quality: u32, neutral_chroma: bool) -> usize {
    let table = if neutral_chroma {
        TEXTURED_MONO_QINDEX
    } else {
        TEXTURED_QINDEX
    };
    table[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn chromatic_flat_qindex(quality: u32) -> usize {
    CHROMATIC_FLAT_QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn chromatic_ramp_qindex(quality: u32) -> usize {
    CHROMATIC_RAMP_QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn deltas(quality: u32) -> Deltas {
    let preset = match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    };
    Deltas {
        uv_dc: UV_DC_DELTA[preset],
        uv_ac: UV_AC_DELTA[preset],
        ..Deltas::default()
    }
}

pub(crate) fn frame_deltas(quality: u32, rgb_error_sum: u64, width: u32, height: u32) -> Deltas {
    let mut selected = deltas(quality);
    if high_chroma_loss(quality, rgb_error_sum, width, height) {
        (selected.uv_dc, selected.uv_ac) = HIGH_CHROMA_LOSS_UV_DELTAS;
    }
    selected
}

pub(crate) fn medium_textured_luma(
    quality: u32,
    counts: [usize; 4],
    total: usize,
    rgb_error_sum: u64,
    width: u32,
    height: u32,
) -> bool {
    quality == 75
        && total > 0
        && counts[crate::segmentation::TEXTURED as usize] == total
        && chroma_loss_limit(width, height).is_some_and(|limit| rgb_error_sum <= limit)
}

// Test the high-import q60 UV AC grid on q75 without that profile's
// luma, rate, filter, or preview choices.
pub(crate) fn medium_high_import_deltas(
    mut selected: Deltas,
    quality: u32,
    counts: [usize; 4],
    total: usize,
    rgb_error_sum: u64,
    visible: (u32, u32),
    base_qindex: usize,
) -> Deltas {
    if quality == 75
        && total > 0
        && counts[crate::segmentation::TEXTURED as usize] == total
        && chroma_loss_limit(visible.0, visible.1).is_some_and(|limit| rgb_error_sum > limit)
    {
        selected.uv_ac = HIGH_IMPORT_UV_AC_QINDEX - base_qindex as i8;
    }
    selected
}

pub(crate) fn chroma_edge_uv_ac_deltas(
    mut selected: Deltas,
    base_qindex: usize,
    counts: [usize; 4],
    curvature: CurvatureTotals,
    (width, height): (u32, u32),
) -> Deltas {
    let total = counts.iter().sum();
    if width >= 16
        && height >= 16
        && counts[crate::segmentation::TEXTURED as usize] == total
        && curvature.only_chroma_exceeds_cutoff(total)
    {
        // Retain a coarser step already selected by the high-import profile.
        let ceiling = textured_qindex(75, false) as i8;
        let target = (ceiling - base_qindex as i8).min(0);
        selected.uv_ac = selected.uv_ac.max(target);
    }
    selected
}

pub(crate) fn rough_chroma_deltas(
    mut selected: Deltas,
    quality: u32,
    counts: [usize; 4],
    curvature: CurvatureTotals,
    high_chroma_loss: bool,
    (width, height): (u32, u32),
) -> Deltas {
    let total = counts.iter().sum();
    let textured = counts[crate::segmentation::TEXTURED as usize];
    let mixed_rough_chroma = quality == 60
        && textured > 0
        && counts[crate::segmentation::CHROMATIC_RAMP as usize] > 0
        && !curvature.within_cutoff(total)
        && !curvature.only_chroma_exceeds_cutoff(total)
        && !curvature.luma_dominates();
    if !high_chroma_loss
        && width >= 16
        && height >= 16
        && (mixed_rough_chroma
            || (textured == total && curvature.one_chroma_plane_leads_rough_luma(total)))
    {
        if quality == 60 {
            // Move halfway toward the existing luma-leading UV AC setting.
            let span = (i16::from(selected.uv_dc) - i16::from(selected.uv_ac)).max(0);
            selected.uv_ac += ((span + 1) / 2) as i8;
        } else if quality == 85 && selected.uv_ac < 0 {
            selected.uv_ac += 1;
        }
    }
    selected
}

pub(crate) fn q85_smooth_textured_deltas(
    mut selected: Deltas,
    quality: u32,
    counts: [usize; 4],
    neutral_chroma: bool,
    omit_display_refinement: bool,
) -> Deltas {
    let [fine, flat, ramp, textured] = counts;
    if quality == 85
        && !neutral_chroma
        && !omit_display_refinement
        && fine > 0
        && textured > 0
        && flat == 0
        && ramp == 0
    {
        selected.uv_ac = selected.uv_ac.saturating_add(1).min(15);
    }
    selected
}

pub(crate) fn medium_textured_deltas(mut original: Deltas) -> Deltas {
    original.uv_dc += MEDIUM_LUMA_REDUCTION as i8;
    original.uv_ac += MEDIUM_LUMA_REDUCTION as i8;
    original
}

pub(crate) fn ordinary_q60_all_texture(
    quality: u32,
    counts: [usize; 4],
    total: usize,
    neutral_chroma: bool,
    high_chroma_loss: bool,
) -> bool {
    quality == 60
        && !neutral_chroma
        && !high_chroma_loss
        && total > 0
        && counts[crate::segmentation::TEXTURED as usize] == total
}

pub(crate) fn high_curvature_q60_textured_deltas(
    mut selected: Deltas,
    ordinary_q60_texture: bool,
    low_curvature: bool,
    curvature: CurvatureTotals,
    rgb_error_sum: u64,
    visible: (u32, u32),
) -> Deltas {
    if !ordinary_q60_texture || low_curvature {
        return selected;
    }
    if curvature.luma_dominates() {
        selected.uv_ac = selected.uv_dc;
    } else if visible.0 >= 16 && visible.1 >= 16 {
        // The curvature class counts padded blocks; require at least one
        // complete visible block before interpolating from visible import loss.
        let Some(limit) = chroma_loss_limit(visible.0, visible.1) else {
            return selected;
        };
        if rgb_error_sum > limit {
            return selected;
        }
        // Use the existing ordinary and high-import UV AC endpoints. Scaling
        // by measured import loss keeps small chroma errors
        // on the finer grid and does not change the strict high-loss branch.
        let ordinary_uv_ac = textured_qindex(60, false) as i8 + UV_AC_DELTA[0];
        let span = (HIGH_IMPORT_UV_AC_QINDEX - ordinary_uv_ac) as u128;
        // The quantization step is an amplitude. Compare squared offsets
        // against squared error to floor the RMS interpolation exactly.
        let scaled_error = u128::from(rgb_error_sum) * span * span;
        let offset = (1..=span)
            .take_while(|step| step * step * u128::from(limit) <= scaled_error)
            .count();
        selected.uv_ac += offset as i8;
    }
    selected
}

pub(crate) fn mixed_y1_ac_profile(
    quality: u32,
    counts: [usize; 4],
    neutral_chroma: bool,
    high_chroma_loss: bool,
    low_curvature: bool,
) -> bool {
    quality == 60
        && !neutral_chroma
        && !high_chroma_loss
        && counts.iter().filter(|&&count| count > 0).count() >= 2
        && low_curvature
}

pub(crate) fn mixed_y1_ac_deltas(mut selected: Deltas, enabled: bool) -> Deltas {
    if enabled {
        selected.y1_dc = -4;
        selected.y2_dc = -4;
        selected.y2_ac = -4;
        selected.uv_dc = -8;
        selected.uv_ac = -15;
    }
    selected
}

pub(crate) fn medium_y1_ac_deltas(mut selected: Deltas) -> Deltas {
    // Applies only to mixed q75. Its ordinary UV deltas are both -9, so
    // compensating by four stays inside the signed VP8 header range.
    let increase = MIXED_Y1_AC_QINDEX_INCREASE as i8;
    selected.y1_dc -= increase;
    selected.y2_dc -= increase;
    selected.y2_ac -= increase;
    selected.uv_dc -= increase;
    selected.uv_ac -= increase;
    selected
}

pub(crate) fn photo_allocation_deltas(
    mut selected: Deltas,
    q60_all_texture: bool,
    q75_medium_non_neutral: bool,
) -> Deltas {
    if q60_all_texture {
        selected.y1_dc = 4;
        selected.y2_dc = 4;
        selected.y2_ac = 4;
        selected.uv_dc = -15;
        selected.uv_ac = -7;
    } else if q75_medium_non_neutral {
        selected.uv_dc -= 4;
    }
    selected
}

pub(crate) const fn medium_luma_reduction() -> usize {
    MEDIUM_LUMA_REDUCTION
}

pub(crate) fn original_high_chroma_loss_deltas() -> Deltas {
    Deltas {
        uv_dc: HIGH_CHROMA_LOSS_ORIGINAL_UV_DELTAS.0,
        uv_ac: HIGH_CHROMA_LOSS_ORIGINAL_UV_DELTAS.1,
        ..Deltas::default()
    }
}

pub(crate) fn high_chroma_loss(quality: u32, rgb_error_sum: u64, width: u32, height: u32) -> bool {
    // ResourcePlan admits at most 10_066_329 visible pixels, well below u64
    // for both this threshold and the maximum 195_075 error per pixel.
    quality == 60 && chroma_loss_limit(width, height).is_some_and(|limit| rgb_error_sum > limit)
}

pub(crate) fn chroma_loss_limit(width: u32, height: u32) -> Option<u64> {
    u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(3 * CHROMA_LOSS_THRESHOLD_PER_RGB_CHANNEL))
}
pub(crate) fn filter_level(quality: u32) -> u8 {
    FILTER_LEVEL[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn lambda_for_q(qindex: usize) -> u64 {
    let q = qindex as u64 + 8;
    (q * q / 4) * LAMBDA_NUMERATOR / LAMBDA_DENOMINATOR
}

pub(crate) fn lambda_for_quality(qindex: usize, quality: u32) -> u64 {
    let base = lambda_for_q(qindex);
    if quality == 60 {
        base * 6 / 5
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_y1_ac_profile_requires_colored_low_curvature_q60_and_multiple_ids() {
        let mixed = [1, 0, 1, 0];
        assert!(mixed_y1_ac_profile(60, mixed, false, false, true));
        for (quality, counts, neutral, high_loss, low_curvature) in [
            (75, mixed, false, false, true),
            (85, mixed, false, false, true),
            (60, [0; 4], false, false, true),
            (60, [0, 0, 0, 4], false, false, true),
            (60, mixed, true, false, true),
            (60, mixed, false, true, true),
            (60, mixed, false, false, false),
        ] {
            assert!(!mixed_y1_ac_profile(
                quality,
                counts,
                neutral,
                high_loss,
                low_curvature
            ));
        }
        assert_eq!(mixed_y1_ac_deltas(deltas(60), false), deltas(60));
    }

    #[test]
    fn mixed_y1_ac_allocation_changes_only_y1_ac_steps_for_every_segment() {
        use crate::ac_quant::{steps, Plane};

        let original = deltas(60);
        let selected = mixed_y1_ac_deltas(original, true);
        assert_eq!(
            (
                selected.y1_dc,
                selected.y2_dc,
                selected.y2_ac,
                selected.uv_dc,
                selected.uv_ac
            ),
            (-4, -4, -4, -8, -15)
        );
        assert_eq!(
            (
                original.y1_dc,
                original.y2_dc,
                original.y2_ac,
                original.uv_dc,
                original.uv_ac
            ),
            (0, 0, 0, -4, -11)
        );
        let qindices = [
            smooth_qindex(60),
            chromatic_flat_qindex(60),
            chromatic_ramp_qindex(60),
            textured_qindex(60, false),
        ];
        assert_eq!(qindices, [6, 18, 32, 32]);
        for original_q in qindices {
            let allocated_q = original_q + MIXED_Y1_AC_QINDEX_INCREASE;
            let before_y1 = steps(original_q as u8, original, Plane::Y1);
            let after_y1 = steps(allocated_q as u8, selected, Plane::Y1);
            assert_eq!(after_y1.dc, before_y1.dc);
            assert!(after_y1.ac > before_y1.ac);
            assert_eq!(
                steps(allocated_q as u8, selected, Plane::Y2),
                steps(original_q as u8, original, Plane::Y2)
            );
            assert_eq!(
                steps(allocated_q as u8, selected, Plane::UV),
                steps(original_q as u8, original, Plane::UV)
            );
            assert_eq!(
                lambda_for_quality(original_q, 60),
                lambda_for_q(original_q) * 6 / 5
            );
        }
        assert_eq!(
            steps(10, selected, Plane::UV).ac,
            steps(6, original, Plane::UV).ac
        );
    }

    #[test]
    fn photo_allocation_requires_exact_source_profile() {
        let all = [0, 0, 0, 4];
        assert!(ordinary_q60_all_texture(60, all, 4, false, false));
        for (quality, counts, total, neutral, high_loss) in [
            (75, all, 4, false, false),
            (85, all, 4, false, false),
            (60, [1, 0, 0, 3], 4, false, false),
            (60, all, 0, false, false),
            (60, all, 4, true, false),
            (60, all, 4, false, true),
        ] {
            assert!(!ordinary_q60_all_texture(
                quality, counts, total, neutral, high_loss
            ));
        }

        let q60 = photo_allocation_deltas(deltas(60), true, false);
        assert_eq!(
            (q60.y1_dc, q60.y2_dc, q60.y2_ac, q60.uv_dc, q60.uv_ac),
            (4, 4, 4, -15, -7)
        );
        assert_eq!(
            photo_allocation_deltas(deltas(60), false, false),
            deltas(60)
        );
        let medium = medium_textured_deltas(deltas(75));
        let q75 = photo_allocation_deltas(medium, false, true);
        assert_eq!((q75.uv_dc, q75.uv_ac), (-11, -7));
        assert_eq!(photo_allocation_deltas(medium, false, false), medium);
    }

    #[test]
    fn ordinary_q60_luma_dominant_high_curvature_changes_only_uv_ac_steps() {
        use crate::ac_quant::{steps, Plane, AC_QUANT};

        let before = deltas(60);
        let qindex = textured_qindex(60, false) as u8;
        let luma_dominant = CurvatureTotals {
            sums: [3 * 448, 3 * 96, 3 * 96 - 1],
            ..Default::default()
        };
        let ordinary = ordinary_q60_all_texture(60, [0, 0, 0, 1], 1, false, false);
        let visible = (5, 3);
        let limit = chroma_loss_limit(visible.0, visible.1).unwrap();
        assert!(ordinary);
        let after = high_curvature_q60_textured_deltas(
            before,
            ordinary,
            false,
            luma_dominant,
            limit,
            visible,
        );
        assert_eq!(
            after,
            Deltas {
                uv_ac: before.uv_dc,
                ..before
            }
        );
        assert_eq!(steps(qindex, before, Plane::UV).ac, AC_QUANT[21]);
        assert_eq!(steps(qindex, after, Plane::UV).ac, AC_QUANT[28]);
        assert_eq!(
            steps(qindex, after, Plane::UV).dc,
            steps(qindex, before, Plane::UV).dc
        );
        for plane in [Plane::Y1, Plane::Y2] {
            assert_eq!(steps(qindex, after, plane), steps(qindex, before, plane));
        }
        for sums in [[3 * 448, 3 * 96 + 1, 0], [3 * 448, 0, 3 * 96 + 1]] {
            assert_eq!(
                high_curvature_q60_textured_deltas(
                    before,
                    ordinary,
                    false,
                    CurvatureTotals {
                        sums,
                        ..Default::default()
                    },
                    8,
                    visible,
                ),
                before
            );
        }
        assert_eq!(
            high_curvature_q60_textured_deltas(
                before,
                ordinary,
                true,
                CurvatureTotals {
                    sums: [2 * 448, 2 * 96, 2 * 96],
                    ..Default::default()
                },
                limit,
                visible,
            ),
            before
        );
        for (quality, counts, total, neutral, high_loss) in [
            (75, [0, 0, 0, 1], 1, false, false),
            (85, [0, 0, 0, 1], 1, false, false),
            (60, [0, 0, 0, 1], 1, true, false),
            (60, [0, 0, 0, 1], 1, false, true),
            (60, [0, 1, 0, 1], 2, false, false),
            (60, [0; 4], 0, false, false),
        ] {
            let ordinary = ordinary_q60_all_texture(quality, counts, total, neutral, high_loss);
            let unchanged = deltas(quality);
            assert_eq!(
                high_curvature_q60_textured_deltas(
                    unchanged,
                    ordinary,
                    false,
                    luma_dominant,
                    limit,
                    visible,
                ),
                unchanged
            );
        }
    }

    #[test]
    fn q60_chroma_dominant_uv_ac_floors_each_import_loss_step() {
        use crate::ac_quant::{steps, Plane, AC_QUANT};

        let before = deltas(60);
        let qindex = textured_qindex(60, false) as u8;
        let curvature = CurvatureTotals {
            sums: [3 * 448, 3 * 96 + 1, 3 * 96],
            ..Default::default()
        };
        let apply = |error, visible| {
            high_curvature_q60_textured_deltas(before, true, false, curvature, error, visible)
        };
        let visible = (16, 16);
        let limit = chroma_loss_limit(visible.0, visible.1).unwrap();
        for offset in 1..=11u64 {
            let first = (offset * offset * limit).div_ceil(11 * 11);
            assert_eq!(
                apply(first - 1, visible).uv_ac,
                before.uv_ac + offset as i8 - 1
            );
            let selected = apply(first, visible);
            assert_eq!(
                selected,
                Deltas {
                    uv_ac: before.uv_ac + offset as i8,
                    ..before
                }
            );
            assert_eq!(
                steps(qindex, selected, Plane::UV).ac,
                AC_QUANT[21 + offset as usize]
            );
        }
        assert_eq!(apply(0, visible), before);
        assert_eq!(apply(limit + 1, visible), before);
        for partial in [(0, 3), (15, 16), (16, 15), (2, 9)] {
            let loss = chroma_loss_limit(partial.0, partial.1).unwrap_or(0);
            assert_eq!(apply(loss, partial), before);
        }
        assert_eq!(apply(u64::MAX, (u32::MAX, u32::MAX)), before);
        let wide = (1 << 21, 1 << 28);
        let wide_limit = chroma_loss_limit(wide.0, wide.1).unwrap();
        assert_eq!(apply(wide_limit, wide).uv_ac, 0);
    }

    #[test]
    fn medium_precision_preserves_uv_steps_and_original_rate_weights() {
        use crate::ac_quant::{steps, Plane};
        let original_deltas = deltas(75);
        let selected_deltas = medium_textured_deltas(original_deltas);
        for original in [
            qindex(75),
            smooth_qindex(75),
            chromatic_flat_qindex(75),
            chromatic_ramp_qindex(75),
            textured_qindex(75, false),
            textured_qindex(75, true),
        ] {
            let calibrated = original - medium_luma_reduction();
            assert_eq!(
                steps(calibrated as u8, selected_deltas, Plane::UV),
                steps(original as u8, original_deltas, Plane::UV)
            );
            assert_eq!(lambda_for_quality(original, 75), lambda_for_q(original));
        }
        assert_eq!((qindex(75), smooth_qindex(75)), (22, 6));
        assert_eq!((original_deltas.uv_dc, original_deltas.uv_ac), (-9, -9));
        assert_eq!((selected_deltas.uv_dc, selected_deltas.uv_ac), (-7, -7));
        for quality in [60, 85] {
            assert_eq!(smooth_qindex(quality), 6);
        }
        assert_eq!((qindex(60), qindex(85)), (40, 8));
        assert_eq!(
            (textured_qindex(60, false), textured_qindex(85, false)),
            (32, 14)
        );
    }

    #[test]
    fn frame_profile_uses_strict_visible_pixel_threshold_only_at_q60() {
        let threshold = 4096 * 3 * 5 * 3;
        assert_eq!(frame_deltas(60, threshold, 5, 3), deltas(60));
        let selected = frame_deltas(60, threshold + 1, 5, 3);
        assert_eq!((selected.uv_dc, selected.uv_ac), HIGH_CHROMA_LOSS_UV_DELTAS);
        assert!(!high_chroma_loss(60, threshold, 5, 3));
        assert!(high_chroma_loss(60, threshold + 1, 5, 3));
        for quality in [75, 85] {
            assert_eq!(frame_deltas(quality, u64::MAX, 5, 3), deltas(quality));
            assert!(!high_chroma_loss(quality, u64::MAX, 5, 3));
        }
        assert_eq!(frame_deltas(60, u64::MAX, u32::MAX, u32::MAX), deltas(60));
    }

    #[test]
    fn medium_high_import_uses_common_uv_ac_grid_only_above_the_visible_threshold() {
        use crate::ac_quant::{steps, Plane};

        let visible = (5, 3);
        let threshold = 4096 * 3 * 5 * 3;
        let textured = [0, 0, 0, 1];
        for (quality, counts, total, error) in [
            (75, textured, 1, threshold - 1),
            (75, textured, 1, threshold),
            (75, [1, 0, 0, 1], 2, threshold + 1),
            (75, [0; 4], 0, threshold + 1),
            (60, textured, 1, threshold + 1),
            (85, textured, 1, threshold + 1),
        ] {
            let before = deltas(quality);
            assert_eq!(
                medium_high_import_deltas(before, quality, counts, total, error, visible, 28),
                before
            );
        }
        let before = deltas(75);
        for neutral in [false, true] {
            let base = textured_qindex(75, neutral);
            let selected =
                medium_high_import_deltas(before, 75, textured, 1, threshold + 1, visible, base);
            assert_eq!(base as i8 + selected.uv_ac, 32);
            assert_eq!(selected.uv_dc, before.uv_dc);
            for plane in [Plane::Y1, Plane::Y2] {
                assert_eq!(
                    steps(base as u8, selected, plane),
                    steps(base as u8, before, plane)
                );
            }
            let original_uv = steps(base as u8, before, Plane::UV);
            let selected_uv = steps(base as u8, selected, Plane::UV);
            assert_eq!(selected_uv.dc, original_uv.dc);
            assert!(selected_uv.ac > original_uv.ac);
        }
    }

    #[test]
    fn chroma_edge_control_changes_only_uv_ac_on_the_existing_plane_cutoff() {
        let textured = [0, 0, 0, 1];
        let at_cutoff = CurvatureTotals {
            sums: [2 * 448, 2 * 96, 2 * 96],
            ..Default::default()
        };
        let chroma_edge = CurvatureTotals {
            sums: [2 * 448, 2 * 96 + 1, 2 * 96],
            ..Default::default()
        };
        let luma_edge = CurvatureTotals {
            sums: [2 * 448 + 1, 2 * 96 + 1, 2 * 96],
            ..Default::default()
        };
        for (quality, base, target) in [(60, 32, -4), (75, 26, 0), (85, 14, 0)] {
            let original = deltas(quality);
            let expected = Deltas {
                uv_ac: target,
                ..original
            };
            assert_eq!(
                chroma_edge_uv_ac_deltas(original, base, textured, chroma_edge, (16, 16)),
                expected
            );
            let high_import = Deltas {
                uv_ac: 4,
                ..original
            };
            assert_eq!(
                chroma_edge_uv_ac_deltas(high_import, base, textured, chroma_edge, (16, 16)),
                high_import
            );
            for (counts, totals, visible) in [
                (textured, at_cutoff, (16, 16)),
                (textured, luma_edge, (16, 16)),
                (textured, chroma_edge, (15, 16)),
                (textured, chroma_edge, (16, 15)),
                ([1, 0, 0, 0], chroma_edge, (16, 16)),
                ([0; 4], chroma_edge, (16, 16)),
            ] {
                assert_eq!(
                    chroma_edge_uv_ac_deltas(original, base, counts, totals, visible),
                    original
                );
            }
        }
    }

    #[test]
    fn one_rough_chroma_plane_coarsens_only_uv_ac_at_two_presets() {
        let textured = [0, 0, 0, 1];
        let rough = CurvatureTotals {
            sums: [897, 192, 193],
            ..Default::default()
        };
        let rough_u = CurvatureTotals {
            sums: [897, 193, 192],
            ..Default::default()
        };
        for (quality, expected_ac) in [(60, -7), (75, -9), (85, -3)] {
            let original = deltas(quality);
            let expected = Deltas {
                uv_ac: expected_ac,
                ..original
            };
            for totals in [rough, rough_u] {
                assert_eq!(
                    rough_chroma_deltas(original, quality, textured, totals, false, (16, 16)),
                    expected
                );
            }
            for (counts, totals, high_loss, visible) in [
                (
                    textured,
                    CurvatureTotals {
                        sums: [896, 0, 193],
                        ..Default::default()
                    },
                    false,
                    (16, 16),
                ),
                (
                    textured,
                    CurvatureTotals {
                        sums: [897, 0, 192],
                        ..Default::default()
                    },
                    false,
                    (16, 16),
                ),
                (
                    textured,
                    CurvatureTotals {
                        sums: [903, 0, 193],
                        ..Default::default()
                    },
                    false,
                    (16, 16),
                ),
                (
                    textured,
                    CurvatureTotals {
                        sums: [897, 193, 193],
                        ..Default::default()
                    },
                    false,
                    (16, 16),
                ),
                (textured, rough, false, (15, 16)),
                (textured, rough, false, (16, 15)),
                (textured, rough, true, (16, 16)),
                ([0; 4], rough, false, (16, 16)),
                ([1, 0, 0, 1], rough, false, (32, 16)),
            ] {
                assert_eq!(
                    rough_chroma_deltas(original, quality, counts, totals, high_loss, visible),
                    original
                );
            }
        }
        let already_coarse = Deltas {
            uv_dc: -4,
            uv_ac: 4,
            ..Deltas::default()
        };
        for quality in [60, 75, 85] {
            assert_eq!(
                rough_chroma_deltas(already_coarse, quality, textured, rough, false, (16, 16)),
                already_coarse
            );
        }
    }

    #[test]
    fn mixed_rough_chroma_uses_the_low_quality_ac_midpoint() {
        let rough = CurvatureTotals {
            sums: [1800, 500, 500],
            ..Default::default()
        };
        for (quality, counts, high_loss, visible, expected) in [
            (60, [0, 0, 1, 1], false, (32, 16), -7),
            (60, [0, 0, 1, 1], true, (32, 16), -11),
            (60, [0, 0, 1, 1], false, (32, 15), -11),
            (60, [1, 0, 0, 1], false, (32, 16), -11),
            (75, [0, 0, 1, 1], false, (32, 16), -9),
            (85, [0, 0, 1, 1], false, (32, 16), -4),
        ] {
            let before = deltas(quality);
            let actual = rough_chroma_deltas(before, quality, counts, rough, high_loss, visible);
            assert_eq!(
                actual,
                Deltas {
                    uv_ac: expected,
                    ..before
                }
            );
        }
    }

    #[test]
    fn q85_smooth_textured_coarsens_only_uv_ac_under_the_map_allowance() {
        use crate::ac_quant::{steps, Plane};

        let mixed = [1, 0, 0, 1];
        for (quality, counts, neutral, omit) in [
            (60, mixed, false, false),
            (75, mixed, false, false),
            (85, mixed, true, false),
            (85, mixed, false, true),
            (85, [1, 1, 0, 0], false, false),
            (85, [1, 1, 0, 1], false, false),
            (85, [1, 0, 1, 1], false, false),
            (85, [1, 0, 0, 0], false, false),
            (85, [0, 0, 0, 1], false, false),
        ] {
            let before = deltas(quality);
            assert_eq!(
                q85_smooth_textured_deltas(before, quality, counts, neutral, omit),
                before
            );
        }
        let before = deltas(85);
        let selected = q85_smooth_textured_deltas(before, 85, mixed, false, false);
        assert_eq!(
            selected,
            Deltas {
                uv_ac: -3,
                ..before
            }
        );
        for qindex in [6, 14] {
            for plane in [Plane::Y1, Plane::Y2] {
                assert_eq!(steps(qindex, selected, plane), steps(qindex, before, plane));
            }
            let original = steps(qindex, before, Plane::UV);
            let proposed = steps(qindex, selected, Plane::UV);
            assert_eq!(proposed.dc, original.dc);
            assert_eq!(proposed.ac, original.ac + 1);
        }
    }

    #[test]
    fn medium_profile_requires_all_textured_and_nonsevere_visible_import() {
        let threshold = 4096 * 3 * 5 * 3;
        assert!(medium_textured_luma(75, [0, 0, 0, 4], 4, threshold, 5, 3));
        for (counts, total, error) in [
            ([0, 0, 0, 4], 4, threshold + 1),
            ([1, 0, 0, 3], 4, threshold),
            ([0, 0, 0, 0], 0, 0),
        ] {
            assert!(!medium_textured_luma(75, counts, total, error, 5, 3));
        }
        for quality in [60, 85] {
            assert!(!medium_textured_luma(quality, [0, 0, 0, 4], 4, 0, 5, 3));
        }
        assert!(!medium_textured_luma(
            75,
            [0, 0, 0, 4],
            4,
            u64::MAX,
            u32::MAX,
            u32::MAX
        ));
    }
}
