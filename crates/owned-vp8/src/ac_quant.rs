// SPDX-License-Identifier: MIT AND BSD-3-Clause
// Copyright (c) 2026 PiesP
// RFC 6386 section 14.1 AC lookup values, checked against the reference
// decoder's dequant_data.h, RFC 6386 section 20.3. See ../LICENSE.rfc6386.
// The method-4 quantizer parameters derive from libwebp commit
// 6c484cbf92e81a5673b24485ac02d211f69be5b7 (Copyright 2011 Google Inc.),
// src/enc/quant_enc.c, src/enc/vp8i_enc.h and src/dsp/enc.c.
// See ../LICENSE.libwebp and ../PATENTS.libwebp.
use crate::dc_quant::DC_QUANT;

pub(crate) const AC_QUANT: [i32; 128] = [
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    53, 54, 55, 56, 57, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94,
    96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 119, 122, 125, 128, 131, 134, 137, 140,
    143, 146, 149, 152, 155, 158, 161, 164, 167, 170, 173, 177, 181, 185, 189, 193, 197, 201, 205,
    209, 213, 217, 221, 225, 229, 234, 239, 245, 249, 254, 259, 264, 269, 274, 279, 284,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plane {
    Y1,
    Y2,
    UV,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Deltas {
    pub y1_dc: i8,
    pub y2_dc: i8,
    pub y2_ac: i8,
    pub uv_dc: i8,
    pub uv_ac: i8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Steps {
    pub dc: i32,
    pub ac: i32,
}

/// Resolve the decoder's six VP8 dequantization factors for a qindex and
/// signed header deltas. The caller validates a base index in 0..=127.
pub(crate) fn steps(qindex: u8, deltas: Deltas, plane: Plane) -> Steps {
    let q = i32::from(qindex);
    let index = |delta: i8, max: i32| (q + i32::from(delta)).clamp(0, max) as usize;
    match plane {
        Plane::Y1 => Steps {
            dc: DC_QUANT[index(deltas.y1_dc, 127)],
            ac: AC_QUANT[index(0, 127)],
        },
        Plane::Y2 => Steps {
            dc: 2 * DC_QUANT[index(deltas.y2_dc, 127)],
            ac: ((AC_QUANT[index(deltas.y2_ac, 127)] * 101_581) >> 16).max(8),
        },
        Plane::UV => Steps {
            dc: DC_QUANT[index(deltas.uv_dc, 117)],
            ac: AC_QUANT[index(deltas.uv_ac, 127)],
        },
    }
}

/// Nearest signed coefficient, conservatively capped to the encoder's
/// 2047 level policy and the signed 16-bit dequantized coefficient domain.
pub(crate) fn quantize(value: i32, step: i32) -> i16 {
    debug_assert!(step > 0);
    let magnitude = value.unsigned_abs();
    let quantized = ((magnitude + (step as u32 / 2)) / step as u32)
        .min(2047)
        .min((i16::MAX as u32) / step as u32) as i16;
    if value < 0 {
        -quantized
    } else {
        quantized
    }
}

pub(crate) fn dequantize(value: i16, step: i32) -> i32 {
    i32::from(value) * step
}

pub(crate) fn quantize_block(coefficients: &[i32; 16], steps: Steps) -> [i16; 16] {
    let mut output = [0; 16];
    for (index, &coefficient) in coefficients.iter().enumerate() {
        output[index] = quantize(coefficient, if index == 0 { steps.dc } else { steps.ac });
    }
    output
}

const MATRIX_PRECISION: u32 = 17;

#[derive(Clone, Copy)]
struct MatrixCoefficient {
    reciprocal: u32,
    bias: u32,
    zero_threshold: u32,
    level_limit: u32,
}

impl MatrixCoefficient {
    fn new(step: i32, weight: u32) -> Self {
        let step = step as u32;
        let reciprocal = (1 << MATRIX_PRECISION) / step;
        let bias = weight << (MATRIX_PRECISION - 8);
        Self {
            reciprocal,
            bias,
            zero_threshold: ((1 << MATRIX_PRECISION) - 1 - bias) / reciprocal,
            level_limit: 2047.min(i16::MAX as u32 / step),
        }
    }

    fn quantize(self, value: i32, sharpen: u8) -> i16 {
        let magnitude = value.unsigned_abs() + u32::from(sharpen);
        if magnitude <= self.zero_threshold {
            return 0;
        }
        // A full signed i32 coefficient is permitted by the owned scalar
        // contract. Use a wide product before the existing signed-level cap.
        let scaled = u64::from(magnitude) * u64::from(self.reciprocal) + u64::from(self.bias);
        let level = (scaled >> MATRIX_PRECISION).min(u64::from(self.level_limit)) as i16;
        if value < 0 {
            -level
        } else {
            level
        }
    }
}

pub(crate) struct Method4Matrix {
    dc: MatrixCoefficient,
    ac: MatrixCoefficient,
    sharpen: [u8; 16],
}

impl Method4Matrix {
    fn new(steps: Steps, plane: Plane) -> Self {
        let (dc_bias, ac_bias) = match plane {
            Plane::Y1 => (96, 110),
            Plane::Y2 => (96, 108),
            Plane::UV => (110, 115),
        };
        let sharpen = if plane == Plane::Y1 {
            // Natural order, as used by the transform. All luma AC weights
            // are at most 90 and all physical Y1 AC steps at most 284.
            [
                0, 30, 60, 90, 30, 60, 90, 90, 60, 90, 90, 90, 90, 90, 90, 90,
            ]
            .map(|weight| ((weight * steps.ac) >> 11) as u8)
        } else {
            [0; 16]
        };
        Self {
            dc: MatrixCoefficient::new(steps.dc, dc_bias),
            ac: MatrixCoefficient::new(steps.ac, ac_bias),
            sharpen,
        }
    }

    pub(crate) fn quantize_block(
        &self,
        coefficients: &[i32; 16],
        preserved_dc: Option<i16>,
    ) -> [i16; 16] {
        let mut levels = [0; 16];
        levels[0] = preserved_dc.unwrap_or_else(|| self.dc.quantize(coefficients[0], 0));
        for index in 1..16 {
            levels[index] = self.ac.quantize(coefficients[index], self.sharpen[index]);
        }
        levels
    }
}

pub(crate) struct Method4Matrices {
    pub y1: Method4Matrix,
    pub y2: Method4Matrix,
    pub uv: Method4Matrix,
}

impl Method4Matrices {
    pub(crate) fn on_grid(qindex: u8, deltas: Deltas) -> Self {
        Self {
            y1: Method4Matrix::new(steps(qindex, deltas, Plane::Y1), Plane::Y1),
            y2: Method4Matrix::new(steps(qindex, deltas, Plane::Y2), Plane::Y2),
            uv: Method4Matrix::new(steps(qindex, deltas, Plane::UV), Plane::UV),
        }
    }
}

pub(crate) fn quantize_block_with_matrix(
    coefficients: &[i32; 16],
    steps: Steps,
    matrix: Option<&Method4Matrix>,
) -> [i16; 16] {
    match matrix {
        Some(matrix) => matrix.quantize_block(coefficients, None),
        None => quantize_block(coefficients, steps),
    }
}

pub(crate) fn dequantize_block(coefficients: &[i16; 16], steps: Steps) -> [i32; 16] {
    let mut output = [0; 16];
    for (index, &coefficient) in coefficients.iter().enumerate() {
        output[index] = dequantize(coefficient, if index == 0 { steps.dc } else { steps.ac });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    // Direct C arithmetic oracle, independent of precomputed thresholds.
    fn native_level(value: i32, step: i32, weight: u32, sharpen: u8) -> i16 {
        let q17 = 131_072u64;
        let reciprocal = q17 / step as u64;
        let scaled = (u64::from(value.unsigned_abs()) + u64::from(sharpen)) * reciprocal
            + (u64::from(weight) * 512);
        let bound = (32_767 / step as u64).min(2_047);
        let level = (scaled / q17).min(bound) as i16;
        if value < 0 {
            -level
        } else {
            level
        }
    }

    #[test]
    fn method4_matrix_matches_native_bias_threshold_and_owned_limits() {
        let mut changed_from_nearest = 0;
        for (plane, dc_bias, ac_bias) in [
            (Plane::Y1, 96, 110),
            (Plane::Y2, 96, 108),
            (Plane::UV, 110, 115),
        ] {
            let frequency = [
                0, 30, 60, 90, 30, 60, 90, 90, 60, 90, 90, 90, 90, 90, 90, 90,
            ];
            for q in 0..=127 {
                let steps = steps(q, Deltas::default(), plane);
                let matrix = Method4Matrix::new(steps, plane);
                for (index, sharpening_weight) in frequency.into_iter().enumerate() {
                    let (step, bias) = if index == 0 {
                        (steps.dc, dc_bias)
                    } else {
                        (steps.ac, ac_bias)
                    };
                    let sharpen = if plane == Plane::Y1 {
                        ((sharpening_weight * step) >> 11) as u8
                    } else {
                        0
                    };
                    for value in (-2 * step..=2 * step).chain([i32::MIN, i32::MAX]) {
                        let mut values = [0; 16];
                        values[index] = value;
                        let chosen = matrix.quantize_block(&values, None)[index];
                        assert_eq!(chosen, native_level(value, step, bias, sharpen));
                        assert!(
                            i32::from(chosen).abs() <= 2047
                                && (i32::from(chosen) * step).abs() <= 32767
                        );
                        changed_from_nearest += usize::from(chosen != quantize(value, step));
                    }
                }
            }
        }
        assert!(changed_from_nearest > 0);
    }

    #[test]
    fn method4_matrix_can_preserve_corrected_chroma_dc_alone() {
        let steps = Steps { dc: 40, ac: 40 };
        let matrix = Method4Matrix::new(steps, Plane::UV);
        let mut values = [-20; 16];
        values[15] = -21;
        let ordinary = matrix.quantize_block(&values, None);
        let retained = matrix.quantize_block(&values, Some(quantize(values[0], steps.dc)));
        assert_eq!((ordinary[0], retained[0]), (0, -1));
        assert_eq!(ordinary[1..], retained[1..]);
    }

    #[test]
    fn decoder_steps_match_boundaries_and_plane_rules() {
        assert_eq!(AC_QUANT.len(), 128);
        assert_eq!(AC_QUANT[0], 4);
        assert_eq!(AC_QUANT[55], 60);
        assert_eq!(AC_QUANT[127], 284);
        assert_eq!(
            steps(0, Deltas::default(), Plane::Y1),
            Steps { dc: 4, ac: 4 }
        );
        assert_eq!(
            steps(0, Deltas::default(), Plane::Y2),
            Steps { dc: 8, ac: 8 }
        );
        assert_eq!(
            steps(127, Deltas::default(), Plane::Y2),
            Steps { dc: 314, ac: 440 }
        );
        assert_eq!(
            steps(127, Deltas::default(), Plane::UV),
            Steps { dc: 132, ac: 284 }
        );
        assert_eq!(
            steps(
                0,
                Deltas {
                    uv_dc: -15,
                    ..Deltas::default()
                },
                Plane::UV
            )
            .dc,
            4
        );
        let negative_uv = Deltas {
            uv_dc: -7,
            uv_ac: -7,
            ..Deltas::default()
        };
        assert_eq!(
            steps(23, negative_uv, Plane::UV),
            Steps {
                dc: DC_QUANT[16],
                ac: AC_QUANT[16]
            }
        );
        assert_eq!(
            steps(0, negative_uv, Plane::UV),
            Steps {
                dc: DC_QUANT[0],
                ac: AC_QUANT[0]
            }
        );
    }

    #[test]
    fn signed_quantization_and_dc_ac_position() {
        assert_eq!(quantize(0, 10), 0);
        assert_eq!(quantize(4, 10), 0);
        assert_eq!(quantize(5, 10), 1);
        assert_eq!(quantize(-5, 10), -1);
        assert_eq!(quantize(i32::MAX, 284), 115);
        let mut source = [0; 16];
        source[0] = 11;
        source[1] = -11;
        let levels = quantize_block(&source, Steps { dc: 10, ac: 20 });
        assert_eq!(levels[0], 1);
        assert_eq!(levels[1], -1);
        assert_eq!(
            dequantize_block(&levels, Steps { dc: 10, ac: 20 })[..2],
            [10, -20]
        );
    }
}
