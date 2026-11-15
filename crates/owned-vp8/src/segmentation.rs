// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Four absolute VP8 quantizer segments. Bit syntax follows RFC 6386 section 9.3
// and the reference decoder's SEGMENT_ABSDATA=1 definition.

use crate::{presets, rate::BoolSink, EncodeError};

pub(crate) const FINE_SMOOTH: u8 = 0;
pub(crate) const CHROMATIC_FLAT: u8 = 1;
pub(crate) const CHROMATIC_RAMP: u8 = 2;
pub(crate) const TEXTURED: u8 = 3;

#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub enabled: bool,
    pub base_qindex: usize,
    pub qindex: [usize; 4],
    pub map_probabilities: [u8; 3],
    active: [bool; 4],
}

impl Config {
    pub(crate) fn nonsegmented(qindex: usize) -> Self {
        Self {
            enabled: false,
            base_qindex: qindex,
            qindex: [qindex; 4],
            map_probabilities: [255; 3],
            active: [false; 4],
        }
    }

    pub(crate) fn from_counts(
        quality: u32,
        counts: [usize; 4],
        total: usize,
        neutral_chroma: bool,
    ) -> Self {
        debug_assert_eq!(counts.iter().sum::<usize>(), total);
        let qindex = [
            presets::smooth_qindex(quality),
            presets::chromatic_flat_qindex(quality),
            presets::chromatic_ramp_qindex(quality),
            presets::textured_qindex(quality, neutral_chroma),
        ];
        let enabled = counts.iter().filter(|&&count| count > 0).count() > 1;
        let base_qindex = qindex[counts.iter().position(|&count| count > 0).unwrap_or(3)];
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
                probability(counts[2], counts[2] + counts[3]),
            ]
        } else {
            [255; 3]
        };
        Self {
            enabled,
            base_qindex,
            qindex,
            map_probabilities,
            active: counts.map(|count| count > 0),
        }
    }

    pub(crate) fn qindex_for(self, id: u8) -> usize {
        self.qindex[id as usize]
    }

    pub(crate) fn write_header(
        self,
        sink: &mut impl BoolSink,
        filter_level: u8,
    ) -> Result<(), EncodeError> {
        if filter_level > 63 {
            return Err(EncodeError::InvalidInput);
        }
        sink.bit(self.enabled)?;
        if !self.enabled {
            return Ok(());
        }
        sink.bit(true)?; // Fresh keyframe segmentation map.
        sink.bit(true)?; // Fresh segment feature data.
        sink.bit(true)?; // Absolute quantizer values (SEGMENT_ABSDATA).
        for id in 0..4 {
            sink.bit(true)?;
            sink.literal(self.qindex[id] as u32, 7)?;
            sink.bit(false)?; // Positive value.
        }
        // Absolute segmentation replaces the frame's filter level. Signal
        // the same level for each active ID, leaving unused IDs at zero.
        for id in 0..4 {
            let active = self.active[id] && filter_level > 0;
            sink.bit(active)?;
            if active {
                sink.literal(u32::from(filter_level), 6)?;
                sink.bit(false)?; // Positive absolute value.
            }
        }
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[0]), 8)?; // IDs 0/1 versus 2/3.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[1]), 8)?; // IDs 0 versus 1.
        sink.bit(true)?;
        sink.literal(u32::from(self.map_probabilities[2]), 8)?; // IDs 2 versus 3.
        Ok(())
    }

    pub(crate) fn write_id(self, sink: &mut impl BoolSink, id: u8) -> Result<(), EncodeError> {
        if self.enabled {
            if id > TEXTURED {
                return Err(EncodeError::InvalidInput);
            }
            sink.write(self.map_probabilities[0], id >= CHROMATIC_RAMP)?;
            if id >= CHROMATIC_RAMP {
                sink.write(self.map_probabilities[2], id == TEXTURED)?;
            } else {
                sink.write(self.map_probabilities[1], id == CHROMATIC_FLAT)?;
            }
        }
        Ok(())
    }
}

/// Curvature selects smooth tiles. Chroma neutrality or three constant planes
/// select the finest class; otherwise range separates flat colors from ramps. Tile
/// boundaries are excluded so padding cannot create edges.
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
    fn tile_range(plane: &[u8], stride: usize, x: usize, y: usize, size: usize) -> u8 {
        let mut minimum = u8::MAX;
        let mut maximum = u8::MIN;
        for row in 0..size {
            for col in 0..size {
                let value = plane[(y + row) * stride + x + col];
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
        }
        maximum - minimum
    }
    if smooth_tile(y, y_stride, mx * 16, my * 16, 16)
        && smooth_tile(u, y_stride / 2, mx * 8, my * 8, 8)
        && smooth_tile(v, y_stride / 2, mx * 8, my * 8, 8)
    {
        let uv_stride = y_stride / 2;
        let mut neutral = true;
        'chroma: for row in 0..8 {
            for col in 0..8 {
                let at = (my * 8 + row) * uv_stride + mx * 8 + col;
                if u[at].abs_diff(128) > 1 || v[at].abs_diff(128) > 1 {
                    neutral = false;
                    break 'chroma;
                }
            }
        }
        if neutral {
            FINE_SMOOTH
        } else {
            let ranges = [
                tile_range(y, y_stride, mx * 16, my * 16, 16),
                tile_range(u, uv_stride, mx * 8, my * 8, 8),
                tile_range(v, uv_stride, mx * 8, my * 8, 8),
            ];
            if ranges == [0; 3] {
                FINE_SMOOTH
            } else if ranges.iter().all(|&range| range <= 1) {
                CHROMATIC_FLAT
            } else {
                CHROMATIC_RAMP
            }
        }
    } else {
        TEXTURED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_class_counts_collapse_or_signal_four_absolute_qindices() {
        for (quality, smooth, flat, ramp, textured) in [
            (60, 7, 19, 33, 33),
            (75, 6, 15, 27, 28),
            (85, 6, 10, 15, 14),
        ] {
            for (id, qindex) in [smooth, flat, ramp, textured].into_iter().enumerate() {
                let mut counts = [0; 4];
                counts[id] = 4;
                let single = Config::from_counts(quality, counts, 4, false);
                assert!(!single.enabled);
                assert_eq!(single.base_qindex, qindex);
            }
            let mixed = Config::from_counts(quality, [1, 1, 1, 1], 4, false);
            assert!(mixed.enabled);
            assert_eq!(mixed.qindex, [smooth, flat, ramp, textured]);
            assert_eq!(mixed.map_probabilities, [128, 128, 128]);
        }
    }

    #[test]
    fn neutral_chroma_selects_textured_precision_per_preset() {
        for (quality, chromatic, neutral) in [(60, 33, 35), (75, 28, 27), (85, 14, 14)] {
            for counts in [[0, 0, 0, 1], [1, 1, 1, 1]] {
                let total = counts.iter().sum();
                let color = Config::from_counts(quality, counts, total, false);
                let mono = Config::from_counts(quality, counts, total, true);
                assert_eq!(color.qindex[TEXTURED as usize], chromatic);
                assert_eq!(mono.qindex[TEXTURED as usize], neutral);
                assert_eq!(
                    color.qindex[..TEXTURED as usize],
                    mono.qindex[..TEXTURED as usize]
                );
                assert_eq!(color.enabled, mono.enabled);
                assert_eq!(color.map_probabilities, mono.map_probabilities);
            }
        }
    }

    #[test]
    fn smoothness_uses_curvature_of_all_three_source_planes() {
        let y: Vec<_> = (0..16)
            .flat_map(|row| (0..32).map(move |col| (80 + row + col) as u8))
            .collect();
        let uv = vec![128; 16 * 8];
        assert_eq!(classify(&y, &uv, &uv, 32, 0, 0), FINE_SMOOTH);
        let chromatic_u = vec![126; 16 * 8];
        assert_eq!(classify(&y, &chromatic_u, &uv, 32, 0, 0), CHROMATIC_RAMP);
        let chromatic_v = vec![130; 16 * 8];
        assert_eq!(classify(&y, &uv, &chromatic_v, 32, 0, 0), CHROMATIC_RAMP);
        let flat_y = vec![80; 32 * 16];
        assert_eq!(classify(&flat_y, &chromatic_u, &uv, 32, 0, 0), FINE_SMOOTH);
        let mut chromatic_ramp_u = chromatic_u.clone();
        for row in 0..8 {
            chromatic_ramp_u[row * 16..row * 16 + 8].fill(126 + row as u8);
        }
        assert_eq!(
            classify(&flat_y, &chromatic_ramp_u, &uv, 32, 0, 0),
            CHROMATIC_RAMP
        );
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
    fn constant_color_uses_fine_segment_but_one_level_variation_remains_flat() {
        let y = vec![80; 32 * 16];
        let u = vec![96; 16 * 8];
        let v = vec![160; 16 * 8];
        assert_eq!(classify(&y, &u, &v, 32, 0, 0), FINE_SMOOTH);
        for plane in 0..3 {
            let mut varied_y = y.clone();
            let mut varied_u = u.clone();
            let mut varied_v = v.clone();
            match plane {
                0 => varied_y[8 * 32 + 8] += 1,
                1 => varied_u[4 * 16 + 4] += 1,
                _ => varied_v[4 * 16 + 4] += 1,
            }
            assert_eq!(
                classify(&varied_y, &varied_u, &varied_v, 32, 0, 0),
                CHROMATIC_FLAT
            );
            // Neighboring tile and repeated calls do not inherit another tile's range.
            assert_eq!(
                classify(&varied_y, &varied_u, &varied_v, 32, 1, 0),
                FINE_SMOOTH
            );
            assert_eq!(classify(&y, &u, &v, 32, 0, 0), FINE_SMOOTH);
        }
    }

    #[test]
    fn all_four_ids_use_the_signaled_map_tree() {
        struct Operations(Vec<(u8, bool)>);
        impl BoolSink for Operations {
            fn write(&mut self, probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push((probability, bit));
                Ok(())
            }
        }
        let config = Config::from_counts(75, [1, 1, 1, 1], 4, false);
        for (id, expected) in [
            (FINE_SMOOTH, [(128, false), (128, false)]),
            (CHROMATIC_FLAT, [(128, false), (128, true)]),
            (CHROMATIC_RAMP, [(128, true), (128, false)]),
            (TEXTURED, [(128, true), (128, true)]),
        ] {
            let mut operations = Operations(Vec::new());
            config.write_id(&mut operations, id).unwrap();
            assert_eq!(operations.0, expected);
        }
        assert_eq!(
            config.write_id(&mut Operations(Vec::new()), 4),
            Err(EncodeError::InvalidInput)
        );
    }

    #[test]
    fn absolute_segments_signal_filter_level_for_active_ids() {
        struct Bits(Vec<bool>);
        impl BoolSink for Bits {
            fn write(&mut self, _probability: u8, bit: bool) -> Result<(), EncodeError> {
                self.0.push(bit);
                Ok(())
            }
        }
        let config = Config::from_counts(75, [1, 0, 0, 1], 2, false);
        let mut bits = Bits(Vec::new());
        config.write_header(&mut bits, 6).unwrap();
        // Four control bits and four quantizer feature records precede the
        // per-segment filter strengths.
        assert_eq!(
            &bits.0[40..58],
            &[
                true, false, false, false, true, true, false, false, false, false, true, false,
                false, false, true, true, false, false,
            ]
        );
        let mut disabled = Bits(Vec::new());
        config.write_header(&mut disabled, 0).unwrap();
        assert_eq!(&disabled.0[40..44], &[false; 4]);
        assert_eq!(
            config.write_header(&mut Bits(Vec::new()), 64),
            Err(EncodeError::InvalidInput)
        );
    }
}
