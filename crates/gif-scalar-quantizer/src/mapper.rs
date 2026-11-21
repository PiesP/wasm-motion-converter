//! In-place mapping of prepared RGB pixels to GIF palette indices.

use crate::palette::nearest_index;

const CELL_COUNT: usize = 32 * 32 * 32;
const WORD_BITS: usize = u32::BITS as usize;
const MAX_PALETTE_BYTES: usize = 256 * 3;

/// Reusable cache. Initialize directly in caller-owned static memory with
/// `MapperScratch::EMPTY`.
pub struct MapperScratch {
    winners: [u8; CELL_COUNT],
    occupied: [u32; CELL_COUNT / WORD_BITS],
}

impl MapperScratch {
    pub const EMPTY: Self = Self {
        winners: [0; CELL_COUNT],
        occupied: [0; CELL_COUNT / WORD_BITS],
    };

    fn index(&mut self, rgb: [u8; 3], palette: &[u8]) -> u8 {
        let [red, green, blue] = rgb.map(|channel| usize::from(channel >> 3));
        let cell = (red << 10) | (green << 5) | blue;
        let word = &mut self.occupied[cell / WORD_BITS];
        let mask = 1 << (cell % WORD_BITS);
        if *word & mask == 0 {
            self.winners[cell] = nearest_index(rgb, palette);
            *word |= mask;
        }
        self.winners[cell]
    }
}

/// Maps a nonempty slice of complete RGBA pixels to 1 through 256 packed RGB
/// palette entries. Alpha is ignored. Each RGB555 cell uses the palette index
/// selected for the first prepared RGB pixel observed in that cell.
///
/// Success returns the pixel count. The first count bytes hold the mapped
/// indices, and the rest of the input buffer is untouched. Invalid RGBA or
/// palette length returns None before any bytes are written.
pub fn map_in_place(
    rgba: &mut [u8],
    packed_palette: &[u8],
    scratch: &mut MapperScratch,
) -> Option<usize> {
    if rgba.is_empty()
        || !rgba.len().is_multiple_of(4)
        || packed_palette.is_empty()
        || packed_palette.len() > MAX_PALETTE_BYTES
        || !packed_palette.len().is_multiple_of(3)
    {
        return None;
    }

    scratch.occupied.fill(0);
    let pixels = rgba.len() / 4;
    for index in 0..pixels {
        // The output index is at or before this pixel's RGBA start, so all
        // subsequent pixels are read from the original bytes.
        let [red, green, blue, _] = rgba.as_chunks::<4>().0[index];
        rgba[index] = scratch.index([red, green, blue], packed_palette);
    }
    Some(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_uses_first_pixel_per_cell_and_resets_between_calls() {
        let palette = [0, 0, 0, 7, 7, 7, 255, 255, 255, 8, 0, 0];
        let first = [
            [0, 0, 0, 4],
            [7, 7, 7, 251],
            [8, 0, 0, 96],
            [255, 255, 255, 0],
            [248, 248, 248, 255],
        ];
        let second = [first[1], first[0], first[2], first[4], first[3]];
        let mut scratch = MapperScratch::EMPTY;
        let mut output = first;

        assert_eq!(
            map_in_place(output.as_flattened_mut(), &palette, &mut scratch),
            Some(5)
        );
        assert_eq!(&output.as_flattened()[..5], &[0, 0, 3, 2, 2]);
        assert_eq!(&output.as_flattened()[5..], &first.as_flattened()[5..]);

        output = second;
        assert_eq!(
            map_in_place(output.as_flattened_mut(), &palette, &mut scratch),
            Some(5)
        );
        assert_eq!(&output.as_flattened()[..5], &[1, 1, 3, 2, 2]);
        assert_eq!(&output.as_flattened()[5..], &second.as_flattened()[5..]);
    }

    #[test]
    fn greatest_tied_index_including_255_is_cacheable() {
        let mut input = [5, 7, 9, 0, 6, 7, 8, 255];
        let palette = [0; MAX_PALETTE_BYTES];
        let mut scratch = MapperScratch::EMPTY;
        assert_eq!(map_in_place(&mut input, &palette, &mut scratch), Some(2));
        assert_eq!(input, [255, 255, 9, 0, 6, 7, 8, 255]);
    }

    #[test]
    fn invalid_dimensions_and_palettes_leave_input_untouched() {
        let mut scratch = MapperScratch::EMPTY;
        let mut input = [170; 5];
        assert_eq!(map_in_place(&mut input, &[1, 2, 3], &mut scratch), None);
        assert_eq!(
            map_in_place(&mut input[..0], &[1, 2, 3], &mut scratch),
            None
        );
        for palette in [&[][..], &[1, 2][..], &[0; 257 * 3][..]] {
            assert_eq!(map_in_place(&mut input[..4], palette, &mut scratch), None);
        }
        assert_eq!(input, [170; 5]);
    }
}
