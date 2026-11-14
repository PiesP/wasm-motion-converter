// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Experimental opaque VP8 keyframe path. Coding rules and
// static format tables are documented in RFC 6386 sections 9, 11, 13 and 14.

use super::{BoolWriter, EncodeError, MAX_OUTPUT_BYTES};
use crate::ac_quant::{self, Deltas, Plane, Steps};
use crate::{residual, transform};

#[derive(Default)]
struct Macroblock {
    y: [[i16; 16]; 16],
    y2: [i16; 16],
    i16: bool,
    u: [[i16; 16]; 4],
    v: [[i16; 16]; 4],
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

fn predictor_dc(reconstructed: &[u8], stride: usize, x: usize, y: usize, size: usize) -> i32 {
    if x == 0 && y == 0 {
        return 128;
    }
    let mut sum = 0;
    let mut count = 0;
    if y > 0 {
        for i in 0..size {
            sum += i32::from(reconstructed[(y - 1) * stride + x + i]);
        }
        count += size as i32;
    }
    if x > 0 {
        for i in 0..size {
            sum += i32::from(reconstructed[(y + i) * stride + x - 1]);
        }
        count += size as i32;
    }
    (sum + count / 2) / count
}

fn code_block(
    source: &[u8],
    reconstructed: &mut [u8],
    stride: usize,
    x: usize,
    y: usize,
    predictor: i32,
    steps: Steps,
) -> [i16; 16] {
    let mut residual = [0i16; 16];
    for row in 0..4 {
        for col in 0..4 {
            residual[row * 4 + col] =
                (i32::from(source[(y + row) * stride + x + col]) - predictor) as i16;
        }
    }
    let transformed = transform::forward(&residual);
    let quantized = ac_quant::quantize_block(&transformed, steps);
    let dequantized = ac_quant::dequantize_block(&quantized, steps);
    let inverse = transform::inverse(&dequantized);
    for row in 0..4 {
        for col in 0..4 {
            reconstructed[(y + row) * stride + x + col] =
                clamp(predictor + i32::from(inverse[row * 4 + col]));
        }
    }
    quantized
}

fn code_i16(
    source: &[u8],
    reconstructed: &mut [u8],
    stride: usize,
    origin: (usize, usize),
    y_steps: Steps,
    y2_steps: Steps,
    block: &mut Macroblock,
) {
    let (x, y) = origin;
    let predictor = predictor_dc(reconstructed, stride, x, y, 16);
    let mut dc = [0i16; 16];
    for by in 0..4 {
        for bx in 0..4 {
            let index = by * 4 + bx;
            let mut samples = [0i16; 16];
            for row in 0..4 {
                for col in 0..4 {
                    samples[row * 4 + col] =
                        (i32::from(source[(y + by * 4 + row) * stride + x + bx * 4 + col])
                            - predictor) as i16;
                }
            }
            let mut transformed = transform::forward(&samples);
            dc[index] = transformed[0] as i16;
            transformed[0] = 0;
            block.y[index] = ac_quant::quantize_block(&transformed, y_steps);
        }
    }
    block.y2 = ac_quant::quantize_block(&transform::forward_wht(&dc), y2_steps);
    let dc = transform::inverse_wht(&ac_quant::dequantize_block(&block.y2, y2_steps));
    for by in 0..4 {
        for bx in 0..4 {
            let index = by * 4 + bx;
            let mut dequantized = ac_quant::dequantize_block(&block.y[index], y_steps);
            dequantized[0] = i32::from(dc[index]);
            let inverse = transform::inverse(&dequantized);
            for row in 0..4 {
                for col in 0..4 {
                    reconstructed[(y + by * 4 + row) * stride + x + bx * 4 + col] =
                        clamp(predictor + i32::from(inverse[row * 4 + col]));
                }
            }
        }
    }
}

fn encode_macroblock_coeffs(
    writer: &mut BoolWriter,
    values: &[[i16; 16]],
    plane: usize,
    above: &mut [bool],
    left: &mut [bool],
    column: usize,
    width: usize,
) -> Result<(), EncodeError> {
    for (index, value) in values.iter().enumerate() {
        let x = index % width;
        let y = index / width;
        let slot = column * width + x;
        let context = usize::from(above[slot]) + usize::from(left[y]);
        let nonzero = residual::encode_block(writer, value, plane, context)?;
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
    encode_observed(
        pixels,
        FrameSpec {
            width,
            height,
            stride,
            format,
            quality,
        },
        0,
        |_, _, _, _| {},
    )
}

#[derive(Clone, Copy)]
struct FrameSpec {
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    quality: u32,
}

fn encode_observed(
    pixels: &[u8],
    spec: FrameSpec,
    luma_policy: u8,
    observe: impl FnOnce(&[u8], &[u8], &[u8], usize),
) -> Result<Vec<u8>, EncodeError> {
    let FrameSpec {
        width,
        height,
        stride,
        format,
        quality,
    } = spec;
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
    let y_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::Y1);
    let uv_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::UV);
    let y2_steps = ac_quant::steps(qindex as u8, Deltas::default(), Plane::Y2);
    for my in 0..blocks_y {
        for mx in 0..blocks_x {
            let mut block = Macroblock {
                i16: luma_policy == 1 || (luma_policy == 2 && (mx + my) % 2 == 0),
                ..Macroblock::default()
            };
            if block.i16 {
                code_i16(
                    &source_y,
                    &mut reconstructed_y,
                    padded_w,
                    (mx * 16, my * 16),
                    y_steps,
                    y2_steps,
                    &mut block,
                );
            } else {
                for by in 0..4 {
                    for bx in 0..4 {
                        let x = mx * 16 + bx * 4;
                        let y = my * 16 + by * 4;
                        let predictor = predictor_y(&reconstructed_y, padded_w, x, y);
                        block.y[by * 4 + bx] = code_block(
                            &source_y,
                            &mut reconstructed_y,
                            padded_w,
                            x,
                            y,
                            predictor,
                            y_steps,
                        );
                    }
                }
            }
            for (plane, reconstructed, coeffs) in [
                (&source_u, &mut reconstructed_u, &mut block.u),
                (&source_v, &mut reconstructed_v, &mut block.v),
            ] {
                let x = mx * 8;
                let y = my * 8;
                let predictor = predictor_dc(reconstructed, uv_w, x, y, 8);
                for by in 0..2 {
                    for bx in 0..2 {
                        let cell_x = x + bx * 4;
                        let cell_y = y + by * 4;
                        coeffs[by * 2 + bx] = code_block(
                            plane,
                            reconstructed,
                            uv_w,
                            cell_x,
                            cell_y,
                            predictor,
                            uv_steps,
                        );
                    }
                }
            }
            blocks.push(block);
        }
    }
    let result = emit_frame(&blocks, width, height, qindex)?;
    observe(
        &reconstructed_y,
        &reconstructed_u,
        &reconstructed_v,
        padded_w,
    );
    Ok(result)
}

fn emit_frame(
    blocks: &[Macroblock],
    width: usize,
    height: usize,
    qindex: usize,
) -> Result<Vec<u8>, EncodeError> {
    let blocks_x = width.div_ceil(16);
    let blocks_y = height.div_ceil(16);
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
    let mut above_y2 = vec![false; blocks_x];
    let mut above_y = vec![false; blocks_x * 4];
    let mut above_u = vec![false; blocks_x * 2];
    let mut above_v = vec![false; blocks_x * 2];
    for my in 0..blocks_y {
        let mut left_y2 = false;
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
                .all(|v| v.iter().all(|&coefficient| coefficient == 0))
                && block.y2.iter().all(|&v| v == 0);
            header.write(128, skip)?;
            header.write(145, block.i16)?;
            if block.i16 {
                header.write(156, false)?;
                header.write(163, false)?; // I16 DC_PRED = 100.
            } else {
                for _ in 0..16 {
                    header.write(231, false)?;
                } // B_DC after B_DC or I16 DC.
            }
            header.write(142, false)?; // DC_PRED chroma mode.
            if !skip {
                if block.i16 {
                    let context = usize::from(above_y2[mx]) + usize::from(left_y2);
                    let nonzero = residual::encode_block(&mut token, &block.y2, 1, context)?;
                    above_y2[mx] = nonzero;
                    left_y2 = nonzero;
                }
                encode_macroblock_coeffs(
                    &mut token,
                    &block.y,
                    if block.i16 { 0 } else { 3 },
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
                if block.i16 {
                    above_y2[mx] = false;
                    left_y2 = false;
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_coefficient_categories_and_skip_contexts() {
        let magnitudes = [
            1, 2, 3, 4, 5, 6, 7, 10, 11, 18, 19, 34, 35, 66, 67, 2047, 2114,
        ];
        let mut blocks = Vec::new();
        // Each magnitude/sign exercises all sixteen scan positions. Interspersed
        // skipped blocks reset Y/UV and, when present, the separate Y2 contexts.
        for magnitude in magnitudes {
            for sign in [-1, 1] {
                for i16 in [false, true] {
                    let mut block = Macroblock {
                        i16,
                        ..Macroblock::default()
                    };
                    for position in 0..16 {
                        block.y[position][position] = sign * magnitude;
                        if i16 {
                            block.y[position][0] = 0;
                        }
                    }
                    for index in 0..4 {
                        block.u[index][(blocks.len() / 4 + index * 4) % 16] = sign * magnitude;
                        block.v[index][(blocks.len() / 4 + index * 4 + 3) % 16] = -sign * magnitude;
                    }
                    if i16 {
                        block.y2[(blocks.len() / 4) % 16] = sign * magnitude;
                    }
                    blocks.push(block);
                    blocks.push(Macroblock {
                        i16,
                        ..Macroblock::default()
                    });
                }
            }
        }
        let columns = 8;
        while blocks.len() % columns != 0 {
            blocks.push(Macroblock::default());
        }
        let width = columns * 16;
        let height = blocks.len() / columns * 16;
        let frame = emit_frame(&blocks, width, height, 0).unwrap();
        let y_steps = ac_quant::steps(0, Deltas::default(), Plane::Y1);
        let uv_steps = ac_quant::steps(0, Deltas::default(), Plane::UV);
        let y2_steps = ac_quant::steps(0, Deltas::default(), Plane::Y2);
        let mut y = vec![0u8; width * height];
        let mut u = vec![0u8; width * height / 4];
        let mut v = u.clone();
        for (index, block) in blocks.iter().enumerate() {
            let mx = index % columns;
            let my = index / columns;
            let dc = transform::inverse_wht(&ac_quant::dequantize_block(&block.y2, y2_steps));
            let i16_predictor = predictor_dc(&y, width, mx * 16, my * 16, 16);
            for by in 0..4 {
                for bx in 0..4 {
                    let x = mx * 16 + bx * 4;
                    let row = my * 16 + by * 4;
                    let mut coefficients =
                        ac_quant::dequantize_block(&block.y[by * 4 + bx], y_steps);
                    let predictor = if block.i16 {
                        coefficients[0] = i32::from(dc[by * 4 + bx]);
                        i16_predictor
                    } else {
                        predictor_y(&y, width, x, row)
                    };
                    let residual = transform::inverse(&coefficients);
                    for dy in 0..4 {
                        for dx in 0..4 {
                            y[(row + dy) * width + x + dx] =
                                clamp(predictor + i32::from(residual[dy * 4 + dx]));
                        }
                    }
                }
            }
            for (plane, coefficients) in [(&mut u, &block.u), (&mut v, &block.v)] {
                let stride = width / 2;
                let predictor = predictor_dc(plane, stride, mx * 8, my * 8, 8);
                for by in 0..2 {
                    for bx in 0..2 {
                        let residual = transform::inverse(&ac_quant::dequantize_block(
                            &coefficients[by * 2 + bx],
                            uv_steps,
                        ));
                        for dy in 0..4 {
                            for dx in 0..4 {
                                plane[(my * 8 + by * 4 + dy) * stride + mx * 8 + bx * 4 + dx] =
                                    clamp(predictor + i32::from(residual[dy * 4 + dx]));
                            }
                        }
                    }
                }
            }
        }
        let expected: Vec<u8> = y.into_iter().chain(u).chain(v).collect();
        assert_decodes(
            &frame,
            width,
            height,
            &expected,
            "categories/zero-runs/skip/Y2",
        );
    }

    fn assert_decodes(frame: &[u8], width: usize, height: usize, expected: &[u8], label: &str) {
        let mut ivf = vec![0u8; 44];
        ivf[..4].copy_from_slice(b"DKIF");
        ivf[6..8].copy_from_slice(&32u16.to_le_bytes());
        ivf[8..12].copy_from_slice(b"VP80");
        ivf[12..14].copy_from_slice(&(width as u16).to_le_bytes());
        ivf[14..16].copy_from_slice(&(height as u16).to_le_bytes());
        ivf[16..20].copy_from_slice(&1u32.to_le_bytes());
        ivf[20..24].copy_from_slice(&1u32.to_le_bytes());
        ivf[24..28].copy_from_slice(&1u32.to_le_bytes());
        ivf[32..36].copy_from_slice(&(frame.len() as u32).to_le_bytes());
        ivf.extend_from_slice(frame);
        for decoder in ["vp8", "libvpx"] {
            let mut child = Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-c:v",
                    decoder,
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "yuv420p",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&ivf).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let difference = output.stdout.iter().zip(expected).position(|(a, b)| a != b);
            assert_eq!(output.stdout.len(), expected.len());
            assert!(
                difference.is_none(),
                "decoder={decoder} {width}x{height} {label} mismatch={difference:?}"
            );
        }
    }

    /// External engineering oracle, deliberately separate from product acceptance.
    /// Both FFmpeg's native VP8 decoder and libvpx must match every visible YUV byte.
    #[test]
    #[ignore = "requires FFmpeg with native vp8 and libvpx decoders"]
    fn independent_decoder_reconstruction() {
        let mut cases = vec![(1, 1), (1, 33), (33, 1), (64, 48)];
        for remainder in 0..16 {
            cases.push((32 + remainder, 48 + (15 - remainder)));
        }
        for (width, height) in cases {
            for quality in [60, 75, 85] {
                for pattern in 0..3 {
                    let mut seed = 0x501u32;
                    let mut pixels = vec![0; width * height * 4];
                    for (i, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        let rgb = match pattern {
                            0 => [((i * 37) & 255) as u8; 3],
                            1 => [seed as u8, (seed >> 8) as u8, (seed >> 16) as u8],
                            _ => [if i % 9 < 2 { 255 } else { 0 }; 3],
                        };
                        pixel.copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                    }
                    let mut expected = Vec::new();
                    let frame = encode_observed(
                        &pixels,
                        FrameSpec {
                            width: width as u32,
                            height: height as u32,
                            stride: width as u32 * 4,
                            format: 0,
                            quality,
                        },
                        pattern,
                        |y, u, v, padded_w| {
                            for (plane, stride, w, h) in [
                                (y, padded_w, width, height),
                                (u, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
                                (v, padded_w / 2, width.div_ceil(2), height.div_ceil(2)),
                            ] {
                                for row in 0..h {
                                    expected
                                        .extend_from_slice(&plane[row * stride..row * stride + w]);
                                }
                            }
                        },
                    )
                    .unwrap();
                    assert_eq!(
                        frame,
                        encode_observed(
                            &pixels,
                            FrameSpec {
                                width: width as u32,
                                height: height as u32,
                                stride: width as u32 * 4,
                                format: 0,
                                quality
                            },
                            pattern,
                            |_, _, _, _| {}
                        )
                        .unwrap()
                    );
                    assert_decodes(
                        &frame,
                        width,
                        height,
                        &expected,
                        &format!("q={quality} pattern={pattern}"),
                    );
                }
            }
        }
    }
}
