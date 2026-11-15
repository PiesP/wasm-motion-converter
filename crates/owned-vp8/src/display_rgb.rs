// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Bounded local display and SSIM proxy for VP8 coefficient trials. RGB
// approximates FFmpeg's default limited-range BT.601 YUV420P conversion;
// neither this prefilter proxy nor its SSIM score is a decoder oracle.

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

#[derive(Clone, Copy)]
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

    fn tile_delta(&self, plane: usize, h: Axis, v: Axis, trial: &[u8; 64]) -> i64 {
        let tile = if plane == 0 { self.tile_u } else { self.tile_v };
        let x0 = self.mx * 8;
        let y0 = self.my * 8;
        let mut sum = 0i64;
        for row in 0..v.len {
            let sy = v.at[row];
            if !(y0..y0 + 8).contains(&sy) {
                continue;
            }
            for col in 0..h.len {
                let sx = h.at[col];
                if (x0..x0 + 8).contains(&sx) {
                    let index = (sy - y0) * 8 + sx - x0;
                    sum += i64::from(i32::from(trial[index]) - i32::from(tile[index]))
                        * i64::from(h.weight[col])
                        * i64::from(v.weight[row]);
                }
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

// FFmpeg's nearest metric enlargement is applied only while sampling SSIM.
// Encoder reconstruction and the RGB display proxy keep physical dimensions.
fn metric_sample(pixel: usize, source_len: usize) -> usize {
    let metric_len = source_len.max(8);
    let increment = ((source_len * 65_536) + metric_len / 2) / metric_len;
    ((increment / 2 + pixel * increment) >> 16).min(source_len - 1)
}

#[derive(Clone, Copy)]
struct WindowRange {
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
}

fn metric_bounds(
    frame: &Frame<'_>,
    physical: (usize, usize, usize, usize),
) -> (usize, usize, usize, usize) {
    let (left, right, top, bottom) = physical;
    if left >= right || top >= bottom {
        return (0, 0, 0, 0);
    }
    (
        if frame.width < 8 { 0 } else { left },
        if frame.width < 8 { 8 } else { right },
        if frame.height < 8 { 0 } else { top },
        if frame.height < 8 { 8 } else { bottom },
    )
}

fn intersecting_windows(
    frame: &Frame<'_>,
    bounds: (usize, usize, usize, usize),
) -> Option<WindowRange> {
    let (left, right, top, bottom) = metric_bounds(frame, bounds);
    if left >= right || top >= bottom {
        return None;
    }
    let nx = (frame.width.max(8) >> 2) - 1;
    let ny = (frame.height.max(8) >> 2) - 1;
    let x0 = left.saturating_sub(7).div_ceil(4);
    let y0 = top.saturating_sub(7).div_ceil(4);
    let x1 = ((right - 1) / 4 + 1).min(nx);
    let y1 = ((bottom - 1) / 4 + 1).min(ny);
    (x0 < x1 && y0 < y1).then_some(WindowRange { x0, x1, y0, y1 })
}

impl Frame<'_> {
    pub(super) fn has_affected_windows(&self, bx: usize, by: usize) -> bool {
        intersecting_windows(self, self.affected(bx, by)).is_some()
    }
}

// Original scalar expression of FFmpeg 7.1.5 vf_ssim.c's 8-bit 8x8
// moment contract. Each window is rounded to float before double aggregation.
#[derive(Clone, Copy, Default)]
struct Moment {
    source: i64,
    source_sq: i64,
    encoded: i64,
    encoded_sq: i64,
    cross: i64,
}

impl Moment {
    fn add(&mut self, source: u8, encoded: u8) {
        let a = i64::from(source);
        let b = i64::from(encoded);
        self.source += a;
        self.source_sq += a * a;
        self.encoded += b;
        self.encoded_sq += b * b;
        self.cross += a * b;
    }

    fn replace(&mut self, source: u8, before: u8, after: u8) {
        let a = i64::from(source);
        let before = i64::from(before);
        let after = i64::from(after);
        self.encoded += after - before;
        self.encoded_sq += after * after - before * before;
        self.cross += a * (after - before);
    }

    fn ssim(self) -> f64 {
        let s1 = self.source;
        let s2 = self.encoded;
        let variance = 64 * (self.source_sq + self.encoded_sq) - s1 * s1 - s2 * s2;
        let covariance = 64 * self.cross - s1 * s2;
        let numerator = (2 * s1 * s2 + 416) as f64 * (2 * covariance + 235_963) as f64;
        let denominator = (s1 * s1 + s2 * s2 + 416) as f64 * (variance + 235_963) as f64;
        (numerator / denominator) as f32 as f64
    }
}

#[derive(Clone, Copy, Default)]
struct Pixel {
    luma: u8,
    u_sum: i64,
    v_sum: i64,
    original: [u8; 3],
    baseline: [u8; 3],
}

// One macroblock can touch at most a 32x32 metric-pixel cache and 7x7
// windows. Candidate updates scatter changed pixels to at most four windows
// each. UV influence lies in [MB-4, MB+20); aligned stride-4 window starts
// range from MB-8 through MB+16, giving cached samples [MB-8, MB+24).
// Clipped edges and minimum-8 metric dimensions only shrink that region.
// The single-edit cache is built after syntax/frontier checks; the bounded
// joint search also uses it for private full-tile trials.
pub(super) struct LocalCache {
    x0: usize,
    y0: usize,
    wx0: usize,
    wy0: usize,
    horizontal: [Axis; 32],
    vertical: [Axis; 32],
    pixels: [Pixel; 32 * 32],
    baseline: [[Moment; 3]; 7 * 7],
}

const _: () = assert!(
    std::mem::size_of::<LocalCache>() + std::mem::size_of::<[[Moment; 3]; 7 * 7]>() <= 64 * 1024
);

impl LocalCache {
    pub(super) fn new(frame: &Frame<'_>) -> Self {
        let bounds = (
            (frame.mx * 16).saturating_sub(4),
            (frame.mx * 16 + 20).min(frame.width),
            (frame.my * 16).saturating_sub(4),
            (frame.my * 16 + 20).min(frame.height),
        );
        let windows = intersecting_windows(frame, bounds).expect("rate-qualified visible window");
        let x0 = windows.x0 * 4;
        let y0 = windows.y0 * 4;
        let right = (windows.x1 - 1) * 4 + 8;
        let bottom = (windows.y1 - 1) * 4 + 8;
        assert!(right - x0 <= 32 && bottom - y0 <= 32);
        assert!(windows.x1 - windows.x0 <= 7 && windows.y1 - windows.y0 <= 7);
        let direct = frame.height.is_multiple_of(2);
        let mut cache = Self {
            x0,
            y0,
            wx0: windows.x0,
            wy0: windows.y0,
            horizontal: [Axis::single(0); 32],
            vertical: [Axis::single(0); 32],
            pixels: [Pixel::default(); 32 * 32],
            baseline: [[Moment::default(); 3]; 7 * 7],
        };
        for x in x0..right {
            cache.horizontal[x - x0] =
                Axis::chroma(metric_sample(x, frame.width), frame.width, true, direct);
        }
        for y in y0..bottom {
            cache.vertical[y - y0] =
                Axis::chroma(metric_sample(y, frame.height), frame.height, false, direct);
        }
        for y in y0..bottom {
            for x in x0..right {
                let px = metric_sample(x, frame.width);
                let py = metric_sample(y, frame.height);
                let h = cache.horizontal[x - x0];
                let v = cache.vertical[y - y0];
                let luma = frame.y(px, py);
                let u_sum = frame.chroma_sum(0, h, v);
                let v_sum = frame.chroma_sum(1, h, v);
                cache.pixels[(y - y0) * 32 + x - x0] = Pixel {
                    luma,
                    u_sum,
                    v_sum,
                    original: frame.original.at(px, py),
                    baseline: render(luma, u_sum, v_sum),
                };
            }
        }
        for wy in windows.y0..windows.y1 {
            for wx in windows.x0..windows.x1 {
                let index = (wy - windows.y0) * 7 + wx - windows.x0;
                for dy in 0..8 {
                    for dx in 0..8 {
                        let x = wx * 4 + dx;
                        let y = wy * 4 + dy;
                        let pixel = cache.pixels[(y - y0) * 32 + x - x0];
                        for channel in 0..3 {
                            cache.baseline[index][channel]
                                .add(pixel.original[channel], pixel.baseline[channel]);
                        }
                    }
                }
            }
        }
        cache
    }

    // Return the unnormalized sum over affected windows and all three RGB
    // components. The frame-wide 3*nx*ny divisor is a shared positive factor
    // for every trial and must not vary with the affected-window count.
    pub(super) fn score(
        &self,
        frame: &Frame<'_>,
        change: Change<'_>,
        bounds: (usize, usize, usize, usize),
    ) -> f64 {
        let Some(windows) = intersecting_windows(frame, bounds) else {
            return 0.0;
        };
        let (left, right, top, bottom) = metric_bounds(frame, bounds);
        // The final incomplete metric tail has no window and is absent from
        // the cache. Only visit metric pixels covered by an impacted window.
        let left = left.max(windows.x0 * 4);
        let right = right.min((windows.x1 - 1) * 4 + 8);
        let top = top.max(windows.y0 * 4);
        let bottom = bottom.min((windows.y1 - 1) * 4 + 8);
        let mut trial = self.baseline;
        for y in top..bottom {
            for x in left..right {
                let pixel = self.pixels[(y - self.y0) * 32 + x - self.x0];
                let delta = frame.change_sum(
                    self.horizontal[x - self.x0],
                    self.vertical[y - self.y0],
                    change,
                );
                if delta == 0 {
                    continue;
                }
                let sums = if change.plane == 0 {
                    (pixel.u_sum + delta, pixel.v_sum)
                } else {
                    (pixel.u_sum, pixel.v_sum + delta)
                };
                let updated = render(pixel.luma, sums.0, sums.1);
                if updated == pixel.baseline {
                    continue;
                }
                let wx0 = x.saturating_sub(7).div_ceil(4).max(windows.x0);
                let wx1 = (x / 4 + 1).min(windows.x1);
                let wy0 = y.saturating_sub(7).div_ceil(4).max(windows.y0);
                let wy1 = (y / 4 + 1).min(windows.y1);
                for wy in wy0..wy1 {
                    for wx in wx0..wx1 {
                        let index = (wy - self.wy0) * 7 + wx - self.wx0;
                        for channel in 0..3 {
                            trial[index][channel].replace(
                                pixel.original[channel],
                                pixel.baseline[channel],
                                updated[channel],
                            );
                        }
                    }
                }
            }
        }
        let mut gain = 0.0;
        for wy in windows.y0..windows.y1 {
            for wx in windows.x0..windows.x1 {
                let index = (wy - self.wy0) * 7 + wx - self.wx0;
                for (updated, original) in trial[index].iter().zip(self.baseline[index].iter()) {
                    gain += updated.ssim() - original.ssim();
                }
            }
        }
        gain
    }

    // Score the complete U/V trial jointly. Replacing the baseline moments
    // once per rendered pixel retains chroma coupling and overlapping windows.
    pub(super) fn score_tiles(&self, frame: &Frame<'_>, u: &[u8; 64], v: &[u8; 64]) -> f64 {
        let bounds = (
            (frame.mx * 16).saturating_sub(4),
            (frame.mx * 16 + 20).min(frame.width),
            (frame.my * 16).saturating_sub(4),
            (frame.my * 16 + 20).min(frame.height),
        );
        let Some(windows) = intersecting_windows(frame, bounds) else {
            return 0.0;
        };
        let right = (windows.x1 - 1) * 4 + 8;
        let bottom = (windows.y1 - 1) * 4 + 8;
        let mut trial = self.baseline;
        for y in self.y0..bottom {
            for x in self.x0..right {
                let pixel = self.pixels[(y - self.y0) * 32 + x - self.x0];
                let h = self.horizontal[x - self.x0];
                let vertical = self.vertical[y - self.y0];
                let u_sum = pixel.u_sum + frame.tile_delta(0, h, vertical, u);
                let v_sum = pixel.v_sum + frame.tile_delta(1, h, vertical, v);
                let updated = render(pixel.luma, u_sum, v_sum);
                if updated == pixel.baseline {
                    continue;
                }
                let wx0 = x.saturating_sub(7).div_ceil(4).max(windows.x0);
                let wx1 = (x / 4 + 1).min(windows.x1);
                let wy0 = y.saturating_sub(7).div_ceil(4).max(windows.y0);
                let wy1 = (y / 4 + 1).min(windows.y1);
                for wy in wy0..wy1 {
                    for wx in wx0..wx1 {
                        let index = (wy - self.wy0) * 7 + wx - self.wx0;
                        for channel in 0..3 {
                            trial[index][channel].replace(
                                pixel.original[channel],
                                pixel.baseline[channel],
                                updated[channel],
                            );
                        }
                    }
                }
            }
        }
        let mut gain = 0.0;
        for wy in windows.y0..windows.y1 {
            for wx in windows.x0..windows.x1 {
                let index = (wy - self.wy0) * 7 + wx - self.wx0;
                for (updated, original) in trial[index].iter().zip(self.baseline[index].iter()) {
                    gain += updated.ssim() - original.ssim();
                }
            }
        }
        gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn metric_ssim(
        width: usize,
        height: usize,
        mut source: impl FnMut(usize, usize) -> [u8; 3],
        mut encoded: impl FnMut(usize, usize) -> [u8; 3],
    ) -> f64 {
        let metric_w = width.max(8);
        let metric_h = height.max(8);
        let nx = (metric_w >> 2) - 1;
        let ny = (metric_h >> 2) - 1;
        let mut sum = 0.0;
        for wy in 0..ny {
            for wx in 0..nx {
                let mut moments = [Moment::default(); 3];
                for dy in 0..8 {
                    for dx in 0..8 {
                        let px = metric_sample(wx * 4 + dx, width);
                        let py = metric_sample(wy * 4 + dy, height);
                        let a = source(px, py);
                        let b = encoded(px, py);
                        for channel in 0..3 {
                            moments[channel].add(a[channel], b[channel]);
                        }
                    }
                }
                for moment in moments {
                    sum += moment.ssim();
                }
            }
        }
        sum / (3 * nx * ny) as f64
    }

    fn full_proxy_ssim(frame: &Frame<'_>, change: Option<Change<'_>>) -> f64 {
        metric_ssim(
            frame.width,
            frame.height,
            |x, y| frame.original.at(x, y),
            |x, y| frame.rendered(x, y, change),
        )
    }

    #[test]
    fn scalar_window_math_matches_frozen_ffmpeg_controls() {
        // RGB pairs and six-decimal All values are frozen FFmpeg 7.1.5
        // decode-free controls; no FFmpeg code or process enters production.
        for (width, height, a, b, expected) in [
            (1, 1, "070e15", "281a27", 0.669798),
            (5, 1, "070e1526194a45247f642fb4833ae9", "0d1a272c255c6e30916a3bc68946fb", 0.961307),
            (1, 11, "070e150e2b1815481b1c651e2382212a9f2431bc2738d92a3ff62d4613304d3033", "0d1a2714372a1b542d227130298e3315ab3637c8393ee53c45023f4c1f42533c45", 0.920340),
            (2, 9, "070e1526194a0e2b182d364d15481b3453501c651e3b7053238221428d562a9f2449aa5931bc2750c75c38d92a57e45f3ff62d5e0162", "0d1a272c255c14372a33425f1b542d3a5f62227130417c65298e336d996830ab364fb66b37c83956d36e3ee53c5df07145023f640d74", 0.960711),
        ] {
            let a = bytes(a);
            let b = bytes(b);
            let value = metric_ssim(width, height,
                |x, y| a[(y * width + x) * 3..][..3].try_into().unwrap(),
                |x, y| b[(y * width + x) * 3..][..3].try_into().unwrap(),
            );
            assert!((value - expected).abs() < 1e-6, "{width}x{height}: {value}");
        }
    }

    #[test]
    fn negative_flat_and_omitted_tail_windows() {
        let mut flat = Moment::default();
        let mut opposite = Moment::default();
        for i in 0..64 {
            flat.add(73, 73);
            let a = if i < 32 { 0 } else { 255 };
            opposite.add(a, 255 - a);
        }
        assert_eq!(flat.ssim(), 1.0);
        assert!(opposite.ssim() < 0.0);
        assert_eq!(
            (0..8).map(|x| metric_sample(x, 5)).collect::<Vec<_>>(),
            [0, 0, 1, 2, 2, 3, 4, 4]
        );
        assert_eq!(
            (0..8).map(|x| metric_sample(x, 2)).collect::<Vec<_>>(),
            [0, 0, 0, 0, 1, 1, 1, 1]
        );
        let before = metric_ssim(2, 9, |_x, y| [y as u8; 3], |_x, y| [y as u8; 3]);
        let after = metric_ssim(
            2,
            9,
            |_x, y| [y as u8; 3],
            |_x, y| [if y == 8 { 255 } else { y as u8 }; 3],
        );
        assert_eq!(before, after);
        let before = metric_ssim(1, 11, |_x, y| [y as u8; 3], |_x, y| [y as u8; 3]);
        let after = metric_ssim(
            1,
            11,
            |_x, y| [y as u8; 3],
            |_x, y| [if y >= 8 { 255 } else { y as u8 }; 3],
        );
        assert_eq!(before, after);
    }

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
        let direct = full_proxy_ssim(&frame, Some(change)) - full_proxy_ssim(&frame, None);
        let global_windows = ((frame.width.max(8) >> 2) - 1) * ((frame.height.max(8) >> 2) - 1);
        assert!((cached / (3 * global_windows) as f64 - direct).abs() < 1e-9);
        let mut trial_u = u_tile;
        for row in 0..4 {
            trial_u[row * 8..row * 8 + 4].copy_from_slice(&patch[row * 4..row * 4 + 4]);
        }
        assert!((cache.score_tiles(&frame, &trial_u, &uv) - cached).abs() < 1e-9);
        let mut trial_v = uv;
        trial_v[0] = 74;
        trial_v[3 * 8 + 3] = 211;
        let joint = cache.score_tiles(&frame, &trial_u, &trial_v);
        let direct_joint = full_proxy_ssim(
            &Frame {
                tile_u: &trial_u,
                tile_v: &trial_v,
                ..frame
            },
            None,
        ) - full_proxy_ssim(&frame, None);
        assert!((joint / (3 * global_windows) as f64 - direct_joint).abs() < 1e-9);
        assert_ne!(cached, 0.0);
        let hidden = Frame {
            width: 1,
            height: 1,
            ..frame
        };
        let bounds = hidden.affected(1, 1);
        assert!(bounds.0 >= bounds.1 || bounds.2 >= bounds.3);
    }

    #[test]
    fn combined_tiles_match_full_rerender_at_tiny_tails_and_macroblock_edges() {
        for (width, height) in [
            (1usize, 1usize),
            (5, 1),
            (1, 11),
            (2, 9),
            (17, 17),
            (31, 31),
            (32, 32),
        ] {
            let padded_w = width.div_ceil(16) * 16;
            let padded_h = height.div_ceil(16) * 16;
            let uv_stride = padded_w / 2;
            let source_y: Vec<_> = (0..padded_w * padded_h)
                .map(|i| ((i * 29 + 41) % 256) as u8)
                .collect();
            let reconstructed_y: Vec<_> = (0..padded_w * padded_h)
                .map(|i| ((i * 47 + 71) % 256) as u8)
                .collect();
            let source_u: Vec<_> = (0..padded_w * padded_h / 4)
                .map(|i| ((i * 13 + 91) % 256) as u8)
                .collect();
            let source_v: Vec<_> = (0..padded_w * padded_h / 4)
                .map(|i| ((i * 23 + 123) % 256) as u8)
                .collect();
            let reconstructed_u: Vec<_> = (0..padded_w * padded_h / 4)
                .map(|i| ((i * 31 + 101) % 256) as u8)
                .collect();
            let reconstructed_v: Vec<_> = (0..padded_w * padded_h / 4)
                .map(|i| ((i * 19 + 149) % 256) as u8)
                .collect();
            for layout in [0, 1, 4] {
                let bpp = if layout == 4 { 3 } else { 4 };
                let stride = width * bpp + 3;
                let mut original = vec![0; stride * height];
                for y in 0..height {
                    for x in 0..width {
                        let rgb = [
                            ((x * 53 + y * 7) % 256) as u8,
                            ((x * 11 + y * 31) % 256) as u8,
                            ((x * 17 + y * 19) % 256) as u8,
                        ];
                        let pixel = &mut original[y * stride + x * bpp..][..bpp];
                        if layout == 1 {
                            pixel[..3].copy_from_slice(&[rgb[2], rgb[1], rgb[0]]);
                        } else {
                            pixel[..3].copy_from_slice(&rgb);
                        }
                    }
                }
                for my in 0..padded_h / 16 {
                    for mx in 0..padded_w / 16 {
                        let mut tile_y = [0; 256];
                        let mut tile_u = [0; 64];
                        let mut tile_v = [0; 64];
                        for row in 0..16 {
                            tile_y[row * 16..row * 16 + 16].copy_from_slice(
                                &reconstructed_y[(my * 16 + row) * padded_w + mx * 16..][..16],
                            );
                        }
                        for row in 0..8 {
                            tile_u[row * 8..row * 8 + 8].copy_from_slice(
                                &reconstructed_u[(my * 8 + row) * uv_stride + mx * 8..][..8],
                            );
                            tile_v[row * 8..row * 8 + 8].copy_from_slice(
                                &reconstructed_v[(my * 8 + row) * uv_stride + mx * 8..][..8],
                            );
                        }
                        let frame = Frame {
                            width,
                            height,
                            stride_y: padded_w,
                            original: Original {
                                pixels: &original,
                                stride,
                                layout,
                            },
                            source_y: &source_y,
                            source_u: &source_u,
                            source_v: &source_v,
                            reconstructed_y: &reconstructed_y,
                            reconstructed_u: &reconstructed_u,
                            reconstructed_v: &reconstructed_v,
                            tile_y: &tile_y,
                            tile_u: &tile_u,
                            tile_v: &tile_v,
                            mx,
                            my,
                        };
                        if !(0..4).any(|patch| frame.has_affected_windows(patch % 2, patch / 2)) {
                            continue;
                        }
                        let cache = LocalCache::new(&frame);
                        assert_eq!(cache.score_tiles(&frame, &tile_u, &tile_v), 0.0);
                        let mut trial_u = tile_u;
                        let mut trial_v = tile_v;
                        for i in 0..64 {
                            if i % 7 == 0 {
                                trial_u[i] = trial_u[i].wrapping_add(67);
                            }
                            if i % 11 == 0 {
                                trial_v[i] = trial_v[i].wrapping_sub(83);
                            }
                        }
                        let count = ((width.max(8) >> 2) - 1) * ((height.max(8) >> 2) - 1);
                        let actual =
                            cache.score_tiles(&frame, &trial_u, &trial_v) / (3 * count) as f64;
                        let expected = full_proxy_ssim(
                            &Frame {
                                tile_u: &trial_u,
                                tile_v: &trial_v,
                                ..frame
                            },
                            None,
                        ) - full_proxy_ssim(&frame, None);
                        assert!(
                            (actual - expected).abs() < 1e-9,
                            "{width}x{height} layout={layout} MB={mx},{my}: {actual} != {expected}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn cached_delta_at_macroblock_edges_matches_full_render() {
        for (width, height) in [(17, 17), (31, 31), (32, 32)] {
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
            if width >= 31 {
                let first = intersecting_windows(&frame, frame.affected(0, 0)).unwrap();
                let last = intersecting_windows(&frame, frame.affected(1, 1)).unwrap();
                assert_ne!(
                    (first.x1 - first.x0) * (first.y1 - first.y0),
                    (last.x1 - last.x0) * (last.y1 - last.y0),
                );
            }
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
                        let full =
                            full_proxy_ssim(&frame, Some(change)) - full_proxy_ssim(&frame, None);
                        let global_windows = ((width.max(8) >> 2) - 1) * ((height.max(8) >> 2) - 1);
                        assert!(
                            (cached / (3 * global_windows) as f64 - full).abs() < 1e-9,
                            "{width}x{height} plane={plane} block={bx},{by}: {cached} vs {full}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn metric_cache_matches_full_proxy_at_minimum_eight_and_tail_edges() {
        for (width, height) in [(1usize, 1usize), (2, 9), (5, 1), (1, 11), (4, 7), (13, 11)] {
            let padded_w = width.div_ceil(16) * 16;
            let padded_h = height.div_ceil(16) * 16;
            let source_y = vec![128u8; padded_w * padded_h];
            let source_uv = vec![128u8; padded_w * padded_h / 4];
            let reconstructed_y = vec![0u8; padded_w * padded_h];
            let reconstructed_uv = vec![0u8; padded_w * padded_h / 4];
            let tile_y = [128u8; 256];
            let mut tile_u = [128u8; 64];
            let tile_v = [128u8; 64];
            for y in 0..4 {
                for x in 0..4 {
                    tile_u[y * 8 + x] = 134;
                }
            }
            let stride = width * 3 + 3;
            let mut original = vec![0u8; stride * height];
            for y in 0..height {
                for x in 0..width {
                    let at = y * stride + x * 3;
                    original[at..at + 3].copy_from_slice(&[
                        ((x * 23 + y * 17 + 19) & 255) as u8,
                        ((x * 11 + y * 31 + 29) & 255) as u8,
                        ((x * 37 + y * 13 + 39) & 255) as u8,
                    ]);
                }
            }
            let frame = Frame {
                width,
                height,
                stride_y: padded_w,
                original: Original {
                    pixels: &original,
                    stride,
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
                mx: 0,
                my: 0,
            };
            let cache = LocalCache::new(&frame);
            let patch = [121u8; 16];
            for plane in 0..2 {
                for by in 0..2 {
                    for bx in 0..2 {
                        if !frame.has_affected_windows(bx, by) {
                            continue;
                        }
                        let change = Change {
                            plane,
                            bx,
                            by,
                            patch: &patch,
                        };
                        let gain = cache.score(&frame, change, frame.affected(bx, by));
                        let full =
                            full_proxy_ssim(&frame, Some(change)) - full_proxy_ssim(&frame, None);
                        let nx = (width.max(8) >> 2) - 1;
                        let ny = (height.max(8) >> 2) - 1;
                        assert!(
                            (gain / (3 * nx * ny) as f64 - full).abs() < 1e-9,
                            "{width}x{height} plane={plane} block={bx},{by}: {gain} vs {full}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn seven_by_seven_window_and_thirty_two_pixel_cache_bound() {
        let tile_y = [0u8; 256];
        let tile_uv = [0u8; 64];
        for width in [1usize, 2, 5, 8, 9, 17, 31, 32, 373, 16_383] {
            for height in [1usize, 2, 9, 11, 17, 31, 32, 263, 16_383] {
                let mx_last = (width - 1) / 16;
                let my_last = (height - 1) / 16;
                for mx in [0, mx_last / 2, mx_last] {
                    for my in [0, my_last / 2, my_last] {
                        let frame = Frame {
                            width,
                            height,
                            stride_y: width.div_ceil(16) * 16,
                            original: Original {
                                pixels: &[],
                                stride: 0,
                                layout: 4,
                            },
                            source_y: &[],
                            source_u: &[],
                            source_v: &[],
                            reconstructed_y: &[],
                            reconstructed_u: &[],
                            reconstructed_v: &[],
                            tile_y: &tile_y,
                            tile_u: &tile_uv,
                            tile_v: &tile_uv,
                            mx,
                            my,
                        };
                        let union = (
                            (mx * 16).saturating_sub(4),
                            (mx * 16 + 20).min(width),
                            (my * 16).saturating_sub(4),
                            (my * 16 + 20).min(height),
                        );
                        let Some(windows) = intersecting_windows(&frame, union) else {
                            continue;
                        };
                        assert!(windows.x1 - windows.x0 <= 7);
                        assert!(windows.y1 - windows.y0 <= 7);
                        assert!((windows.x1 - windows.x0 - 1) * 4 + 8 <= 32);
                        assert!((windows.y1 - windows.y0 - 1) * 4 + 8 <= 32);
                        for by in 0..2 {
                            for bx in 0..2 {
                                if let Some(part) =
                                    intersecting_windows(&frame, frame.affected(bx, by))
                                {
                                    assert!(part.x0 >= windows.x0 && part.x1 <= windows.x1);
                                    assert!(part.y0 >= windows.y0 && part.y1 <= windows.y1);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
