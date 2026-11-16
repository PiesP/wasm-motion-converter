# #501 half-weight I4 AC-tail trial candidate

## Retained control and one source change

The control is the rejected full-weight I4 AC-tail point measured at product
commit `5ac69991e0ca95bbf4e09fa6e8a8787cc574e9da`, with scalar module
SHA-256 `1270b81d00b76e8697b8abc0f7fdca4301543b1930d0c1047caecc76599abbfa`.
Its source and result documentation closed at
`b1d598421d2d427ed95585b47e031530b11282f7`. All 45 tuning conditions
passed. All five exposed actual-browser-RGB conditions passed raw VP8 size
and RGB SSIM, but PSNR failed rows 19, 38, and 57 by 0.234737, 0.156728,
and 0.110714 dB beyond the unchanged primary-minus-1-dB floor. The joint
result was 47/50, so the control remains rejected. Its saved 45-condition
paired audit passed 90 streams and 180 native `vp8`/`libvpx` decodes. Keep
these failed and successful receipts bound to the control; they do not qualify
this candidate.

This candidate changes only the integer lambda passed to the I4 AC-tail
coefficient decision from the original mode lambda to `lambda / 2`. The
strict token-rate decrease guard, source-Y inverse-patch SSD, and strict
`256 * SSD + trial_lambda * token_rate` comparison still decide whether to
zero a final `+1` or `-1` AC coefficient when another coefficient remains.
The full original lambda continues to price I4 prediction modes, the final
selected mode and residual, and macroblock selection. Neither pruning bound
changes its cost basis or order. The candidate can still consider at most
16 tiles times ten modes per eligible I4 macroblock, using fixed local arrays.

The quality-60 mixed-source eligibility, qindex allocation, signaled deltas,
filter, coefficient statistics, emission, skip and header admission, ABI,
frame cadence, geometry, and resource ceilings remain the control's. Excluded
source profiles retain their previous I4 decisions. This is one correction
point, not a parameter sweep or a new quality threshold. A smaller trial
weight may retain more coefficients, but no quality, size, or speed outcome is
predicted.

## Verification and adoption boundary

The focused Rust fixture must show a marginal coefficient removed by the
full-weight decision and retained by the half-weight decision using production
plane-3 token costs and exact inverse-patch SSD. The selected-mode score must
independently match full-lambda mode-plus-residual pricing. Pruned and
exhaustive I4 decisions must agree with the tail path both enabled and
disabled; synchronous/resumable repeated jobs, native `vp8`/`libvpx`
reconstruction, and existing resource, partition, cancellation, and reset
checks remain applicable. Complete the locked Rust gate, scalar WASM
provenance, and compiled ABI2 check before the codec screen.

The screen remains the same 45 tuning plus five exposed actual-browser-RGB
conditions. Each row requires PSNR at least the primary comparator minus
1 dB, RGB SSIM at least the primary minus 0.01, and raw VP8 bytes at most
the greater of 1.25 times the primary or primary plus 128. Retained paired
outputs require independent decoder and RGB-hash verification. Only a clean
50/50 result permits the full 687-condition exposed screen. A fresh cohort,
Windows product acceptance, lifecycle, and performance are separate gates.
This source point has no measured encoded-frame size, RGB quality, conversion
speed, or product result.

## Engineering validation before the codec screen

The locked/offline native crate gate passed 146 ordinary tests and all 17
explicitly enabled independent-decoder tests. The focused marginal-tail,
pruned-versus-exhaustive, and selected-score tests passed. Formatting and
all-target Clippy with warnings denied passed. The project-selected Node was
`26.13.1`.

The maintained scalar `--generate` build produced module SHA-256
`e81e5d7d741a2bbf682c44f166d438d65633210bc8aee16c73030f43dd519d77`:
245,377 raw bytes and 81,980 bytes under the pinned Node gzip level-9 recipe
with timestamp zero. Its declared initial linear memory is 1,114,112 bytes
and its exact maximum is 201,326,592 bytes (192 MiB). The module adds 14 raw
and 14 gzip bytes over the retained full-weight control. These are executable
module sizes, not encoded-frame size or conversion-throughput measurements.

All 28 recorded source-input hashes matched. The generated provenance JSON
SHA-256 is
`2d814396e9d99594af47e3f996c465ba550034cf58c1c28a6f725340e0ea1877`.
The independent `--check` rebuild matched, `--verify-prebuilt` passed, and
the compiled ABI2 engineering check passed. The frozen 50-condition codec
screen, broader exposed screen, fresh cohort, Windows acceptance, and
performance qualification remain unrun for this source point.
