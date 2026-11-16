# #501 selected-mode I4 AC-neighbor candidate: unmeasured

## Frozen control and change

The signed 10% SSD-budget AC-tail control at
`934848306c5da717a9c95dc031fe07ce067f1c76` passed all 45 tuning rows
and all five actual-browser-RGB quality rows. Actual row 38 exceeded its
unchanged raw VP8 size cap by 914.5 bytes, so the joint result was 49/50 and
the point was rejected. Preserve its source-bound module, 45-row paired
decoder audit, and first failure receipts. No full 687-row, fresh cohort,
Windows product, or performance evidence transfers to this candidate.

This candidate changes the I4 residual choice only for blocks where the
existing mixed-source feature is enabled. For each 4x4 block, stage one runs
the original ten-mode search with full lambda, baseline coefficients and
plane-3 residual rates. Mode order, strict earliest-mode tie handling, and
mode-only and distortion lower-bound pruning remain fixed. No coefficient
trial occurs while modes are compared.

Stage two freezes that mode, predictor, incoming coefficient context, mode
cost, baseline coefficients and reconstructed patch. In ascending VP8 scan
positions 1 through 15, it independently reduces each nonzero AC level by
one toward zero. Every candidate starts from the same baseline. A candidate
must retain at least one nonzero coefficient, strictly reduce plane-3 token
rate under the same incoming context, satisfy
`10 * trial_source_y_ssd <= 11 * baseline_source_y_ssd`, and strictly improve
`256 * SSD + (mode_lambda / 2) * token_rate` against the baseline. The
strictly lowest admitted half-lambda score wins; ties retain the baseline or
the first admitted scan position. The selected patch is committed before the
next block's prediction. The returned I4 score is independently recomputed
from that selected patch and rate with the original full mode lambda.

At most 16 blocks times 15 AC positions, or 240 independent variants, are
considered per eligible macroblock in addition to at most 160 original mode
trials. There is no chained refinement, new heap or persistent frame state.
The mixed q60 eligibility, quantizers, deltas, filter, coefficient statistics,
emission, skip behavior, ABI, geometry, cadence and resource limits remain
fixed. This greedy selected-mode search does not claim a global optimum over
variants of unselected modes. Its runtime gain and integrated candidate
frequency are unknown.

## Required evidence before adoption

Focused tests cover the unchanged first-block stage-one winner,
exhaustive/pruned parity, independent single edits and tie rules, coefficient
signs and magnitudes, incoming contexts, strict rate/RD, the nonzero guard,
and independently recomputed full-lambda score. The retained 10% boundary
test and integrated skip checks remain in the full gate. The locked Rust,
native-decoder, sync/resumable/repeat, resource, partition, cancellation,
WASM provenance and compiled ABI2 gates remain required. The first focused
locked/offline Rust pass completed: all-targets `cargo check`, formatting,
four selected-AC tests, and one test each for first-mode parity,
pruned/exhaustive parity, and independently recomputed selected score passed.
An additional fixed saturated-patch fixture requires two separately
admitted AC trials to have equal actual token-rate savings, keeps the earlier
scan position on that tie, and replaces it when the later position has a
strictly lower actual rate. A second locked/offline focused run passed all
five selected-AC tests, all-targets `cargo check`, and formatting for that
source revision.
The initial formatting check failed on new test layout; the correction and
repeat check passed. The full locked/offline crate gate then passed 155
ordinary tests and all 17 explicitly enabled native VP8/libvpx decoder tests.
All-targets Clippy with warnings denied and formatting passed.

Maintained scalar WASM generation and an independent `--check` rebuild passed
with project-selected Node 26.13.1. `--verify-prebuilt` and the compiled ABI2
engineering check passed. A separately preserved snapshot verifies all 28
closed source inputs against the manifest and the rejected parent source.
Independent pinned-Node gzip and WASM memory inspection matched the manifest:
module SHA-256
`206cf945b56ca26d1cb11d1636cb80a4a623036691a8a6d901c41bd79910f223`,
244,951 raw bytes, 81,960 gzip bytes at level 9 with timestamp zero, initial
linear memory 1,114,112 bytes, and exact maximum 201,326,592 bytes. The
manifest SHA-256 is
`49a0542aac5e93f1812ec8dc4073b31e06177f4b42816f7a4db5ca3ae8162594`.
The rejected parent module
`a9e6d87d245ca00ae104c5f990e8ca1828db965ae82e4fb766cd297ce2280f6b`
and manifest
`8b6d395d52d3ba415347d43b22cc8853b01c366396a9e92c1afd4927480f2cea`
remain preserved separately. The raw and gzip byte differences are executable
module sizes, not encoded-frame size or throughput measurements. Codec,
product and delivery gates remain unrun for this source point.

The frozen 45-plus-five screen remains unchanged, with primary-relative PSNR,
RGB SSIM, raw VP8 size, paired stream and independent decoder checks. Only
50/50 permits the full 687-row exposed screen. Fresh media, Windows product
acceptance, lifecycle, performance and delivery remain separate gates. No
quality, size, speed or adoption result is predicted here.
