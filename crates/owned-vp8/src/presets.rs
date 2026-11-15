// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory knobs calibrated on tuning and explicitly exposed regressions.
// Only a prospectively frozen fresh cohort can establish acceptance.
use crate::ac_quant::Deltas;

pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
const SMOOTH_QINDEX: usize = 6;
const MEDIUM_LUMA_REDUCTION: usize = 2;

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

pub(crate) fn medium_textured_deltas(mut original: Deltas) -> Deltas {
    original.uv_dc += MEDIUM_LUMA_REDUCTION as i8;
    original.uv_ac += MEDIUM_LUMA_REDUCTION as i8;
    original
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

fn chroma_loss_limit(width: u32, height: u32) -> Option<u64> {
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
