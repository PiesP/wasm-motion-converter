# Owned VP8 v2: ABI2 engineering checkpoint

Related issue: #501. This checkpoint is **PARTIAL**, with no production route
switch or runtime removal. The M0 contract and its thresholds remain authoritative.
M1 landed in #502 (`a49c5f3e`); #497/#499's failed DC-only candidate remains intact.

## Implemented boundary

The complete residual encoder now uses bounded deterministic I16/I4/UV rate
search, frozen-decision coefficient statistics and signaling-adjusted probability
updates. Default and proposed models are counted through finalized arithmetic
coding; updates are selected only for a strictly smaller complete frame.
Unfiltered reconstruction remains the predictor source. Presets are exploratory.

ABI2 provides fixed-width checked requests, generation/frame tickets, input and
finalized-output leases, distinct failure statuses, and conversion-owned mutable
state. Color, analysis, statistics, model selection, symbol emission, carry,
finalization and assembly have bounded work units. The final output plan is
published at a separate barrier before allocation. Plans charge linear capacity
once, retained warm-instance pages, external inputs and the possible host copy.
The existing 512/128/192/96 MiB policies are preserved.

The orphan `owned-vp8-core.ts` adapter caches successfully validated compiled
code, creates a fresh instance for each conversion, reuses it for frames and
retires it after settled consumers. It yields to host tasks, checks stale tickets,
waits for asynchronous memory reservations, validates the raw keyframe header and
keeps the output lease until a physical consumer settles. Cancellation does not
race that consumer. Failed jobs have no automatic backend retry.

The source-bound development artifact is outside the production import graph.
Its declared memory maximum is exactly 192 MiB and it has no imports or ABI1
exports. The builder checks pinned compiler/source/flags and reproducible bytes.
There are no external production Cargo dependencies.

## Evidence and limits

The Rust engine candidate `ce0e561e` produced WASM SHA-256
`09341bb47a82045e7c407be2fc071ffa7429ba4d8f903ae61247bc9f35b4c01c`:
164621 raw bytes, 30700 gzip-9 bytes, initial linear memory 1179648 bytes.
The primary comparator remains the shipped patched wasm-webp binary from M0.
Node was project-selected 26.13.1; Rust was 1.99.1; FFmpeg was 7.1.5 with native
VP8 and separate libvpx decoders.

- Rust: 42 unit tests and three independent-decoder suites passed; fmt/Clippy
  passed. Tests include signed coefficients, all AC positions, Y2/skip contexts,
  long carry tails, probability extremes, malformed requests and resource plans.
- Compiled ABI2: 40 conditions passed with two independent decoders, repeated
  within-conversion and fresh-conversion determinism, layout/opacity checks,
  pending leases, stale publication, active Node cancellation and new-instance
  recovery. Node cancellation is engineering evidence, not browser acceptance.
- A separate 4096x2048 seeded-noise condition produced 7272782 raw VP8 bytes,
  exceeding the historical 4 MiB prototype cap. Repeated encodes and both
  decoders agreed; actual retained linear capacity was 101711872 bytes. Maximum
  observed Node work step was 4.73 ms. This is neither a browser latency result
  nor a measured process/GPU memory peak.
- Portable application unit tests: 127 files / 1503 tests passed before the host
  adapter; the integrated host/builder focused checks then passed 14 tests.
  Maintained quality and production build passed. Exact-head CI remains required
  for landing; these checks do not substitute for prepared Windows acceptance.

The nine tuning inputs produce 27 preset conditions. With the new probability
model and exploratory qindices 40/22/8, **16/27** jointly pass PSNR, SSIM and size.
Remaining failures include smooth-region quantization and photographic size.
Earlier qcurve probes remain failed tuning cohorts, not overwritten evidence.
All 15 held-out fixture identities remain frozen and unmeasured by candidates.
Generic segment quantization and an independently checked color-import leaf are
subsequent implementation work, not reasons to reinterpret this result as adoption.

## Next acceptance work

Finish preset/color/segment calibration on tuning inputs, then freeze a complete
candidate before held-out measurements. Integrate the actual software route,
connect resource accounting, qualify full animations and balanced product timing,
active Stop/recovery and installed browser engines under the prepared Windows
lease. Real Safari/mobile coverage remains UNVERIFIED. Only after the required
M2/M3/M4 gates pass may M5 remove wasm-webp imports, assets and runtime-only glue.
Delivery/provider source and served bytes must be reconciled separately.
