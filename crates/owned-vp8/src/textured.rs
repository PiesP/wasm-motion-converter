// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// A deliberately coarse but real opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::dc_quant::DC_QUANT;
use crate::default_coeff_probs::DEFAULT_COEFF_PROBS;

#[derive(Default)]
struct Macroblock {
    y: [i16; 16],
    u: [i16; 4],
    v: [i16; 4],
}

fn allocated(size: usize) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| EncodeError::OutputLimit)?;
    bytes.resize(size, 0);
    Ok(bytes)
}

fn clamp(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}
fn round_ratio(value: i32, divisor: i32) -> i32 {
    if value < 0 {
        -((-value + divisor / 2) / divisor)
    } else {
        (value + divisor / 2) / divisor
    }
}
fn quantize(target: i32, predictor: i32, step: i32) -> i16 {
    round_ratio((target - predictor) * 8, step).clamp(-2048, 2047) as i16
}
fn reconstruct(predictor: i32, coefficient: i16, step: i32) -> u8 {
    clamp(predictor + ((i32::from(coefficient) * step + 4) >> 3))
}
fn yuv_from_rgb(r: i32, g: i32, b: i32) -> (u8, u8, u8) {
    // Fixed-point limited-range BT.601-like transform. This is an experiment:
    // the exact product Canvas color contract still requires qualification.
    (
        clamp(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16),
        clamp(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128),
        clamp(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128),
    )
}

fn predictor_y(reconstructed: &[u8], stride: usize, x: usize, y: usize) -> i32 {
    let mut sum = 4;
    for i in 0..4 {
        sum += if y == 0 {
            127
        } else {
            i32::from(reconstructed[(y - 1) * stride + x + i])
        };
        sum += if x == 0 {
            129
        } else {
            i32::from(reconstructed[(y + i) * stride + x - 1])
        };
    }
    sum >> 3
}

fn predictor_uv(reconstructed: &[u8], stride: usize, x: usize, y: usize) -> i32 {
    if x == 0 && y == 0 {
        return 128;
    }
    let mut sum = 0;
    let mut count = 0;
    if y > 0 {
        for i in 0..8 {
            sum += i32::from(reconstructed[(y - 1) * stride + x + i]);
        }
        count += 8;
    }
    if x > 0 {
        for i in 0..8 {
            sum += i32::from(reconstructed[(y + i) * stride + x - 1]);
        }
        count += 8;
    }
    (sum + count / 2) / count
}

fn average_block(source: &[u8], stride: usize, x: usize, y: usize) -> i32 {
    let mut total = 0;
    for row in 0..4 {
        for col in 0..4 {
            total += i32::from(source[(y + row) * stride + x + col]);
        }
    }
    (total + 8) / 16
}
fn fill_reconstruction(target: &mut [u8], stride: usize, x: usize, y: usize, value: u8) {
    for row in 0..4 {
        target[(y + row) * stride + x..(y + row) * stride + x + 4].fill(value);
    }
}

fn encode_coeff(
    writer: &mut BoolWriter,
    value: i16,
    plane: usize,
    context: usize,
) -> Result<(), EncodeError> {
    let probs = &DEFAULT_COEFF_PROBS[((plane * 8) * 3 + context) * 11..][..11];
    let abs = i32::from(value).abs() as usize;
    if abs == 0 {
        return writer.write(probs[0], false);
    } // End of block.
      // Walk the RFC 6386 coefficient token tree to the selected magnitude.
    let (bits, length, extra_base, extra_probs): (u16, u32, usize, &[u8]) = match abs {
        1 => (0b110, 3, 1, &[]),
        2 => (0b11100, 5, 2, &[]),
        3 => (0b111010, 6, 3, &[]),
        4 => (0b111011, 6, 4, &[]),
        5..=6 => (0b111100, 6, 5, &[159]),
        7..=10 => (0b111101, 6, 7, &[165, 145]),
        11..=18 => (0b1111100, 7, 11, &[173, 148, 140]),
        19..=34 => (0b1111101, 7, 19, &[176, 155, 140, 135]),
        35..=66 => (0b1111110, 7, 35, &[180, 157, 141, 134, 130]),
        _ => (
            0b1111111,
            7,
            67,
            &[254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
        ),
    };
    let tree_positions: &[usize] = match length {
        3 => &[0, 1, 2],
        5 => &[0, 1, 2, 3, 4],
        6 if abs <= 4 => &[0, 1, 2, 3, 4, 5],
        6 => &[0, 1, 2, 3, 6, 7],
        7 if abs <= 34 => &[0, 1, 2, 3, 6, 8, 9],
        7 => &[0, 1, 2, 3, 6, 8, 10],
        _ => unreachable!(),
    };
    for (index, &prob_index) in tree_positions.iter().enumerate() {
        writer.write(
            probs[prob_index],
            (bits >> (length as usize - 1 - index)) & 1 != 0,
        )?;
    }
    if !extra_probs.is_empty() {
        let extra = abs - extra_base;
        for (shift, &probability) in extra_probs.iter().enumerate() {
            writer.write(
                probability,
                extra & (1 << (extra_probs.len() - 1 - shift)) != 0,
            )?;
        }
    }
    writer.bit(value < 0)?;
    // No AC terms in this narrow coder. End the block at coefficient one.
    let band_one = &DEFAULT_COEFF_PROBS[((plane * 8 + 1) * 3 + abs.min(2)) * 11..][..11];
    writer.write(band_one[0], false)
}

fn encode_macroblock_coeffs(
    writer: &mut BoolWriter,
    values: &[i16],
    plane: usize,
    above: &mut [bool],
    left: &mut [bool],
    column: usize,
    width: usize,
) -> Result<(), EncodeError> {
    for (index, &value) in values.iter().enumerate() {
        let x = index % width;
        let y = index / width;
        let slot = column * width + x;
        let context = usize::from(above[slot]) + usize::from(left[y]);
        encode_coeff(writer, value, plane, context)?;
        let nonzero = value != 0;
        above[slot] = nonzero;
        left[y] = nonzero;
    }
    Ok(())
}

pub fn encode_textured(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
) -> Result<Vec<u8>, EncodeError> {
    let width = width as usize;
    let height = height as usize;
    let stride = stride as usize;
    let padded_w = width.checked_add(15).ok_or(EncodeError::InvalidInput)? & !15;
    let padded_h = height.checked_add(15).ok_or(EncodeError::InvalidInput)? & !15;
    let y_size = padded_w
        .checked_mul(padded_h)
        .ok_or(EncodeError::InvalidInput)?;
    let uv_size = y_size / 4;
    let uv_w = padded_w / 2;
    let mut source_y = allocated(y_size)?;
    let mut source_u = allocated(uv_size)?;
    let mut source_v = allocated(uv_size)?;
    let mut reconstructed_y = allocated(y_size)?;
    let mut reconstructed_u = allocated(uv_size)?;
    let mut reconstructed_v = allocated(uv_size)?;
    for cy in 0..padded_h / 2 {
        for cx in 0..uv_w {
            let mut sum_u = 0u32;
            let mut sum_v = 0u32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let x = (cx * 2 + dx).min(width - 1);
                    let y = (cy * 2 + dy).min(height - 1);
                    let at = y * stride + x * 4;
                    let (r, g, b) = if format == 0 {
                        (pixels[at], pixels[at + 1], pixels[at + 2])
                    } else {
                        (pixels[at + 2], pixels[at + 1], pixels[at])
                    };
                    let (luma, chroma_u, chroma_v) =
                        yuv_from_rgb(i32::from(r), i32::from(g), i32::from(b));
                    source_y[(cy * 2 + dy) * padded_w + cx * 2 + dx] = luma;
                    sum_u += u32::from(chroma_u);
                    sum_v += u32::from(chroma_v);
                }
            }
            source_u[cy * uv_w + cx] = ((sum_u + 2) / 4) as u8;
            source_v[cy * uv_w + cx] = ((sum_v + 2) / 4) as u8;
        }
    }
    let blocks_x = padded_w / 16;
    let blocks_y = padded_h / 16;
    let count = blocks_x
        .checked_mul(blocks_y)
        .ok_or(EncodeError::InvalidInput)?;
    let mut blocks = Vec::new();
    blocks
        .try_reserve_exact(count)
        .map_err(|_| EncodeError::OutputLimit)?;
    let qindex = match quality {
        60 => 40,
        75 => 22,
        _ => 8,
    };
    let y_step = DC_QUANT[qindex];
    let uv_step = DC_QUANT[qindex].min(132);
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let mut block = Macroblock::default();
            for by in 0..4 {
                for bx in 0..4 {
                    let x = mx * 16 + bx * 4;
                    let y = my * 16 + by * 4;
                    let predictor = predictor_y(&reconstructed_y, padded_w, x, y);
                    let mean = average_block(&source_y, padded_w, x, y);
                    let coeff = quantize(mean, predictor, y_step);
                    block.y[by * 4 + bx] = coeff;
                    fill_reconstruction(
                        &mut reconstructed_y,
                        padded_w,
                        x,
                        y,
                        reconstruct(predictor, coeff, y_step),
                    );
                }
            }
            for (plane, reconstructed, coeffs) in [
                (&source_u, &mut reconstructed_u, &mut block.u),
                (&source_v, &mut reconstructed_v, &mut block.v),
            ] {
                let x = mx * 8;
                let y = my * 8;
                let predictor = predictor_uv(reconstructed, uv_w, x, y);
                for by in 0..2 {
                    for bx in 0..2 {
                        let cell_x = x + bx * 4;
                        let cell_y = y + by * 4;
                        let mean = average_block(plane, uv_w, cell_x, cell_y);
                        let coeff = quantize(mean, predictor, uv_step);
                        coeffs[by * 2 + bx] = coeff;
                        fill_reconstruction(
                            reconstructed,
                            uv_w,
                            cell_x,
                            cell_y,
                            reconstruct(predictor, coeff, uv_step),
                        );
                    }
                }
            }
            blocks.push(block);
        }
    }
    let mut header = BoolWriter::new();
    header.bit(false)?; // YUV color space.
    header.bit(false)?; // Decoder clamps output pixels.
    header.bit(false)?; // Segmentation disabled.
    header.bit(false)?; // Normal loop filter.
    header.literal(0, 6)?; // No loop filtering during this experiment.
    header.literal(0, 3)?;
    header.bit(false)?; // Macroblock filter deltas disabled.
    header.literal(0, 2)?; // One coefficient partition.
    header.literal(qindex as u32, 7)?;
    for _ in 0..5 {
        header.bit(false)?;
    }
    header.bit(false)?; // Entropy updates not retained.
    for probability in super::COEFF_UPDATE_PROBS {
        header.write(probability, false)?;
    }
    header.bit(true)?; // Macroblock coefficient skip flags enabled.
    header.literal(128, 8)?;
    let mut token = BoolWriter::new();
    let mut above_y = vec![false; blocks_x * 4];
    let mut above_u = vec![false; blocks_x * 2];
    let mut above_v = vec![false; blocks_x * 2];
    for my in 0..blocks_y {
        let mut left_y = [false; 4];
        let mut left_u = [false; 2];
        let mut left_v = [false; 2];
        for mx in 0..blocks_x {
            let block = &blocks[my * blocks_x + mx];
            let skip = block
                .y
                .iter()
                .chain(&block.u)
                .chain(&block.v)
                .all(|&v| v == 0);
            header.write(128, skip)?;
            header.write(145, false)?; // B_PRED luma mode.
            for _ in 0..16 {
                header.write(231, false)?;
            } // B_DC_PRED; all contexts B_DC.
            header.write(142, false)?; // DC_PRED chroma mode.
            if !skip {
                encode_macroblock_coeffs(
                    &mut token,
                    &block.y,
                    3,
                    &mut above_y,
                    &mut left_y,
                    mx,
                    4,
                )?;
                encode_macroblock_coeffs(
                    &mut token,
                    &block.u,
                    2,
                    &mut above_u,
                    &mut left_u,
                    mx,
                    2,
                )?;
                encode_macroblock_coeffs(
                    &mut token,
                    &block.v,
                    2,
                    &mut above_v,
                    &mut left_v,
                    mx,
                    2,
                )?;
            } else {
                above_y[mx * 4..mx * 4 + 4].fill(false);
                above_u[mx * 2..mx * 2 + 2].fill(false);
                above_v[mx * 2..mx * 2 + 2].fill(false);
                left_y.fill(false);
                left_u.fill(false);
                left_v.fill(false);
            }
        }
    }
    let first = header.finish()?;
    let second = token.finish()?;
    let total = 10usize
        .checked_add(first.len())
        .and_then(|n| n.checked_add(second.len()))
        .ok_or(EncodeError::OutputLimit)?;
    if first.len() > 0x7ffff || total > MAX_OUTPUT_BYTES {
        return Err(EncodeError::OutputLimit);
    }
    let mut result = Vec::new();
    result
        .try_reserve_exact(total)
        .map_err(|_| EncodeError::OutputLimit)?;
    let tag = ((first.len() as u32) << 5) | 0x10;
    result.extend_from_slice(&tag.to_le_bytes()[..3]);
    result.extend_from_slice(&[0x9d, 0x01, 0x2a]);
    result.extend_from_slice(&(width as u16).to_le_bytes());
    result.extend_from_slice(&(height as u16).to_le_bytes());
    result.extend_from_slice(&first);
    result.extend_from_slice(&second);
    Ok(result)
}
