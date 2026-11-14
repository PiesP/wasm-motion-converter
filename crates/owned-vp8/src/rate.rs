// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Fixed-point estimated Boolean costs for bounded VP8 mode decisions.

use crate::{BoolWriter, EncodeError};

pub(crate) trait BoolSink {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError>;

    fn bit(&mut self, bit: bool) -> Result<(), EncodeError> {
        self.write(128, bit)
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

fn bit_cost(probability: u32) -> u32 {
    if probability == 0 {
        return 4096;
    }
    if probability == 256 {
        return 0;
    }
    let exponent = 31 - probability.leading_zeros();
    let mut normalized = (u64::from(probability) << (8 - exponent)) << 16;
    let mut fractional = 0u32;
    for shift in (0..8).rev() {
        normalized = (normalized * normalized) >> 24;
        if normalized >= (512 << 16) {
            normalized >>= 1;
            fractional |= 1 << shift;
        }
    }
    (8 - exponent) * 256 - fractional
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
}
