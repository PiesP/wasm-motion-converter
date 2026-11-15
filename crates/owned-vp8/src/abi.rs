// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Checked ABI2 ownership. A caller ends each physical write before begin/release.

use crate::limits::{Request, ResourcePlan, Status, ABI_VERSION};
use crate::textured::FrameEncoder;
use std::sync::Mutex;

const WORKING: u32 = 10;
const OUTPUT_READY: u32 = 11;
const REQUEST_WORDS: usize = 12;
const RESPONSE_WORDS: usize = 24;
static ZERO_CHUNK: [u8; 65_536] = [0; 65_536];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
enum Phase {
    Idle = 0,
    Planned = 1,
    Reserving = 2,
    InputLease = 3,
    Encoding = 4,
    OutputLease = 5,
    Retired = 6,
}

struct State {
    request: [u32; REQUEST_WORDS],
    response: [u32; RESPONSE_WORDS],
    phase: Phase,
    generation: u32,
    frame: u32,
    input: Vec<u8>,
    plan: Option<ResourcePlan>,
    frozen_request: Option<Request>,
    job: Option<FrameEncoder>,
    cancelled: bool,
    retire_requested: bool,
}

impl State {
    const fn new() -> Self {
        Self {
            request: [0; REQUEST_WORDS],
            response: [0; RESPONSE_WORDS],
            phase: Phase::Idle,
            generation: 0,
            frame: 0,
            input: Vec::new(),
            plan: None,
            frozen_request: None,
            job: None,
            cancelled: false,
            retire_requested: false,
        }
    }

    fn request_record(&self) -> Request {
        let r = self.request;
        Request {
            version: r[0],
            width: r[1],
            height: r[2],
            stride: r[3],
            layout: r[4],
            quality: r[5],
            input_bytes: r[6],
            output_limit: r[7],
            generation: r[8],
            frame: r[9],
            external_live_bytes: r[10],
            retained_output_bytes: r[11],
        }
    }

    fn current(&self, generation: u32, frame: u32) -> Result<(), Status> {
        if generation == 0 || generation != self.generation || frame == 0 || frame != self.frame {
            return Err(Status::StaleTicket);
        }
        Ok(())
    }

    fn refresh(&mut self, status: u32) -> u32 {
        let mut result = [0; RESPONSE_WORDS];
        result[0] = ABI_VERSION;
        result[1] = status;
        result[2] = self.phase as u32;
        result[3] = self.generation;
        result[4] = self.frame;
        result[9] = memory_capacity();
        if let Some(plan) = self.plan {
            result[10] = plan.linear_capacity_bytes;
            result[11] = plan.aggregate_bytes;
            result[15] = plan.padded_width;
            result[16] = plan.padded_height;
            result[17] = plan.macroblock_count;
            result[18] = plan.frame_bytes;
            result[19] = plan.host_output_copy_bytes;
        }
        if matches!(status, 0 | WORKING | OUTPUT_READY)
            && self.phase == Phase::InputLease
            && !self.cancelled
        {
            result[5] = self.input.as_ptr() as u32;
            result[6] = self.input.len() as u32;
        }
        if let Some(job) = &self.job {
            result[12] = job.stage();
            (result[13], result[14]) = job.progress();
            if matches!(status, 0 | WORKING | OUTPUT_READY)
                && self.phase == Phase::OutputLease
                && !self.cancelled
            {
                let output = job.output();
                result[7] = output.as_ptr() as u32;
                result[8] = output.len() as u32;
            }
        } else if self.phase == Phase::Reserving {
            result[13] = self.input.len() as u32;
            result[14] = self.frozen_request.map_or(0, |r| r.input_bytes);
        }
        self.response = result;
        status
    }

    fn checked_capacity(&self) -> Result<(), Status> {
        let capacity = memory_capacity();
        if capacity != 0 {
            self.plan
                .ok_or(Status::AbiMismatch)?
                .admit_actual_capacity(capacity)?;
        }
        Ok(())
    }

    fn plan(&mut self) -> Result<u32, Status> {
        if self.phase != Phase::Idle || self.retire_requested {
            return Err(Status::BusyLease);
        }
        let request = self.request_record();
        let mut plan = ResourcePlan::checked(request)?;
        if (self.generation != 0 && request.generation != self.generation)
            || request.frame <= self.frame
        {
            return Err(Status::StaleTicket);
        }
        let capacity = memory_capacity();
        if capacity != 0 {
            plan = plan.with_capacity_floor(capacity)?;
        }
        self.generation = request.generation;
        self.frame = request.frame;
        self.cancelled = false;
        self.plan = Some(plan);
        self.frozen_request = Some(request);
        self.phase = Phase::Planned;
        Ok(Status::Ok as u32)
    }

    fn reserve_step(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        if self.cancelled {
            return Err(Status::Cancelled);
        }
        if !matches!(self.phase, Phase::Planned | Phase::Reserving) {
            return Err(Status::BusyLease);
        }
        let length = self.frozen_request.ok_or(Status::AbiMismatch)?.input_bytes as usize;
        if self.phase == Phase::Planned {
            // A differently sized frame never keeps an uncharged old reservation.
            if self.input.capacity() != length {
                self.input = Vec::new();
            }
            self.input.clear();
            self.input
                .try_reserve_exact(length)
                .map_err(|_| Status::MemoryAdmission)?;
            let capacity =
                u32::try_from(self.input.capacity()).map_err(|_| Status::MemoryAdmission)?;
            self.plan = Some(
                self.plan
                    .ok_or(Status::AbiMismatch)?
                    .with_input_capacity(capacity)?,
            );
            self.phase = Phase::Reserving;
        }
        let count = (length - self.input.len()).min(ZERO_CHUNK.len());
        self.input.extend_from_slice(&ZERO_CHUNK[..count]);
        self.checked_capacity()?;
        if self.input.len() == length {
            self.phase = Phase::InputLease;
            Ok(Status::Ok as u32)
        } else {
            Ok(WORKING)
        }
    }

    fn begin(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        if self.cancelled {
            return Err(Status::Cancelled);
        }
        if self.phase != Phase::InputLease {
            return Err(Status::BusyLease);
        }
        let request = self.frozen_request.ok_or(Status::AbiMismatch)?;
        let plan = self.plan.ok_or(Status::AbiMismatch)?;
        let input = std::mem::take(&mut self.input);
        // `begin` is the host's acknowledgement that the input write settled.
        // The caller must not retain a writable destination lease afterward.
        self.phase = Phase::Encoding;
        self.job = match FrameEncoder::new(request, input, plan) {
            Ok(job) => Some(job),
            Err(status) => {
                self.retire();
                return Err(status);
            }
        };
        if let Err(status) = self.checked_capacity() {
            self.retire();
            return Err(status);
        }
        Ok(WORKING)
    }

    fn step(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        if self.cancelled {
            return Err(Status::Cancelled);
        }
        if self.phase != Phase::Encoding {
            return Err(Status::BusyLease);
        }
        let job = self.job.as_mut().ok_or(Status::AbiMismatch)?;
        let done = match job.step() {
            Ok(done) => done,
            Err(status) => {
                self.retire();
                return Err(status);
            }
        };
        self.plan = Some(self.job.as_ref().ok_or(Status::AbiMismatch)?.plan());
        if let Err(status) = self.checked_capacity() {
            self.retire();
            return Err(status);
        }
        if done {
            self.phase = Phase::OutputLease;
            Ok(OUTPUT_READY)
        } else {
            Ok(WORKING)
        }
    }

    fn release_input(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        if self.phase != Phase::InputLease {
            return Err(Status::BusyLease);
        }
        // Used after an aborted pending input write has physically settled.
        self.input.clear();
        self.finish_frame();
        Ok(Status::Ok as u32)
    }

    fn release_output(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        if self.phase != Phase::OutputLease {
            return Err(Status::BusyLease);
        }
        if let Some(mut job) = self.job.take() {
            self.input = job.take_input();
        }
        self.input.clear();
        self.finish_frame();
        Ok(Status::Ok as u32)
    }

    fn finish_frame(&mut self) {
        self.job = None;
        self.plan = None;
        self.frozen_request = None;
        self.cancelled = false;
        self.phase = if self.retire_requested {
            Phase::Retired
        } else {
            Phase::Idle
        };
        if self.retire_requested {
            self.input = Vec::new();
        }
    }

    fn abort(&mut self, generation: u32, frame: u32) -> Result<u32, Status> {
        self.current(generation, frame)?;
        self.cancelled = true;
        if matches!(self.phase, Phase::InputLease | Phase::OutputLease) {
            // Keep every leased byte allocated/stable until the explicit release.
            return Ok(Status::Cancelled as u32);
        }
        if let Some(mut job) = self.job.take() {
            self.input = job.take_input();
        }
        self.input.clear();
        self.finish_frame();
        Ok(Status::Cancelled as u32)
    }

    fn retire(&mut self) -> u32 {
        self.retire_requested = true;
        if !matches!(self.phase, Phase::InputLease | Phase::OutputLease) {
            self.finish_frame();
        } else {
            self.cancelled = true;
        }
        Status::Ok as u32
    }
}

fn capacity_word(pages: u64) -> u32 {
    pages
        .checked_mul(65_536)
        .and_then(|bytes| u32::try_from(bytes).ok())
        .unwrap_or(u32::MAX)
}
#[cfg(target_arch = "wasm32")]
fn memory_capacity() -> u32 {
    capacity_word(core::arch::wasm32::memory_size::<0>() as u64)
}
#[cfg(not(target_arch = "wasm32"))]
fn memory_capacity() -> u32 {
    capacity_word(0)
}

static STATE: Mutex<State> = Mutex::new(State::new());

fn access(operation: impl FnOnce(&mut State) -> Result<u32, Status>) -> u32 {
    match STATE.lock() {
        Ok(mut state) => {
            let status = operation(&mut state).unwrap_or_else(|error| error as u32);
            state.refresh(status)
        }
        Err(_) => Status::AbiMismatch as u32,
    }
}

#[no_mangle]
pub extern "C" fn vp8_v2_abi_version() -> u32 {
    ABI_VERSION
}
#[no_mangle]
pub extern "C" fn vp8_v2_request_ptr() -> u32 {
    STATE
        .lock()
        .map_or(0, |mut s| s.request.as_mut_ptr() as u32)
}
#[no_mangle]
pub extern "C" fn vp8_v2_response_ptr() -> u32 {
    STATE.lock().map_or(0, |s| s.response.as_ptr() as u32)
}
#[no_mangle]
pub extern "C" fn vp8_v2_plan() -> u32 {
    access(State::plan)
}
#[no_mangle]
pub extern "C" fn vp8_v2_reserve_step(generation: u32, frame: u32) -> u32 {
    access(|s| s.reserve_step(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_begin(generation: u32, frame: u32) -> u32 {
    access(|s| s.begin(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_step(generation: u32, frame: u32) -> u32 {
    access(|s| s.step(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_abort(generation: u32, frame: u32) -> u32 {
    access(|s| s.abort(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_release_input(generation: u32, frame: u32) -> u32 {
    access(|s| s.release_input(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_release_output(generation: u32, frame: u32) -> u32 {
    access(|s| s.release_output(generation, frame))
}
#[no_mangle]
pub extern "C" fn vp8_v2_retire() -> u32 {
    access(|s| Ok(s.retire()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_ticket_and_abort_at_refinement_count_replay_and_release_recover() {
        let (width, height) = (33usize, 33usize);
        let input: Vec<u8> = (0..height)
            .flat_map(|y| {
                (0..width).flat_map(move |x| {
                    let gray = 48 + (x * 9 + y * 13 + (x * y % 7) * 3) % 160;
                    [
                        (gray + (x * 5 + y * 3) % 17) as u8,
                        gray as u8,
                        (gray - (x * 3 + y * 7) % 13) as u8,
                        255,
                    ]
                })
            })
            .collect();
        let joint_input: Vec<u8> = (0..5)
            .flat_map(|x| {
                let rgb = if (3 * x) % 4 == 0 {
                    [244, 29, 171]
                } else if (2 * x) & 1 != 0 {
                    [35, 227, 91]
                } else {
                    [89, 61, 239]
                };
                [rgb[0], rgb[1], rgb[2], 255]
            })
            .collect();
        for target in [36, 37, 38, 39, 40, 27, 29, 28, 35] {
            let mut reached = false;
            let joint = (37..=40).contains(&target);
            let (case_width, case_height, case_input, qualities): (usize, usize, &[u8], &[u32]) =
                if joint {
                    (5, 1, &joint_input, &[85])
                } else {
                    (width, height, &input, &[60, 75, 85])
                };
            for &quality in qualities {
                let mut state = State::new();
                state.request = [
                    2,
                    case_width as u32,
                    case_height as u32,
                    (case_width * 4) as u32,
                    0,
                    quality,
                    case_input.len() as u32,
                    1_048_576,
                    41,
                    1,
                    case_input.len() as u32,
                    0,
                ];
                assert_eq!(state.plan(), Ok(0));
                reserve(&mut state);
                state.input.copy_from_slice(case_input);
                assert_eq!(state.begin(41, 1), Ok(WORKING));
                for _ in 0..4096 {
                    if state.job.as_ref().unwrap().stage() == target {
                        reached = true;
                        assert_eq!(state.step(41, 2), Err(Status::StaleTicket));
                        assert_eq!(state.job.as_ref().unwrap().stage(), target);
                        assert!(state.job.as_ref().unwrap().output().is_empty());
                        assert_eq!(state.abort(41, 1), Ok(Status::Cancelled as u32));
                        assert_eq!(state.phase, Phase::Idle);
                        assert!(state.job.is_none());
                        state.request = [2, 16, 16, 64, 0, 75, 1024, 1_048_576, 41, 2, 1024, 0];
                        assert_eq!(state.plan(), Ok(0));
                        ready(&mut state);
                        assert_eq!(state.phase, Phase::OutputLease);
                        assert_eq!(state.release_output(41, 2), Ok(0));
                        break;
                    }
                    if state.step(41, 1).unwrap() == OUTPUT_READY {
                        break;
                    }
                }
                if reached {
                    break;
                }
            }
            assert!(reached, "stage={target}");
        }
    }

    #[test]
    fn capacity_conversion_never_turns_4gib_into_an_unchecked_zero() {
        assert_eq!(capacity_word(18), 18 * 65_536);
        assert_eq!(capacity_word(3072), 192 * 1024 * 1024);
        assert_eq!(capacity_word(65_536), u32::MAX);
        assert_eq!(capacity_word(u64::MAX), u32::MAX);
    }

    fn planned(bytes: u32) -> State {
        let mut state = State::new();
        state.request = [2, 16, 16, 64, 0, 75, bytes, 1_048_576, 41, 1, 1024, 0];
        assert_eq!(state.plan(), Ok(0));
        state
    }

    fn reserve(state: &mut State) {
        for _ in 0..4096 {
            let status = state.reserve_step(41, state.frame).unwrap();
            if status == 0 {
                assert_eq!(state.phase, Phase::InputLease);
                return;
            }
            assert_eq!(status, WORKING);
        }
        panic!("input reservation did not finish within its byte bound");
    }

    fn ready(state: &mut State) {
        reserve(state);
        for pixel in state.input.as_chunks_mut::<4>().0 {
            *pixel = [128, 128, 128, 255];
        }
        assert_eq!(state.begin(41, state.frame), Ok(WORKING));
        for _ in 0..4096 {
            let status = state.step(41, state.frame).unwrap();
            if status == OUTPUT_READY {
                return;
            }
            assert_eq!(status, WORKING);
        }
        panic!("tiny frame did not finish within the stage bound");
    }

    #[test]
    fn planned_request_is_frozen_and_initialization_is_bounded() {
        let mut state = planned(131_072);
        // The externally writable request record cannot enlarge an admitted copy.
        state.request[6] = u32::MAX;
        state.request[8] = 999;
        assert_eq!(state.reserve_step(41, 1), Ok(WORKING));
        assert_eq!(state.input.len(), 65_536);
        assert_eq!(state.reserve_step(41, 1), Ok(0));
        assert_eq!(state.input.len(), 131_072);
        assert_eq!(state.generation, 41);
    }

    #[test]
    fn cancelled_pending_input_and_retirement_keep_the_lease_stable() {
        let mut state = planned(1024);
        reserve(&mut state);
        let pointer = state.input.as_ptr();
        let capacity = state.input.capacity();
        assert_eq!(state.abort(41, 1), Ok(Status::Cancelled as u32));
        assert_eq!(state.plan(), Err(Status::BusyLease));
        assert_eq!(state.begin(41, 1), Err(Status::Cancelled));
        assert_eq!(state.retire(), 0);
        assert_eq!(state.input.as_ptr(), pointer);
        assert_eq!(state.input.capacity(), capacity);
        assert_eq!(state.phase, Phase::InputLease);
        assert_eq!(state.release_input(41, 1), Ok(0));
        assert_eq!(state.phase, Phase::Retired);
        assert_eq!(state.input.capacity(), 0);
    }

    #[test]
    fn output_lease_blocks_mutation_and_old_tickets_cannot_release_new_work() {
        let mut state = planned(1024);
        ready(&mut state);
        let job = state.job.as_ref().unwrap();
        let pointer = job.output().as_ptr();
        let bytes = job.output().to_vec();
        state.refresh(Status::StaleTicket as u32);
        assert_eq!(state.response[7], 0);
        assert_eq!(state.response[8], 0);
        assert_eq!(state.plan(), Err(Status::BusyLease));
        assert_eq!(state.step(41, 1), Err(Status::BusyLease));
        assert_eq!(state.abort(41, 1), Ok(Status::Cancelled as u32));
        assert_eq!(state.job.as_ref().unwrap().output().as_ptr(), pointer);
        assert_eq!(state.job.as_ref().unwrap().output(), bytes);
        state.refresh(Status::Cancelled as u32);
        assert_eq!(state.response[7], 0);
        assert_eq!(state.response[8], 0);
        assert_eq!(state.release_output(41, 1), Ok(0));
        state.request = [2, 16, 16, 64, 0, 75, 1024, 1_048_576, 41, 2, 1024, 0];
        assert_eq!(state.plan(), Ok(0));
        assert_eq!(state.release_output(41, 1), Err(Status::StaleTicket));
        ready(&mut state);
        assert_eq!(state.job.as_ref().unwrap().output(), bytes);
        assert_eq!(state.release_output(41, 2), Ok(0));
    }

    #[test]
    fn constructor_and_active_pixel_errors_retire_without_stale_publication() {
        let mut state = planned(1024);
        reserve(&mut state);
        // Exercise a fallible constructor without relying on an actual OOM.
        let mut oversized = Vec::with_capacity(2048);
        oversized.resize(1024, 0);
        state.input = oversized;
        assert_eq!(state.begin(41, 1), Err(Status::MemoryAdmission));
        assert_eq!(state.phase, Phase::Retired);
        assert!(state.job.is_none());

        let mut state = planned(1024);
        reserve(&mut state);
        // Alpha is checked in bounded color steps; zero is nonopaque.
        assert_eq!(state.begin(41, 1), Ok(WORKING));
        for _ in 0..100 {
            match state.step(41, 1) {
                Ok(WORKING) => {}
                Err(Status::UnsupportedPixels) => {
                    assert_eq!(state.phase, Phase::Retired);
                    state.refresh(Status::UnsupportedPixels as u32);
                    assert_eq!(state.response[7], 0);
                    return;
                }
                other => panic!("unexpected pixel-validation outcome {other:?}"),
            }
        }
        panic!("nonopacity was not rejected");
    }
}
