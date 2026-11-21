// SPDX-License-Identifier: MIT AND BSD-3-Clause
// Copyright (c) 2026 PiesP
// Derived color conversion coefficients and gamma lookup tables: Copyright
// 2010-2014 Google Inc. See ../LICENSE.libwebp and ../PATENTS.libwebp.
// Diagnostic source counterpart: libwebp commit
// 6c484cbf92e81a5673b24485ac02d211f69be5b7, src/enc/picture_csp_enc.c
// and src/dsp/yuv.h. The shipped patched wasm-webp binary is separately pinned.

/// Gamma-compressed RGB-to-YUV420 import for exactly four visible RGB samples.
///
/// The caller supplies row-major [top-left, top-right, bottom-left, bottom-right].
/// For an odd visible width/height, repeat the last visible column/row before
/// calling. This leaf performs fixed work for one row pair and never reads
/// outside the supplied four samples. It does not premultiply or handle alpha.
/// Y remains per pixel; U/V derive from one gamma-domain 2x2 RGB average.
#[inline]
pub(crate) fn convert_2x2(rgb: [[u8; 3]; 4]) -> ([u8; 4], u8, u8) {
    let y = rgb.map(|[r, g, b]| {
        (((16839 * u32::from(r) + 33059 * u32::from(g) + 6420 * u32::from(b) + 32768) >> 16) + 16)
            as u8
    });
    let r = gamma_average(rgb.map(|pixel| pixel[0]));
    let g = gamma_average(rgb.map(|pixel| pixel[1]));
    let b = gamma_average(rgb.map(|pixel| pixel[2]));
    let u = clip_uv(-9719 * r - 19081 * g + 28800 * b);
    let v = clip_uv(28800 * r - 24116 * g - 4684 * b);
    (y, u, v)
}

/// Input-only nearest-chroma RGB error over the visible part of one 2x2 cell.
/// Both visible dimensions are at most two. Each channel difference is at most
/// 255, so a cell contributes at most 4 * 3 * 255^2 = 780_300.
#[inline]
pub(crate) fn nearest_chroma_rgb_error(
    rgb: [[u8; 3]; 4],
    luma: [u8; 4],
    u: u8,
    v: u8,
    visible_width: usize,
    visible_height: usize,
) -> u64 {
    debug_assert!(visible_width <= 2 && visible_height <= 2);
    let d = i32::from(u) - 128;
    let e = i32::from(v) - 128;
    let mut sum = 0u64;
    for dy in 0..visible_height {
        for dx in 0..visible_width {
            let index = dy * 2 + dx;
            let c = i32::from(luma[index]) - 16;
            let predicted = [
                ((298 * c + 409 * e + 128) >> 8).clamp(0, 255),
                ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255),
                ((298 * c + 516 * d + 128) >> 8).clamp(0, 255),
            ];
            for (source, output) in rgb[index].into_iter().zip(predicted) {
                let difference = i32::from(source) - output;
                sum += (difference * difference) as u64;
            }
        }
    }
    sum
}

#[inline]
fn gamma_average(samples: [u8; 4]) -> i32 {
    let sum = samples
        .map(|value| u32::from(GAMMA_TO_LINEAR[value as usize]))
        .into_iter()
        .sum::<u32>();
    let index = (sum >> 9) as usize;
    let fraction = sum & 511;
    // Interpolation returns four times the average channel value.
    let lower = u32::from(LINEAR_TO_GAMMA[index]);
    let upper = u32::from(LINEAR_TO_GAMMA[index + 1]);
    ((lower * (512 - fraction) + upper * fraction + 64) >> 7) as i32
}

#[inline]
fn clip_uv(value: i32) -> u8 {
    ((value + (1 << 17) + (128 << 18)) >> 18).clamp(0, 255) as u8
}

// Generated once from the source counterpart's InitGammaTables() constants
// (kGamma=.80, GAMMA_FIX=12, GAMMA_TAB_FIX=7), then checked against actual
// WebPPictureImportRGB() planes from a native build of that pinned commit.
const GAMMA_TO_LINEAR: [u16; 256] = [
    0, 49, 85, 117, 147, 176, 204, 231, 257, 282, 307, 331, 355, 379, 402, 425, 447, 469, 491, 513,
    534, 556, 577, 598, 618, 639, 659, 679, 699, 719, 739, 759, 778, 798, 817, 836, 855, 874, 893,
    912, 930, 949, 967, 986, 1004, 1022, 1040, 1059, 1077, 1094, 1112, 1130, 1148, 1165, 1183,
    1200, 1218, 1235, 1252, 1270, 1287, 1304, 1321, 1338, 1355, 1372, 1389, 1406, 1422, 1439, 1456,
    1472, 1489, 1505, 1522, 1538, 1555, 1571, 1587, 1604, 1620, 1636, 1652, 1668, 1684, 1700, 1716,
    1732, 1748, 1764, 1780, 1796, 1812, 1827, 1843, 1859, 1874, 1890, 1905, 1921, 1937, 1952, 1967,
    1983, 1998, 2014, 2029, 2044, 2059, 2075, 2090, 2105, 2120, 2135, 2151, 2166, 2181, 2196, 2211,
    2226, 2241, 2256, 2270, 2285, 2300, 2315, 2330, 2345, 2359, 2374, 2389, 2403, 2418, 2433, 2447,
    2462, 2477, 2491, 2506, 2520, 2535, 2549, 2564, 2578, 2592, 2607, 2621, 2636, 2650, 2664, 2679,
    2693, 2707, 2721, 2736, 2750, 2764, 2778, 2792, 2806, 2820, 2835, 2849, 2863, 2877, 2891, 2905,
    2919, 2933, 2947, 2961, 2975, 2988, 3002, 3016, 3030, 3044, 3058, 3072, 3085, 3099, 3113, 3127,
    3140, 3154, 3168, 3182, 3195, 3209, 3222, 3236, 3250, 3263, 3277, 3291, 3304, 3318, 3331, 3345,
    3358, 3372, 3385, 3399, 3412, 3426, 3439, 3452, 3466, 3479, 3493, 3506, 3519, 3533, 3546, 3559,
    3573, 3586, 3599, 3612, 3626, 3639, 3652, 3665, 3678, 3692, 3705, 3718, 3731, 3744, 3757, 3771,
    3784, 3797, 3810, 3823, 3836, 3849, 3862, 3875, 3888, 3901, 3914, 3927, 3940, 3953, 3966, 3979,
    3992, 4005, 4018, 4031, 4044, 4056, 4069, 4082, 4095,
];
const LINEAR_TO_GAMMA: [u8; 33] = [
    0, 3, 8, 13, 19, 25, 31, 38, 45, 52, 60, 67, 75, 83, 91, 99, 107, 116, 124, 133, 142, 151, 160,
    169, 178, 187, 197, 206, 216, 226, 235, 245, 255,
];

#[cfg(test)]
mod tests {
    use super::{convert_2x2, nearest_chroma_rgb_error};

    #[test]
    fn nearest_chroma_proxy_counts_visible_pixels_only() {
        let rgb = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255; 3]];
        let (luma, u, v) = convert_2x2(rgb);
        assert_eq!((luma, u, v), ([82, 145, 41, 235], 128, 128));
        assert_eq!(nearest_chroma_rgb_error(rgb, luma, u, v, 2, 2), 152_325);
        assert_eq!(nearest_chroma_rgb_error(rgb, luma, u, v, 1, 1), 43_542);
        assert_eq!(nearest_chroma_rgb_error(rgb, luma, u, v, 0, 2), 0);
        assert_eq!(nearest_chroma_rgb_error(rgb, luma, u, v, 2, 0), 0);
    }

    // Native libwebp 6c484cbf WebPPictureImportRGB(), use_argb=0, before encode.
    // Oracle source SHA256: 31be241217f587930778af5427156c15e4e54dc4edde3107412011f7b3cfdf6a.
    // Input/plane digests are in the task's external color-oracle evidence.
    #[test]
    fn solid_and_mixed_colors_match_independent_import() {
        assert_eq!(convert_2x2([[160, 64, 32]; 4]), ([93; 4], 99, 173));
        assert_eq!(
            convert_2x2([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]),
            ([82, 145, 41, 235], 128, 128)
        );
        assert_eq!(
            convert_2x2([[25, 97, 173], [30, 101, 169], [40, 110, 158], [13, 87, 181]]),
            ([88, 91, 97, 81], 170, 91)
        );
    }

    #[test]
    fn all_neutral_values_match_independent_import() {
        // Oracle: 256x1 RGB ramp, one visible pixel for each gray level.
        let expected = concat!(
            "1011121313141516171819191a1b1c1d1e1f1f20212223242525262728292a2b",
            "2b2c2d2e2f3031323233343536373838393a3b3c3d3e3e3f4041424344444546",
            "4748494a4a4b4c4d4e4f5050515253545556565758595a5b5c5c5d5e5f606162",
            "6263646566676869696a6b6c6d6e6f6f70717273747575767778797a7b7b7c7d",
            "7e7f8081818283848586878788898a8b8c8d8d8e8f9091929393949596979899",
            "999a9b9c9d9e9fa0a0a1a2a3a4a5a6a6a7a8a9aaabacacadaeafb0b1b2b2b3b4",
            "b5b6b7b8b8b9babbbcbdbebebfc0c1c2c3c4c4c5c6c7c8c9cacacbcccdcecfd0",
            "d0d1d2d3d4d5d6d7d7d8d9dadbdcdddddedfe0e1e2e3e3e4e5e6e7e8e9e9eaeb",
        );
        assert_eq!(expected.len(), 512);
        for gray in 0..=u8::MAX {
            let (y, u, v) = convert_2x2([[gray; 3]; 4]);
            let offset = usize::from(gray) * 2;
            let reference = u8::from_str_radix(&expected[offset..offset + 2], 16).unwrap();
            assert_eq!(y, [reference; 4], "gray={gray}");
            assert_eq!((u, v), (128, 128), "gray={gray}");
        }
    }

    fn visible_planes(width: usize, height: usize, rgb: &[[u8; 3]]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let uv_width = width.div_ceil(2);
        let uv_height = height.div_ceil(2);
        let mut y = vec![0; width * height];
        let mut u = vec![0; uv_width * uv_height];
        let mut v = vec![0; uv_width * uv_height];
        for cy in 0..uv_height {
            for cx in 0..uv_width {
                let samples = std::array::from_fn(|index| {
                    let x = (cx * 2 + index % 2).min(width - 1);
                    let yy = (cy * 2 + index / 2).min(height - 1);
                    rgb[yy * width + x]
                });
                let (luma, chroma_u, chroma_v) = convert_2x2(samples);
                for dy in 0..2 {
                    for dx in 0..2 {
                        let x = cx * 2 + dx;
                        let yy = cy * 2 + dy;
                        if x < width && yy < height {
                            y[yy * width + x] = luma[dy * 2 + dx];
                        }
                    }
                }
                u[cy * uv_width + cx] = chroma_u;
                v[cy * uv_width + cx] = chroma_v;
            }
        }
        (y, u, v)
    }

    #[test]
    fn odd_visible_edges_match_independent_import() {
        let rgb = [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [0, 255, 255],
            [255, 0, 255],
            [255, 255, 0],
            [0, 0, 0],
            [255, 255, 255],
            [128, 128, 128],
        ];
        assert_eq!(
            visible_planes(3, 3, &rgb),
            (
                vec![82, 145, 41, 170, 107, 210, 16, 235, 126],
                vec![128; 4],
                vec![128; 4]
            )
        );
        let column = [[12, 23, 34], [130, 140, 150], [245, 235, 225]];
        assert_eq!(
            visible_planes(1, 3, &column),
            (vec![34, 135, 220], vec![135, 122], vec![122, 133])
        );
    }

    #[test]
    fn varied_color_grid_matches_independent_import_planes() {
        // Fixed 8x8 RGB generator; input SHA256:
        // de25723e9bf50b38e2d64aa0c92532b99e8877f8082f0508f033652ad75b0c05.
        let rgb: Vec<[u8; 3]> = (0..8)
            .flat_map(|y| {
                (0..8).map(move |x| {
                    [
                        (x * 37 + y * 13) as u8,
                        (x * 11 + y * 53) as u8,
                        (x * 71 + y * 29) as u8,
                    ]
                })
            })
            .collect();
        let (y, u, v) = visible_planes(8, 8, &rgb);
        assert_eq!(
            y,
            hex_bytes(concat!(
                "10263c524f657b4f31475d7370869c57",
                "52687e7b91a7bd7873899f9cb2c883",
                "9994aaa7bd516823393349465c7288",
                "445a546a677d934e647b7572889eb4",
                "6f859b"
            ))
        );
        assert_eq!(u, hex_bytes("88b672967f71695c9f59ab8d99747a84"));
        assert_eq!(v, hex_bytes("7c8aab805c748b4f6f8fcb7a809b7559"));
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|digits| u8::from_str_radix(std::str::from_utf8(digits).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn chroma_is_independent_of_pixel_order_within_one_pair() {
        let pixels = [[255, 31, 20], [17, 203, 44], [11, 7, 249], [221, 187, 83]];
        let original = convert_2x2(pixels);
        for shift in 0..4 {
            let rotated = std::array::from_fn(|i| pixels[(i + shift) % 4]);
            let (y, u, v) = convert_2x2(rotated);
            assert_eq!((u, v), (original.1, original.2));
            assert_eq!(y, std::array::from_fn(|i| original.0[(i + shift) % 4]));
        }
    }
}
