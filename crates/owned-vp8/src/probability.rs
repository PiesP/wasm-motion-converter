// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Per-frame VP8 coefficient probability proposals. Default/update tables are
// the existing RFC 6386 section 13.4/13.5 format constants in this crate.

use crate::{
    coeff_update_probs::COEFF_UPDATE_PROBS, default_coeff_probs::DEFAULT_COEFF_PROBS, EncodeError,
};

pub(crate) const NODE_COUNT: usize = DEFAULT_COEFF_PROBS.len();
pub(crate) const MAX_NODES_PER_STEP: usize = 64;
const _: [(); NODE_COUNT] = [(); COEFF_UPDATE_PROBS.len()];

/// Counts coefficient branches for one frozen analysis. Mode/coefficient trials
/// must not mutate its committed counts. Frame-profile previews use private
/// statistics and discard them before another profile; each starts with `new()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Statistics {
    counts: [[u32; 2]; NODE_COUNT],
}

impl Default for Statistics {
    fn default() -> Self {
        Self::new()
    }
}

impl Statistics {
    pub(crate) fn new() -> Self {
        Self {
            counts: [[0; 2]; NODE_COUNT],
        }
    }

    pub(crate) fn observe(&mut self, index: usize, bit: bool) -> Result<(), EncodeError> {
        let count = self
            .counts
            .get_mut(index)
            .ok_or(EncodeError::InvalidInput)?
            .get_mut(usize::from(bit))
            .ok_or(EncodeError::InvalidInput)?;
        *count = count.checked_add(1).ok_or(EncodeError::InvalidInput)?;
        Ok(())
    }

    pub(crate) fn counts(&self, index: usize) -> Result<[u32; 2], EncodeError> {
        self.counts
            .get(index)
            .copied()
            .ok_or(EncodeError::InvalidInput)
    }
}

/// Estimated saving is in the caller's cost units, normally 1/256 bit.
/// The actual finalized arithmetic-coded frame size remains the adoption gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    pub index: usize,
    pub default_probability: u8,
    pub chosen_probability: u8,
    pub updated: bool,
    pub estimated_saving: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Model {
    probabilities: [u8; NODE_COUNT],
    update_flags: [bool; NODE_COUNT],
    estimated_savings: [u128; NODE_COUNT],
}

impl Default for Model {
    fn default() -> Self {
        Self::new()
    }
}

impl Model {
    pub(crate) fn new() -> Self {
        Self {
            probabilities: DEFAULT_COEFF_PROBS,
            update_flags: [false; NODE_COUNT],
            estimated_savings: [0; NODE_COUNT],
        }
    }

    pub(crate) fn probabilities(&self) -> &[u8; NODE_COUNT] {
        &self.probabilities
    }

    pub(crate) fn updated(&self, index: usize) -> Result<bool, EncodeError> {
        self.update_flags
            .get(index)
            .copied()
            .ok_or(EncodeError::InvalidInput)
    }

    #[cfg(test)]
    pub(crate) fn estimated_saving(&self, index: usize) -> Result<u128, EncodeError> {
        self.estimated_savings
            .get(index)
            .copied()
            .ok_or(EncodeError::InvalidInput)
    }

    /// Compare data plus the actual update flag and 8 literal probability bits.
    /// The cost function is deterministic and returns nonnegative fixed units.
    /// A tie or a proposal equal to the default keeps the default. Repeating
    /// this call for one index replaces its prior decision instead of compounding
    /// statistics, so a bounded caller can restart a frame deterministically.
    pub(crate) fn optimize_one<F: Fn(u8, bool) -> u32>(
        &mut self,
        statistics: &Statistics,
        index: usize,
        cost: &F,
    ) -> Result<Decision, EncodeError> {
        let [zeros, ones] = statistics.counts(index)?;
        let old = DEFAULT_COEFF_PROBS[index];
        let mut chosen = old;
        let mut saving = 0;
        let observations = u64::from(zeros) + u64::from(ones);
        if let Some(proposed) =
            (u64::from(zeros) * 256 + observations / 2).checked_div(observations)
        {
            let proposed = proposed.clamp(1, 255) as u8;
            if proposed != old {
                let old_data = data_cost(zeros, ones, old, cost);
                let new_data = data_cost(zeros, ones, proposed, cost);
                let update_probability = COEFF_UPDATE_PROBS[index];
                let old_total = old_data + u128::from(cost(update_probability, false));
                let mut new_total = new_data + u128::from(cost(update_probability, true));
                for shift in (0..8).rev() {
                    new_total += u128::from(cost(128, proposed & (1 << shift) != 0));
                }
                if new_total < old_total {
                    chosen = proposed;
                    saving = old_total - new_total;
                }
            }
        }
        self.probabilities[index] = chosen;
        self.update_flags[index] = chosen != old;
        self.estimated_savings[index] = saving;
        Ok(Decision {
            index,
            default_probability: old,
            chosen_probability: chosen,
            updated: chosen != old,
            estimated_saving: saving,
        })
    }

    /// At most 64 table entries per invocation; the conversion's step protocol
    /// yields to a host task between ranges. Returns the number of updates in
    /// this range, not a whole-frame size claim.
    pub(crate) fn optimize_range<F: Fn(u8, bool) -> u32>(
        &mut self,
        statistics: &Statistics,
        start: usize,
        count: usize,
        cost: &F,
    ) -> Result<u32, EncodeError> {
        let end = start.checked_add(count).ok_or(EncodeError::InvalidInput)?;
        if count > MAX_NODES_PER_STEP || end > NODE_COUNT {
            return Err(EncodeError::InvalidInput);
        }
        let mut updated = 0;
        for index in start..end {
            updated += u32::from(self.optimize_one(statistics, index, cost)?.updated);
        }
        Ok(updated)
    }
}

fn data_cost<F: Fn(u8, bool) -> u32>(zeros: u32, ones: u32, probability: u8, cost: &F) -> u128 {
    u128::from(zeros) * u128::from(cost(probability, false))
        + u128::from(ones) * u128::from(cost(probability, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent floating-point diagnostic for the fixed-point caller API.
    // Zero probability is treated as a bounded maximum cost, as in rate.rs.
    fn diagnostic_cost(probability: u8, bit: bool) -> u32 {
        let selected = if bit {
            256 - u32::from(probability)
        } else {
            u32::from(probability)
        };
        if selected == 0 {
            2048
        } else {
            (-f64::from(selected).log2() * 256.0 + 2048.0).round() as u32
        }
    }

    #[test]
    fn strongly_biased_data_pays_for_update_flag_and_literal() {
        let mut stats = Statistics::new();
        for _ in 0..5000 {
            stats.observe(0, false).unwrap();
        }
        let mut model = Model::new();
        let decision = model.optimize_one(&stats, 0, &diagnostic_cost).unwrap();
        assert_eq!(decision.default_probability, 128);
        assert_eq!(decision.chosen_probability, 255);
        assert!(decision.updated);
        assert!(decision.estimated_saving > 0);
        assert_eq!(model.probabilities()[0], 255);
        assert_eq!(
            model.estimated_saving(0).unwrap(),
            decision.estimated_saving
        );
        assert!(model.updated(0).unwrap());

        // Check the independent numerical inequality including update syntax.
        let old_total = 5000u128 * u128::from(diagnostic_cost(128, false))
            + u128::from(diagnostic_cost(COEFF_UPDATE_PROBS[0], false));
        let new_total = 5000u128 * u128::from(diagnostic_cost(255, false))
            + u128::from(diagnostic_cost(COEFF_UPDATE_PROBS[0], true))
            + (0..8)
                .map(|shift| u128::from(diagnostic_cost(128, 255 & (1 << shift) != 0)))
                .sum::<u128>();
        assert_eq!(decision.estimated_saving, old_total - new_total);
    }

    #[test]
    fn small_samples_ties_and_optimal_default_do_not_update() {
        let mut stats = Statistics::new();
        stats.observe(0, false).unwrap();
        let mut model = Model::new();
        assert!(
            !model
                .optimize_one(&stats, 0, &diagnostic_cost)
                .unwrap()
                .updated
        );
        assert_eq!(model.probabilities()[0], 128);
        for _ in 0..499 {
            stats.observe(0, false).unwrap();
            stats.observe(0, true).unwrap();
        }
        stats.observe(0, true).unwrap();
        assert_eq!(stats.counts(0).unwrap(), [500, 500]);
        assert!(
            !model
                .optimize_one(&stats, 0, &diagnostic_cost)
                .unwrap()
                .updated
        );
        let optimal_index = DEFAULT_COEFF_PROBS.iter().position(|&p| p == 253).unwrap();
        let mut optimal_stats = Statistics::new();
        for _ in 0..253 {
            optimal_stats.observe(optimal_index, false).unwrap();
        }
        for _ in 0..3 {
            optimal_stats.observe(optimal_index, true).unwrap();
        }
        assert!(
            !model
                .optimize_one(&optimal_stats, optimal_index, &diagnostic_cost)
                .unwrap()
                .updated
        );
        assert_eq!(model.probabilities()[optimal_index], 253);

        // Even when the proposed value differs, equal total estimated costs
        // cannot justify signaling an update.
        let mut biased = Statistics::new();
        for _ in 0..100 {
            biased.observe(0, false).unwrap();
        }
        let tie = model.optimize_one(&biased, 0, &|_, _| 0).unwrap();
        assert!(!tie.updated);
        assert_eq!(tie.chosen_probability, 128);
        assert_eq!(tie.estimated_saving, 0);
    }

    #[test]
    fn bounded_ranges_reject_invalid_inputs_and_preserve_frame_isolation() {
        let mut stats = Statistics::new();
        assert_eq!(
            stats.observe(NODE_COUNT, false),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(stats.counts(NODE_COUNT), Err(EncodeError::InvalidInput));
        stats.counts[0][0] = u32::MAX;
        assert_eq!(stats.observe(0, false), Err(EncodeError::InvalidInput));
        stats.counts[0][1] = u32::MAX;
        let mut first = Model::new();
        let mut second = Model::new();
        assert_eq!(
            first
                .optimize_range(&stats, 0, 64, &diagnostic_cost)
                .unwrap(),
            second
                .optimize_range(&stats, 0, 64, &diagnostic_cost)
                .unwrap()
        );
        assert_eq!(first, second);
        assert_eq!(
            first
                .optimize_range(&stats, 0, 64, &diagnostic_cost)
                .unwrap(),
            u32::from(first.updated(0).unwrap())
        );
        assert_eq!(first, second);
        assert_eq!(
            first.optimize_range(&stats, 64, 65, &diagnostic_cost),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(
            first.optimize_range(&stats, NODE_COUNT, 1, &diagnostic_cost),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(
            first.optimize_range(&stats, usize::MAX, 1, &diagnostic_cost),
            Err(EncodeError::InvalidInput)
        );
        assert_eq!(first.updated(NODE_COUNT), Err(EncodeError::InvalidInput));
        assert_eq!(
            first.estimated_saving(NODE_COUNT),
            Err(EncodeError::InvalidInput)
        );
        let fresh = Model::new();
        assert_eq!(fresh.probabilities(), &DEFAULT_COEFF_PROBS);
        assert!(!fresh.updated(0).unwrap());
    }

    #[test]
    fn extreme_counts_use_wide_checked_cost_arithmetic() {
        let index = DEFAULT_COEFF_PROBS
            .iter()
            .position(|&probability| probability == 253)
            .unwrap();
        let mut stats = Statistics::new();
        stats.counts[index] = [u32::MAX, u32::MAX - 1];
        let mut model = Model::new();
        let cost = |probability: u8, _bit: bool| {
            if probability == 253 {
                u32::MAX
            } else {
                0
            }
        };
        let decision = model.optimize_one(&stats, index, &cost).unwrap();
        assert!(decision.updated);
        assert_eq!(decision.chosen_probability, 128);
        assert!(decision.estimated_saving > u128::from(u64::MAX));
        assert_eq!(
            model.estimated_saving(index).unwrap(),
            decision.estimated_saving
        );
    }
}
