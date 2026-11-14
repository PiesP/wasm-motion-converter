// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory encoder knobs, calibrated only against the frozen tuning split.
pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
pub(crate) const SMOOTH_QINDEX: usize = 6;
pub(crate) const TEXTURED_QINDEX: [usize; 3] = [30, 23, 14];
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
pub(crate) fn lambda_for_q(qindex: usize) -> u64 {
    let q = qindex as u64 + 8;
    (q * q / 4) * LAMBDA_NUMERATOR / LAMBDA_DENOMINATOR
}
