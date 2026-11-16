# #501 owned VP8 UV refinement header cache candidate

Source base: `9698e01371fce297cf8ff15a44ae050f81d11320`.
Owned module baseline SHA-256: `bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e`.
Formatted trial source (`textured.rs`) SHA-256:
`fc67839f73c1d510012d9b086cbbbfb2d3dca8f818e8d6573a1f69370079e4d2`.

## Hypothesis and scope

`refine_selected_uv` calls `selected_cost` for its baseline and each UV DC or
last-AC +/-1 trial. `selected_cost` rewrites the segment, skip and mode symbols
at each call. During one refinement, the macroblock position, modes, segment,
neighbor modes and header budget remain fixed. A UV trial can only change the
whole-macroblock skip bit in that header. A two-entry cache indexed by that bit
can reuse the header rate and symbol count for later trials.

The cache lives only inside one `refine_selected_uv` call. Other callers keep
the uncached `selected_cost` path. Every trial still checks the I16 symbol
maximum and the current `HeaderBudget::fits_symbols` result before measuring
coefficient tokens. Luma and UV token costs, error and `None` ordering, rate
arithmetic, floating score decisions and reconstruction remain as before. No
new dependency, allocation, ABI, stage, yield point, preset or tuning value is
introduced.

## Verification state

The coordinator ran the pinned Rust 1.99.1 toolchain for local checks.
Formatting and `cargo fmt --check` passed. The three focused cache tests passed; the
full ordinary native test run
passed 164 tests with 17 ignored. All-targets Clippy with warnings denied
passed. The 17 ignored tests were then invoked separately and passed (exit 0,
34.97 seconds) on the same formatted source. `git diff --check` passed.

The added unit tests compare cached and uncached scores across I16/I4,
segments, modes, coefficient contexts
and skip transitions; a separate case checks cached-header budget rejection
before invalid coefficient tokens. A third case checks cache reset across header
contexts. The test and static-check results do not establish exact native/WASM
bytes, steps, status or trace. The maintained generator, reproducible rebuild check and prebuilt check passed.
The resulting module is `49b5820dda386a0fbeb5f0d568d97e93517568c4c67852f69f88b5d8500abff4`,
245,864 raw bytes and 81,592 bytes using pinned Node gzip level 9, mtime 0.
It has zero imports, unchanged ABI2 exports, 1,114,112 initial linear bytes and
a 201,326,592-byte maximum. All 48 compiled ABI2 engineering cases passed,
including independent decoding and leased/stale-output checks. Direct
cache-versus-BD output identity and performance remain unrun. No new browser or
product timing and no speedup or acceptance are claimed. The retained
`bd170496` combined-module result remains a baseline;
the host product's current low-quality timing near 44 seconds versus roughly
17-18 seconds for the prior runtime does not establish a gain for this trial.

Reproduce the narrow checks from the repository root with the pinned toolchain:

```bash
cargo +1.99.1 test --manifest-path crates/owned-vp8/Cargo.toml --locked refinement_header_cache
cargo +1.99.1 fmt --manifest-path crates/owned-vp8/Cargo.toml --check
```

README result updates require the maintained provenance refresh while keeping
the generated module byte-identical. The next gate is direct exact-output,
step, status and trace comparison against the immutable BD module before any
Node performance cohort, followed by controlled full-output and product gates. Compare worst-step latency only after
the bytes, steps, status and trace agree; retain any failed receipts.
