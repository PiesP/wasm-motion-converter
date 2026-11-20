// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

use super::{
    display_rgb, encode_status, filter_completed_one, FilterConfig, Macroblock, SegmentConfig,
};
use crate::limits::Status;

pub(super) const MAX_BLOCKS: usize = 4;
const LEVEL_STRIDE: u8 = 4;
// floor(1e6 * 10^(0.1/10)) keeps the allowed PSNR loss below 0.1 dB.
const SSD_SCALE: u64 = 1_000_000;
const SSD_LIMIT: u64 = 1_023_292;

#[derive(Clone, Copy)]
enum Phase {
    Initialize,
    Copy(usize),
    Filter(usize),
    Error,
    Moments,
    Release,
}

pub(super) struct Frame<'a> {
    pub visible: (usize, usize),
    pub padded: (usize, usize),
    pub original: display_rgb::Original<'a>,
    pub reconstructed: [&'a [u8]; 3],
    pub scratch: [&'a mut [u8]; 3],
    pub blocks: &'a [Macroblock],
    pub segments: SegmentConfig,
}

pub(super) struct Search {
    incumbent: FilterConfig,
    level: u8,
    next_level: u8,
    max_level: u8,
    completed: u32,
    total: u32,
    phase: Phase,
    incumbent_error: u64,
    best_score: f64,
    best_level: u8,
    score: display_rgb::CompleteScore,
}

impl Search {
    pub(super) fn new(
        incumbent: FilterConfig,
        radius: u8,
        width: usize,
        height: usize,
    ) -> Result<Self, Status> {
        let radius = radius / LEVEL_STRIDE * LEVEL_STRIDE;
        let lower = i16::from(incumbent.level) - i16::from(radius);
        let min_level = if lower > 0 {
            lower as u8
        } else {
            ((lower - 1).rem_euclid(i16::from(LEVEL_STRIDE)) + 1) as u8
        };
        let max_level = incumbent.level.saturating_add(radius).min(63);
        let score =
            display_rgb::CompleteScore::new(width, height).ok_or(Status::MemoryAdmission)?;
        Ok(Self {
            incumbent,
            level: incumbent.level,
            next_level: min_level,
            max_level,
            completed: 0,
            total: u32::from((max_level - min_level) / LEVEL_STRIDE + 1),
            phase: Phase::Initialize,
            incumbent_error: 0,
            best_score: f64::NEG_INFINITY,
            best_level: incumbent.level,
            score,
        })
    }

    pub(super) fn progress(&self) -> (u32, u32) {
        (self.completed, self.total)
    }

    fn next_trial(&mut self) {
        self.completed += 1;
        if self.next_level == self.incumbent.level {
            self.next_level += LEVEL_STRIDE;
        }
        if self.next_level > self.max_level {
            self.phase = Phase::Release;
        } else {
            self.level = self.next_level;
            self.next_level += LEVEL_STRIDE;
            self.score.reset();
            self.phase = Phase::Copy(0);
        }
    }

    pub(super) fn advance(&mut self, frame: Frame<'_>) -> Result<Option<FilterConfig>, Status> {
        let Frame {
            visible: (width, height),
            padded: (padded_width, padded_height),
            original,
            reconstructed,
            scratch: [y, u, v],
            blocks,
            segments,
        } = frame;
        match self.phase {
            Phase::Initialize => {
                if !self.score.initialize_chunk() {
                    return Err(Status::MemoryAdmission);
                }
                if self.score.initialized() {
                    self.phase = Phase::Copy(0);
                }
            }
            Phase::Copy(plane) => {
                [y, u, v][plane].copy_from_slice(reconstructed[plane]);
                self.phase = if plane == 2 {
                    Phase::Filter(0)
                } else {
                    Phase::Copy(plane + 1)
                };
            }
            Phase::Filter(block) => {
                filter_completed_one(
                    y,
                    u,
                    v,
                    padded_width,
                    padded_height,
                    block,
                    blocks,
                    segments,
                    FilterConfig {
                        level: self.level,
                        ..self.incumbent
                    },
                )
                .map_err(encode_status)?;
                self.phase = if block + 1 == blocks.len() {
                    Phase::Error
                } else {
                    Phase::Filter(block + 1)
                };
            }
            Phase::Error | Phase::Moments => {
                let view = display_rgb::CompleteFrame::checked(
                    width,
                    height,
                    padded_width,
                    original,
                    y,
                    u,
                    v,
                )
                .ok_or(Status::InvalidInput)?;
                if matches!(self.phase, Phase::Error) {
                    let error = view.squared_error_chunk(0, width * height);
                    if self.level == self.incumbent.level {
                        self.incumbent_error = error;
                    }
                    // At most four padded blocks, or 1,024 visible pixels.
                    if error * SSD_SCALE > self.incumbent_error * SSD_LIMIT {
                        self.next_trial();
                    } else {
                        self.phase = Phase::Moments;
                    }
                } else {
                    self.score.advance(&view);
                    let (done, total) = self.score.progress();
                    if done == total {
                        let score = self.score.finish().ok_or(Status::InvalidInput)?;
                        if score > self.best_score {
                            self.best_score = score;
                            self.best_level = self.level;
                        }
                        self.next_trial();
                    }
                }
            }
            Phase::Release => {
                if self.score.release_one_chunk() {
                    return Ok(Some(FilterConfig {
                        level: self.best_level,
                        ..self.incumbent
                    }));
                }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_filter_prefers_the_first_better_strength_and_respects_the_ssd_limit() {
        let (width, height) = (32, 16);
        let incumbent = FilterConfig::for_quality(60);
        let blocks = [Macroblock::default(); 2];
        let segments = SegmentConfig::from_counts(60, [2, 0, 0, 0], 2, true);
        let y: Vec<_> = (0..width * height)
            .map(|index| if index % width < 16 { 92 } else { 112 })
            .collect();
        let uv = [128; 128];
        let mut target = y.clone();
        let mut work_u = uv;
        let mut work_v = uv;
        // A 20-level seam first passes the positive four-step grid at 18.
        for block in 0..blocks.len() {
            filter_completed_one(
                &mut target,
                &mut work_u,
                &mut work_v,
                width,
                height,
                block,
                &blocks,
                segments,
                FilterConfig {
                    level: 18,
                    ..incumbent
                },
            )
            .unwrap();
        }
        assert_ne!(target, y);
        for (original_y, expected) in [(&target, 18), (&y, incumbent.level)] {
            let original: Vec<_> = original_y
                .iter()
                .flat_map(|&luma| {
                    // The completed RGB proxy has no chroma terms at neutral UV.
                    let gray = ((76_309 * (i32::from(luma) - 16) + (1 << 15)) >> 16) as u8;
                    [gray, gray, gray, 255]
                })
                .collect();
            let mut scratch = [0; 512];
            let mut search = Search::new(incumbent, 32, width, height).unwrap();
            let mut steps = 0;
            loop {
                let before = search.progress();
                let final_config = search
                    .advance(Frame {
                        visible: (width, height),
                        padded: (width, height),
                        original: display_rgb::Original {
                            pixels: &original,
                            stride: width * 4,
                            layout: 0,
                        },
                        reconstructed: [&y, &uv, &uv],
                        scratch: [&mut scratch, &mut work_u, &mut work_v],
                        blocks: &blocks,
                        segments,
                    })
                    .unwrap();
                steps += 1;
                assert!(steps <= 100);
                let after = search.progress();
                assert_eq!(before.1, 10);
                assert_eq!(before.1, after.1);
                assert!(after.0 >= before.0 && after.0 - before.0 <= 1);
                if let Some(config) = final_config {
                    assert_eq!(config.level, expected);
                    assert_eq!(after, (10, 10));
                    break;
                }
            }
        }
    }
}
