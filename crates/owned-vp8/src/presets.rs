// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory encoder knobs, calibrated only against the frozen tuning split.
use crate::ac_quant::Deltas;

pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
pub(crate) const SMOOTH_QINDEX: usize = 6;
pub(crate) const CHROMATIC_SMOOTH_QINDEX: [usize; 3] = [8, 8, 8];
pub(crate) const TEXTURED_QINDEX: [usize; 3] = [30, 23, 14];
pub(crate) const UV_DC_DELTA: [i8; 3] = [0, -4, -4];
pub(crate) const UV_AC_DELTA: [i8; 3] = [0, -4, -4];
pub(crate) const LAMBDA_NUMERATOR: u64 = 1;
pub(crate) const LAMBDA_DENOMINATOR: u64 = 1;
pub(crate) fn qindex(quality: u32) -> usize {
    QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn textured_qindex(quality: u32) -> usize {
    TEXTURED_QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn chromatic_smooth_qindex(quality: u32) -> usize {
    CHROMATIC_SMOOTH_QINDEX[match quality {
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
pub(crate) fn lambda_for_q(qindex: usize) -> u64 {
    let q = qindex as u64 + 8;
    (q * q / 4) * LAMBDA_NUMERATOR / LAMBDA_DENOMINATOR
}
