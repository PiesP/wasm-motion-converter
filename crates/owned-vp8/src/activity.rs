// SPDX-License-Identifier: MIT AND BSD-3-Clause
// Copyright (c) 2026 PiesP
// Activity analysis and segment allocation follow libwebp 1.3.2 (6c484cbf),
// Copyright (c) 2011 Google Inc. See ../LICENSE.libwebp and ../PATENTS.libwebp.

use crate::ac_quant::{Deltas, AC_QUANT};
use crate::prediction::{self, LargeMode};
use crate::segmentation::Config;
use crate::transform;
use std::array;

// Maximum ceil(width / 16) * ceil(height / 16) over the admitted geometry
// selected by limits::MAX_DIMENSION and limits::MAX_PIXELS.
pub(super) const MAP_CAPACITY_BYTES: usize = 40_280;

const QUANTIZERS: [[u8; 255]; 3] = [
    [
        45, 45, 45, 45, 45, 44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 43, 43, 43, 43, 43, 43, 43,
        43, 43, 43, 43, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 41, 41, 41, 41, 41, 41, 41, 41,
        41, 41, 41, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 39, 39, 39, 39, 39, 39, 39, 39, 39,
        39, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 36,
        36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 34, 34, 34,
        34, 34, 34, 34, 34, 34, 34, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 32, 32, 32, 32, 32, 32,
        32, 32, 32, 32, 31, 31, 31, 31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
        29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 28, 28, 28, 28, 28, 28, 28, 28, 28, 27, 27, 27, 27,
        27, 27, 27, 27, 27, 26, 26, 26, 26, 26, 26, 26, 26, 26, 26, 25, 25, 25, 25, 25, 25, 25, 25,
        25, 24, 24, 24, 24, 24, 24, 24, 24, 24, 23, 23, 23, 23, 23, 23, 23, 23, 23, 22, 22, 22, 22,
        22, 22, 22, 22, 22, 21, 21, 21, 21, 21, 21, 21, 21, 21, 20, 20, 20, 20, 20, 20, 20, 20, 19,
        19, 19,
    ],
    [
        36, 36, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 34, 34, 34, 34, 34, 34, 34, 34,
        34, 34, 34, 34, 34, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 32, 32, 32, 32,
        32, 32, 32, 32, 32, 32, 32, 32, 32, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 30, 30,
        30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29,
        29, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27,
        27, 27, 27, 26, 26, 26, 26, 26, 26, 26, 26, 26, 26, 26, 26, 25, 25, 25, 25, 25, 25, 25, 25,
        25, 25, 25, 25, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 23, 23, 23, 23, 23, 23, 23,
        23, 23, 23, 23, 23, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 21, 21, 21, 21, 21, 21,
        21, 21, 21, 21, 21, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 19, 19, 19, 19, 19, 19,
        19, 19, 19, 19, 19, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 17, 17, 17, 17, 17, 17,
        17, 17, 17, 17, 17, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 15, 15, 15, 15, 15, 15, 15,
        15, 15,
    ],
    [
        20, 20, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
        19, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18,
        17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 16,
        16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 15, 15,
        15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 14, 14, 14, 14,
        14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 13, 13, 13, 13, 13,
        13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 12, 12, 12, 12, 12, 12, 12,
        12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11,
        11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
        10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
        9, 9, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    ],
];

pub(super) struct Activity {
    alpha: Vec<u8>,
    histogram: [u32; 256],
    uv_total: i64,
    allocation: Option<Allocation>,
}

struct Allocation {
    config: Config,
    deltas: Deltas,
    alpha_to_id: [u8; 256],
}

impl Activity {
    pub(super) fn new(count: usize) -> Option<Self> {
        let mut alpha = Vec::new();
        if cfg!(feature = "activity-allocation") {
            if count > MAP_CAPACITY_BYTES {
                return None;
            }
            alpha.try_reserve_exact(count).ok()?;
            if !(count..=MAP_CAPACITY_BYTES).contains(&alpha.capacity()) {
                return None;
            }
        }
        Some(Self {
            alpha,
            histogram: [0; 256],
            uv_total: 0,
            allocation: None,
        })
    }

    pub(super) fn observe(
        &mut self,
        y: &[u8],
        u: &[u8],
        v: &[u8],
        stride: usize,
        mx: usize,
        my: usize,
    ) {
        if self.alpha.capacity() == 0 {
            return;
        }
        let mut y_alpha = 0;
        let mut uv_alpha = 0;
        for mode in [LargeMode::Dc, LargeMode::TrueMotion] {
            let mut luma = [0; 32];
            let plane = Plane { pixels: y, stride };
            let (x, y) = (mx * 16, my * 16);
            let pred = plane.predict::<16, 256>(x, y, mode, prediction::predict_large);
            plane.observe_block(x, y, 16, &pred, &mut luma);
            y_alpha = y_alpha.max(susceptibility(&luma));

            let mut chroma = [0; 32];
            let (x, y) = (mx * 8, my * 8);
            for pixels in [u, v] {
                let plane = Plane {
                    pixels,
                    stride: stride / 2,
                };
                let pred = plane.predict::<8, 64>(x, y, mode, prediction::predict_uv);
                plane.observe_block(x, y, 8, &pred, &mut chroma);
            }
            uv_alpha = uv_alpha.max(susceptibility(&chroma));
        }
        let alpha = (255 - ((3 * y_alpha + uv_alpha + 2) >> 2)).clamp(0, 255) as u8;
        debug_assert!(self.alpha.len() < self.alpha.capacity());
        self.alpha.push(alpha);
        self.histogram[alpha as usize] += 1;
        self.uv_total += i64::from(uv_alpha);
    }

    pub(super) fn finish(
        &mut self,
        quality: u32,
        allow: bool,
        near_neutral: bool,
        native_filter: bool,
    ) -> Option<(Config, Deltas)> {
        if !allow || self.alpha.is_empty() {
            self.alpha = Vec::new();
            return None;
        }
        self.allocation = self.plan(quality, near_neutral, native_filter);
        if self.allocation.is_none() {
            self.alpha = Vec::new();
        }
        self.allocation
            .as_ref()
            .map(|allocation| (allocation.config, allocation.deltas))
    }

    pub(super) fn selected(&self) -> bool {
        self.allocation.is_some()
    }

    pub(super) fn id(&self, index: usize, source_class: u8) -> u8 {
        self.allocation
            .as_ref()
            .map_or(source_class, |a| a.alpha_to_id[self.alpha[index] as usize])
    }

    pub(super) fn release_map(&mut self) {
        self.alpha = Vec::new();
        self.allocation = None;
    }

    fn plan(&self, quality: u32, near_neutral: bool, native_filter: bool) -> Option<Allocation> {
        let Cluster { alpha, beta, map } = cluster(&self.histogram);
        let qtable = &QUANTIZERS[match quality {
            60 => 0,
            75 => 1,
            85 => 2,
            _ => return None,
        }];
        let mut groups = [(0usize, 0u8); 4];
        let mut quantizers = [0usize; 4];
        let mut remap = [0u8; 4];
        let mut len = 0;
        // Native group equivalence uses both the quantizer and the initial
        // filter. Retain these initial levels for the selected coding IDs.
        for i in 0..4 {
            let q = qtable[(alpha[i] + 127) as usize] as usize;
            let strength = (AC_QUANT[q] >> 2).min(63) * 300 / (256 + beta[i]);
            let strength = if strength < 2 {
                0
            } else {
                strength.min(63) as u8
            };
            let group = (q, strength);
            let id = groups[..len]
                .iter()
                .position(|&g| g == group)
                .unwrap_or(len);
            if id == len {
                groups[id] = group;
                quantizers[id] = q;
                len += 1;
            }
            remap[i] = id as u8;
        }
        let last = quantizers[len - 1];
        quantizers[len..].fill(last);
        let last = groups[len - 1];
        groups[len..].fill(last);
        let map = map.map(|group| remap[group as usize]);
        let mut counts = [0usize; 4];
        for (value, samples) in self.histogram.into_iter().enumerate() {
            counts[map[value] as usize] += samples as usize;
        }
        let first = counts.iter().position(|&n| n != 0)?;
        if counts
            .iter()
            .zip(quantizers)
            .all(|(&n, q)| n == 0 || q == quantizers[first])
        {
            return None;
        }
        let levels = native_filter.then(|| groups.map(|(_, level)| level));
        let config = Config::from_activity(quantizers, counts, near_neutral, levels);
        let uv_alpha = (self.uv_total / self.alpha.len() as i64) as i32;
        let deltas = Deltas {
            uv_dc: -2,
            uv_ac: (((uv_alpha - 64) * 10 / 70) * 50 / 100).clamp(-4, 6) as i8,
            ..Deltas::default()
        };
        Some(Allocation {
            config,
            deltas,
            alpha_to_id: map,
        })
    }
}

struct Plane<'a> {
    pixels: &'a [u8],
    stride: usize,
}

impl Plane<'_> {
    fn predict<const N: usize, const LEN: usize>(
        &self,
        x: usize,
        y: usize,
        mode: LargeMode,
        predictor: impl FnOnce(&[u8], &[u8], u8, bool, bool, LargeMode) -> [u8; LEN],
    ) -> [u8; LEN] {
        let top: [u8; N] = if y == 0 {
            [127; N]
        } else {
            let start = (y - 1) * self.stride + x;
            self.pixels[start..start + N].try_into().unwrap()
        };
        let left: [u8; N] = if x == 0 {
            [129; N]
        } else {
            array::from_fn(|i| self.pixels[(y + i) * self.stride + x - 1])
        };
        let corner = match (x != 0, y != 0) {
            (true, true) => self.pixels[(y - 1) * self.stride + x - 1],
            (false, true) => 129,
            (_, false) => 127,
        };
        predictor(&top, &left, corner, y != 0, x != 0, mode)
    }

    fn observe_block(&self, x: usize, y: usize, width: usize, pred: &[u8], bins: &mut [u16; 32]) {
        for by in (0..width).step_by(4) {
            for bx in (0..width).step_by(4) {
                let residual = array::from_fn(|i| {
                    let dx = bx + i % 4;
                    let dy = by + i / 4;
                    i16::from(self.pixels[(y + dy) * self.stride + x + dx])
                        - i16::from(pred[dy * width + dx])
                });
                for coeff in transform::forward(&residual) {
                    bins[(coeff.unsigned_abs() >> 3).min(31) as usize] += 1;
                }
            }
        }
    }
}

fn susceptibility(bins: &[u16; 32]) -> i32 {
    let largest = i32::from(*bins.iter().max().unwrap());
    if largest <= 1 {
        return 0;
    }
    let last = bins.iter().rposition(|&count| count != 0).unwrap();
    510 * last as i32 / largest
}

struct Cluster {
    alpha: [i32; 4],
    beta: [i32; 4],
    map: [u8; 256],
}

fn cluster(histogram: &[u32; 256]) -> Cluster {
    let lo = histogram.iter().position(|&n| n != 0).unwrap();
    let hi = histogram.iter().rposition(|&n| n != 0).unwrap();
    let mut centers: [i32; 4] = array::from_fn(|k| (lo + (2 * k + 1) * (hi - lo) / 8) as i32);
    let mut map = [0; 256];
    let mut weighted_center = 0;
    for _ in 0..6 {
        let mut weights = [0; 4];
        let mut values = [0; 4];
        let mut current = 0;
        for a in lo..=hi {
            if histogram[a] == 0 {
                continue;
            }
            let alpha = a as i32;
            while current + 1 < centers.len()
                && (alpha - centers[current + 1]).abs() < (alpha - centers[current]).abs()
            {
                current += 1;
            }
            map[a] = current as u8;
            let n = histogram[a] as i32;
            weights[current] += n;
            values[current] += alpha * n;
        }
        let mut movement = 0;
        let mut sum = 0;
        let mut total = 0;
        for i in 0..4 {
            let weight = weights[i];
            if weight > 0 {
                let center = (values[i] + weight / 2) / weight;
                movement += (centers[i] - center).abs();
                centers[i] = center;
                sum += center * weight;
                total += weight;
            }
        }
        weighted_center = (sum + total / 2) / total;
        if movement < 5 {
            break;
        }
    }
    let lo = *centers.iter().min().unwrap();
    let span = (*centers.iter().max().unwrap() - lo).max(1);
    Cluster {
        alpha: centers.map(|a| (255 * (a - weighted_center) / span).clamp(-127, 127)),
        beta: centers.map(|a| (255 * (a - lo) / span).clamp(0, 255)),
        map,
    }
}
