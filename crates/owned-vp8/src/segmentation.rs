// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Three absolute VP8 quantizer segments. Bit syntax follows RFC 6386 section 9.3
// and the reference decoder's SEGMENT_ABSDATA=1 definition.

use crate::{presets, rate::BoolSink, EncodeError};

pub(crate) const NEUTRAL_SMOOTH: u8 = 0;
pub(crate) const CHROMATIC_SMOOTH: u8 = 1;
pub(crate) const TEXTURED: u8 = 2;

#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub enabled: bool,
    pub base_qindex: usize,
    pub qindex: [usize; 3],
    pub map_probabilities: [u8; 2],
}

impl Config {
    pub(crate) fn nonsegmented(qindex: usize) -> Self {
        Self {
            enabled: false,
            base_qindex: qindex,
            qindex: [qindex; 3],
            map_probabilities: [255; 2],
        }
    }

    pub(crate) fn from_counts(quality: u32, counts: [usize; 3], total: usize) -> Self {
        debug_assert_eq!(counts.iter().sum::<usize>(), total);
        let qindex = [
            presets::SMOOTH_QINDEX,
            presets::chromatic_smooth_qindex(quality),
            presets::textured_qindex(quality),
        ];
        let enabled = counts.iter().filter(|&&count| count > 0).count() > 1;
        let base_qindex = qindex[counts.iter().position(|&count| count > 0).unwrap_or(2)];
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
            ]
        } else {
            [255; 2]
        };
        Self {
            enabled,
            base_qindex,
            qindex,
            map_probabilities,
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
            sink.bit(id < 3)?;
            if id < 3 {
                sink.literal(self.qindex[id] as u32, 7)?;
                sink.bit(false)?; // Positive value.
            }
        }
        for _ in 0..4 {
            sink.bit(false)?;
        } // No loop-filter overrides.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[0]), 8)?; // IDs 0/1 versus 2/3.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[1]), 8)?; // IDs 0 versus 1.
        sink.bit(false)?; // Unused IDs 2/3 branch stays 255.
        Ok(())
    }

    pub(crate) fn write_id(self, sink: &mut impl BoolSink, id: u8) -> Result<(), EncodeError> {
        if self.enabled {
            if id > TEXTURED {
                return Err(EncodeError::InvalidInput);
            }
            sink.write(self.map_probabilities[0], id == TEXTURED)?;
            if id == TEXTURED {
                sink.write(255, false)?; // ID 2 in the 2/3 subtree.
            } else {
                sink.write(self.map_probabilities[1], id == CHROMATIC_SMOOTH)?;
            }
        }
        Ok(())
    }
}

/// Curvature selects smooth tiles; neutral chroma then selects the finest
/// smooth class. Tile boundaries are excluded so padding cannot create edges.
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
        let uv_stride = y_stride / 2;
        for row in 0..8 {
            for col in 0..8 {
                let at = (my * 8 + row) * uv_stride + mx * 8 + col;
                if u[at].abs_diff(128) > 1 || v[at].abs_diff(128) > 1 {
                    return CHROMATIC_SMOOTH;
                }
            }
        }
        NEUTRAL_SMOOTH
    } else {
        TEXTURED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_class_counts_collapse_or_signal_three_absolute_qindices() {
        for (quality, chromatic, textured) in [(60, 8, 30), (75, 8, 23), (85, 8, 14)] {
            for (id, qindex) in [presets::SMOOTH_QINDEX, chromatic, textured]
                .into_iter()
                .enumerate()
            {
                let mut counts = [0; 3];
                counts[id] = 4;
                let single = Config::from_counts(quality, counts, 4);
                assert!(!single.enabled);
                assert_eq!(single.base_qindex, qindex);
            }
            let mixed = Config::from_counts(quality, [1, 1, 2], 4);
            assert!(mixed.enabled);
            assert_eq!(mixed.qindex, [presets::SMOOTH_QINDEX, chromatic, textured]);
            assert_eq!(mixed.map_probabilities, [128, 128]);
        }
    }

    #[test]
    fn smoothness_uses_curvature_of_all_three_source_planes() {
        let y: Vec<_> = (0..16)
            .flat_map(|row| (0..32).map(move |col| (80 + row + col) as u8))
            .collect();
        let uv = vec![128; 16 * 8];
        assert_eq!(classify(&y, &uv, &uv, 32, 0, 0), NEUTRAL_SMOOTH);
        let chromatic_u = vec![126; 16 * 8];
        assert_eq!(classify(&y, &chromatic_u, &uv, 32, 0, 0), CHROMATIC_SMOOTH);
        let chromatic_v = vec![130; 16 * 8];
        assert_eq!(classify(&y, &uv, &chromatic_v, 32, 0, 0), CHROMATIC_SMOOTH);
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
    fn all_three_ids_use_the_signaled_map_tree() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let config = Config::from_counts(75, [1, 1, 1], 3);
        for (id, expected) in [
            (NEUTRAL_SMOOTH, [(171, false), (128, false)]),
            (CHROMATIC_SMOOTH, [(171, false), (128, true)]),
            (TEXTURED, [(171, true), (255, false)]),
        ] {
            let mut operations = Operations(Vec::new());
            config.write_id(&mut operations, id).unwrap();
            assert_eq!(operations.0, expected);
        }
        assert_eq!(
            config.write_id(&mut Operations(Vec::new()), 3),
            Err(EncodeError::InvalidInput)
        );
    }
}
