# #501 I4 AC-tail RDO candidate: rejected

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
is possible and has not been measured. The codec result is recorded below;
no throughput or product-acceptance result is claimed.

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
All 28 recorded source-input hashes matched. At the measured source, the
provenance JSON SHA-256 was
`7cc85c109d4ab4f43a60925f1c4c781bebdee9529bf5d968d5ce01799cf849cb`.
The independent `--check` rebuild matched the generated module,
`--verify-prebuilt` passed, and the compiled ABI2 engineering check passed.

The retained control module is
`3c22eb63ddf652b27aacf394f24212c827fa75d27012a19b7a6bd3851f3396f2`:
243,475 raw bytes and 81,320 pinned-Node-gzip bytes. The candidate module
adds 1,888 raw and 646 gzip bytes. These are executable-module sizes, not
encoded-frame size or conversion-throughput measurements. The frozen 50-row
codec screen result follows. The broader exposed screen, fresh cohort,
Windows acceptance, and performance qualification remain unrun for this
source point.

## Frozen exposed screen: rejected for adoption

The measured source was commit `5ac69991e0ca95bbf4e09fa6e8a8787cc574e9da`
with module SHA-256
`1270b81d00b76e8697b8abc0f7fdca4301543b1930d0c1047caecc76599abbfa`.
All 45 tuning conditions passed. In the five exposed actual-browser-RGB
conditions, raw VP8 size and RGB SSIM passed every row, while PSNR failed
rows 19, 38, and 57 against the primary comparator minus 1 dB. The joint
result is **47/50**, so this candidate is rejected for adoption. The retained
50-condition coordinator summary SHA-256 is
`28090e270dd836b944988581d8954bbd7ae0e44e8918626c09e36b1cc857082c`.

| Actual row | Primary bytes | Candidate bytes | Size limit | PSNR delta (dB) | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 0 | 32,660 | 35,236 | 40,825 | -0.957844 | Pass |
| 19 | 27,068 | 29,465 | 33,835 | -1.234737 | PSNR fail |
| 38 | 26,722 | 32,333 | 33,402.5 | -1.156728 | PSNR fail |
| 57 | 29,990 | 34,225 | 37,487.5 | -1.110714 | PSNR fail |
| 76 | 8,652 | 10,774 | 10,815 | -0.589395 | Pass |

Row 38 has 1,069.5 bytes of raw-size headroom, but its PSNR is below the
threshold by 0.156728 dB. The paired 45-condition audit matched 90 retained
streams and 180 native `vp8`/`libvpx` decodes against their RGB hashes. Its
summary SHA-256 is
`0b9eba3b949498e7b039cc818b0a033d7c8824ffd539277c63f9e65a3d19ab08`.
After the README result wording changed, maintained generation and
`--verify-prebuilt` passed again. The WASM bytes remained exactly the measured
module; the documentation-bound provenance JSON SHA-256 became
`3ec995b795efc84bcc112738250f9ec7d349abf9055a4a39ad0f808328ebeece`.
The full 687-condition exposed screen, fresh cohort, Windows product
acceptance, and performance were not run after the PSNR failures. Keep this
failed point and the rejected control as distinct evidence.
