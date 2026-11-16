# #501 I4 AC-tail source-Y SSD guard: prospective candidate

## Retained controls and one source change

The rejected [full-weight I4 AC-tail point](501-owned-vp8-i4-ac-tail-rdo-candidate.md)
and [half-weight point](501-owned-vp8-i4-ac-tail-half-lambda-candidate.md)
each passed 47/50 frozen codec conditions. Both passed raw VP8 size and RGB SSIM
on all five exposed actual-browser-RGB rows, while rows 19, 38, and 57 failed
the PSNR floor. Their source-bound streams, decoder checks, and failed receipts
remain separate controls. This candidate starts from the clean half-weight
source at `b3e2cf9221ccbef601b949a7ae3c11721d5f0b6c`.

In `choose_i4_ac_tail`, the only new condition is that the zeroed tail's
decoder-inverse 4x4 source-Y squared error must be no greater than the
unmodified coefficient's squared error. The existing strict decrease in
production plane-3 token rate and strict
`256 * SSD + (mode_lambda / 2) * token_rate` improvement must also hold.
An equal-SSD, lower-rate trial can still win when the half weight is positive;
an RD-favored trial with higher SSD now retains the coefficient. Exact ties
retain the baseline. The selected mode and macroblock continue to use the
full original lambda.

Eligibility, prediction-mode order, pruning bounds, coefficient contexts,
quantizers and deltas, filter, frame classifier, skip/header/statistics paths,
emission, ABI, frame cadence, and resource limits stay at the half-weight
point. At most 160 local I4 tail opportunities are considered per eligible
macroblock; no extra frame buffer or new source profile is introduced.

## Verification and adoption boundary

Focused tests must establish a rate-favored higher-SSD trial is retained,
zero-loss and lower-SSD rate-improving trials are accepted, and historical
full/half RD fixture decisions remain explicit. Signed tails and contexts 0,
1, and 2, all-zero and otherwise ineligible blocks, pruned/exhaustive I4
mode selection with the feature enabled and disabled, and independent
full-lambda selected-mode score remain covered. Complete the locked Rust
crate gate, formatter and Clippy, synchronous/resumable and repeat behavior,
native `vp8` and `libvpx` decodes, resource/partition/cancellation checks,
the maintained scalar WASM provenance build, and compiled ABI2 check before
the codec screen.

The frozen screen remains 45 tuning plus five exposed actual-browser-RGB
conditions. Every row must meet the unchanged primary-relative PSNR, RGB
SSIM, and raw-byte limits; retained paired streams and decoder RGB hashes
must match. Only 50/50 permits the full 687-condition exposed screen.
Fresh held-out media, Windows product acceptance, lifecycle, and performance
remain separate gates. Local source-Y SSD non-increase does not guarantee
final RGB PSNR non-increase after prediction-mode changes, neighboring
reconstruction, deblocking, and chroma. Retaining more coefficients could
also exceed the raw-byte limit. No codec or product outcome is claimed here.

## Engineering validation before the codec screen

The locked offline native crate gate passed 147 ordinary tests and all 17
explicit independent-decoder tests. The focused AC-tail fixture, pruned versus
exhaustive I4 decisions, selected-score check, formatter, and all-target Clippy
with warnings denied passed. The negative guard fixture uses the eligible q60
mixed-allocation Y1 steps `{ dc: 20, ac: 26 }` and production half-trial
lambda `101`; both signs and all three contexts show a rate/RD-favored
higher-SSD trial retained by the guard. The zero-loss, lower-rate fixture uses
an explicitly supplied clipped source patch. These unit cases do not prove
that an integrated production frame selects the guarded trial.

The maintained scalar generation produced module SHA-256
`b91db560333d74090976b68df02b52bba4fc0435b0966bf6db991941295c87d4`.
It has 245,384 raw bytes and 81,981 bytes under pinned Node 26.13.1 gzip
level 9 with zero timestamp. Its declared linear memory is initially
1,114,112 bytes with an exact maximum of 201,326,592 bytes (192 MiB).
All 28 recorded source-input hashes matched; the provenance JSON SHA-256 is
`f47c45a2bd8857dbbc457c5526cb70f07e8387ebdfccc2352c2f70518f868400`.
Independent `--check` rebuilding matched the generated module,
`--verify-prebuilt` passed, and the compiled ABI2 engineering check passed.

The first independent audit attempt compared Python gzip bytes with the
Node-defined gzip budget and failed because their deflate output differs.
That failed audit was retained; the corrected audit checked source hashes,
raw bytes, pinned Node gzip bytes, and WASM memory independently and passed.
No codec screen, broader exposure, fresh cohort, Windows product acceptance,
or performance gate has run for this source point.
