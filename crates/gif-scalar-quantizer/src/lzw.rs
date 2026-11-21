//! GIF image data blocks for an already mapped frame.

const CODE_LIMIT: u16 = 4096;
const MAX_CODE_WIDTH: u8 = 12;
const SLOT_COUNT: usize = 8192;
const KEY_BITS: u32 = 20;
const KEY_MASK: u32 = (1 << KEY_BITS) - 1;
const BLOCK_LIMIT: u8 = 254;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LzwError {
    InvalidDepth,
    InvalidIndex,
    OutputTooSmall,
}

/// Reusable fixed storage. Initialize directly in caller-owned static memory
/// with `LzwScratch::EMPTY`.
pub struct LzwScratch {
    slots: [u32; SLOT_COUNT],
}

impl LzwScratch {
    pub const EMPTY: Self = Self {
        slots: [0; SLOT_COUNT],
    };

    fn reset(&mut self) {
        self.slots.fill(0);
    }

    fn lookup(&self, key: u32) -> (usize, u32) {
        let hash = key.wrapping_mul(0x9e37_79b1);
        let mut slot = (hash >> (u32::BITS - SLOT_COUNT.trailing_zeros())) as usize;
        loop {
            let entry = self.slots[slot];
            if entry == 0 || entry & KEY_MASK == key {
                return (slot, entry);
            }
            slot = (slot + 1) & (SLOT_COUNT - 1);
        }
    }
}

/// Writes the minimum code size, GIF LZW sub-blocks and zero terminator.
///
/// Accepts depths 2 through 8 and indices below 2 to the power of depth.
/// Empty input produces a clear code followed by an end code. Invalid depth
/// or indices leave output untouched. On insufficient capacity, the output
/// prefix may have been written. Success returns the exact length and leaves
/// the remaining output unchanged.
pub fn encode_lzw(
    indices: &[u8],
    depth: u8,
    output: &mut [u8],
    scratch: &mut LzwScratch,
) -> Result<usize, LzwError> {
    if !(2..=8).contains(&depth) {
        return Err(LzwError::InvalidDepth);
    }

    let clear = 1_u16 << depth;
    if depth < 8 && indices.iter().any(|&index| u16::from(index) >= clear) {
        return Err(LzwError::InvalidIndex);
    }

    let mut writer = SubBlocks::new(output);
    writer.byte(depth)?;

    let mut width = depth + 1;
    writer.code(clear, width)?;
    if let Some((&first, remaining)) = indices.split_first() {
        scratch.reset();
        let mut next_code = clear + 2;
        let mut prefix = u16::from(first);

        for &index in remaining {
            let key = (u32::from(prefix) << 8) | u32::from(index);
            let (slot, entry) = scratch.lookup(key);
            if entry != 0 {
                prefix = (entry >> KEY_BITS) as u16;
                continue;
            }

            writer.code(prefix, width)?;
            width = next_width(width, next_code);

            if next_code == CODE_LIMIT {
                writer.code(clear, width)?;
                scratch.reset();
                width = depth + 1;
                next_code = clear + 2;
            } else {
                scratch.slots[slot] = (u32::from(next_code) << KEY_BITS) | key;
                next_code += 1;
            }
            prefix = u16::from(index);
        }

        writer.code(prefix, width)?;
        width = next_width(width, next_code);
    }

    writer.code(clear + 1, width)?;
    writer.finish()
}

// The decoder learns one entry when it reads the just-emitted data code.
// It starts using the wider width after that entry fills the old width.
fn next_width(width: u8, next_code: u16) -> u8 {
    width + u8::from(width < MAX_CODE_WIDTH && next_code == 1 << width)
}

struct SubBlocks<'a> {
    output: &'a mut [u8],
    written: usize,
    length_offset: usize,
    block_len: u8,
    pending: u32,
    pending_bits: u8,
}

impl<'a> SubBlocks<'a> {
    fn new(output: &'a mut [u8]) -> Self {
        Self {
            output,
            written: 0,
            length_offset: 0,
            block_len: 0,
            pending: 0,
            pending_bits: 0,
        }
    }

    fn byte(&mut self, value: u8) -> Result<(), LzwError> {
        let next = self
            .output
            .get_mut(self.written)
            .ok_or(LzwError::OutputTooSmall)?;
        *next = value;
        self.written += 1;
        Ok(())
    }

    fn payload_byte(&mut self, value: u8) -> Result<(), LzwError> {
        if self.block_len == 0 {
            self.length_offset = self.written;
            self.byte(0)?;
        }
        self.byte(value)?;
        self.block_len += 1;
        if self.block_len == BLOCK_LIMIT {
            self.output[self.length_offset] = self.block_len;
            self.block_len = 0;
        }
        Ok(())
    }

    fn code(&mut self, code: u16, width: u8) -> Result<(), LzwError> {
        debug_assert!(code < 1 << width);
        self.pending |= u32::from(code) << self.pending_bits;
        self.pending_bits += width;
        while self.pending_bits >= 8 {
            self.payload_byte(self.pending as u8)?;
            self.pending >>= 8;
            self.pending_bits -= 8;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<usize, LzwError> {
        if self.pending_bits != 0 {
            self.payload_byte(self.pending as u8)?;
        }
        if self.block_len != 0 {
            self.output[self.length_offset] = self.block_len;
        }
        self.byte(0)?;
        Ok(self.written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(indices: &[u8], depth: u8) -> Vec<u8> {
        let mut output = vec![0; indices.len() * 2 + 16];
        let mut scratch = LzwScratch::EMPTY;
        let count = encode_lzw(indices, depth, &mut output, &mut scratch).unwrap();
        output.truncate(count);
        output
    }

    fn unpack(blocks: &[u8]) -> (Vec<u8>, Vec<usize>) {
        let mut payload = Vec::new();
        let mut sizes = Vec::new();
        let mut remaining = &blocks[1..];
        loop {
            let (&size, bytes) = remaining.split_first().unwrap();
            if size == 0 {
                assert!(bytes.is_empty());
                return (payload, sizes);
            }
            let size = usize::from(size);
            assert!(size <= 254);
            payload.extend_from_slice(&bytes[..size]);
            sizes.push(size);
            remaining = &bytes[size..];
        }
    }

    fn decoded(blocks: &[u8]) -> (Vec<u8>, usize, usize) {
        let depth = usize::from(blocks[0]);
        let literal_count = 2_usize.pow(depth as u32);
        let (payload, _) = unpack(blocks);
        let mut offset = 0;
        let mut output = Vec::new();
        let mut table: Vec<Vec<u8>> = Vec::new();
        let mut previous: Option<Vec<u8>> = None;
        let mut width = depth + 1;
        let mut widest = width;
        let mut clears = 0;
        loop {
            let mut code = 0;
            for shift in 0..width {
                let bit = payload[offset / 8] >> (offset % 8) & 1;
                code |= usize::from(bit) << shift;
                offset += 1;
            }

            if code == literal_count {
                if clears != 0 {
                    assert_eq!(table.len(), 4096);
                }
                table = (0..literal_count)
                    .map(|literal| vec![literal as u8])
                    .collect();
                table.resize(literal_count + 2, Vec::new());
                previous = None;
                width = depth + 1;
                clears += 1;
                continue;
            }
            assert!(clears > 0, "first code must clear the dictionary");
            if code == literal_count + 1 {
                assert!(payload.len() * 8 - offset < 8, "bytes after end code");
                if offset % 8 != 0 {
                    assert_eq!(payload[offset / 8] >> (offset % 8), 0);
                }
                return (output, clears, widest);
            }

            let sequence = if code == table.len() {
                let mut sequence = previous.clone().unwrap();
                sequence.push(sequence[0]);
                sequence
            } else {
                table[code].clone()
            };
            assert!(!sequence.is_empty());
            output.extend_from_slice(&sequence);
            if let Some(mut entry) = previous {
                if table.len() < 4096 {
                    entry.push(sequence[0]);
                    table.push(entry);
                    if table.len() == 1 << width && width < 12 {
                        width += 1;
                        widest = widest.max(width);
                    }
                }
            }
            previous = Some(sequence);
        }
    }

    #[test]
    fn known_bytes_cover_empty_repetition_and_end_width_transition() {
        assert_eq!(encoded(&[], 2), [2, 1, 0x2c, 0]);
        assert_eq!(encoded(&[0], 2), [2, 2, 0x44, 0x01, 0]);
        assert_eq!(encoded(&[0, 0, 0], 2), [2, 2, 0x84, 0x0b, 0]);
        assert_eq!(encoded(&[0, 1, 2], 2), [2, 2, 0x44, 0x54, 0]);
    }

    #[test]
    fn sub_blocks_use_254_payload_bytes_at_the_boundary() {
        let indices: Vec<u8> = (0..224).collect();
        let exact = encoded(&indices[..223], 8);
        assert_eq!(unpack(&exact).1, [254]);
        assert_eq!(decoded(&exact).0, indices[..223]);
        let next = encoded(&indices, 8);
        assert_eq!(unpack(&next).1, [254, 1]);
        assert_eq!(decoded(&next).0, indices);
    }

    #[test]
    fn rejects_invalid_arguments_and_recovers_from_short_output() {
        let mut output = [238; 12];
        let mut scratch = LzwScratch::EMPTY;
        for depth in [0, 1, 9, 255] {
            assert_eq!(
                encode_lzw(&[1], depth, &mut output, &mut scratch),
                Err(LzwError::InvalidDepth)
            );
        }
        assert_eq!(
            encode_lzw(&[1, 4], 2, &mut output, &mut scratch),
            Err(LzwError::InvalidIndex)
        );
        assert_eq!(output, [238; 12]);
        for capacity in 0..5 {
            assert_eq!(
                encode_lzw(&[0, 1, 2], 2, &mut output[..capacity], &mut scratch),
                Err(LzwError::OutputTooSmall)
            );
        }
        assert_eq!(encode_lzw(&[0, 1, 2], 2, &mut output, &mut scratch), Ok(5));
        assert_eq!(&output[..5], &[2, 2, 0x44, 0x54, 0]);
        assert_eq!(&output[5..], &[238; 7]);
    }

    #[test]
    fn independent_decoder_round_trips_every_depth_through_dictionary_resets() {
        let mut seed = 0x23ac_af29_u32;
        for depth in 2..=8 {
            let indices: Vec<u8> = (0..50_000)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    (seed >> (32 - depth)) as u8
                })
                .collect();
            let (pixels, clears, widest) = decoded(&encoded(&indices, depth));
            assert_eq!(widest, 12, "depth {depth}");
            assert!(clears > 1, "depth {depth}");
            assert_eq!(pixels, indices, "depth {depth}");
        }
    }
}
