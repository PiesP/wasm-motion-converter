# #501 mixed-segment Y1 AC allocation candidate

## Prospective source contract

The source control is product commit `b9b7e8939cf6139db6db778d11f2519567fe61c2`
with owned VP8 module SHA-256
`f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186`.
This is one prospective parameter point, not a qualified improvement. Retain
the control module and all earlier failed receipts separately.

The allocation applies only to quality 60 frames with non-neutral imported
chroma, no high-chroma-loss profile, at least two active source segment IDs,
and padded source Y/U/V mean curvature within the existing cutoff. It does
not use fixture IDs, output bytes, or quality feedback for eligibility. All
other frames keep their prior allocation.

For eligible frames, add four to the base qindex and all four absolute segment
qindices: `[6, 18, 32, 32]` becomes `[10, 22, 36, 36]`. Set the signaled
`(Y1 DC, Y2 DC, Y2 AC, UV DC, UV AC)` deltas from
`(0, 0, 0, -4, -11)` to `(-4, -4, -4, -8, -15)`. This preserves the
effective Y1 DC, Y2 DC/AC, and UV DC/AC dequantization factors, including
clamping at the smooth segment. Only Y1 AC becomes coarser. Three newly
nonzero Y deltas add 15 Boolean header symbols, included in the existing
first-partition admission budget. Mode-rate lambda remains the original
segment qindex's quality-60 `6/5` weight.

The classifier, filter, mode and tie rules, coefficient model and refinement,
ABI, layouts, cadence, geometry, and resource ceilings stay the same.
Equivalent dequantization factors outside Y1 AC do not imply identical modes,
predictors, coefficients, output bytes, RGB quality, or runtime. The candidate
does not incorporate prior I16 tail trials, UV precision changes, rate-price
changes, or SIMD work.

## Verification and adoption boundary

Focused Rust tests check the predicate exclusions; exact base, absolute
segment, delta, six-factor, lambda, filter, and header changes; synchronous
and resumable bytes; repeated frames; and bounded ABI progress. Native `vp8`
and `libvpx` must independently reconstruct the visible YUV output. Complete
the locked Rust gate, generated scalar WASM provenance and compiled ABI2 check
before measuring this parameter point.

The frozen screen is 45 tuning conditions and five exposed actual-browser-RGB
conditions. Each row requires PSNR at least the primary comparator minus 1 dB,
RGB SSIM at least the primary minus 0.01, and raw VP8 bytes at most the greater
of 1.25 times the primary or primary plus 128. Verify the paired saved outputs
with both decoders and retained RGB hashes. A full 687-condition exposed screen
follows only if all 50 rows and decoder checks pass. A fresh held-out cohort,
Windows product acceptance, lifecycle, and performance remain separate gates.
No quality, size, or throughput result was available when this contract was
written.

## Engineering result before the codec screen

The native locked/offline Rust suite passed 141 regular tests and all 17
independent-decoder ignored tests. The focused mixed-allocation tests passed,
as did formatting and all-target Clippy with warnings denied. The maintained
scalar build generated module SHA-256
`3c22eb63ddf652b27aacf394f24212c827fa75d27012a19b7a6bd3851f3396f2`:
243,475 raw bytes, 81,320 bytes with the maintained Node gzip recipe, and an
exact 192 MiB maximum linear memory declaration. The independent `--check`
rebuild matched, `--verify-prebuilt` validated closed-source provenance, and
the compiled ABI2 engineering check passed. The original module and provenance
were retained before generation. This module adds 267 raw and 172 gzip bytes
relative to the original artifact; those module sizes are not encoded-frame
size or product throughput measurements.

The frozen 50-condition codec screen, paired saved-output decoder audit, full
687-condition exposed screen, fresh cohort, Windows product acceptance, and
performance have not run for this candidate. Engineering correctness alone
does not qualify adoption.
