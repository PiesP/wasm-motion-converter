//! Palette selection over the already prepared RGB pixels of one GIF frame.

const RED_DIM: usize = 33;
const GREEN_DIM: usize = 65;
const BLUE_DIM: usize = 33;
const STRIDES: [usize; 3] = [GREEN_DIM * BLUE_DIM, BLUE_DIM, 1];
const PREFIX_LEN: usize = RED_DIM * GREEN_DIM * BLUE_DIM;
const MAX_COLORS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteMethod {
    Variance,
    WeightedMedian,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteError {
    InvalidLimit,
    InvalidInput,
    PixelCountOverflow,
    OutputTooSmall,
}

/// Caller-owned, reusable storage. Initialize directly in static storage with
/// `PaletteScratch::EMPTY` to keep the histogram off the stack.
pub struct PaletteScratch {
    prefix: Prefix,
    leaves: [Leaf; MAX_COLORS],
}

impl PaletteScratch {
    pub const EMPTY: Self = Self {
        prefix: Prefix {
            counts: [0; PREFIX_LEN],
            sums: [[0; 3]; PREFIX_LEN],
        },
        leaves: [Leaf::EMPTY; MAX_COLORS],
    };
}

/// Builds up to `limit` packed RGB entries and returns the number written.
///
/// The input must contain 1 through u32::MAX complete RGBA pixels. The caller
/// checks frame dimensions and prepares the pixels. Alpha is ignored. The
/// limit is 1 through 256 and output must hold at least limit * 3 bytes. Only
/// the returned number of entries is written. Errors leave output untouched.
///
/// Each RGB565 bin is indivisible, even when it contains several distinct
/// prepared colors. Each palette entry is the RGB888 mean of its leaf's
/// pixels, rounded to nearest with halves rounded up.
///
/// Variance first returns RGB888 means in lexicographic mapper-cell order
/// when all occupied RGB555 cells fit the limit. Otherwise, it selects the
/// RGB565 split with the highest population-weighted gain.
/// Scores use f64 arithmetic from integer moments. Equal computed scores
/// prefer red, green, then blue, and the lowest cut on the chosen axis.
/// Weighted median selects the longest occupied axis in RGB units and the cut
/// closest to a 50/50 population split. Axis and cut ties use the same order.
/// The most populous splittable leaf is selected for weighted median.
///
/// In both methods, the lowest leaf index wins equal selection priority. A
/// split replaces that slot with the lower child and appends the upper child.
/// Leaves are emitted in slot order.
pub fn build_palette(
    prepared_rgba: &[u8],
    limit: usize,
    output: &mut [u8],
    scratch: &mut PaletteScratch,
    method: PaletteMethod,
) -> Result<usize, PaletteError> {
    if !(1..=MAX_COLORS).contains(&limit) {
        return Err(PaletteError::InvalidLimit);
    }
    if prepared_rgba.is_empty() || !prepared_rgba.len().is_multiple_of(4) {
        return Err(PaletteError::InvalidInput);
    }
    if prepared_rgba.len() / 4 > u32::MAX as usize {
        return Err(PaletteError::PixelCountOverflow);
    }
    if output.len() < limit * 3 {
        return Err(PaletteError::OutputTooSmall);
    }

    let PaletteScratch { prefix, leaves } = scratch;
    prefix.populate(prepared_rgba);
    if method == PaletteMethod::Variance {
        if let Some(count) = prefix.mapper_centroids(limit, output) {
            return Ok(count);
        }
    }

    let (bounds, total) = prefix.accumulate();
    leaves[0] = Leaf::new(prefix, bounds, total, method, limit > 1);

    let mut count = 1;
    while count < limit {
        let Some((index, cut)) = next_split(&leaves[..count]) else {
            break;
        };

        let leaf = leaves[index];
        let mut lower_bounds = leaf.bounds;
        let mut upper_bounds = leaf.bounds;
        lower_bounds.high[cut.axis] = cut.boundary;
        upper_bounds.low[cut.axis] = cut.boundary;
        let search_children = count + 1 < limit;
        leaves[index] = Leaf::new(prefix, lower_bounds, cut.lower, method, search_children);
        leaves[count] = Leaf::new(
            prefix,
            upper_bounds,
            leaf.total.minus(cut.lower),
            method,
            search_children,
        );
        count += 1;
    }

    for (entry, leaf) in output
        .as_chunks_mut::<3>()
        .0
        .iter_mut()
        .zip(&leaves[..count])
    {
        *entry = leaf.total.rounded_mean();
    }
    Ok(count)
}

/// Returns the nearest entry in a palette of 1 through 256 packed RGB colors.
/// The greatest index wins ties in squared Euclidean RGB distance.
pub fn nearest_index(rgb: [u8; 3], palette: &[u8]) -> u8 {
    debug_assert!(!palette.is_empty() && palette.len().is_multiple_of(3));
    debug_assert!(palette.len() <= MAX_COLORS * 3);

    let [red, green, blue] = rgb.map(i32::from);
    let mut best_distance = i32::MAX;
    let mut best_index = 0;

    for (index, entry) in palette.as_chunks::<3>().0.iter().enumerate().rev() {
        let dr = red - i32::from(entry[0]);
        let dg = green - i32::from(entry[1]);
        let db = blue - i32::from(entry[2]);
        let distance = dr * dr + dg * dg + db * db;
        if distance == 0 {
            return index as u8;
        }
        if distance < best_distance {
            best_distance = distance;
            best_index = index as u8;
        }
    }
    best_index
}

#[derive(Clone, Copy)]
struct Moments {
    sums: [u64; 3],
    count: u32,
}

impl Moments {
    const ZERO: Self = Self {
        sums: [0; 3],
        count: 0,
    };

    fn plus(self, other: Self) -> Self {
        Self {
            sums: core::array::from_fn(|channel| self.sums[channel] + other.sums[channel]),
            count: self.count + other.count,
        }
    }

    fn minus(self, other: Self) -> Self {
        Self {
            sums: core::array::from_fn(|channel| self.sums[channel] - other.sums[channel]),
            count: self.count - other.count,
        }
    }

    fn rounded_mean(self) -> [u8; 3] {
        let count = u64::from(self.count);
        self.sums.map(|sum| ((sum + count / 2) / count) as u8)
    }
}

/// Coordinates are inclusive upper endpoints in the zero-padded prefix table.
/// A leaf contains bins after its lower endpoints through its upper endpoints.
#[derive(Clone, Copy)]
struct Bounds {
    low: [u8; 3],
    high: [u8; 3],
}

impl Bounds {
    const EMPTY: Self = Self {
        low: [0; 3],
        high: [0; 3],
    };
}

struct Prefix {
    counts: [u32; PREFIX_LEN],
    sums: [[u64; 3]; PREFIX_LEN],
}

impl Prefix {
    fn get(&self, index: usize) -> Moments {
        Moments {
            sums: self.sums[index],
            count: self.counts[index],
        }
    }

    fn put(&mut self, index: usize, moments: Moments) {
        self.sums[index] = moments.sums;
        self.counts[index] = moments.count;
    }

    fn populate(&mut self, prepared_rgba: &[u8]) {
        self.counts.fill(0);
        self.sums.fill([0; 3]);

        for rgba in prepared_rgba.as_chunks::<4>().0 {
            let red = usize::from(rgba[0] >> 3) + 1;
            let green = usize::from(rgba[1] >> 2) + 1;
            let blue = usize::from(rgba[2] >> 3) + 1;
            let index = red * STRIDES[0] + green * STRIDES[1] + blue;
            self.counts[index] += 1;
            let sums = &mut self.sums[index];
            sums[0] += u64::from(rgba[0]);
            sums[1] += u64::from(rgba[1]);
            sums[2] += u64::from(rgba[2]);
        }
    }

    fn mapper_centroids(&self, limit: usize, output: &mut [u8]) -> Option<usize> {
        let mut occupied_bins = [0; MAX_COLORS];
        let mut occupied = 0;
        for red in 1..RED_DIM {
            // Each five-bit green cell covers two adjacent RGB565 green bins.
            for green in (1..GREEN_DIM).step_by(2) {
                let row = red * STRIDES[0] + green * STRIDES[1];
                for blue in 1..BLUE_DIM {
                    let lower = row + blue;
                    let upper = lower + STRIDES[1];
                    if self.counts[lower] + self.counts[upper] == 0 {
                        continue;
                    }
                    if occupied == limit {
                        return None;
                    }
                    occupied_bins[occupied] = lower;
                    occupied += 1;
                }
            }
        }
        for (entry, &lower) in output
            .as_chunks_mut::<3>()
            .0
            .iter_mut()
            .zip(&occupied_bins[..occupied])
        {
            *entry = self
                .get(lower)
                .plus(self.get(lower + STRIDES[1]))
                .rounded_mean();
        }
        Some(occupied)
    }

    fn accumulate(&mut self) -> (Bounds, Moments) {
        let mut min = [RED_DIM as u8, GREEN_DIM as u8, BLUE_DIM as u8];
        let mut max = [0; 3];
        for red in 1..RED_DIM {
            let mut plane = [Moments::ZERO; BLUE_DIM];
            for green in 1..GREEN_DIM {
                let mut row = Moments::ZERO;
                let start = red * STRIDES[0] + green * STRIDES[1];
                for (blue, plane_sum) in plane.iter_mut().enumerate().skip(1) {
                    let index = start + blue;
                    let bin = self.get(index);
                    if bin.count != 0 {
                        let position = [red as u8, green as u8, blue as u8];
                        for axis in 0..3 {
                            min[axis] = min[axis].min(position[axis]);
                            max[axis] = max[axis].max(position[axis]);
                        }
                    }

                    row = row.plus(bin);
                    *plane_sum = plane_sum.plus(row);
                    self.put(index, plane_sum.plus(self.get(index - STRIDES[0])));
                }
            }
        }

        let bounds = Bounds {
            low: min.map(|value| value - 1),
            high: max,
        };
        (bounds, self.get(PREFIX_LEN - 1))
    }
}

/// Area at a fixed axis boundary, before subtracting the leaf's lower face.
/// The subtraction order keeps each count and channel sum nonnegative.
struct Plane {
    stride: usize,
    high_high: usize,
    low_high: usize,
    high_low: usize,
    low_low: usize,
}

impl Plane {
    fn new(bounds: Bounds, axis: usize) -> Self {
        let first = (axis + 1) % 3;
        let second = (axis + 2) % 3;
        let first_high = usize::from(bounds.high[first]) * STRIDES[first];
        let first_low = usize::from(bounds.low[first]) * STRIDES[first];
        let second_high = usize::from(bounds.high[second]) * STRIDES[second];
        let second_low = usize::from(bounds.low[second]) * STRIDES[second];

        Self {
            stride: STRIDES[axis],
            high_high: first_high + second_high,
            low_high: first_low + second_high,
            high_low: first_high + second_low,
            low_low: first_low + second_low,
        }
    }

    fn at(&self, prefix: &Prefix, boundary: u8) -> Moments {
        let base = usize::from(boundary) * self.stride;
        prefix
            .get(base + self.high_high)
            .minus(prefix.get(base + self.low_high))
            .minus(
                prefix
                    .get(base + self.high_low)
                    .minus(prefix.get(base + self.low_low)),
            )
    }
}

#[derive(Clone, Copy)]
struct Cut {
    lower: Moments,
    priority: f64,
    axis: usize,
    boundary: u8,
}

#[derive(Clone, Copy)]
struct Leaf {
    bounds: Bounds,
    total: Moments,
    cut: Option<Cut>,
}

impl Leaf {
    const EMPTY: Self = Self {
        bounds: Bounds::EMPTY,
        total: Moments::ZERO,
        cut: None,
    };

    fn new(
        prefix: &Prefix,
        bounds: Bounds,
        total: Moments,
        method: PaletteMethod,
        search: bool,
    ) -> Self {
        let cut = if search && total.count > 1 {
            best_cut(prefix, bounds, total, method)
        } else {
            None
        };
        Self { bounds, total, cut }
    }
}

fn next_split(leaves: &[Leaf]) -> Option<(usize, Cut)> {
    let mut best: Option<(usize, Cut)> = None;
    for (index, leaf) in leaves.iter().enumerate() {
        if let Some(cut) = leaf.cut {
            if best
                .as_ref()
                .is_none_or(|(_, current)| cut.priority > current.priority)
            {
                best = Some((index, cut));
            }
        }
    }
    best
}

fn best_cut(prefix: &Prefix, bounds: Bounds, total: Moments, method: PaletteMethod) -> Option<Cut> {
    let mut best: Option<Cut> = None;
    let mut longest_span = 0;

    for (axis, bin_width) in [8, 4, 8].into_iter().enumerate() {
        let plane = Plane::new(bounds, axis);
        let base = plane.at(prefix, bounds.low[axis]);
        let mut first_valid = 0;
        let mut last_valid = 0;
        let mut smallest_imbalance = u32::MAX;
        let mut median = None;

        for boundary in bounds.low[axis] + 1..bounds.high[axis] {
            let lower = plane.at(prefix, boundary).minus(base);
            if lower.count == 0 {
                continue;
            }
            if lower.count == total.count {
                break;
            }

            match method {
                PaletteMethod::Variance => {
                    let priority = variance_gain(lower, total.minus(lower));
                    if best
                        .as_ref()
                        .is_none_or(|current| priority > current.priority)
                    {
                        best = Some(Cut {
                            lower,
                            priority,
                            axis,
                            boundary,
                        });
                    }
                }
                PaletteMethod::WeightedMedian => {
                    if first_valid == 0 {
                        first_valid = boundary;
                    }
                    last_valid = boundary;
                    let imbalance = lower.count.abs_diff(total.count - lower.count);
                    if imbalance < smallest_imbalance {
                        smallest_imbalance = imbalance;
                        median = Some(Cut {
                            lower,
                            priority: f64::from(total.count),
                            axis,
                            boundary,
                        });
                    }
                }
            }
        }

        if first_valid != 0 {
            let span = (usize::from(last_valid - first_valid) + 1) * bin_width;
            if span > longest_span {
                longest_span = span;
                best = median;
            }
        }
    }

    best
}

fn variance_gain(lower: Moments, upper: Moments) -> f64 {
    let a = f64::from(lower.count);
    let b = f64::from(upper.count);

    // The distance between means is obtained by cross multiplication. Each
    // channel sum fits in 40 bits, and the denominator remains finite at
    // the maximum admitted population.
    let [dr, dg, db] = core::array::from_fn(|channel| {
        lower.sums[channel] as f64 * b - upper.sums[channel] as f64 * a
    });
    (dr * dr + dg * dg + db * db) / (a * b * (a + b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static SCRATCH: Mutex<PaletteScratch> = Mutex::new(PaletteScratch::EMPTY);

    fn palette(input: &[[u8; 4]], limit: usize, method: PaletteMethod) -> Vec<[u8; 3]> {
        let mut output = vec![0; limit * 3];
        let count = build_palette(
            input.as_flattened(),
            limit,
            &mut output,
            &mut SCRATCH.lock().unwrap(),
            method,
        )
        .unwrap();
        output.as_chunks::<3>().0[..count].to_vec()
    }

    #[test]
    fn rejects_invalid_inputs_without_touching_output() {
        let rgba = [12, 34, 56, 78];
        let mut output = [194; 5];
        let mut scratch = SCRATCH.lock().unwrap();

        for (input, limit, expected) in [
            (&rgba[..], 0, PaletteError::InvalidLimit),
            (&rgba[..], 257, PaletteError::InvalidLimit),
            (&rgba[..0], 1, PaletteError::InvalidInput),
            (&rgba[..3], 1, PaletteError::InvalidInput),
            (&rgba[..], 2, PaletteError::OutputTooSmall),
        ] {
            assert_eq!(
                build_palette(
                    input,
                    limit,
                    &mut output,
                    &mut scratch,
                    PaletteMethod::Variance
                ),
                Err(expected)
            );
            assert_eq!(output, [194; 5]);
        }
        assert_eq!(
            build_palette(&rgba, 1, &mut output, &mut scratch, PaletteMethod::Variance),
            Ok(1)
        );
        assert_eq!(output, [12, 34, 56, 194, 194]);
    }

    #[test]
    fn rgb565_collision_uses_actual_bytes_and_rounds_half_up() {
        let pixels = [[144, 196, 8, 0], [151, 199, 15, 255]];
        for method in [PaletteMethod::Variance, PaletteMethod::WeightedMedian] {
            assert_eq!(palette(&pixels, 256, method), [[148, 198, 12]]);
            assert_eq!(palette(&[[255, 255, 255, 0]; 9], 256, method), [[255; 3]]);
            assert_eq!(palette(&[[0, 0, 0, 255]; 7], 256, method), [[0; 3]]);
        }
    }

    #[test]
    fn variance_and_median_make_different_population_tradeoffs() {
        let pixels = [
            [[0, 0, 0, 255]; 4].as_slice(),
            [[16, 0, 0, 255]; 10].as_slice(),
            [[255, 0, 0, 255]].as_slice(),
        ]
        .concat();

        assert_eq!(
            palette(&pixels, 2, PaletteMethod::Variance),
            [[11, 0, 0], [255, 0, 0]]
        );
        assert_eq!(
            palette(&pixels, 2, PaletteMethod::WeightedMedian),
            [[0, 0, 0], [38, 0, 0]]
        );
    }

    #[test]
    fn variance_prioritizes_gain_while_median_prioritizes_population() {
        let pixels = [
            [[0, 0, 0, 255]].as_slice(),
            [[24, 0, 0, 255]; 9].as_slice(),
            [[160, 0, 0, 255]; 6].as_slice(),
            [[252, 0, 0, 255]].as_slice(),
        ]
        .concat();

        assert_eq!(
            palette(&pixels, 3, PaletteMethod::Variance),
            [[22, 0, 0], [160, 0, 0], [252, 0, 0]]
        );
        assert_eq!(
            palette(&pixels, 3, PaletteMethod::WeightedMedian),
            [[0, 0, 0], [173, 0, 0], [24, 0, 0]]
        );
    }

    #[test]
    fn equal_gains_prefer_axis_cut_and_leaf_in_order() {
        let corners = [
            [0, 0, 0, 255],
            [0, 255, 0, 255],
            [255, 0, 0, 255],
            [255, 255, 0, 255],
        ];
        assert_eq!(
            palette(&corners, 2, PaletteMethod::Variance),
            [[0, 128, 0], [255, 128, 0]]
        );
        assert_eq!(
            palette(&corners, 3, PaletteMethod::Variance),
            [[0, 0, 0], [255, 128, 0], [0, 255, 0]]
        );

        let equally_spaced = [[0, 0, 0, 255], [16, 0, 0, 255], [32, 0, 0, 255]];
        for method in [PaletteMethod::Variance, PaletteMethod::WeightedMedian] {
            assert_eq!(palette(&equally_spaced, 2, method), [[0, 0, 0], [24, 0, 0]]);
        }
    }

    #[test]
    fn equivalent_rgb565_spans_prefer_red_for_weighted_median() {
        let corners = [
            [0, 0, 0, 255],
            [0, 248, 0, 255],
            [248, 0, 0, 255],
            [248, 248, 0, 255],
        ];
        assert_eq!(
            palette(&corners, 2, PaletteMethod::WeightedMedian),
            [[0, 124, 0], [248, 124, 0]]
        );
    }

    #[test]
    fn preserves_256_distinct_bins_and_is_independent_of_pixel_order() {
        let pixels: Vec<_> = (0..256)
            .map(|index| {
                [
                    ((index % 32) * 8 + 7) as u8,
                    (((index / 32) * 8 + index % 8) * 4 + 1) as u8,
                    ((index * 13 % 32) * 8 + 3) as u8,
                    255,
                ]
            })
            .collect();
        let mut expected: Vec<_> = pixels.iter().map(|&[r, g, b, _]| [r, g, b]).collect();
        expected.sort_unstable();
        let reversed: Vec<_> = pixels.iter().copied().rev().collect();

        for method in [PaletteMethod::Variance, PaletteMethod::WeightedMedian] {
            let mut output = palette(&pixels, 256, method);
            assert_eq!(output, palette(&reversed, 256, method));
            output.sort_unstable();
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn sparse_variance_combines_adjacent_green_bins_and_orders_mapper_cells() {
        let pixels = [
            [32, 0, 224, 255],
            [32, 7, 231, 255],
            [32, 7, 231, 255],
            [0, 8, 0, 255],
            [0, 8, 7, 255],
            [0, 8, 0, 255],
            [0, 7, 24, 255],
        ];
        assert_eq!(
            palette(&pixels, 3, PaletteMethod::Variance),
            [[0, 7, 24], [0, 8, 2], [32, 5, 229]]
        );
        assert_eq!(
            palette(&pixels, 3, PaletteMethod::WeightedMedian),
            [[0, 8, 2], [0, 7, 24], [32, 5, 229]]
        );
    }

    #[test]
    fn moments_cover_maximum_population_and_channel_values() {
        let lower_count = u32::MAX / 2;
        let upper_count = u32::MAX - lower_count;
        let lower = Moments {
            sums: [0; 3],
            count: lower_count,
        };
        let upper = Moments {
            sums: [u64::from(upper_count) * 255; 3],
            count: upper_count,
        };
        let total = lower.plus(upper);

        assert_eq!(total.count, u32::MAX);
        assert_eq!(total.rounded_mean(), [128; 3]);
        assert_eq!(total.minus(lower).sums, upper.sums);
        let expected = (f64::from(lower_count) * f64::from(upper_count) / f64::from(u32::MAX))
            * (3.0 * 255.0 * 255.0);
        let relative_error = (variance_gain(lower, upper) - expected).abs() / expected;
        assert!(relative_error < 1e-15);
    }

    #[test]
    fn nearest_index_uses_all_channels_and_prefers_the_greatest_index_on_ties() {
        assert_eq!(nearest_index([10, 10, 10], &[8, 10, 10, 9, 9, 9]), 1);
        assert_eq!(
            nearest_index([10, 10, 10], &[10, 10, 9, 10, 11, 10, 12, 10, 10]),
            1
        );
        assert_eq!(nearest_index([255, 255, 255], &[0, 0, 0]), 0);
        assert_eq!(nearest_index([7, 8, 9], &[7, 8, 9, 0, 0, 0, 7, 8, 9]), 2);
        assert_eq!(nearest_index([0, 0, 0], &[0; 256 * 3]), 255);
    }
}
