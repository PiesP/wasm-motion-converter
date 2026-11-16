# #501 owned VP8 UV refinement header cache candidate

Source base: `9698e01371fce297cf8ff15a44ae050f81d11320`.
Measured trial source: `2c5ddff0c4a73a6af583ad012d6ec968069c52a3`.
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

The pinned Rust 1.99.1 format check, three focused cache tests, 164 ordinary
native tests, 17 separately invoked ignored tests, and all-targets Clippy with
warnings denied passed. The focused cases compare I16/I4, segments, modes,
coefficient contexts, skip transitions, budget rejection before invalid tokens,
and fresh cache scope. The maintained WASM generator, reproducible rebuild and
prebuilt checks passed. The module is
`49b5820dda386a0fbeb5f0d568d97e93517568c4c67852f69f88b5d8500abff4`
(245,864 raw bytes; 81,592 pinned gzip bytes), with zero imports, unchanged
ABI2 exports, 1,114,112 initial and 201,326,592 maximum linear bytes. All 48
compiled ABI2 engineering cases passed, including independent decoding and
leased/stale-output checks.

The one direct control run compared this module with the immutable `bd170496`
module on 20 exposed settings: five fixed inputs at q60/q75/q85 and five
post-Canvas browser RGB captures at q60. All 20 matched in complete raw VP8
bytes, bounded ABI steps, status and stage/done/total trace. The five captured
rows also matched the saved Y1 raw payloads. This run made no new decoder or
metric comparison; 20 matches do not establish the 687-condition regression.
Both phase runners exited 0 without timeout. The retained private
`refinement-header-cache-01/control-preparation/ROOT-RESULT-AUDIT.json` audit
has SHA-256 `d89297c9565c6bfdf582cf237deb722fd458ed43475531a660bd20dc874b70b8`.

The single Node timing cohort warmed 10 module/input instances and retained 40
measured `job.encode` calls, four per module and captured input in ABBA/BAAB
order. Values below are milliseconds; each cell is median (range, MAD).
Positive delta means the cache candidate was slower.

| Captured RGB q60 index | BD control | Cache candidate | Median delta |
| --- | ---: | ---: | ---: |
| 0 | 547.308 (22.665, 7.578) | 542.281 (31.846, 7.752) | -0.918% |
| 19 | 492.530 (16.986, 5.485) | 493.742 (13.506, 2.929) | +0.246% |
| 38 | 513.474 (2.929, 0.800) | 515.205 (15.554, 4.145) | +0.337% |
| 57 | 523.058 (8.514, 0.877) | 527.613 (12.071, 2.557) | +0.871% |
| 76 | 394.930 (5.398, 1.844) | 396.350 (1.896, 0.640) | +0.360% |

All 50 warm/measured encodes reported 20,512,768 bytes of terminal WASM
linear capacity; that is not a physical peak. One median improved and four
increased. **DEFER integration:** this one cohort shows no consistent benefit
and establishes neither statistical significance nor a browser/product gain.
The prior host product low-quality timing near 44 seconds versus roughly
17-18 seconds for the prior runtime remains a separate unresolved gap. The
earlier M2 original-reference diagnostic also failed three of 77 frames; this
cache trial does not repair those quality failures. No unchanged rerun, full
687-condition run, fresh or V13 input, browser/product comparison, physical
peak measurement, or ownership change followed this control.

Reproduce the narrow checks from the repository root with the pinned toolchain:

```bash
cargo +1.99.1 test --manifest-path crates/owned-vp8/Cargo.toml --locked refinement_header_cache
cargo +1.99.1 fmt --manifest-path crates/owned-vp8/Cargo.toml --check
```

README result updates require a provenance refresh while keeping the measured
module byte-identical. Retain the one control's receipts; any future
qualification needs its own source-bound full-output and product evidence.
