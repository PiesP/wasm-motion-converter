// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Prediction arithmetic follows RFC 6386 sections 12.2 and 12.3.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(crate) enum LargeMode {
    Dc = 0,
    Vertical = 1,
    Horizontal = 2,
    TrueMotion = 3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(crate) enum SmallMode {
    Dc = 0,
    TrueMotion = 1,
    VerticalEdge = 2,
    HorizontalEdge = 3,
    LeftDown = 4,
    RightDown = 5,
    VerticalRight = 6,
    VerticalLeft = 7,
    HorizontalDown = 8,
    HorizontalUp = 9,
}

fn predict_square<const N: usize, const LEN: usize>(
    top: &[u8],
    left: &[u8],
    top_left: u8,
    has_top: bool,
    has_left: bool,
    mode: LargeMode,
) -> [u8; LEN] {
    assert!(!has_top || top.len() >= N);
    assert!(!has_left || left.len() >= N);
    let mut result = [0; LEN];
    let dc = if !has_top && !has_left {
        128
    } else {
        let mut sum = 0u32;
        if has_top {
            sum += top[..N].iter().map(|&v| u32::from(v)).sum::<u32>();
        }
        if has_left {
            sum += left[..N].iter().map(|&v| u32::from(v)).sum::<u32>();
        }
        let count = N * (usize::from(has_top) + usize::from(has_left));
        ((sum + (count / 2) as u32) / count as u32) as u8
    };
    for y in 0..N {
        let l = if has_left { left[y] } else { 129 };
        for x in 0..N {
            let t = if has_top { top[x] } else { 127 };
            result[y * N + x] = match mode {
                LargeMode::Dc => dc,
                LargeMode::Vertical => t,
                LargeMode::Horizontal => l,
                LargeMode::TrueMotion => {
                    (i32::from(l) + i32::from(t) - i32::from(top_left)).clamp(0, 255) as u8
                }
            };
        }
    }
    result
}

/// The caller supplies reconstructed edge pixels. A missing top or left edge
/// receives VP8's virtual value 127 or 129, respectively. `top_left` is the
/// decoder's corner value, including the virtual corner at a frame edge.
pub(crate) fn predict_large(
    top: &[u8],
    left: &[u8],
    top_left: u8,
    has_top: bool,
    has_left: bool,
    mode: LargeMode,
) -> [u8; 256] {
    predict_square::<16, 256>(top, left, top_left, has_top, has_left, mode)
}

pub(crate) fn predict_uv(
    top: &[u8],
    left: &[u8],
    top_left: u8,
    has_top: bool,
    has_left: bool,
    mode: LargeMode,
) -> [u8; 64] {
    predict_square::<8, 64>(top, left, top_left, has_top, has_left, mode)
}

#[inline]
fn avg3(a: u8, b: u8, c: u8) -> u8 {
    ((u16::from(a) + 2 * u16::from(b) + u16::from(c) + 2) >> 2) as u8
}

#[inline]
fn avg2(a: u8, b: u8) -> u8 {
    ((u16::from(a) + u16::from(b) + 1) >> 1) as u8
}

/// The caller supplies the eight reconstructed top samples, four left samples
/// and corner after applying macroblock-edge replication/virtual pixel rules.
pub(crate) fn predict_i4(top: &[u8; 8], left: &[u8; 4], top_left: u8, mode: SmallMode) -> [u8; 16] {
    // RFC 6386 section 12.3 constructs E from bottom-left through the
    // corner to top-right. The caller has already supplied virtual edges.
    let e = [
        left[3], left[2], left[1], left[0], top_left, top[0], top[1], top[2], top[3],
    ];
    let ef = |i: usize| avg3(e[i - 1], e[i], e[i + 1]);
    let eh = |i: usize| avg2(e[i], e[i + 1]);
    let tf = |i: usize| avg3(top[i - 1], top[i], top[(i + 1).min(7)]);
    let th = |i: usize| avg2(top[i], top[i + 1]);
    match mode {
        SmallMode::LeftDown => {
            return std::array::from_fn(|index| tf(index / 4 + index % 4 + 1));
        }
        SmallMode::RightDown => {
            return std::array::from_fn(|index| ef(4 + index % 4 - index / 4));
        }
        SmallMode::VerticalRight => {
            return [
                eh(4),
                eh(5),
                eh(6),
                eh(7),
                ef(4),
                ef(5),
                ef(6),
                ef(7),
                ef(3),
                eh(4),
                eh(5),
                eh(6),
                ef(2),
                ef(4),
                ef(5),
                ef(6),
            ];
        }
        SmallMode::VerticalLeft => {
            return [
                th(0),
                th(1),
                th(2),
                th(3),
                tf(1),
                tf(2),
                tf(3),
                tf(4),
                th(1),
                th(2),
                th(3),
                tf(5),
                tf(2),
                tf(3),
                tf(4),
                tf(6),
            ];
        }
        SmallMode::HorizontalDown => {
            return [
                eh(3),
                ef(4),
                ef(5),
                ef(6),
                eh(2),
                ef(3),
                eh(3),
                ef(4),
                eh(1),
                ef(2),
                eh(2),
                ef(3),
                eh(0),
                ef(1),
                eh(1),
                ef(2),
            ];
        }
        SmallMode::HorizontalUp => {
            let lf = |i: usize| avg3(left[i - 1], left[i], left[(i + 1).min(3)]);
            let lh = |i: usize| avg2(left[i], left[i + 1]);
            return [
                lh(0),
                lf(1),
                lh(1),
                lf(2),
                lh(1),
                lf(2),
                lh(2),
                lf(3),
                lh(2),
                lf(3),
                left[3],
                left[3],
                left[3],
                left[3],
                left[3],
                left[3],
            ];
        }
        _ => {}
    }
    let mut result = [0u8; 16];
    let dc = ((4u16
        + top[..4]
            .iter()
            .chain(left)
            .map(|&v| u16::from(v))
            .sum::<u16>())
        >> 3) as u8;
    for y in 0..4 {
        let previous_left = if y == 0 { top_left } else { left[y - 1] };
        let next_left = left[(y + 1).min(3)];
        for x in 0..4 {
            result[y * 4 + x] = match mode {
                SmallMode::Dc => dc,
                SmallMode::TrueMotion => (i32::from(left[y]) + i32::from(top[x])
                    - i32::from(top_left))
                .clamp(0, 255) as u8,
                SmallMode::VerticalEdge => avg3(
                    if x == 0 { top_left } else { top[x - 1] },
                    top[x],
                    top[x + 1],
                ),
                SmallMode::HorizontalEdge => avg3(previous_left, left[y], next_left),
                _ => unreachable!("diagonal modes returned above"),
            };
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_macroblock_modes_and_edges() {
        let top: Vec<u8> = (0..16).map(|x| x * 9).collect();
        let left: Vec<u8> = (0..16).map(|y| 255 - y * 7).collect();
        let original_top = top.clone();
        let original_left = left.clone();
        let dc = predict_large(&top, &left, 53, true, true, LargeMode::Dc);
        let expected = ((top.iter().map(|&v| u32::from(v)).sum::<u32>()
            + left.iter().map(|&v| u32::from(v)).sum::<u32>()
            + 16)
            >> 5) as u8;
        assert_eq!(dc, [expected; 256]);
        assert_eq!(
            predict_large(&[], &[], 53, false, false, LargeMode::Dc),
            [128; 256]
        );
        assert_eq!(
            predict_large(&top, &left, 53, false, true, LargeMode::Dc)[0],
            ((left.iter().map(|&v| u32::from(v)).sum::<u32>() + 8) >> 4) as u8
        );
        assert_eq!(
            predict_large(&top, &left, 53, true, false, LargeMode::Dc)[0],
            ((top.iter().map(|&v| u32::from(v)).sum::<u32>() + 8) >> 4) as u8
        );
        let vertical = predict_large(&top, &left, 53, true, true, LargeMode::Vertical);
        let horizontal = predict_large(&top, &left, 53, true, true, LargeMode::Horizontal);
        assert_eq!(&vertical[0..16], top.as_slice());
        assert_eq!(&vertical[240..256], top.as_slice());
        assert_eq!(horizontal[0], 255);
        assert_eq!(&horizontal[16..32], &[248; 16]);
        let tm = predict_large(&top, &left, 53, true, true, LargeMode::TrueMotion);
        assert_eq!(tm[0], 202);
        assert_eq!(tm[15], 255);
        assert_eq!(tm[15 * 16], 97);
        assert_eq!(
            predict_large(&top, &left, 53, false, true, LargeMode::Vertical),
            [127; 256]
        );
        assert_eq!(
            predict_large(&top, &left, 53, true, false, LargeMode::Horizontal),
            [129; 256]
        );
        assert_eq!(top, original_top);
        assert_eq!(left, original_left);
    }

    #[test]
    fn chroma_modes_have_eight_sample_rounding() {
        let top = [1, 2, 3, 4, 5, 6, 7, 8];
        let left = [10, 20, 30, 40, 50, 60, 70, 80];
        assert_eq!(
            predict_uv(&top, &left, 0, true, true, LargeMode::Dc),
            [25; 64]
        );
        assert_eq!(
            predict_uv(&[], &[], 0, false, false, LargeMode::Dc),
            [128; 64]
        );
        assert_eq!(
            predict_uv(&top, &left, 255, true, true, LargeMode::TrueMotion),
            [0; 64]
        );
        assert_eq!(
            predict_uv(&top, &left, 0, true, true, LargeMode::TrueMotion)[63],
            88
        );
    }

    #[test]
    fn four_by_four_filtered_edges_and_clamps() {
        let top = [10, 20, 40, 80, 160, 200, 220, 240];
        let left = [5, 30, 90, 250];
        assert_eq!(predict_i4(&top, &left, 2, SmallMode::Dc), [66; 16]);
        let ve = predict_i4(&top, &left, 2, SmallMode::VerticalEdge);
        assert_eq!(&ve[..4], &[11, 23, 45, 90]);
        assert_eq!(&ve[12..], &[11, 23, 45, 90]);
        let he = predict_i4(&top, &left, 2, SmallMode::HorizontalEdge);
        assert_eq!([he[0], he[4], he[8], he[12]], [11, 39, 115, 210]);
        let tm = predict_i4(&top, &left, 2, SmallMode::TrueMotion);
        assert_eq!(tm[0], 13);
        assert_eq!(tm[3], 83);
        let high = predict_i4(&[255; 8], &[255; 4], 0, SmallMode::TrueMotion);
        let low = predict_i4(&[0; 8], &[0; 4], 255, SmallMode::TrueMotion);
        assert_eq!(high, [255; 16]);
        assert_eq!(low, [0; 16]);
    }
}
