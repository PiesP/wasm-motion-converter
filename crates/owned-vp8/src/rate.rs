// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Fixed-point estimated Boolean costs for bounded VP8 mode decisions.

use crate::{BoolWriter, EncodeError};

pub(crate) trait BoolSink {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError>;

    fn write_coeff(
        &mut self,
        _index: usize,
        probability: u8,
        bit: bool,
    ) -> Result<(), EncodeError> {
        self.write(probability, bit)
    }

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

pub(crate) const MAX_BUFFERED_OPS: usize = 8192;

#[derive(Clone, Copy)]
struct BoolOp {
    probability: u8,
    bit: bool,
}

const _: () = assert!(std::mem::size_of::<BoolOp>() == 2);
const _: () = assert!(2 * MAX_BUFFERED_OPS * std::mem::size_of::<BoolOp>() <= 32 * 1024);

/// One bounded header or coefficient work unit, never a frame-wide bit list.
pub(crate) struct OpBuffer {
    ops: Vec<BoolOp>,
    cursor: usize,
}

impl OpBuffer {
    pub(crate) fn new() -> Result<Self, EncodeError> {
        let mut ops = Vec::new();
        ops.try_reserve_exact(MAX_BUFFERED_OPS)
            .map_err(|_| EncodeError::OutputLimit)?;
        Ok(Self { ops, cursor: 0 })
    }

    pub(crate) fn pending(&self) -> bool {
        self.cursor < self.ops.len()
    }

    pub(crate) fn next(&self) -> Option<(u8, bool)> {
        self.ops.get(self.cursor).map(|op| (op.probability, op.bit))
    }

    pub(crate) fn advance(&mut self) {
        self.cursor += 1;
        if self.cursor == self.ops.len() {
            self.ops.clear();
            self.cursor = 0;
        }
    }
}

impl BoolSink for OpBuffer {
    fn write(&mut self, probability_of_zero: u8, bit: bool) -> Result<(), EncodeError> {
        if self.ops.len() == MAX_BUFFERED_OPS {
            return Err(EncodeError::OutputLimit);
        }
        self.ops.push(BoolOp {
            probability: probability_of_zero,
            bit,
        });
        Ok(())
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
        self.cost += u64::from(probability_cost(probability_of_zero, bit));
        Ok(())
    }
}

/// An arithmetic write renormalizes at most eight times, so it can emit at
/// most one byte. The finalizer contributes at most four additional bytes.
#[derive(Default)]
pub(crate) struct SymbolCounter {
    pub count: usize,
}

impl BoolSink for SymbolCounter {
    fn write(&mut self, _probability_of_zero: u8, _bit: bool) -> Result<(), EncodeError> {
        self.count = self.count.checked_add(1).ok_or(EncodeError::OutputLimit)?;
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

pub(crate) fn probability_cost(probability_of_zero: u8, bit: bool) -> u32 {
    bit_cost(if bit {
        256 - u32::from(probability_of_zero)
    } else {
        u32::from(probability_of_zero)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_buffer_has_a_fixed_reusable_limit() {
        let mut ops = OpBuffer::new().unwrap();
        for _ in 0..MAX_BUFFERED_OPS {
            ops.write(128, false).unwrap();
        }
        assert_eq!(ops.write(128, true), Err(EncodeError::OutputLimit));
        for _ in 0..MAX_BUFFERED_OPS {
            assert_eq!(ops.next(), Some((128, false)));
            ops.advance();
        }
        assert!(!ops.pending());
        ops.write(128, true).unwrap();
        assert_eq!(ops.next(), Some((128, true)));
    }

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
