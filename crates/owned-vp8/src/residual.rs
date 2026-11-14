// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Original token encoder; tree, scan and band constants: RFC 6386 section 13.

use crate::{default_coeff_probs::DEFAULT_COEFF_PROBS, BoolWriter, EncodeError};

pub(crate) const SCAN: [usize; 16] = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const BANDS: [usize; 16] = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7];

/// Coefficients are in raster order. `plane=0` omits DC (supplied by Y2).
/// A zero token guarantees a later nonzero, so its successor omits the EOB node.
pub(crate) fn encode_block(
    writer: &mut BoolWriter,
    values: &[i16; 16],
    plane: usize,
    mut context: usize,
) -> Result<bool, EncodeError> {
    let start = usize::from(plane == 0);
    let end = (start..16)
        .rfind(|&i| values[SCAN[i]] != 0)
        .map_or(start, |i| i + 1);
    let mut previous_zero = false;
    for position in start..16 {
        let probs =
            &DEFAULT_COEFF_PROBS[((plane * 8 + BANDS[position]) * 3 + context) * 11..][..11];
        if !previous_zero {
            writer.write(probs[0], position < end)?;
            if position == end {
                break;
            }
        }
        let value = values[SCAN[position]];
        let abs = i32::from(value).unsigned_abs() as usize;
        writer.write(probs[1], abs != 0)?;
        if abs == 0 {
            context = 0;
            previous_zero = true;
            continue;
        }
        previous_zero = false;
        writer.write(probs[2], abs != 1)?;
        if abs > 1 {
            writer.write(probs[3], abs > 4)?;
            if abs <= 4 {
                writer.write(probs[4], abs != 2)?;
                if abs != 2 {
                    writer.write(probs[5], abs == 4)?;
                }
            } else {
                let (category, base, extra): (usize, usize, &[u8]) = match abs {
                    5..=6 => (0, 5, &[159]),
                    7..=10 => (1, 7, &[165, 145]),
                    11..=18 => (2, 11, &[173, 148, 140]),
                    19..=34 => (3, 19, &[176, 155, 140, 135]),
                    35..=66 => (4, 35, &[180, 157, 141, 134, 130]),
                    67..=2114 => (
                        5,
                        67,
                        &[254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
                    ),
                    _ => return Err(EncodeError::InvalidInput),
                };
                writer.write(probs[6], category >= 2)?;
                if category < 2 {
                    writer.write(probs[7], category == 1)?;
                } else {
                    writer.write(probs[8], category >= 4)?;
                    writer.write(probs[if category < 4 { 9 } else { 10 }], category & 1 != 0)?;
                }
                let offset = abs - base;
                for (index, &probability) in extra.iter().enumerate() {
                    writer.write(probability, offset & (1 << (extra.len() - index - 1)) != 0)?;
                }
            }
        }
        writer.bit(value < 0)?;
        context = abs.min(2);
    }
    Ok(end > start)
}
