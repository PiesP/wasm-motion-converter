// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Two absolute VP8 quantizer segments. Bit syntax follows RFC 6386 section 9.3
// and the reference decoder's SEGMENT_ABSDATA=1 definition.

use crate::{presets, rate::BoolSink, EncodeError};

pub(crate) const SMOOTH: u8 = 0;
pub(crate) const TEXTURED: u8 = 1;

#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub enabled: bool,
    pub base_qindex: usize,
    pub qindex: [usize; 2],
    pub map_probability: u8,
}

impl Config {
    pub(crate) fn nonsegmented(qindex: usize) -> Self {
        Self {
            enabled: false,
            base_qindex: qindex,
            qindex: [qindex; 2],
            map_probability: 255,
        }
    }

    pub(crate) fn from_counts(quality: u32, smooth_count: usize, total: usize) -> Self {
        let textured = presets::textured_qindex(quality);
        let smooth = presets::SMOOTH_QINDEX;
        let enabled = smooth_count > 0 && smooth_count < total && smooth != textured;
        let base_qindex = if smooth_count == total {
            smooth
        } else {
            textured
        };
        let map_probability = if enabled {
            ((smooth_count * 256 + total / 2) / total).clamp(1, 255) as u8
        } else {
            255
        };
        Self {
            enabled,
            base_qindex,
            qindex: [smooth, textured],
            map_probability,
        }
    }

    pub(crate) fn qindex_for(self, id: u8) -> usize {
        self.qindex[id as usize]
    }

    pub(crate) fn write_header(self, sink: &mut impl BoolSink) -> Result<(), EncodeError> {
        sink.bit(self.enabled)?;
        if !self.enabled {
            return Ok(());
        }
        sink.bit(true)?; // Fresh keyframe segmentation map.
        sink.bit(true)?; // Fresh segment feature data.
        sink.bit(true)?; // Absolute quantizer values (SEGMENT_ABSDATA).
        for id in 0..4 {
            sink.bit(id < 2)?;
            if id < 2 {
                sink.literal(self.qindex[id] as u32, 7)?;
                sink.bit(false)?; // Positive value.
            }
        }
        for _ in 0..4 {
            sink.bit(false)?;
        } // No loop-filter overrides.
        sink.bit(false)?; // Root probability stays 255.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probability), 8)?; // IDs 0/1 branch.
        sink.bit(false)?; // Unused IDs 2/3 branch stays 255.
        Ok(())
    }

    pub(crate) fn write_id(self, sink: &mut impl BoolSink, id: u8) -> Result<(), EncodeError> {
        if self.enabled {
            if id > TEXTURED {
                return Err(EncodeError::InvalidInput);
            }
            sink.write(255, false)?; // Enter the 0/1 subtree.
            sink.write(self.map_probability, id == TEXTURED)?;
        }
        Ok(())
    }
}

/// Maximum absolute second difference inside each Y/UV macroblock tile.
/// A linear ramp or flat tile has curvature at most two after integer YUV
/// rounding; texture and hard edges exceed it. Tile boundaries are excluded
/// so source padding cannot create a false edge at an image boundary.
pub(crate) fn classify(y: &[u8], u: &[u8], v: &[u8], y_stride: usize, mx: usize, my: usize) -> u8 {
    fn smooth_tile(plane: &[u8], stride: usize, x: usize, y: usize, size: usize) -> bool {
        for row in 0..size {
            for col in 1..size - 1 {
                let at = (y + row) * stride + x + col;
                let curvature =
                    i32::from(plane[at - 1]) - 2 * i32::from(plane[at]) + i32::from(plane[at + 1]);
                if curvature.abs() > 2 {
                    return false;
                }
            }
        }
        for row in 1..size - 1 {
            for col in 0..size {
                let at = (y + row) * stride + x + col;
                let curvature = i32::from(plane[at - stride]) - 2 * i32::from(plane[at])
                    + i32::from(plane[at + stride]);
                if curvature.abs() > 2 {
                    return false;
                }
            }
        }
        true
    }
    if smooth_tile(y, y_stride, mx * 16, my * 16, 16)
        && smooth_tile(u, y_stride / 2, mx * 8, my * 8, 8)
        && smooth_tile(v, y_stride / 2, mx * 8, my * 8, 8)
    {
        SMOOTH
    } else {
        TEXTURED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_class_counts_collapse_or_signal_two_absolute_qindices() {
        for (quality, textured) in [(60, 30), (75, 23), (85, 14)] {
            let smooth = Config::from_counts(quality, 4, 4);
            assert!(!smooth.enabled);
            assert_eq!(smooth.base_qindex, presets::SMOOTH_QINDEX);
            let texture = Config::from_counts(quality, 0, 4);
            assert!(!texture.enabled);
            assert_eq!(texture.base_qindex, textured);
            let mixed = Config::from_counts(quality, 2, 4);
            assert!(mixed.enabled);
            assert_eq!(mixed.qindex, [presets::SMOOTH_QINDEX, textured]);
            assert_eq!(mixed.map_probability, 128);
        }
    }

    #[test]
    fn smoothness_uses_curvature_of_all_three_source_planes() {
        let y: Vec<_> = (0..16)
            .flat_map(|row| (0..32).map(move |col| (80 + row + col) as u8))
            .collect();
        let uv = vec![128; 16 * 8];
        assert_eq!(classify(&y, &uv, &uv, 32, 0, 0), SMOOTH);
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
}
