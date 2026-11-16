# #501 I4 AC-tail RDO candidate

## Prospective source contract

The control is the rejected mixed-segment Y1 AC allocation point at product
commit `4a034d2b79234633c8f09c64b42e481fea221834`. Its generated scalar
module SHA-256 is
`3c22eb63ddf652b27aacf394f24212c827fa75d27012a19b7a6bd3851f3396f2`.
Keep its 49/50 screen result and paired-decoder receipts distinct from this
candidate. This document specifies one source decision, not a parameter sweep
or a claim of improvement.

For the existing quality-60, non-neutral, mixed-segment, low-curvature source
profile, each I4 prediction-mode candidate may remove its final nonzero Y1 AC
coefficient in VP8 scan order if that coefficient is `+1` or `-1` and another
coefficient remains nonzero. I4 has no Y2 DC. The only trial changes that AC
coefficient to zero. The rate comparison uses the production plane-3 token
path and the candidate's incoming above/left coefficient context. The
distortion comparison uses source-Y squared error from ordinary inverse
reconstruction of the 4x4 patch. Accept the trial only when its token rate is
strictly lower and its `256 * SSD + lambda * token_rate` is strictly lower.
Ties keep the quantized coefficient. The mode score adds the selected token
rate once to the existing B-mode rate.

At most 16 tiles times ten prediction modes, or 160 tail opportunities, are
considered per eligible I4 macroblock. Trials use fixed local arrays and do
not commit neighbors, contexts, or statistics. The baseline-distortion prune
is delayed until after the trial on eligible candidates, because a tail change
can reduce distortion. The earlier mode-only bound remains valid. Mode order,
strict tie selection, selected-mode reconstruction, coefficient-presence bits,
skip decisions, and first-partition admission continue through their existing
paths. Source profiles outside the predicate retain the previous I4 path.

This point retains the control's segment qindices, quantizer deltas, lambda,
filter, source classifier, ABI, frame cadence, and resource ceilings. It does
not include I16-tail trials, SIMD work, or a second encoder fallback.

## Verification and adoption boundary

Focused Rust checks must cover tail eligibility, rate and distortion guards,
scan signs and contexts, selected-patch inverse reconstruction, score
accounting, trial isolation, and exact pruned-versus-exhaustive I4 decisions
with the feature both enabled and disabled. Source-predicate exclusions,
synchronous/resumable and repeated-frame determinism, independent native `vp8`
and `libvpx` reconstruction, bounded ABI progress, partition and cancellation
behavior remain required. The locked Rust gate, generated scalar WASM
provenance, and compiled ABI2 check precede any codec screen.

The frozen screen has 45 tuning conditions and five exposed actual-browser-RGB
conditions. Each row requires PSNR at least the primary comparator minus 1 dB,
RGB SSIM at least the primary minus 0.01, and raw VP8 bytes at most the greater
of 1.25 times the primary or primary plus 128. Paired output decoding and RGB
hashes must be verified. The full 687-condition exposed screen follows only if
all 50 rows and decoder checks pass. A fresh held-out cohort, Windows product
acceptance, lifecycle, and performance are separate gates. Extra per-step CPU
is possible and has not been measured. No size, quality, speed, or acceptance
result is claimed for this candidate.

## Engineering validation before the codec screen

The locked/offline native crate gate passed 145 ordinary tests and all 17
explicitly enabled independent-decoder tests. The focused I4 tail, pruning,
and selected-score checks passed. Formatting and all-target Clippy with
warnings denied passed. The project-selected Node was `26.13.1`.

The maintained scalar `--generate` build produced module SHA-256
`1270b81d00b76e8697b8abc0f7fdca4301543b1930d0c1047caecc76599abbfa`.
The module has 245,363 raw bytes and 81,966 bytes under the pinned Node gzip
level-9 recipe with timestamp zero. Its declared initial linear memory is
1,114,112 bytes and its exact maximum is 201,326,592 bytes (192 MiB).
All 28 recorded source-input hashes matched. The provenance JSON SHA-256 is
`7cc85c109d4ab4f43a60925f1c4c781bebdee9529bf5d968d5ce01799cf849cb`.
The independent `--check` rebuild matched the generated module,
`--verify-prebuilt` passed, and the compiled ABI2 engineering check passed.

The retained control module is
`3c22eb63ddf652b27aacf394f24212c827fa75d27012a19b7a6bd3851f3396f2`:
243,475 raw bytes and 81,320 pinned-Node-gzip bytes. The candidate module
adds 1,888 raw and 646 gzip bytes. These are executable-module sizes, not
encoded-frame size or conversion-throughput measurements. The frozen 50-row
codec screen, broader exposed screen, fresh cohort, Windows acceptance, and
performance qualification remain unrun for this source point.
