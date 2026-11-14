// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// VP8 integer transform rules: RFC 6386 sections 14.3-14.4.
// Forward transform scaling/rounding and its structure are adapted from
// libwebp 1.3.2 src/dsp/enc.c (Copyright 2011 Google Inc.; BSD-style license
// in libwebp COPYING, plus PATENTS). The inverse follows the RFC's normative
// decoder arithmetic, including signed arithmetic shifts. Preserve the
// upstream notice/license in the crate's provenance when integrating.

/// Transform a row-major 4x4 block of source-minus-predictor samples.
/// Each input must be in [-255, 255]. Output is in natural coefficient order.
pub(crate) fn forward(residual: &[i16; 16]) -> [i32; 16] {
    let mut intermediate = [0i32; 16];
    let mut output = [0i32; 16];
    for row in 0..4 {
        let d0 = i32::from(residual[row * 4]);
        let d1 = i32::from(residual[row * 4 + 1]);
        let d2 = i32::from(residual[row * 4 + 2]);
        let d3 = i32::from(residual[row * 4 + 3]);
        let a0 = d0 + d3;
        let a1 = d1 + d2;
        let a2 = d1 - d2;
        let a3 = d0 - d3;
        intermediate[row * 4] = (a0 + a1) * 8;
        intermediate[row * 4 + 1] = (a2 * 2217 + a3 * 5352 + 1812) >> 9;
        intermediate[row * 4 + 2] = (a0 - a1) * 8;
        intermediate[row * 4 + 3] = (a3 * 2217 - a2 * 5352 + 937) >> 9;
    }
    for column in 0..4 {
        let a0 = intermediate[column] + intermediate[12 + column];
        let a1 = intermediate[4 + column] + intermediate[8 + column];
        let a2 = intermediate[4 + column] - intermediate[8 + column];
        let a3 = intermediate[column] - intermediate[12 + column];
        output[column] = (a0 + a1 + 7) >> 4;
        output[4 + column] = ((a2 * 2217 + a3 * 5352 + 12000) >> 16) + i32::from(a3 != 0);
        output[8 + column] = (a0 - a1 + 7) >> 4;
        output[12 + column] = (a3 * 2217 - a2 * 5352 + 51000) >> 16;
    }
    output
}

#[inline]
fn mul_cos(value: i32) -> i32 {
    value + ((value * 20091) >> 16)
}
#[inline]
fn mul_sin(value: i32) -> i32 {
    (value * 35468) >> 16
}

/// Decoder-equivalent inverse DCT of dequantized natural-order coefficients.
/// Caller must keep coefficients within the VP8 signed 16-bit decode domain.
pub(crate) fn inverse(coefficients: &[i32; 16]) -> [i16; 16] {
    let mut intermediate = [0i32; 16];
    let mut output = [0i16; 16];
    for column in 0..4 {
        let a = coefficients[column] + coefficients[8 + column];
        let b = coefficients[column] - coefficients[8 + column];
        let c = mul_sin(coefficients[4 + column]) - mul_cos(coefficients[12 + column]);
        let d = mul_cos(coefficients[4 + column]) + mul_sin(coefficients[12 + column]);
        intermediate[column] = a + d;
        intermediate[4 + column] = b + c;
        intermediate[8 + column] = b - c;
        intermediate[12 + column] = a - d;
    }
    for row in 0..4 {
        let a = intermediate[row * 4] + intermediate[row * 4 + 2] + 4;
        let b = intermediate[row * 4] - intermediate[row * 4 + 2] + 4;
        let c = mul_sin(intermediate[row * 4 + 1]) - mul_cos(intermediate[row * 4 + 3]);
        let d = mul_cos(intermediate[row * 4 + 1]) + mul_sin(intermediate[row * 4 + 3]);
        output[row * 4] = ((a + d) >> 3) as i16;
        output[row * 4 + 1] = ((b + c) >> 3) as i16;
        output[row * 4 + 2] = ((b - c) >> 3) as i16;
        output[row * 4 + 3] = ((a - d) >> 3) as i16;
    }
    output
}

/// Transform the sixteen Y1 DC values for I16 Y2 coding.
pub(crate) fn forward_wht(dc: &[i16; 16]) -> [i32; 16] {
    let mut intermediate = [0i32; 16];
    let mut output = [0i32; 16];
    for row in 0..4 {
        let a0 = i32::from(dc[row * 4]) + i32::from(dc[row * 4 + 2]);
        let a1 = i32::from(dc[row * 4 + 1]) + i32::from(dc[row * 4 + 3]);
        let a2 = i32::from(dc[row * 4 + 1]) - i32::from(dc[row * 4 + 3]);
        let a3 = i32::from(dc[row * 4]) - i32::from(dc[row * 4 + 2]);
        intermediate[row * 4] = a0 + a1;
        intermediate[row * 4 + 1] = a3 + a2;
        intermediate[row * 4 + 2] = a3 - a2;
        intermediate[row * 4 + 3] = a0 - a1;
    }
    for column in 0..4 {
        let a0 = intermediate[column] + intermediate[8 + column];
        let a1 = intermediate[4 + column] + intermediate[12 + column];
        let a2 = intermediate[4 + column] - intermediate[12 + column];
        let a3 = intermediate[column] - intermediate[8 + column];
        output[column] = (a0 + a1) >> 1;
        output[4 + column] = (a3 + a2) >> 1;
        output[8 + column] = (a3 - a2) >> 1;
        output[12 + column] = (a0 - a1) >> 1;
    }
    output
}

/// Decoder-equivalent inverse WHT. Output replaces the sixteen Y1 DC terms.
pub(crate) fn inverse_wht(coefficients: &[i32; 16]) -> [i16; 16] {
    let mut intermediate = [0i32; 16];
    let mut output = [0i16; 16];
    for column in 0..4 {
        let a = coefficients[column] + coefficients[12 + column];
        let b = coefficients[4 + column] + coefficients[8 + column];
        let c = coefficients[4 + column] - coefficients[8 + column];
        let d = coefficients[column] - coefficients[12 + column];
        intermediate[column] = a + b;
        intermediate[4 + column] = c + d;
        intermediate[8 + column] = a - b;
        intermediate[12 + column] = d - c;
    }
    for row in 0..4 {
        let a = intermediate[row * 4] + intermediate[row * 4 + 3];
        let b = intermediate[row * 4 + 1] + intermediate[row * 4 + 2];
        let c = intermediate[row * 4 + 1] - intermediate[row * 4 + 2];
        let d = intermediate[row * 4] - intermediate[row * 4 + 3];
        output[row * 4] = ((a + b + 3) >> 3) as i16;
        output[row * 4 + 1] = ((c + d + 3) >> 3) as i16;
        output[row * 4 + 2] = ((a - b + 3) >> 3) as i16;
        output[row * 4 + 3] = ((d - c + 3) >> 3) as i16;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_residual_scaling_and_signed_rounding() {
        assert_eq!(
            forward(&[0; 16]),
            [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        let positive = forward(&[1; 16]);
        let negative = forward(&[-1; 16]);
        assert_eq!(positive, [8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(negative, [-8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(inverse(&positive), [1; 16]);
        assert_eq!(inverse(&negative), [-1; 16]);
    }

    #[test]
    fn forward_impulses_match_pinned_reference() {
        // Fixed 16-bit output digests from libwebp v1.3.2 FTransform_C for
        // one -255 and +255 spatial impulse at each position.
        const EXPECTED: [[u64; 2]; 16] = [
            [11456212188769334215, 6039701707063888640],
            [6770454192274475097, 15351978075580462750],
            [5374463807870203990, 12391651678336837877],
            [5156749290359901480, 9387583273461820639],
            [4510737023213948861, 15591590576390352071],
            [11520148050690776020, 17593044642127076649],
            [7214951821568060877, 7643008735349894200],
            [2938982222963260079, 15549758757271639225],
            [18233046123811038624, 15443798598297305275],
            [1372205952901399249, 9906825475370619779],
            [7953945332276782623, 16112557680216150333],
            [14664900241848198827, 12468594237662143588],
            [9917613853279730543, 4898839901669101417],
            [9390043801848473, 7358104425916605238],
            [15463324814277392426, 769910053866682497],
            [10386578159440463453, 17603643874427880435],
        ];
        for (position, expected) in EXPECTED.iter().enumerate() {
            for (sign_index, sign) in [-1, 1].into_iter().enumerate() {
                let mut residual = [0; 16];
                residual[position] = sign * 255;
                let mut digest = 14_695_981_039_346_656_037u64;
                for coefficient in forward(&residual) {
                    for byte in (coefficient as i16).to_le_bytes() {
                        digest = (digest ^ u64::from(byte)).wrapping_mul(1_099_511_628_211);
                    }
                }
                assert_eq!(
                    digest, expected[sign_index],
                    "position={position} sign={sign}"
                );
            }
        }
    }

    #[test]
    fn inverse_one_hot_ac_positions_and_signs() {
        // FNV-1a digests of signed 16-bit row-major residuals from the
        // independent RFC 6386 section 14.4 C reference, for coefficients
        // -16 and +16 at each AC position. This catches axis and rounding
        // mistakes without sharing the Rust inverse implementation.
        const EXPECTED: [[u64; 2]; 15] = [
            [12719866681707157813, 5228418471149615701],
            [10687822588658036341, 17144130092006571189],
            [11519289430436116949, 6431302460511676693],
            [4088411577132651709, 2278273449795158597],
            [1705626118999799704, 17781399052441955251],
            [17716114881058250773, 9458709246524937717],
            [16585892488421105448, 2985471607051477955],
            [6410680724173142069, 8730433076006585397],
            [1723839147067052997, 17991253501097343461],
            [10182005976193480597, 17782411823830347157],
            [11226292458673798517, 10530648315910138933],
            [4611984901957219261, 9007035053896991045],
            [9710579376356912072, 3346784918306224075],
            [4034149346014009877, 4427685009576296437],
            [16712378367958516608, 9608585079233243099],
        ];
        for index in 1..16 {
            for (sign_index, sign) in [-1, 1].into_iter().enumerate() {
                let mut coefficients = [0; 16];
                coefficients[index] = sign * 16;
                let mut digest = 14_695_981_039_346_656_037u64;
                for sample in inverse(&coefficients) {
                    for byte in sample.to_le_bytes() {
                        digest = (digest ^ u64::from(byte)).wrapping_mul(1_099_511_628_211);
                    }
                }
                assert_eq!(
                    digest,
                    EXPECTED[index - 1][sign_index],
                    "index={index} sign={sign}"
                );
            }
        }
    }

    #[test]
    fn wht_dc_and_zero_known_answers() {
        assert_eq!(forward_wht(&[0; 16]), [0; 16]);
        assert_eq!(forward_wht(&[1; 16])[0], 8);
        assert_eq!(forward_wht(&[-1; 16])[0], -8);
        assert_eq!(inverse_wht(&[0; 16]), [0; 16]);
        assert_eq!(
            inverse_wht(&[8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            [1; 16]
        );
    }
}
