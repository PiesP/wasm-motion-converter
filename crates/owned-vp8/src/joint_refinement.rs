// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Private, frame-budgeted UV coefficient trials. A search state never borrows
// or mutates the live macroblock while its score is incomplete.

use super::*;

pub(super) const EXTRA_PROPOSALS_PER_FRAME: usize = 128;
const MAX_MOVES: usize = 64;
const BEAM_WIDTH: usize = 2;
const MAX_DEPTH: usize = 4;

pub(super) fn extra_quota(block: usize, block_count: usize) -> usize {
    ((block + 1) * EXTRA_PROPOSALS_PER_FRAME / block_count)
        - (block * EXTRA_PROPOSALS_PER_FRAME / block_count)
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Move {
    plane: u8,
    patch: u8,
    coefficient: u8,
    direction: i8,
}

impl Move {
    fn position_bit(self) -> u128 {
        1u128
            << (usize::from(self.plane) * 64
                + usize::from(self.patch) * 16
                + usize::from(self.coefficient))
    }
}

#[derive(Clone, Copy, Default)]
struct Path {
    moves: [u8; MAX_DEPTH],
    len: u8,
    positions: u128,
    move_set: u64,
    gain: f64,
}

impl Path {
    fn append(mut self, index: usize, descriptor: Move) -> Self {
        self.moves[usize::from(self.len)] = index as u8;
        self.len += 1;
        self.positions |= descriptor.position_bit();
        self.move_set |= 1u64 << index;
        self
    }
}

pub(super) struct JointResult {
    pub block: Macroblock,
    pub u: [u8; 64],
    pub v: [u8; 64],
    pub changes: [RefinementChange; MAX_DEPTH],
    pub len: usize,
}

pub(super) struct JointSearch {
    base: Macroblock,
    tile_y: [u8; 256],
    base_u: [u8; 64],
    base_v: [u8; 64],
    predicted_u: [u8; 64],
    predicted_v: [u8; 64],
    cache: display_rgb::LocalCache,
    guard_rgb_ssd: bool,
    moves: [Move; MAX_MOVES],
    move_count: usize,
    beam: [Path; BEAM_WIDTH],
    beam_count: usize,
    next: [Path; BEAM_WIDTH],
    next_count: usize,
    depth: usize,
    parent: usize,
    descriptor: usize,
    used: usize,
    quota: usize,
    best: [RefinementChange; MAX_DEPTH],
    best_len: usize,
    best_gain: f64,
    done: bool,
}

// The one heap-held search includes its full display cache, paths and tiles.
// The previous fixed cache charge covers it without raising the 8 MiB scratch.
const _: () = assert!(std::mem::size_of::<JointSearch>() <= 65_536);

fn patch_from_tile(tile: &[u8; 64], patch: usize) -> [u8; 16] {
    prediction_patch::<8, 64>(tile, patch % 2, patch / 2)
}

fn predict_plane(reconstructed: &[u8], stride: usize, mx: usize, my: usize, mode: u8) -> [u8; 64] {
    let x = mx * 8;
    let y = my * 8;
    let (top, left, corner) = edge::<8>(reconstructed, stride, x, y);
    prediction::predict_uv(&top, &left, corner, y > 0, x > 0, mode_from_u8(mode))
}

fn level(block: &Macroblock, plane: usize, patch: usize, coefficient: usize) -> i16 {
    if plane == 0 {
        block.u[patch][coefficient]
    } else {
        block.v[patch][coefficient]
    }
}

fn coefficients_mut(block: &mut Macroblock, plane: usize, patch: usize) -> &mut [i16; 16] {
    if plane == 0 {
        &mut block.u[patch]
    } else {
        &mut block.v[patch]
    }
}

fn apply_change(
    block: &mut Macroblock,
    u: &mut [u8; 64],
    v: &mut [u8; 64],
    predicted_u: &[u8; 64],
    predicted_v: &[u8; 64],
    steps: Steps,
    change: RefinementChange,
) -> Result<(), EncodeError> {
    let plane = usize::from(change.plane);
    let patch = usize::from(change.patch);
    let coefficient = usize::from(change.coefficient);
    if plane >= 2 || patch >= 4 || coefficient >= 16 {
        return Err(EncodeError::InvalidInput);
    }
    let coefficients = coefficients_mut(block, plane, patch);
    if coefficients[coefficient] != change.old {
        return Err(EncodeError::InvalidInput);
    }
    coefficients[coefficient] = change.new;
    let predicted = if plane == 0 { predicted_u } else { predicted_v };
    let predictor = patch_from_tile(predicted, patch);
    let pixels = reconstructed_patch(coefficients, &predictor, steps);
    let tile = if plane == 0 { u } else { v };
    store_patch::<8, 64>(tile, patch % 2, patch / 2, &pixels);
    Ok(())
}

impl JointSearch {
    pub(super) fn new(
        live: &display_rgb::Frame<'_>,
        selected: &Macroblock,
        baseline: Option<(RefinementChange, f64)>,
        reconstructed_uv: [&[u8]; 2],
        steps: Steps,
        quota: usize,
        guard_rgb_ssd: bool,
    ) -> Result<Option<Self>, EncodeError> {
        if quota == 0 {
            return Ok(None);
        }
        // A skipped base has no coded coefficient. Distinct-position ±1 moves
        // cannot return every UV coefficient to zero, so no final path can
        // retain its required whole-macroblock skip syntax.
        if selected.skip() {
            return Ok(None);
        }
        let [reconstructed_u, reconstructed_v] = reconstructed_uv;
        let stride = live.stride_y / 2;
        let predicted_u =
            predict_plane(reconstructed_u, stride, live.mx, live.my, selected.uv_mode);
        let predicted_v =
            predict_plane(reconstructed_v, stride, live.mx, live.my, selected.uv_mode);
        let mut base = *selected;
        let mut base_u = *live.tile_u;
        let mut base_v = *live.tile_v;
        if let Some((change, _)) = baseline {
            let plane = usize::from(change.plane);
            let patch = usize::from(change.patch);
            let coefficient = usize::from(change.coefficient);
            if plane >= 2
                || patch >= 4
                || coefficient >= 16
                || level(&base, plane, patch, coefficient) != change.new
            {
                return Err(EncodeError::InvalidInput);
            }
            let predicted = if plane == 0 {
                &predicted_u
            } else {
                &predicted_v
            };
            let current = if plane == 0 { &base_u } else { &base_v };
            let predictor = patch_from_tile(predicted, patch);
            let actual = patch_from_tile(current, patch);
            let expected =
                reconstructed_patch(coefficients_mut(&mut base, plane, patch), &predictor, steps);
            if actual != expected {
                return Err(EncodeError::InvalidInput);
            }
            coefficients_mut(&mut base, plane, patch)[coefficient] = change.old;
            let restored =
                reconstructed_patch(coefficients_mut(&mut base, plane, patch), &predictor, steps);
            let tile = if plane == 0 { &mut base_u } else { &mut base_v };
            store_patch::<8, 64>(tile, patch % 2, patch / 2, &restored);
        }
        let base_frame = display_rgb::Frame {
            tile_u: &base_u,
            tile_v: &base_v,
            ..*live
        };
        let mut moves = [Move::default(); MAX_MOVES];
        let mut move_count = 0;
        for plane in 0..2 {
            for patch in 0..4 {
                if !base_frame.has_affected_windows(patch % 2, patch / 2) {
                    continue;
                }
                let coefficients = if plane == 0 {
                    &base.u[patch]
                } else {
                    &base.v[patch]
                };
                let last = (1..16)
                    .rev()
                    .find(|&scan| coefficients[residual::SCAN[scan]] != 0)
                    .map(|scan| residual::SCAN[scan]);
                let mut positions = [Some(0), last, None, None];
                let mut low = 2;
                for scan in 1..16 {
                    let index = residual::SCAN[scan];
                    if Some(index) != last && coefficients[index] != 0 {
                        positions[low] = Some(index);
                        low += 1;
                        if low == positions.len() {
                            break;
                        }
                    }
                }
                for (slot, position) in positions.iter().enumerate() {
                    let Some(coefficient) = position else {
                        continue;
                    };
                    if positions[..slot].contains(position) {
                        continue;
                    }
                    let step = if *coefficient == 0 {
                        steps.dc
                    } else {
                        steps.ac
                    };
                    for direction in [-1, 1] {
                        if adjacent_level(coefficients[*coefficient], step, direction).is_none() {
                            continue;
                        }
                        moves[move_count] = Move {
                            plane: plane as u8,
                            patch: patch as u8,
                            coefficient: *coefficient as u8,
                            direction: direction as i8,
                        };
                        move_count += 1;
                    }
                }
            }
        }
        if move_count == 0 {
            return Ok(None);
        }
        let cache = display_rgb::LocalCache::new(&base_frame);
        let mut best = [RefinementChange {
            plane: 0,
            patch: 0,
            coefficient: 0,
            old: 0,
            new: 0,
        }; MAX_DEPTH];
        let mut best_len = 0;
        let mut best_gain = 0.0;
        if let Some((change, baseline_gain)) = baseline {
            // The mandatory selector already scored this exact one-edit trial.
            // Repeating it here would spend uncharged work before the quota.
            if baseline_gain > 0.0 {
                best[0] = change;
                best_len = 1;
                best_gain = baseline_gain;
            }
        }
        Ok(Some(Self {
            base,
            tile_y: *live.tile_y,
            base_u,
            base_v,
            predicted_u,
            predicted_v,
            cache,
            guard_rgb_ssd,
            moves,
            move_count,
            beam: [Path::default(); BEAM_WIDTH],
            beam_count: 1,
            next: [Path::default(); BEAM_WIDTH],
            next_count: 0,
            depth: 0,
            parent: 0,
            descriptor: 0,
            used: 0,
            quota,
            best,
            best_len,
            best_gain,
            done: false,
        }))
    }

    fn render_path(&self, path: Path, steps: Steps) -> Result<JointResult, EncodeError> {
        let mut block = self.base;
        let mut u = self.base_u;
        let mut v = self.base_v;
        let mut changes = self.best;
        for (slot, &move_index) in path.moves[..usize::from(path.len)].iter().enumerate() {
            let descriptor = self.moves[usize::from(move_index)];
            let plane = usize::from(descriptor.plane);
            let patch = usize::from(descriptor.patch);
            let coefficient = usize::from(descriptor.coefficient);
            let old = level(&block, plane, patch, coefficient);
            let step = if coefficient == 0 { steps.dc } else { steps.ac };
            let new = adjacent_level(old, step, i32::from(descriptor.direction))
                .ok_or(EncodeError::InvalidInput)?;
            let change = RefinementChange {
                plane: descriptor.plane,
                patch: descriptor.patch,
                coefficient: descriptor.coefficient,
                old,
                new,
            };
            apply_change(
                &mut block,
                &mut u,
                &mut v,
                &self.predicted_u,
                &self.predicted_v,
                steps,
                change,
            )?;
            changes[slot] = change;
        }
        Ok(JointResult {
            block,
            u,
            v,
            changes,
            len: usize::from(path.len),
        })
    }

    fn final_frontier_valid(
        &self,
        block: &Macroblock,
        u: &[u8; 64],
        v: &[u8; 64],
        right: bool,
        below: bool,
    ) -> bool {
        if block.skip() != self.base.skip() {
            return false;
        }
        for (base, trial, base_coefficients, trial_coefficients) in [
            (&self.base_u, u, &self.base.u, &block.u),
            (&self.base_v, v, &self.base.v, &block.v),
        ] {
            if right && (0..8).any(|row| base[row * 8 + 7] != trial[row * 8 + 7]) {
                return false;
            }
            if below && base[56..64] != trial[56..64] {
                return false;
            }
            for patch in 0..4 {
                if (right && patch % 2 == 1 || below && patch / 2 == 1)
                    && base_coefficients[patch].iter().any(|&value| value != 0)
                        != trial_coefficients[patch].iter().any(|&value| value != 0)
                {
                    return false;
                }
            }
        }
        true
    }

    fn consider_next(&mut self, path: Path) {
        if self.next[..self.next_count]
            .iter()
            .any(|old| old.move_set == path.move_set)
        {
            return;
        }
        if self.next_count < BEAM_WIDTH {
            self.next[self.next_count] = path;
            self.next_count += 1;
        } else if path.gain > self.next[self.next_count - 1].gain {
            self.next[self.next_count - 1] = path;
        } else {
            return;
        }
        if self.next_count == 2 && self.next[1].gain > self.next[0].gain {
            self.next.swap(0, 1);
        }
    }

    pub(super) fn step(
        &mut self,
        live: &display_rgb::Frame<'_>,
        steps: Steps,
        right: bool,
        below: bool,
    ) -> Result<(), EncodeError> {
        if self.done {
            return Ok(());
        }
        loop {
            if self.used == self.quota || self.depth == MAX_DEPTH || self.beam_count == 0 {
                self.done = true;
                return Ok(());
            }
            if self.parent == self.beam_count {
                self.beam = self.next;
                self.beam_count = self.next_count;
                self.next = [Path::default(); BEAM_WIDTH];
                self.next_count = 0;
                self.depth += 1;
                self.parent = 0;
                self.descriptor = 0;
                continue;
            }
            if self.descriptor == self.move_count {
                self.parent += 1;
                self.descriptor = 0;
                continue;
            }
            let index = self.descriptor;
            self.descriptor += 1;
            let descriptor = self.moves[index];
            let parent = self.beam[self.parent];
            if parent.positions & descriptor.position_bit() != 0 {
                continue;
            }
            self.used += 1;
            let path = parent.append(index, descriptor);
            let trial = self.render_path(path, steps)?;
            let base_frame = display_rgb::Frame {
                tile_y: &self.tile_y,
                tile_u: &self.base_u,
                tile_v: &self.base_v,
                ..*live
            };
            let gain = if self.guard_rgb_ssd {
                let score = self
                    .cache
                    .score_tiles_with_ssd(&base_frame, &trial.u, &trial.v, true);
                let Some(gain) = score.allowed_gain(true) else {
                    if self.used == self.quota {
                        self.done = true;
                    }
                    return Ok(());
                };
                gain
            } else {
                self.cache.score_tiles(&base_frame, &trial.u, &trial.v)
            };
            let path = Path { gain, ..path };
            if gain > self.best_gain
                && self.final_frontier_valid(&trial.block, &trial.u, &trial.v, right, below)
            {
                self.best_gain = gain;
                self.best_len = usize::from(path.len);
                self.best[..self.best_len].copy_from_slice(&trial.changes[..self.best_len]);
            }
            self.consider_next(path);
            if self.used == self.quota {
                self.done = true;
            }
            return Ok(());
        }
    }

    pub(super) fn result(&self, steps: Steps) -> Result<JointResult, EncodeError> {
        let mut block = self.base;
        let mut u = self.base_u;
        let mut v = self.base_v;
        for change in &self.best[..self.best_len] {
            apply_change(
                &mut block,
                &mut u,
                &mut v,
                &self.predicted_u,
                &self.predicted_v,
                steps,
                *change,
            )?;
        }
        Ok(JointResult {
            block,
            u,
            v,
            changes: self.best,
            len: self.best_len,
        })
    }

    pub(super) fn used(&self) -> usize {
        self.used
    }

    pub(super) fn quota(&self) -> usize {
        self.quota
    }

    pub(super) fn done(&self) -> bool {
        self.done
    }

    #[cfg(test)]
    pub(super) fn limit_for_test(&mut self, quota: usize) {
        assert!(quota <= EXTRA_PROPOSALS_PER_FRAME);
        assert_eq!(self.used, 0);
        self.quota = quota;
    }

    #[cfg(test)]
    pub(super) fn rgb_ssd_guard_enabled_for_test(&self) -> bool {
        self.guard_rgb_ssd
    }

    #[cfg(test)]
    pub(super) fn paths_have_distinct_positions(&self) -> bool {
        self.beam[..self.beam_count]
            .iter()
            .chain(self.next[..self.next_count].iter())
            .all(|path| {
                let mut positions = 0u128;
                for &move_index in &path.moves[..usize::from(path.len)] {
                    let bit = self.moves[usize::from(move_index)].position_bit();
                    if positions & bit != 0 {
                        return false;
                    }
                    positions |= bit;
                }
                positions == path.positions
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_quotas_charge_exactly_128_without_redistribution() {
        for count in [1, 2, 3, 5, 9, 127, 128, 129, 625, 40_280] {
            let mut sum = 0;
            for block in 0..count {
                let quota = extra_quota(block, count);
                assert!(quota <= EXTRA_PROPOSALS_PER_FRAME);
                sum += quota;
                assert_eq!(sum, (block + 1) * EXTRA_PROPOSALS_PER_FRAME / count);
            }
            assert_eq!(sum, EXTRA_PROPOSALS_PER_FRAME);
        }
        assert_eq!(extra_quota(0, 40_280), 0);
        assert_eq!(extra_quota(40_279, 40_280), 1);
    }

    #[test]
    fn beam_keeps_private_negative_intermediate_until_full_child_score() {
        let y = [128u8; 256];
        let uv = [128u8; 64];
        let dummy = [0u8; 16 * 16 * 3];
        let input = display_rgb::Frame {
            width: 16,
            height: 16,
            stride_y: 16,
            original: display_rgb::Original {
                pixels: &dummy,
                stride: 48,
                layout: 4,
            },
            source_y: &y,
            source_u: &uv,
            source_v: &uv,
            reconstructed_y: &y,
            reconstructed_u: &uv,
            reconstructed_v: &uv,
            tile_y: &y,
            tile_u: &uv,
            tile_v: &uv,
            mx: 0,
            my: 0,
        };
        let mut original = [0u8; 16 * 16 * 3];
        for py in 0..16 {
            for px in 0..16 {
                original[(py * 16 + px) * 3..][..3].copy_from_slice(&input.rendered(px, py, None));
            }
        }
        let frame = display_rgb::Frame {
            original: display_rgb::Original {
                pixels: &original,
                stride: 48,
                layout: 4,
            },
            ..input
        };
        let mut block = Macroblock::default();
        block.y[0][0] = 1; // Keep the base unskipped while testing UV beam behavior.
        let steps = ac_quant::steps(32, Deltas::default(), Plane::UV);
        let mut search = JointSearch::new(&frame, &block, None, [&uv, &uv], steps, 128, false)
            .unwrap()
            .unwrap();
        let first_depth = search.move_count;
        assert!(first_depth >= 4);
        for _ in 0..first_depth {
            search.step(&frame, steps, false, false).unwrap();
        }
        assert_eq!(search.used, first_depth);
        assert_eq!(search.next_count, 2);
        assert!(search.next[..2].iter().all(|path| path.gain < 0.0));
        assert_eq!(search.best_len, 0);
        search.step(&frame, steps, false, false).unwrap();
        assert_eq!(search.used, first_depth + 1);
        assert_eq!(search.depth, 1);
        assert!(search.paths_have_distinct_positions());

        // The same moves remain charged, but a baseline matching the source
        // cannot admit a changed RGB sample with higher source error.
        let mut guarded = JointSearch::new(&frame, &block, None, [&uv, &uv], steps, 128, true)
            .unwrap()
            .unwrap();
        assert_eq!(guarded.move_count, first_depth);
        let first = Path::default().append(0, guarded.moves[0]);
        let first_result = guarded.render_path(first, steps).unwrap();
        assert!(
            guarded
                .cache
                .score_tiles_with_ssd(&frame, &first_result.u, &first_result.v, true)
                .rgb_ssd_delta
                > 0
        );
        guarded.step(&frame, steps, false, false).unwrap();
        assert_eq!(guarded.next_count, 0);
        for _ in 1..first_depth {
            guarded.step(&frame, steps, false, false).unwrap();
        }
        assert_eq!(guarded.used, first_depth);
        for path in &guarded.next[..guarded.next_count] {
            let result = guarded.render_path(*path, steps).unwrap();
            assert_eq!(
                guarded
                    .cache
                    .score_tiles_with_ssd(&frame, &result.u, &result.v, true)
                    .rgb_ssd_delta,
                0
            );
        }
        assert_eq!(guarded.best_len, 0);
    }
}
