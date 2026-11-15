// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Bounded local display proxy for VP8 coefficient trials. This approximates
// FFmpeg's default limited-range BT.601 YUV420P -> RGB24 conversion; it is not
// a byte-exact decoder or an SSIM oracle.

#[derive(Clone, Copy)]
pub(super) struct Original<'a> {
    pub pixels: &'a [u8],
    pub stride: usize,
    pub layout: u32,
}

impl Original<'_> {
    fn at(self, x: usize, y: usize) -> [u8; 3] {
        let bpp = if self.layout == 4 { 3 } else { 4 };
        let offset = y * self.stride + x * bpp;
        if matches!(self.layout, 0 | 2 | 4) {
            [
                self.pixels[offset],
                self.pixels[offset + 1],
                self.pixels[offset + 2],
            ]
        } else {
            [
                self.pixels[offset + 2],
                self.pixels[offset + 1],
                self.pixels[offset],
            ]
        }
    }
}

#[derive(Clone, Copy)]
struct Axis {
    at: [usize; 4],
    weight: [i32; 4],
    len: usize,
}

impl Axis {
    fn single(at: usize) -> Self {
        Self {
            at: [at, 0, 0, 0],
            weight: [4096, 0, 0, 0],
            len: 1,
        }
    }

    fn chroma(pixel: usize, output_len: usize, horizontal: bool, direct: bool) -> Self {
        let input_len = output_len.div_ceil(2);
        if direct || (horizontal && output_len.is_multiple_of(2)) {
            return Self::single(pixel / 2);
        }
        let count = input_len.saturating_sub(2).clamp(1, 4);
        // FFmpeg's short source planes collapse their bicubic support. With
        // one effective tap, centered scaling gives the observed 5->3 map.
        let position_q12 =
            ((2 * pixel + 1) as i64 * input_len as i64 * 4096 / (2 * output_len) as i64) - 2048;
        if count == 1 {
            let nearest = (position_q12 + 2048)
                .div_euclid(4096)
                .clamp(0, input_len as i64 - 1) as usize;
            return Self::single(nearest);
        }
        // The regular scaler starts its short filter at a truncating signed
        // quotient of the centered source position and (tap_count - 2)/2.
        let first = (position_q12 - (count as i64 - 2) * 2048) / 4096;
        let mut at = [0; 4];
        let mut numerator = [0i64; 4];
        let mut total = 0i64;
        for i in 0..count {
            let sample = first + i as i64;
            at[i] = sample.clamp(0, input_len as i64 - 1) as usize;
            numerator[i] = cubic((position_q12 - sample * 4096).unsigned_abs() as i64);
            total += numerator[i];
        }
        let mut weight = [0; 4];
        // Normalize the signed cubic weights, preserving their sum exactly.
        let mut assigned = 0;
        for i in 0..count - 1 {
            weight[i] = ((numerator[i] * 4096 + total.signum() * (total.abs() / 2)) / total) as i32;
            assigned += weight[i];
        }
        weight[count - 1] = 4096 - assigned;
        Self {
            at,
            weight,
            len: count,
        }
    }
}

// B=0, C=0.6 Keys cubic. Numerators share the denominator 5 * 4096^3.
fn cubic(distance: i64) -> i64 {
    const Q: i64 = 4096;
    if distance < Q {
        5 * Q.pow(3) - 12 * distance.pow(2) * Q + 7 * distance.pow(3)
    } else if distance < 2 * Q {
        12 * Q.pow(3) - 24 * distance * Q.pow(2) + 15 * distance.pow(2) * Q - 3 * distance.pow(3)
    } else {
        0
    }
}

pub(super) struct Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub stride_y: usize,
    pub original: Original<'a>,
    pub source_y: &'a [u8],
    pub source_u: &'a [u8],
    pub source_v: &'a [u8],
    pub reconstructed_y: &'a [u8],
    pub reconstructed_u: &'a [u8],
    pub reconstructed_v: &'a [u8],
    pub tile_y: &'a [u8; 256],
    pub tile_u: &'a [u8; 64],
    pub tile_v: &'a [u8; 64],
    pub mx: usize,
    pub my: usize,
}

#[derive(Clone, Copy)]
pub(super) struct Change<'a> {
    pub plane: usize,
    pub bx: usize,
    pub by: usize,
    pub patch: &'a [u8; 16],
}

impl Frame<'_> {
    fn y(&self, x: usize, y: usize) -> u8 {
        let bx = x / 16;
        let by = y / 16;
        if bx == self.mx && by == self.my {
            return self.tile_y[(y % 16) * 16 + x % 16];
        }
        let at = y * self.stride_y + x;
        if by < self.my || (by == self.my && bx < self.mx) {
            self.reconstructed_y[at]
        } else {
            self.source_y[at]
        }
    }

    fn uv(&self, plane: usize, x: usize, y: usize, change: Option<Change<'_>>) -> u8 {
        let bx = x / 8;
        let by = y / 8;
        if bx == self.mx && by == self.my {
            if let Some(change) = change {
                let lx = x % 8;
                let ly = y % 8;
                if change.plane == plane && lx / 4 == change.bx && ly / 4 == change.by {
                    return change.patch[(ly % 4) * 4 + lx % 4];
                }
            }
            let tile = if plane == 0 { self.tile_u } else { self.tile_v };
            return tile[(y % 8) * 8 + x % 8];
        }
        let at = y * (self.stride_y / 2) + x;
        let committed = by < self.my || (by == self.my && bx < self.mx);
        match (plane, committed) {
            (0, true) => self.reconstructed_u[at],
            (1, true) => self.reconstructed_v[at],
            (0, false) => self.source_u[at],
            _ => self.source_v[at],
        }
    }

    fn chroma_sum(&self, plane: usize, h: Axis, v: Axis) -> i64 {
        let mut sum = 0i64;
        for row in 0..v.len {
            for col in 0..h.len {
                sum += i64::from(self.uv(plane, h.at[col], v.at[row], None))
                    * i64::from(h.weight[col])
                    * i64::from(v.weight[row]);
            }
        }
        sum
    }

    #[cfg(test)]
    pub(super) fn rendered(&self, x: usize, y: usize, change: Option<Change<'_>>) -> [u8; 3] {
        let direct = self.height.is_multiple_of(2);
        let h = Axis::chroma(x, self.width, true, direct);
        let v = Axis::chroma(y, self.height, false, direct);
        let mut sums = [self.chroma_sum(0, h, v), self.chroma_sum(1, h, v)];
        if let Some(change) = change {
            sums[change.plane] += self.change_sum(h, v, change);
        }
        render(self.y(x, y), sums[0], sums[1])
    }

    #[cfg(test)]
    pub(super) fn error(&self, x: usize, y: usize, change: Option<Change<'_>>) -> u32 {
        let reference = self.original.at(x, y);
        let rendered = self.rendered(x, y, change);
        squared_rgb_error(reference, rendered)
    }

    pub(super) fn affected(&self, bx: usize, by: usize) -> (usize, usize, usize, usize) {
        let x = self.mx * 16 + bx * 8;
        let y = self.my * 16 + by * 8;
        (
            x.saturating_sub(4),
            (x + 12).min(self.width),
            y.saturating_sub(4),
            (y + 12).min(self.height),
        )
    }

    fn change_sum(&self, h: Axis, v: Axis, change: Change<'_>) -> i64 {
        let block_x = self.mx * 8 + change.bx * 4;
        let block_y = self.my * 8 + change.by * 4;
        let tile = if change.plane == 0 {
            self.tile_u
        } else {
            self.tile_v
        };
        let mut sum = 0i64;
        for row in 0..v.len {
            let sy = v.at[row];
            if !(block_y..block_y + 4).contains(&sy) {
                continue;
            }
            for col in 0..h.len {
                let sx = h.at[col];
                if !(block_x..block_x + 4).contains(&sx) {
                    continue;
                }
                let new = change.patch[(sy - block_y) * 4 + sx - block_x];
                let old = tile[(sy - self.my * 8) * 8 + sx - self.mx * 8];
                sum += i64::from(i32::from(new) - i32::from(old))
                    * i64::from(h.weight[col])
                    * i64::from(v.weight[row]);
            }
        }
        sum
    }
}

fn render(luma: u8, u_sum: i64, v_sum: i64) -> [u8; 3] {
    let y = i32::from(luma) - 16;
    let u = (((u_sum + (1 << 23)) >> 24).clamp(0, 255) as i32) - 128;
    let v = (((v_sum + (1 << 23)) >> 24).clamp(0, 255) as i32) - 128;
    let round = 1 << 15;
    let rgb = [
        76309 * y + 104597 * v,
        76309 * y - 25675 * u - 53279 * v,
        76309 * y + 132201 * u,
    ];
    rgb.map(|channel| ((channel + round) >> 16).clamp(0, 255) as u8)
}

fn squared_rgb_error(reference: [u8; 3], rendered: [u8; 3]) -> u32 {
    reference
        .into_iter()
        .zip(rendered)
        .map(|(a, b)| {
            let d = i32::from(a) - i32::from(b);
            (d * d) as u32
        })
        .sum()
}

#[derive(Clone, Copy, Default)]
struct Pixel {
    luma: u8,
    u_sum: i64,
    v_sum: i64,
    original: [u8; 3],
    baseline_error: u32,
}

// At most 24x24 visible pixels and 48 one-dimensional weight vectors. The
// baseline is built once only if a rate-qualified coefficient trial exists.
pub(super) struct LocalCache {
    x0: usize,
    y0: usize,
    horizontal: [Axis; 24],
    vertical: [Axis; 24],
    pixels: [Pixel; 24 * 24],
}

const _: () = assert!(std::mem::size_of::<LocalCache>() <= 32 * 1024);

impl LocalCache {
    pub(super) fn new(frame: &Frame<'_>) -> Self {
        let x0 = (frame.mx * 16).saturating_sub(4);
        let y0 = (frame.my * 16).saturating_sub(4);
        let right = (frame.mx * 16 + 20).min(frame.width);
        let bottom = (frame.my * 16 + 20).min(frame.height);
        let direct = frame.height.is_multiple_of(2);
        let mut cache = Self {
            x0,
            y0,
            horizontal: [Axis::single(0); 24],
            vertical: [Axis::single(0); 24],
            pixels: [Pixel::default(); 24 * 24],
        };
        for x in x0..right {
            cache.horizontal[x - x0] = Axis::chroma(x, frame.width, true, direct);
        }
        for y in y0..bottom {
            cache.vertical[y - y0] = Axis::chroma(y, frame.height, false, direct);
        }
        for y in y0..bottom {
            for x in x0..right {
                let h = cache.horizontal[x - x0];
                let v = cache.vertical[y - y0];
                let luma = frame.y(x, y);
                let u_sum = frame.chroma_sum(0, h, v);
                let v_sum = frame.chroma_sum(1, h, v);
                let original = frame.original.at(x, y);
                let baseline_error = squared_rgb_error(original, render(luma, u_sum, v_sum));
                cache.pixels[(y - y0) * 24 + x - x0] = Pixel {
                    luma,
                    u_sum,
                    v_sum,
                    original,
                    baseline_error,
                };
            }
        }
        cache
    }

    pub(super) fn score(
        &self,
        frame: &Frame<'_>,
        change: Change<'_>,
        bounds: (usize, usize, usize, usize),
    ) -> (u64, u64) {
        let (left, right, top, bottom) = bounds;
        let mut baseline = 0u64;
        let mut candidate = 0u64;
        for y in top..bottom {
            for x in left..right {
                let index = (y - self.y0) * 24 + x - self.x0;
                let pixel = self.pixels[index];
                baseline += u64::from(pixel.baseline_error);
                let delta = frame.change_sum(
                    self.horizontal[x - self.x0],
                    self.vertical[y - self.y0],
                    change,
                );
                let sums = if change.plane == 0 {
                    (pixel.u_sum + delta, pixel.v_sum)
                } else {
                    (pixel.u_sum, pixel.v_sum + delta)
                };
                candidate += u64::from(squared_rgb_error(
                    pixel.original,
                    render(pixel.luma, sums.0, sums.1),
                ));
            }
        }
        (baseline, candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_plane_phase_and_direct_height() {
        let horizontal: Vec<_> = (0..5)
            .map(|x| Axis::chroma(x, 5, true, false).at[0])
            .collect();
        assert_eq!(horizontal, [0, 0, 1, 2, 2]);
        let vertical: Vec<_> = (0..9)
            .map(|y| Axis::chroma(y, 9, false, true).at[0])
            .collect();
        assert_eq!(vertical, [0, 0, 1, 1, 2, 2, 3, 3, 4]);
        let regular = Axis::chroma(3, 9, false, false);
        assert!(regular.len > 1);
        assert_eq!(regular.weight[..regular.len].iter().sum::<i32>(), 4096);
        for dimension in 1..=128 {
            for pixel in 0..dimension {
                for horizontal in [false, true] {
                    let axis = Axis::chroma(pixel, dimension, horizontal, false);
                    assert!(axis.at[..axis.len]
                        .iter()
                        .all(|&sample| sample < dimension.div_ceil(2)));
                    assert_eq!(axis.weight[..axis.len].iter().sum::<i32>(), 4096);
                }
            }
        }
        for dimension in [1, 2, 3, 5, 9, 16_383] {
            for pixel in [0, 1, dimension / 2, dimension - 1] {
                if pixel >= dimension {
                    continue;
                }
                for horizontal in [false, true] {
                    let axis = Axis::chroma(pixel, dimension, horizontal, false);
                    assert!(axis.at[..axis.len]
                        .iter()
                        .all(|&sample| sample < dimension.div_ceil(2)));
                    assert_eq!(axis.weight[..axis.len].iter().sum::<i32>(), 4096);
                }
            }
        }
    }

    #[test]
    fn original_layout_and_stride() {
        let rgba = [10, 20, 30, 255, 99, 99, 40, 50, 60, 255, 99, 99];
        let bgra = [30, 20, 10, 255, 99, 99, 60, 50, 40, 255, 99, 99];
        assert_eq!(
            Original {
                pixels: &rgba,
                stride: 6,
                layout: 0
            }
            .at(0, 1),
            [40, 50, 60]
        );
        assert_eq!(
            Original {
                pixels: &bgra,
                stride: 6,
                layout: 1
            }
            .at(0, 1),
            [40, 50, 60]
        );
        assert_eq!(
            Original {
                pixels: &rgba,
                stride: 6,
                layout: 2
            }
            .at(0, 1),
            [40, 50, 60]
        );
        assert_eq!(
            Original {
                pixels: &bgra,
                stride: 6,
                layout: 3
            }
            .at(0, 1),
            [40, 50, 60]
        );
        let rgb = [10, 20, 30, 99, 40, 50, 60, 99];
        assert_eq!(
            Original {
                pixels: &rgb,
                stride: 4,
                layout: 4
            }
            .at(0, 1),
            [40, 50, 60]
        );
    }

    #[test]
    fn cached_patch_delta_matches_full_local_render_and_halo() {
        let y = [128u8; 256];
        let uv = [128u8; 64];
        let mut u_tile = uv;
        for row in 0..4 {
            for col in 0..4 {
                u_tile[row * 8 + col] = 133;
            }
        }
        let original = [120u8; 16 * 16 * 3];
        let frame = Frame {
            width: 16,
            height: 11,
            stride_y: 16,
            original: Original {
                pixels: &original,
                stride: 16 * 3,
                layout: 4,
            },
            source_y: &y,
            source_u: &uv,
            source_v: &uv,
            reconstructed_y: &y,
            reconstructed_u: &uv,
            reconstructed_v: &uv,
            tile_y: &y,
            tile_u: &u_tile,
            tile_v: &uv,
            mx: 0,
            my: 0,
        };
        let patch = [129u8; 16];
        let change = Change {
            plane: 0,
            bx: 0,
            by: 0,
            patch: &patch,
        };
        let bounds = frame.affected(0, 0);
        assert_eq!(bounds, (0, 12, 0, 11));
        let cache = LocalCache::new(&frame);
        let cached = cache.score(&frame, change, bounds);
        let mut direct = (0, 0);
        for py in bounds.2..bounds.3 {
            for px in bounds.0..bounds.1 {
                direct.0 += u64::from(frame.error(px, py, None));
                direct.1 += u64::from(frame.error(px, py, Some(change)));
            }
        }
        assert_eq!(cached, direct);
        assert_ne!(cached.0, cached.1);
        let hidden = Frame {
            width: 1,
            height: 1,
            ..frame
        };
        let bounds = hidden.affected(1, 1);
        assert!(bounds.0 >= bounds.1 || bounds.2 >= bounds.3);
    }

    #[test]
    fn cached_delta_at_macroblock_edges_matches_full_render() {
        for (width, height) in [(31, 31), (32, 32)] {
            let source_y = [126u8; 32 * 32];
            let source_uv = [123u8; 16 * 16];
            let reconstructed_y = [131u8; 32 * 32];
            let reconstructed_uv = [135u8; 16 * 16];
            let tile_y = [128u8; 256];
            let tile_u = [127u8; 64];
            let tile_v = [129u8; 64];
            let original = [100u8; 32 * 32 * 3];
            let frame = Frame {
                width,
                height,
                stride_y: 32,
                original: Original {
                    pixels: &original,
                    stride: 32 * 3,
                    layout: 4,
                },
                source_y: &source_y,
                source_u: &source_uv,
                source_v: &source_uv,
                reconstructed_y: &reconstructed_y,
                reconstructed_u: &reconstructed_uv,
                reconstructed_v: &reconstructed_uv,
                tile_y: &tile_y,
                tile_u: &tile_u,
                tile_v: &tile_v,
                mx: 1,
                my: 1,
            };
            let cache = LocalCache::new(&frame);
            let patch = [134u8; 16];
            for plane in 0..2 {
                for by in 0..2 {
                    for bx in 0..2 {
                        let change = Change {
                            plane,
                            bx,
                            by,
                            patch: &patch,
                        };
                        let bounds = frame.affected(bx, by);
                        let cached = cache.score(&frame, change, bounds);
                        let mut full = (0, 0);
                        for y in bounds.2..bounds.3 {
                            for x in bounds.0..bounds.1 {
                                full.0 += u64::from(frame.error(x, y, None));
                                full.1 += u64::from(frame.error(x, y, Some(change)));
                            }
                        }
                        assert_eq!(
                            cached, full,
                            "{width}x{height} plane={plane} block={bx},{by}"
                        );
                    }
                }
            }
        }
    }
}
