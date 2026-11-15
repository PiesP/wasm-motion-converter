// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory knobs calibrated on tuning and explicitly exposed regressions.
// Only a prospectively frozen fresh cohort can establish acceptance.
use crate::ac_quant::Deltas;

pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
pub(crate) const SMOOTH_QINDEX: usize = 6;
pub(crate) const CHROMATIC_FLAT_QINDEX: [usize; 3] = [14, 15, 10];
pub(crate) const CHROMATIC_RAMP_QINDEX: [usize; 3] = [28, 27, 15];
pub(crate) const TEXTURED_QINDEX: [usize; 3] = [30, 28, 14];
pub(crate) const TEXTURED_MONO_QINDEX: [usize; 3] = [34, 27, 14];
pub(crate) const UV_DC_DELTA: [i8; 3] = [-4, -9, -4];
pub(crate) const UV_AC_DELTA: [i8; 3] = [-15, -9, -4];
pub(crate) const FILTER_LEVEL: [u8; 3] = [6, 4, 4];
pub(crate) const LAMBDA_NUMERATOR: u64 = 1;
pub(crate) const LAMBDA_DENOMINATOR: u64 = 1;
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
