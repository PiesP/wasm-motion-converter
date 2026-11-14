// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Exploratory encoder knobs, calibrated only against the frozen tuning split.
pub(crate) const QINDEX: [usize; 3] = [40, 22, 8];
pub(crate) const LAMBDA_NUMERATOR: u64 = 1;
pub(crate) const LAMBDA_DENOMINATOR: u64 = 1;
pub(crate) fn qindex(quality: u32) -> usize {
    QINDEX[match quality {
        60 => 0,
        75 => 1,
        _ => 2,
    }]
}
pub(crate) fn lambda(quality: u32) -> u64 {
    let q = qindex(quality) as u64 + 8;
    (q * q / 4) * LAMBDA_NUMERATOR / LAMBDA_DENOMINATOR
}
