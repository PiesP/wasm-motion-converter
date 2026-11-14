// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Admission arithmetic for issue #501 ABI2. Product ceilings are defined in
// src/utils/constants.ts; the frozen comparison is in issue #501's M0 contract.

const MIB: u64 = 1024 * 1024;
const PAGE: u64 = 65_536;
pub(crate) const ABI_VERSION: u32 = 2;
pub(crate) const MAX_DIMENSION: u64 = 16_383;
pub(crate) const MAX_PIXELS: u64 = 10_066_329;
pub(crate) const MAX_LINEAR_BYTES: u64 = 192 * MIB;
pub(crate) const MAX_FRAME_LIVE_BYTES: u64 = 192 * MIB;
pub(crate) const MAX_OUTPUT_BYTES: u64 = 96 * MIB;
pub(crate) const DEMUX_RESERVE_BYTES: u64 = 128 * MIB;
pub(crate) const CONVERSION_BUDGET_BYTES: u64 = 512 * MIB;
const SCRATCH_ALLOWANCE_BYTES: u64 = 8 * MIB;
const MACROBLOCK_RECORD_BYTES: u64 = 832;
const MACROBLOCK_CONTEXT_BYTES: u64 = 32;
const MAX_FIRST_PARTITION_BYTES: u64 = 0x7ffff;

/// ABI2 request, twelve little-endian fixed-width words in linear memory.
/// `input_bytes` is the entire copied reservation, including any row padding.
/// `external_live_bytes` excludes the WASM linear memory but includes the host
/// source, pending native frames and other concurrently live frame bytes.
/// `retained_output_bytes` covers previously retained encoded output.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub layout: u32,
    pub quality: u32,
    pub input_bytes: u32,
    pub output_limit: u32,
    pub generation: u32,
    pub frame: u32,
    pub external_live_bytes: u32,
    pub retained_output_bytes: u32,
}

// Values are stable ABI outcomes; the state machine supplies stale, busy and
// cancellation outcomes after checking tickets and output leases.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Ok = 0,
    InvalidInput = 1,
    UnsupportedLayout = 2,
    MemoryAdmission = 3,
    OutputLimit = 4,
    PartitionLimit = 5,
    AbiMismatch = 6,
    StaleTicket = 7,
    BusyLease = 8,
    Cancelled = 9,
    UnsupportedPixels = 12,
}

/// All byte fields fit ABI2 u32 records. Capacity includes the slots listed in
/// `linear_live_bytes`; aggregate accounting charges capacity once, never adds
/// those inner slots again. The final host copy is charged separately.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResourcePlan {
    pub padded_width: u32,
    pub padded_height: u32,
    pub macroblock_count: u32,
    pub input_extent: u32,
    pub input_reservation_bytes: u32,
    pub yuv_plane_set_bytes: u32,
    pub coefficient_bytes: u32,
    pub context_bytes: u32,
    pub scratch_allowance_bytes: u32,
    pub first_partition_bytes: u32,
    pub coefficient_partition_bytes: u32,
    pub frame_bytes: u32,
    pub host_output_copy_bytes: u32,
    pub linear_live_bytes: u32,
    pub linear_capacity_bytes: u32,
    pub aggregate_bytes: u32,
    request: Request,
}

fn add(a: u64, b: u64) -> Result<u64, Status> {
    a.checked_add(b).ok_or(Status::MemoryAdmission)
}

fn multiply(a: u64, b: u64) -> Result<u64, Status> {
    a.checked_mul(b).ok_or(Status::MemoryAdmission)
}

fn word(bytes: u64) -> Result<u32, Status> {
    u32::try_from(bytes).map_err(|_| Status::MemoryAdmission)
}

fn page_capacity(bytes: u64) -> Result<u64, Status> {
    Ok(add(bytes, PAGE - 1)? / PAGE * PAGE)
}

impl ResourcePlan {
    /// No allocation or media access occurs before this admission decision.
    pub(crate) fn checked(request: Request) -> Result<Self, Status> {
        if request.version != ABI_VERSION {
            return Err(Status::AbiMismatch);
        }
        let bytes_per_pixel: u64 = match request.layout {
            0..=3 => 4, // RGBA, BGRA, RGBX, BGRX
            4 => 3,     // packed RGB
            _ => return Err(Status::UnsupportedLayout),
        };
        let width = u64::from(request.width);
        let height = u64::from(request.height);
        let stride = u64::from(request.stride);
        if width == 0
            || height == 0
            || width > MAX_DIMENSION
            || height > MAX_DIMENSION
            || request.generation == 0
            || request.frame == 0
            || !matches!(request.quality, 60 | 75 | 85)
        {
            return Err(Status::InvalidInput);
        }
        if multiply(width, height)? > MAX_PIXELS {
            return Err(Status::MemoryAdmission);
        }
        let row_bytes = multiply(width, bytes_per_pixel)?;
        if stride < row_bytes {
            return Err(Status::InvalidInput);
        }
        let input_extent = add(multiply(height - 1, stride)?, row_bytes)?;
        if input_extent > u64::from(request.input_bytes) || request.input_bytes == 0 {
            return Err(Status::InvalidInput);
        }
        if u64::from(request.input_bytes) > MAX_FRAME_LIVE_BYTES
            || u64::from(request.external_live_bytes) > MAX_FRAME_LIVE_BYTES
            || u64::from(request.retained_output_bytes) > MAX_OUTPUT_BYTES
        {
            return Err(Status::MemoryAdmission);
        }
        if request.output_limit == 0 || u64::from(request.output_limit) > MAX_OUTPUT_BYTES {
            return Err(Status::OutputLimit);
        }
        let padded_width = add(width, 15)? & !15;
        let padded_height = add(height, 15)? & !15;
        let padded_pixels = multiply(padded_width, padded_height)?;
        // Y + U + V at 4:2:0, with both source and unfiltered reconstruction
        // live during analysis. Padding makes each plane extent integral.
        let yuv_set = multiply(padded_pixels, 3)? / 2;
        let macroblocks = multiply(padded_width / 16, padded_height / 16)?;
        let coefficients = multiply(macroblocks, MACROBLOCK_RECORD_BYTES)?;
        let contexts = multiply(macroblocks, MACROBLOCK_CONTEXT_BYTES)?;
        let linear_live = [
            u64::from(request.input_bytes),
            yuv_set,
            yuv_set,
            coefficients,
            contexts,
            SCRATCH_ALLOWANCE_BYTES,
        ]
        .into_iter()
        .try_fold(0u64, add)?;
        let capacity = page_capacity(linear_live)?;
        if capacity > MAX_LINEAR_BYTES {
            return Err(Status::MemoryAdmission);
        }
        let aggregate = add(
            add(DEMUX_RESERVE_BYTES, u64::from(request.external_live_bytes))?,
            add(u64::from(request.retained_output_bytes), capacity)?,
        )?;
        if aggregate > CONVERSION_BUDGET_BYTES {
            return Err(Status::MemoryAdmission);
        }
        Ok(Self {
            padded_width: word(padded_width)?,
            padded_height: word(padded_height)?,
            macroblock_count: word(macroblocks)?,
            input_extent: word(input_extent)?,
            input_reservation_bytes: request.input_bytes,
            yuv_plane_set_bytes: word(yuv_set)?,
            coefficient_bytes: word(coefficients)?,
            context_bytes: word(contexts)?,
            scratch_allowance_bytes: word(SCRATCH_ALLOWANCE_BYTES)?,
            first_partition_bytes: 0,
            coefficient_partition_bytes: 0,
            frame_bytes: 0,
            host_output_copy_bytes: 0,
            linear_live_bytes: word(linear_live)?,
            linear_capacity_bytes: word(capacity)?,
            aggregate_bytes: word(aggregate)?,
            request,
        })
    }

    /// A reused instance retains its prior linear-memory pages. Admit those
    /// pages before accepting a new frame, even if this frame needs fewer slots.
    pub(crate) fn with_capacity_floor(mut self, existing_actual: u32) -> Result<Self, Status> {
        if existing_actual != 0 && u64::from(existing_actual) % PAGE != 0 {
            return Err(Status::MemoryAdmission);
        }
        let capacity = u64::from(self.linear_capacity_bytes.max(existing_actual));
        if capacity > MAX_LINEAR_BYTES {
            return Err(Status::MemoryAdmission);
        }
        let aggregate = add(
            add(
                DEMUX_RESERVE_BYTES,
                u64::from(self.request.external_live_bytes),
            )?,
            add(u64::from(self.request.retained_output_bytes), capacity)?,
        )?;
        if aggregate > CONVERSION_BUDGET_BYTES {
            return Err(Status::MemoryAdmission);
        }
        self.linear_capacity_bytes = word(capacity)?;
        self.aggregate_bytes = word(aggregate)?;
        Ok(self)
    }

    /// Finalized partition sizes are admitted before their storage is exposed.
    /// Both partition buffers and final frame remain live during assembly. This
    /// also reserves a separate host copy for the mux ownership handoff.
    pub(crate) fn with_output_sizes(
        self,
        first_partition: u32,
        coefficient_partition: u32,
    ) -> Result<Self, Status> {
        if first_partition == 0 || u64::from(first_partition) > MAX_FIRST_PARTITION_BYTES {
            return Err(Status::PartitionLimit);
        }
        if coefficient_partition == 0 {
            return Err(Status::PartitionLimit);
        }
        let output = add(
            add(10, u64::from(first_partition))?,
            u64::from(coefficient_partition),
        )?;
        if output > u64::from(self.request.output_limit) || output > MAX_OUTPUT_BYTES {
            return Err(Status::OutputLimit);
        }
        let previous_outputs = u64::from(self.first_partition_bytes)
            + u64::from(self.coefficient_partition_bytes)
            + u64::from(self.frame_bytes);
        let base = u64::from(self.linear_live_bytes)
            .checked_sub(previous_outputs)
            .ok_or(Status::MemoryAdmission)?;
        let linear_live = add(
            base,
            add(
                add(u64::from(first_partition), u64::from(coefficient_partition))?,
                output,
            )?,
        )?;
        let capacity = page_capacity(linear_live)?.max(u64::from(self.linear_capacity_bytes));
        if capacity > MAX_LINEAR_BYTES {
            return Err(Status::MemoryAdmission);
        }
        let aggregate = add(
            add(
                DEMUX_RESERVE_BYTES,
                u64::from(self.request.external_live_bytes),
            )?,
            add(
                add(u64::from(self.request.retained_output_bytes), capacity)?,
                output,
            )?,
        )?;
        if aggregate > CONVERSION_BUDGET_BYTES {
            return Err(Status::MemoryAdmission);
        }
        Ok(Self {
            first_partition_bytes: first_partition,
            coefficient_partition_bytes: coefficient_partition,
            frame_bytes: word(output)?,
            host_output_copy_bytes: word(output)?,
            linear_live_bytes: word(linear_live)?,
            linear_capacity_bytes: word(capacity)?,
            aggregate_bytes: word(aggregate)?,
            ..self
        })
    }

    /// Recheck observed WebAssembly.Memory capacity after allocation or growth.
    /// The projected capacity is a pre-admitted upper reservation, not a lower
    /// bound on actual allocation. Charge the full projection in the aggregate;
    /// the caller must measure capacity at bounded stage boundaries. This does
    /// not prove Rust allocator use or browser/GPU process peak.
    pub(crate) fn admit_actual_capacity(self, actual_capacity: u32) -> Result<(), Status> {
        let actual = u64::from(actual_capacity);
        let projected = u64::from(self.linear_capacity_bytes);
        if actual == 0 || actual % PAGE != 0 || actual > projected {
            return Err(Status::MemoryAdmission);
        }
        let aggregate = add(
            add(
                DEMUX_RESERVE_BYTES,
                u64::from(self.request.external_live_bytes),
            )?,
            add(
                add(u64::from(self.request.retained_output_bytes), projected)?,
                u64::from(self.host_output_copy_bytes),
            )?,
        )?;
        if projected > MAX_LINEAR_BYTES || aggregate > CONVERSION_BUDGET_BYTES {
            return Err(Status::MemoryAdmission);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(width: u32, height: u32, layout: u32) -> Request {
        let bpp = if layout == 4 { 3 } else { 4 };
        Request {
            version: ABI_VERSION,
            width,
            height,
            stride: width * bpp,
            layout,
            quality: 75,
            input_bytes: width * height * bpp,
            output_limit: MAX_OUTPUT_BYTES as u32,
            generation: 1,
            frame: 1,
            external_live_bytes: 0,
            retained_output_bytes: 0,
        }
    }

    #[test]
    fn fixed_width_abi_and_admitted_geometry() {
        assert_eq!(std::mem::size_of::<Request>(), 48);
        assert_eq!(std::mem::align_of::<Request>(), 4);
        assert_eq!(Status::Ok as u32, 0);
        assert_eq!(Status::Cancelled as u32, 9);
        assert_eq!(Status::StaleTicket as u32, 7);
        assert_eq!(Status::BusyLease as u32, 8);
        for remainder in 0..16 {
            let p = ResourcePlan::checked(request(32 + remainder, 33, 0)).unwrap();
            assert_eq!(p.padded_width, (32 + remainder + 15) & !15);
            assert_eq!(p.padded_height, 48);
            assert!(p.input_extent <= p.input_reservation_bytes);
            assert_eq!(p.linear_capacity_bytes % PAGE as u32, 0);
            assert!(u64::from(p.aggregate_bytes) <= CONVERSION_BUDGET_BYTES);
        }
        for (width, height, layout) in [(1, 1, 0), (1, 16383, 4), (16383, 1, 0), (4096, 2457, 1)] {
            let p = ResourcePlan::checked(request(width, height, layout)).unwrap();
            assert!(p.macroblock_count > 0);
            assert!(p.linear_capacity_bytes <= MAX_LINEAR_BYTES as u32);
            assert!(p.admit_actual_capacity(p.linear_capacity_bytes).is_ok());
        }
    }

    #[test]
    fn rejects_malformed_records_and_output_limits() {
        let base = request(17, 13, 0);
        let variants = [
            (Request { version: 1, ..base }, Status::AbiMismatch),
            (Request { layout: 99, ..base }, Status::UnsupportedLayout),
            (Request { width: 0, ..base }, Status::InvalidInput),
            (
                Request {
                    generation: 0,
                    ..base
                },
                Status::InvalidInput,
            ),
            (Request { frame: 0, ..base }, Status::InvalidInput),
            (
                Request {
                    quality: 74,
                    ..base
                },
                Status::InvalidInput,
            ),
            (Request { stride: 67, ..base }, Status::InvalidInput),
            (
                Request {
                    input_bytes: 883,
                    ..base
                },
                Status::InvalidInput,
            ),
            (
                Request {
                    stride: u32::MAX,
                    ..base
                },
                Status::InvalidInput,
            ),
            (
                Request {
                    width: 16384,
                    ..base
                },
                Status::InvalidInput,
            ),
            (
                Request {
                    output_limit: 0,
                    ..base
                },
                Status::OutputLimit,
            ),
            (
                Request {
                    output_limit: 96 * MIB as u32 + 1,
                    ..base
                },
                Status::OutputLimit,
            ),
            (
                Request {
                    retained_output_bytes: 96 * MIB as u32 + 1,
                    ..base
                },
                Status::MemoryAdmission,
            ),
            (
                Request {
                    external_live_bytes: 192 * MIB as u32 + 1,
                    ..base
                },
                Status::MemoryAdmission,
            ),
        ];
        for (record, expected) in variants {
            assert_eq!(ResourcePlan::checked(record), Err(expected), "{record:?}");
        }
        let plan = ResourcePlan::checked(base).unwrap();
        assert_eq!(plan.with_output_sizes(0, 1), Err(Status::PartitionLimit));
        assert_eq!(
            plan.with_output_sizes(0x80000, 1),
            Err(Status::PartitionLimit)
        );
        assert_eq!(plan.with_output_sizes(1, 0), Err(Status::PartitionLimit));
        assert_eq!(
            plan.with_output_sizes(10, MAX_OUTPUT_BYTES as u32),
            Err(Status::OutputLimit)
        );
        let final_plan = plan.with_output_sizes(100, 1000).unwrap();
        assert_eq!(final_plan.frame_bytes, 1110);
        assert_eq!(final_plan.host_output_copy_bytes, 1110);
        assert!(final_plan.aggregate_bytes > plan.aggregate_bytes);
        assert!(final_plan
            .admit_actual_capacity(final_plan.linear_capacity_bytes)
            .is_ok());
        assert!(final_plan
            .admit_actual_capacity(final_plan.linear_capacity_bytes - PAGE as u32)
            .is_ok());
        assert_eq!(
            final_plan.admit_actual_capacity(0),
            Err(Status::MemoryAdmission)
        );
        assert_eq!(
            final_plan.admit_actual_capacity(final_plan.linear_capacity_bytes + PAGE as u32),
            Err(Status::MemoryAdmission)
        );
        assert_eq!(
            final_plan.admit_actual_capacity(final_plan.linear_capacity_bytes - 1),
            Err(Status::MemoryAdmission)
        );
        let tight = ResourcePlan::checked(Request {
            external_live_bytes: MAX_FRAME_LIVE_BYTES as u32,
            retained_output_bytes: MAX_OUTPUT_BYTES as u32,
            ..base
        })
        .unwrap();
        assert_eq!(
            tight.with_output_sizes(100, 64 * MIB as u32),
            Err(Status::MemoryAdmission)
        );
        assert_eq!(
            ResourcePlan::checked(Request {
                input_bytes: MAX_FRAME_LIVE_BYTES as u32,
                ..base
            }),
            Err(Status::MemoryAdmission)
        );
    }

    #[test]
    fn warm_capacity_floor_is_charged_once_and_survives_output_admission() {
        let base = ResourcePlan::checked(request(1, 1, 0)).unwrap();
        let floor = base.linear_capacity_bytes + PAGE as u32 * 4;
        let warm = base.with_capacity_floor(floor).unwrap();
        assert_eq!(warm.linear_capacity_bytes, floor);
        assert_eq!(warm.aggregate_bytes - base.aggregate_bytes, PAGE as u32 * 4);
        assert_eq!(
            warm.with_output_sizes(100, 100)
                .unwrap()
                .linear_capacity_bytes,
            floor
        );
        assert_eq!(
            base.with_capacity_floor(floor - 1),
            Err(Status::MemoryAdmission)
        );
        assert_eq!(
            base.with_capacity_floor(MAX_LINEAR_BYTES as u32 + PAGE as u32),
            Err(Status::MemoryAdmission)
        );
    }

    #[test]
    fn deterministic_records_never_overflow_or_misaccount() {
        let mut seed = 0x501u32;
        let next = |seed: &mut u32| {
            *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *seed
        };
        for _ in 0..100_000 {
            let mut record = request(1, 1, 0);
            record.width = next(&mut seed);
            record.height = next(&mut seed);
            record.stride = next(&mut seed);
            record.input_bytes = next(&mut seed);
            record.output_limit = next(&mut seed);
            record.external_live_bytes = next(&mut seed);
            record.retained_output_bytes = next(&mut seed);
            record.layout = next(&mut seed) % 7;
            if let Ok(plan) = ResourcePlan::checked(record) {
                assert!(plan.input_extent <= record.input_bytes);
                assert!(plan.linear_live_bytes <= plan.linear_capacity_bytes);
                assert_eq!(plan.linear_capacity_bytes % PAGE as u32, 0);
                assert!(u64::from(plan.linear_capacity_bytes) <= MAX_LINEAR_BYTES);
                assert!(u64::from(plan.aggregate_bytes) <= CONVERSION_BUDGET_BYTES);
                let first = next(&mut seed) % 0x80000;
                let coefficient = next(&mut seed) % (MAX_OUTPUT_BYTES as u32 + 1);
                if let Ok(final_plan) = plan.with_output_sizes(first, coefficient) {
                    assert_eq!(final_plan.frame_bytes, 10 + first + coefficient);
                    assert!(final_plan.linear_live_bytes <= final_plan.linear_capacity_bytes);
                    assert!(u64::from(final_plan.aggregate_bytes) <= CONVERSION_BUDGET_BYTES);
                    assert!(final_plan
                        .admit_actual_capacity(final_plan.linear_capacity_bytes)
                        .is_ok());
                }
            }
        }
        // Exercise admitted shapes as well as malformed words. No allocation
        // scales with input dimensions; this loop only constructs records.
        for _ in 0..100_000 {
            let width = 1 + next(&mut seed) % 4096;
            let height = 1 + next(&mut seed) % 2048;
            let layout = next(&mut seed) % 5;
            let mut record = request(width, height, layout);
            record.stride += next(&mut seed) % 65;
            record.input_bytes =
                (height - 1) * record.stride + width * if layout == 4 { 3 } else { 4 };
            record.external_live_bytes = next(&mut seed) % (MAX_FRAME_LIVE_BYTES as u32 + 1);
            record.retained_output_bytes = next(&mut seed) % (MAX_OUTPUT_BYTES as u32 + 1);
            if let Ok(plan) = ResourcePlan::checked(record) {
                assert_eq!(plan.input_extent, record.input_bytes);
                assert!(plan.linear_live_bytes <= plan.linear_capacity_bytes);
                assert!(u64::from(plan.aggregate_bytes) <= CONVERSION_BUDGET_BYTES);
                let first = 1 + next(&mut seed) % 0x7ffff;
                let coefficient = 1 + next(&mut seed) % (MAX_OUTPUT_BYTES as u32);
                if let Ok(final_plan) = plan.with_output_sizes(first, coefficient) {
                    assert_eq!(final_plan.frame_bytes, 10 + first + coefficient);
                    assert_eq!(final_plan.host_output_copy_bytes, final_plan.frame_bytes);
                    assert!(final_plan.linear_capacity_bytes <= MAX_LINEAR_BYTES as u32);
                    assert!(final_plan
                        .admit_actual_capacity(final_plan.linear_capacity_bytes)
                        .is_ok());
                    // A larger observed capacity may no longer fit the
                    // aggregate even when the projected size did.
                    assert_eq!(
                        final_plan.admit_actual_capacity(MAX_LINEAR_BYTES as u32 + PAGE as u32),
                        Err(Status::MemoryAdmission)
                    );
                }
            }
        }
    }
}
