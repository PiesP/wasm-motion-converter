// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Fixed-point estimated Boolean costs for bounded VP8 mode decisions.

use crate::{BoolWriter, EncodeError};

pub(crate) trait BoolSink {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError>;

    fn bit(&mut self, bit: bool) -> Result<(), EncodeError> {
        self.write(128, bit)
    }

    fn literal(&mut self, value: u32, bits: u32) -> Result<(), EncodeError> {
        for shift in (0..bits).rev() {
            self.bit(value & (1 << shift) != 0)?;
        }
        Ok(())
    }
}

impl BoolSink for BoolWriter {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        BoolWriter::write(self, probability_of_zero, bit)
    }
}

/// Cost is measured in 1/256 bit. No floating point or mutable statistics are
/// involved in selection. The same token path is used by the real writer.
#[derive(Default)]
pub(crate) struct RateCounter {
    pub cost: u64,
}

impl BoolSink for RateCounter {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        let probability = if bit {
            256 - u32::from(probability_of_zero)
        } else {
            u32::from(probability_of_zero)
        };
        self.cost += u64::from(bit_cost(probability));
        Ok(())
    }
}

/// Mirrors byte emission and termination without storing encoded bytes. Carry
/// changes earlier byte values but never the number of bytes emitted.
pub(crate) struct CountingBoolSink {
    range: u32,
    bottom: u32,
    bit_count: u32,
    bytes: usize,
}

impl Default for CountingBoolSink {
    fn default() -> Self {
        Self {
            range: 255,
            bottom: 0,
            bit_count: 24,
            bytes: 0,
        }
    }
}

impl CountingBoolSink {
    pub(crate) fn finish_size(&self) -> Result<usize, EncodeError> {
        self.bytes.checked_add(4).ok_or(EncodeError::OutputLimit)
    }
}

impl BoolSink for CountingBoolSink {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        let split = 1 + (((self.range - 1) * u32::from(probability_of_zero)) >> 8);
        if bit {
            self.bottom = self.bottom.wrapping_add(split);
            self.range -= split;
        } else {
            self.range = split;
        }
        while self.range < 128 {
            self.range <<= 1;
            self.bottom <<= 1;
            self.bit_count -= 1;
            if self.bit_count == 0 {
                self.bytes = self.bytes.checked_add(1).ok_or(EncodeError::OutputLimit)?;
                self.bottom &= (1 << 24) - 1;
                self.bit_count = 8;
            }
        }
        Ok(())
    }
}

const fn calculate_cost(probability: u32) -> u32 {
    if probability == 0 {
        return 4096;
    }
    if probability == 256 {
        return 0;
    }
    let exponent = 31 - probability.leading_zeros();
    let mut normalized = ((probability as u64) << (8 - exponent)) << 16;
    let mut fractional = 0u32;
    let mut shift = 8;
    while shift > 0 {
        shift -= 1;
        normalized = (normalized * normalized) >> 24;
        if normalized >= (512 << 16) {
            normalized >>= 1;
            fractional |= 1 << shift;
        }
    }
    (8 - exponent) * 256 - fractional
}

const COSTS: [u16; 257] = {
    let mut result = [0; 257];
    let mut probability = 0;
    while probability <= 256 {
        result[probability] = calculate_cost(probability as u32) as u16;
        probability += 1;
    }
    result
};

fn bit_cost(probability: u32) -> u32 {
    u32::from(COSTS[probability as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_point_cost_orders_probabilities() {
        assert_eq!(bit_cost(256), 0);
        assert_eq!(bit_cost(128), 256);
        assert_eq!(bit_cost(64), 512);
        assert!(bit_cost(1) > bit_cost(16));
        assert!(bit_cost(16) > bit_cost(64));
        let mut counter = RateCounter::default();
        counter.write(192, false).unwrap();
        let likely = counter.cost;
        counter.cost = 0;
        counter.write(192, true).unwrap();
        assert!(counter.cost > likely);
    }

    #[test]
    fn counted_arithmetic_length_matches_finalized_writer() {
        let mut counted = CountingBoolSink::default();
        let mut actual = BoolWriter::new();
        let mut seed = 0x501u32;
        for i in 0..100_000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let probability = if i % 7 == 0 { 1 } else { (seed >> 16) as u8 };
            let bit = seed & 1 != 0;
            counted.write(probability, bit).unwrap();
            actual.write(probability, bit).unwrap();
        }
        assert_eq!(
            counted.finish_size().unwrap(),
            actual.finish().unwrap().len()
        );
    }
}
