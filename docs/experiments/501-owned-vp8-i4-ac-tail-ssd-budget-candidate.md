# #501 I4 AC-tail 10% source-Y SSD budget: prospective candidate

## Retained controls and one source change

The rejected [full-weight I4 AC-tail point](501-owned-vp8-i4-ac-tail-rdo-candidate.md)
and [half-weight point](501-owned-vp8-i4-ac-tail-half-lambda-candidate.md)
each passed 47/50 frozen codec conditions: actual raw VP8 sizes passed, but
three rows missed PSNR. The rejected [no-increase source-Y SSD guard](501-owned-vp8-i4-ac-tail-ssd-guard-candidate.md)
passed 49/50: all actual PSNR and RGB SSIM rows passed, but actual row 38
exceeded its raw-size limit by 1,151.5 bytes. Its measured source is signed
commit `b5b9e8aa645633fd703904540543a4b277ecf104`; its rejected module
SHA-256 is
`b91db560333d74090976b68df02b52bba4fc0435b0966bf6db991941295c87d4`.
Keep these distinct source-bound failures and paired-decoder receipts.

This candidate changes only the local source-Y SSD admission for one I4
AC-tail zeroing trial from `trial_ssd <= baseline_ssd` to
`10 * trial_ssd <= 11 * baseline_ssd`. The exact rational comparison allows
at most a 10% increase in the decoder-inverse 4x4 patch's source-Y SSD.
Equality is allowed; a zero-SSD baseline still allows only zero SSD. The
existing strict reduction in production plane-3 token rate and strict
`256 * SSD + (mode_lambda / 2) * token_rate` improvement remain necessary.
The original full lambda still prices I4 modes and the returned macroblock.

The mixed q60 eligibility, quantizers and deltas, filter, mode order and
pruning, coefficient contexts, statistics/emission, skip/header behavior,
ABI, frame cadence, and resource ceilings remain fixed. The trial still
uses local arrays and at most 160 opportunities per eligible I4 macroblock;
there is no new frame state, allocation, stage, or runtime comparator.
This is one prespecified point, not a configurable quality control or sweep.

## Verification and adoption boundary

Focused Rust tests must prove the integer boundary including zero baseline,
inclusive equality and one SSD unit above it. A fixed production-weight
coefficient fixture must show a rate/RD-favored SSD increase accepted within
the budget that the prior hard guard rejected. A rate/RD-favored trial beyond
the budget must be retained for both signs and all three incoming contexts.
Retain lower-SSD and zero-loss positives, strict rate/RD ties, eligibility
guards, historical full/half arithmetic, pruned/exhaustive I4 decisions with
the feature both on and off, and independent full-weight mode score. Complete
the locked Rust, native-decoder, sync/resumable/repeat, resource/partition/
cancellation, maintained WASM provenance, and compiled ABI2 gates before any
codec screen. A unit coefficient fixture does not establish that an integrated
production frame selects the trial.

The unchanged frozen screen has 45 ordered tuning conditions and five
exposed actual-browser-RGB conditions. Every row must pass the unchanged
primary-relative PSNR, RGB SSIM, and raw VP8 size gates, with saved paired
streams and independent decoder hashes checked. Only 50/50 permits the full
687-condition exposed screen. Fresh media, Windows product acceptance,
lifecycle, performance, and delivery remain separate gates.

A 10% increase in the same global MSE domain corresponds to about 0.414 dB,
but this budget is local inverse source-Y SSD, not global visible RGB MSE.
Changed modes, neighbors, deblocking and chroma prevent a global quality
bound. The hard-guard row 76 had only about 0.4107 dB remaining RGB PSNR
margin; its size headroom was only 42 bytes. Neither a quality pass nor the
1,151.5-byte row-38 size recovery is predicted. No new codec or product
result is claimed for this candidate.

## Engineering validation before the codec screen

The locked offline native crate gate passed 149 ordinary tests and all 17
explicit independent-decoder tests. The focused AC-tail tests passed seven
cases, including the exact rational boundary and the production-weight
bounded-SSD admission fixture. Pruned versus exhaustive I4 search and the
independent full-weight selected score passed. Formatting and all-target
Clippy with warnings denied passed. These fixtures do not prove that an
integrated production frame selects the new allowance.

Maintained scalar generation produced module SHA-256
`a9e6d87d245ca00ae104c5f990e8ca1828db965ae82e4fb766cd297ce2280f6b`:
245,390 raw bytes and 81,993 bytes under pinned Node 26.13.1 gzip level 9
with timestamp zero. Its declared initial linear memory is 1,114,112 bytes
and its exact maximum is 201,326,592 bytes (192 MiB). All 28 recorded
source-input hashes matched; the provenance JSON SHA-256 is
`89d2b469944ca28b98be76af5290d9440829adad18b5fe46e3e930057645fed6`.
The independent `--check` rebuild matched the generated module,
`--verify-prebuilt` passed, and the compiled ABI2 engineering check passed.
The earlier rejected hard-guard module and provenance remain preserved as
separate controls.

No frozen codec screen, broader exposed screen, fresh cohort, Windows product
acceptance, lifecycle, or performance qualification has run for this new
source point.
