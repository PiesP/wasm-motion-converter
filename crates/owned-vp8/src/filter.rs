// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Test-side VP8 keyframe reconstruction filter. The arithmetic follows RFC 6386
// section 15 and was checked against libwebp decoder DSP C at commit
// 6c484cbf92e81a5673b24485ac02d211f69be5b7 (BSD-3-Clause, COPYING).
// Apply only after *all* macroblocks are reconstructed: intra prediction must
// read unfiltered neighbors. This module is excluded from production builds.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FilterParams {
    pub level: u8,
    pub sharpness: u8,
    pub simple: bool,
    pub i4: bool,
    pub has_coefficients: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum FilterError {
    Control,
    Plane,
    Macroblock,
}

pub(super) struct Plane<'a> {
    pub data: &'a mut [u8],
    pub width: usize,
    pub height: usize,
    pub stride: usize,
}

pub(super) struct Planes<'a> {
    pub y: Plane<'a>,
    pub u: Plane<'a>,
    pub v: Plane<'a>,
}

#[derive(Clone, Copy)]
enum Edge {
    Vertical,
    Horizontal,
}

#[derive(Clone, Copy)]
enum Taps {
    Simple,
    Macroblock,
    Inner,
}

fn clip_signed(value: i32) -> i32 {
    value.clamp(-128, 127)
}

fn clip_delta(value: i32) -> i32 {
    value.clamp(-16, 15)
}

fn clip_pixel(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn thresholds(level: u8, sharpness: u8) -> (i32, i32, i32) {
    let level = i32::from(level);
    let sharpness = i32::from(sharpness);
    let mut interior = level;
    if sharpness > 0 {
        interior >>= if sharpness > 4 { 2 } else { 1 };
        interior = interior.min(9 - sharpness);
    }
    interior = interior.max(1);
    let hev = if level >= 40 {
        2
    } else if level >= 15 {
        1
    } else {
        0
    };
    (interior, 2 * level + interior, hev)
}

fn filter_segment(
    data: &mut [u8],
    q: usize,
    step: usize,
    limit: i32,
    interior: i32,
    hev: i32,
    taps: Taps,
) {
    let p3 = i32::from(data[q - 4 * step]);
    let p2 = i32::from(data[q - 3 * step]);
    let p1 = i32::from(data[q - 2 * step]);
    let p0 = i32::from(data[q - step]);
    let q0 = i32::from(data[q]);
    let q1 = i32::from(data[q + step]);
    let q2 = i32::from(data[q + 2 * step]);
    let q3 = i32::from(data[q + 3 * step]);

    // libwebp NeedsFilter_C uses twice the RFC edge limit to avoid fractions.
    if 4 * (p0 - q0).abs() + (p1 - q1).abs() > 2 * limit + 1 {
        return;
    }
    if !matches!(taps, Taps::Simple)
        && ((p3 - p2).abs() > interior
            || (p2 - p1).abs() > interior
            || (p1 - p0).abs() > interior
            || (q3 - q2).abs() > interior
            || (q2 - q1).abs() > interior
            || (q1 - q0).abs() > interior)
    {
        return;
    }

    let high_variance = (p1 - p0).abs() > hev || (q1 - q0).abs() > hev;
    if matches!(taps, Taps::Simple) || high_variance {
        let a = 3 * (q0 - p0) + clip_signed(p1 - q1);
        let a1 = clip_delta((a + 4) >> 3);
        let a2 = clip_delta((a + 3) >> 3);
        data[q - step] = clip_pixel(p0 + a2);
        data[q] = clip_pixel(q0 - a1);
    } else if matches!(taps, Taps::Inner) {
        let a = 3 * (q0 - p0);
        let a1 = clip_delta((a + 4) >> 3);
        let a2 = clip_delta((a + 3) >> 3);
        let a3 = (a1 + 1) >> 1;
        data[q - 2 * step] = clip_pixel(p1 + a3);
        data[q - step] = clip_pixel(p0 + a2);
        data[q] = clip_pixel(q0 - a1);
        data[q + step] = clip_pixel(q1 - a3);
    } else {
        let a = clip_signed(3 * (q0 - p0) + clip_signed(p1 - q1));
        let a1 = (27 * a + 63) >> 7;
        let a2 = (18 * a + 63) >> 7;
        let a3 = (9 * a + 63) >> 7;
        data[q - 3 * step] = clip_pixel(p2 + a3);
        data[q - 2 * step] = clip_pixel(p1 + a2);
        data[q - step] = clip_pixel(p0 + a1);
        data[q] = clip_pixel(q0 - a1);
        data[q + step] = clip_pixel(q1 - a2);
        data[q + 2 * step] = clip_pixel(q2 - a3);
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The VP8 edge needs separate plane, position, geometry, and threshold controls"
)]
fn filter_edge(
    plane: &mut Plane<'_>,
    x: usize,
    y: usize,
    length: usize,
    edge: Edge,
    limit: i32,
    interior: i32,
    hev: i32,
    taps: Taps,
) {
    let step = match edge {
        Edge::Vertical => 1,
        Edge::Horizontal => plane.stride,
    };
    for offset in 0..length {
        let (px, py) = match edge {
            Edge::Vertical => (x, y + offset),
            Edge::Horizontal => (x + offset, y),
        };
        filter_segment(
            plane.data,
            py * plane.stride + px,
            step,
            limit,
            interior,
            hev,
            taps,
        );
    }
}

fn valid_plane(plane: &Plane<'_>, required_width: usize, required_height: usize) -> bool {
    plane.width >= required_width
        && plane.height >= required_height
        && plane.stride >= plane.width
        && plane.height > 0
        && plane
            .stride
            .checked_mul(plane.height - 1)
            .and_then(|bytes| bytes.checked_add(plane.width))
            .is_some_and(|bytes| bytes <= plane.data.len())
}

/// Filter one already-reconstructed macroblock in raster order. `has_coefficients`
/// is the actual macroblock coefficient-presence bit; I4 always has inner edges.
pub(super) fn filter_macroblock(
    planes: &mut Planes<'_>,
    mb_x: usize,
    mb_y: usize,
    params: FilterParams,
) -> Result<(), FilterError> {
    if params.level > 63 || params.sharpness > 7 {
        return Err(FilterError::Control);
    }
    let x = mb_x.checked_mul(16).ok_or(FilterError::Macroblock)?;
    let y = mb_y.checked_mul(16).ok_or(FilterError::Macroblock)?;
    let cx = mb_x.checked_mul(8).ok_or(FilterError::Macroblock)?;
    let cy = mb_y.checked_mul(8).ok_or(FilterError::Macroblock)?;
    let x_end = x.checked_add(16).ok_or(FilterError::Macroblock)?;
    let y_end = y.checked_add(16).ok_or(FilterError::Macroblock)?;
    let cx_end = cx.checked_add(8).ok_or(FilterError::Macroblock)?;
    let cy_end = cy.checked_add(8).ok_or(FilterError::Macroblock)?;
    if !valid_plane(&planes.y, x_end, y_end)
        || !valid_plane(&planes.u, cx_end, cy_end)
        || !valid_plane(&planes.v, cx_end, cy_end)
    {
        return Err(FilterError::Plane);
    }
    if params.level == 0 {
        return Ok(());
    }
    let (interior, inner_limit, hev) = thresholds(params.level, params.sharpness);
    let mb_limit = inner_limit + 4;
    let inner = params.i4 || params.has_coefficients;
    let mb_taps = if params.simple {
        Taps::Simple
    } else {
        Taps::Macroblock
    };
    let inner_taps = if params.simple {
        Taps::Simple
    } else {
        Taps::Inner
    };

    // Match libwebp frame_dec.c DoFilter: left, inner vertical, top, inner
    // horizontal. Simple filtering deliberately leaves U and V untouched.
    if mb_x > 0 {
        filter_edge(
            &mut planes.y,
            x,
            y,
            16,
            Edge::Vertical,
            mb_limit,
            interior,
            hev,
            mb_taps,
        );
        if !params.simple {
            filter_edge(
                &mut planes.u,
                cx,
                cy,
                8,
                Edge::Vertical,
                mb_limit,
                interior,
                hev,
                mb_taps,
            );
            filter_edge(
                &mut planes.v,
                cx,
                cy,
                8,
                Edge::Vertical,
                mb_limit,
                interior,
                hev,
                mb_taps,
            );
        }
    }
    if inner {
        for offset in [4, 8, 12] {
            filter_edge(
                &mut planes.y,
                x + offset,
                y,
                16,
                Edge::Vertical,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
        }
        if !params.simple {
            filter_edge(
                &mut planes.u,
                cx + 4,
                cy,
                8,
                Edge::Vertical,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
            filter_edge(
                &mut planes.v,
                cx + 4,
                cy,
                8,
                Edge::Vertical,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
        }
    }
    if mb_y > 0 {
        filter_edge(
            &mut planes.y,
            x,
            y,
            16,
            Edge::Horizontal,
            mb_limit,
            interior,
            hev,
            mb_taps,
        );
        if !params.simple {
            filter_edge(
                &mut planes.u,
                cx,
                cy,
                8,
                Edge::Horizontal,
                mb_limit,
                interior,
                hev,
                mb_taps,
            );
            filter_edge(
                &mut planes.v,
                cx,
                cy,
                8,
                Edge::Horizontal,
                mb_limit,
                interior,
                hev,
                mb_taps,
            );
        }
    }
    if inner {
        for offset in [4, 8, 12] {
            filter_edge(
                &mut planes.y,
                x,
                y + offset,
                16,
                Edge::Horizontal,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
        }
        if !params.simple {
            filter_edge(
                &mut planes.u,
                cx,
                cy + 4,
                8,
                Edge::Horizontal,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
            filter_edge(
                &mut planes.v,
                cx,
                cy + 4,
                8,
                Edge::Horizontal,
                inner_limit,
                interior,
                hev,
                inner_taps,
            );
        }
    }
    Ok(())
}

/// Run only after the full unfiltered frame and every macroblock's metadata
/// have been frozen. The caller supplies row-major per-MB segment parameters.
pub(super) fn filter_frame(
    planes: &mut Planes<'_>,
    mb_width: usize,
    mb_height: usize,
    parameters: &[FilterParams],
) -> Result<(), FilterError> {
    if mb_width == 0 || mb_height == 0 || mb_width.checked_mul(mb_height) != Some(parameters.len())
    {
        return Err(FilterError::Macroblock);
    }
    for mb_y in 0..mb_height {
        for mb_x in 0..mb_width {
            filter_macroblock(planes, mb_x, mb_y, parameters[mb_y * mb_width + mb_x])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Frozen from libwebp decoder DSP C (commit 6c484cbf92e81a5673b24485ac02d211f69be5b7).
    // Reproduction source, exact input/output, source hashes and license are in
    // .codex-artifacts/wmc-501-vp8-v2/filter-oracle/ outside the tracked tree.
    #[test]
    fn pinned_decoder_edge_vectors() {
        type EdgeVector = (&'static str, u8, u8, u8, [u8; 8], [u8; 8]);
        let vectors: [EdgeVector; 15] = [
            (
                "flat_simple",
                10,
                0,
                0,
                [100, 100, 100, 100, 104, 104, 104, 104],
                [100, 100, 100, 101, 103, 104, 104, 104],
            ),
            (
                "flat_inner",
                10,
                0,
                1,
                [100, 100, 100, 100, 104, 104, 104, 104],
                [100, 100, 101, 101, 102, 103, 104, 104],
            ),
            (
                "flat_mb",
                10,
                0,
                2,
                [100, 100, 100, 100, 104, 104, 104, 104],
                [100, 101, 101, 102, 102, 103, 103, 104],
            ),
            (
                "flat_mbplus",
                10,
                0,
                3,
                [100, 100, 100, 100, 104, 104, 104, 104],
                [100, 101, 101, 102, 102, 103, 103, 104],
            ),
            (
                "hev_inner",
                10,
                0,
                1,
                [100, 100, 100, 98, 104, 106, 106, 106],
                [100, 100, 100, 99, 102, 106, 106, 106],
            ),
            (
                "hev_mb",
                10,
                0,
                2,
                [100, 100, 100, 98, 104, 106, 106, 106],
                [100, 100, 100, 99, 102, 106, 106, 106],
            ),
            (
                "low_extreme",
                63,
                0,
                2,
                [0, 0, 0, 0, 1, 1, 1, 1],
                [0, 0, 0, 0, 1, 1, 1, 1],
            ),
            (
                "high_extreme",
                63,
                0,
                2,
                [254, 254, 254, 254, 255, 255, 255, 255],
                [254, 254, 254, 254, 255, 255, 255, 255],
            ),
            (
                "positive_edge",
                63,
                0,
                0,
                [0, 0, 0, 0, 255, 255, 255, 255],
                [0, 0, 0, 0, 255, 255, 255, 255],
            ),
            (
                "negative_edge",
                63,
                0,
                0,
                [255, 255, 255, 255, 0, 0, 0, 0],
                [255, 255, 255, 255, 0, 0, 0, 0],
            ),
            (
                "threshold_pass",
                10,
                0,
                0,
                [100, 100, 100, 100, 112, 112, 112, 112],
                [100, 100, 100, 103, 109, 112, 112, 112],
            ),
            (
                "threshold_fail",
                10,
                0,
                0,
                [100, 100, 100, 100, 113, 113, 113, 113],
                [100, 100, 100, 100, 113, 113, 113, 113],
            ),
            (
                "sharpness_max",
                63,
                7,
                2,
                [100, 100, 100, 100, 104, 104, 104, 104],
                [100, 101, 101, 102, 102, 103, 103, 104],
            ),
            (
                "hev_border",
                15,
                0,
                2,
                [100, 100, 100, 98, 104, 106, 106, 106],
                [100, 100, 100, 99, 102, 106, 106, 106],
            ),
            (
                "hev_just_over",
                15,
                0,
                2,
                [100, 100, 100, 97, 104, 107, 107, 107],
                [100, 100, 100, 99, 102, 107, 107, 107],
            ),
        ];
        for (name, level, sharpness, mode, mut actual, expected) in vectors {
            let (interior, limit, hev) = thresholds(level, sharpness);
            let taps = match mode {
                0 => Taps::Simple,
                1 => Taps::Inner,
                2 | 3 => Taps::Macroblock,
                _ => unreachable!(),
            };
            filter_segment(
                &mut actual,
                4,
                1,
                limit + i32::from(mode == 3) * 4,
                interior,
                hev,
                taps,
            );
            assert_eq!(actual, expected, "{name}");
        }
    }

    #[test]
    fn pinned_decoder_all_levels_and_sharpnesses() {
        let expected = [
            0x79058c69d8ff97d7,
            0x38ac2a93b102c388,
            0x101f4ab2bf6ec133,
            0xa65e866f5b64a823,
        ];
        for (mode, expected_hash) in expected.into_iter().enumerate() {
            let mut hash: u64 = 0xcbf29ce484222325;
            let mut seed: u32 = 0x9e3779b9 ^ mode as u32;
            for level in 0..64_u8 {
                for sharpness in 0..8_u8 {
                    for _ in 0..8 {
                        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        let base = 16 + ((seed >> 8) % 224) as i32;
                        let delta = ((seed >> 16) % 32) as i32 - 16;
                        let mut data = [
                            base,
                            base,
                            base + ((seed >> 4) & 3) as i32 - 1,
                            base,
                            base + delta,
                            base + delta + ((seed >> 6) & 3) as i32 - 1,
                            base + delta,
                            base + delta,
                        ]
                        .map(clip_pixel);
                        if level > 0 {
                            let (interior, limit, hev) = thresholds(level, sharpness);
                            let taps = match mode {
                                0 => Taps::Simple,
                                1 => Taps::Inner,
                                2 | 3 => Taps::Macroblock,
                                _ => unreachable!(),
                            };
                            filter_segment(
                                &mut data,
                                4,
                                1,
                                limit + i32::from(mode == 3) * 4,
                                interior,
                                hev,
                                taps,
                            );
                        }
                        for byte in data {
                            hash = (hash ^ u64::from(byte)).wrapping_mul(1_099_511_628_211);
                        }
                    }
                }
            }
            assert_eq!(hash, expected_hash, "mode {mode}");
        }
    }

    fn planes<'a>(
        y: &'a mut [u8],
        u: &'a mut [u8],
        v: &'a mut [u8],
        y_stride: usize,
        uv_stride: usize,
        y_height: usize,
    ) -> Planes<'a> {
        Planes {
            y: Plane {
                data: y,
                width: y_stride,
                height: y_height,
                stride: y_stride,
            },
            u: Plane {
                data: u,
                width: uv_stride,
                height: y_height / 2,
                stride: uv_stride,
            },
            v: Plane {
                data: v,
                width: uv_stride,
                height: y_height / 2,
                stride: uv_stride,
            },
        }
    }

    fn params(simple: bool, i4: bool, has_coefficients: bool) -> FilterParams {
        FilterParams {
            level: 10,
            sharpness: 0,
            simple,
            i4,
            has_coefficients,
        }
    }

    #[test]
    fn macroblock_boundary_and_simple_chroma() {
        for simple in [false, true] {
            let mut y = vec![100; 32 * 16];
            let mut u = vec![100; 16 * 8];
            let mut v = vec![100; 16 * 8];
            for row in y.as_chunks_mut::<32>().0 {
                row[16..].fill(104);
            }
            for plane in [&mut u, &mut v] {
                for row in plane.as_chunks_mut::<16>().0 {
                    row[8..].fill(104);
                }
            }
            let mut frame = planes(&mut y, &mut u, &mut v, 32, 16, 16);
            filter_frame(&mut frame, 2, 1, &[params(simple, false, false); 2]).unwrap();
            assert!(y[15] > 100 && y[16] < 104);
            if simple {
                assert_eq!(u[7], 100);
                assert_eq!(v[8], 104);
            } else {
                assert!(u[7] > 100 && v[8] < 104);
            }
        }
    }

    #[test]
    fn top_boundary_uses_horizontal_edges() {
        for simple in [false, true] {
            let mut y = vec![100; 16 * 32];
            let mut u = vec![100; 8 * 16];
            let mut v = vec![100; 8 * 16];
            y[16 * 16..].fill(104);
            u[8 * 8..].fill(104);
            v[8 * 8..].fill(104);
            let mut frame = planes(&mut y, &mut u, &mut v, 16, 8, 32);
            filter_frame(&mut frame, 1, 2, &[params(simple, false, false); 2]).unwrap();
            assert!(y[15 * 16] > 100 && y[16 * 16] < 104);
            if simple {
                assert_eq!(u[7 * 8], 100);
                assert_eq!(v[8 * 8], 104);
            } else {
                assert!(u[7 * 8] > 100 && v[8 * 8] < 104);
            }
        }
    }

    #[test]
    fn inner_edges_follow_i4_or_coefficient_presence() {
        for (i4, coefficients, filtered) in [
            (false, false, false),
            (false, true, true),
            (true, false, true),
        ] {
            let mut y = vec![100; 16 * 16];
            let mut u = vec![100; 8 * 8];
            let mut v = vec![100; 8 * 8];
            for row in y.as_chunks_mut::<16>().0 {
                row[4..].fill(104);
            }
            for row in u.as_chunks_mut::<8>().0 {
                row[4..].fill(104);
            }
            for row in v.as_chunks_mut::<8>().0 {
                row[4..].fill(104);
            }
            let mut frame = planes(&mut y, &mut u, &mut v, 16, 8, 16);
            filter_macroblock(&mut frame, 0, 0, params(false, i4, coefficients)).unwrap();
            assert_eq!(y[3] > 100, filtered);
            assert_eq!(u[3] > 100, filtered);
            assert_eq!(v[4] < 104, filtered);
        }
    }

    #[test]
    fn level_zero_and_invalid_geometry() {
        // One coded macroblock can carry a tiny visible image; stride padding is
        // untouched and level zero skips filtering even when inner edges exist.
        let mut y = vec![100; 20 * 16];
        let mut u = vec![100; 12 * 8];
        let mut v = vec![100; 12 * 8];
        for row in y.as_chunks_mut::<20>().0 {
            row[4..16].fill(104);
            row[16..].fill(231);
        }
        for row in u.as_chunks_mut::<12>().0 {
            row[8..].fill(231);
        }
        for row in v.as_chunks_mut::<12>().0 {
            row[8..].fill(231);
        }
        let original = y.clone();
        let mut frame = Planes {
            y: Plane {
                data: &mut y,
                width: 16,
                height: 16,
                stride: 20,
            },
            u: Plane {
                data: &mut u,
                width: 8,
                height: 8,
                stride: 12,
            },
            v: Plane {
                data: &mut v,
                width: 8,
                height: 8,
                stride: 12,
            },
        };
        filter_macroblock(
            &mut frame,
            0,
            0,
            FilterParams {
                level: 0,
                ..params(false, true, false)
            },
        )
        .unwrap();
        assert_eq!(frame.y.data, original);
        filter_macroblock(&mut frame, 0, 0, params(false, true, false)).unwrap();
        for row in frame.y.data.as_chunks::<20>().0 {
            assert_eq!(&row[16..], &[231; 4]);
        }
        assert_eq!(
            filter_macroblock(&mut frame, 1, 0, params(false, false, false)),
            Err(FilterError::Plane)
        );
        assert_eq!(
            filter_macroblock(&mut frame, usize::MAX, 0, params(false, false, false)),
            Err(FilterError::Macroblock)
        );
        assert_eq!(
            filter_macroblock(
                &mut frame,
                0,
                0,
                FilterParams {
                    sharpness: 8,
                    ..params(false, false, false)
                }
            ),
            Err(FilterError::Control)
        );
        assert_eq!(
            filter_macroblock(
                &mut frame,
                0,
                0,
                FilterParams {
                    level: 64,
                    ..params(false, false, false)
                }
            ),
            Err(FilterError::Control)
        );
        assert_eq!(
            filter_frame(&mut frame, 2, 1, &[params(false, false, false)]),
            Err(FilterError::Macroblock)
        );
        assert_eq!(
            filter_frame(&mut frame, 0, 0, &[]),
            Err(FilterError::Macroblock)
        );
    }
}
