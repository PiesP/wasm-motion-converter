// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// RFC 6386 section 14.1 AC lookup values, checked against the reference
// decoder's dequant_data.h in RFC 6386 attachment 20.3. No encoder code is
// imported; these are VP8 format constants.
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
