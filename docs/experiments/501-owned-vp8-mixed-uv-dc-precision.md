# #501 mixed-profile UV DC precision candidate

## Changed premise

The preceding signed guard source `844cfcb9f084ff663ac8198f68372387394f1b71`
passed all 45 tuning and five actual-browser-RGB PSNR, SSIM, and raw VP8 size
gates against the pinned shipped patched wasm-webp oracle. Its 90 saved streams
also matched retained RGB under both native VP8 and libvpx. The separate
original-source comparison still failed PSNR for frame 76: 40.996814 dB
versus primary 42.701327 dB, a -1.704513 dB delta against the unchanged
-1 dB floor. Frame 76 raw VP8 was 10,760 bytes against a 10,815-byte limit;
its encoded bytes and decoded RGB were unchanged from the preceding BD170
candidate. The sampled SSD guard alone did not resolve this failure. These
are diagnostic results, not production acceptance.

The private retained audit is
`uv-rgb-ssd-guard-01/quality-preparation/ROOT-RESULT-AUDIT.json`
(SHA-256 `e67dec6dfbb66bef13146a02becc8a88b57d041f58205e69e17a1f7754d0a80b`).
The historical mixed-Y1-AC allocation result remains frozen in
`501-owned-vp8-mixed-y1-ac-allocation-candidate.md` at its measured source.

## Single bounded source change

For the existing eligible quality-60 `mixed_y1_ac` profile only, change the
signaled UV DC delta from -8 to -9. Retain UV AC at -15, all Y deltas, segment
qindices, eligibility, RGB SSD guard, candidate search, color import, filter,
rate decisions, cadence, geometry, ABI, resource ceilings, and baseline oracle.
Both synchronous and resumable frame paths use the same delta selector.

The mixed profile's segment qindices are `[10, 22, 36, 36]`. The VP8 DC
quantizer table makes its UV DC steps change from `[6, 17, 25, 25]` to
`[5, 16, 25, 25]`; the latter two segments lie on a table plateau. Frame 76's
previous class counts `[1064, 2009, 4334, 753]` therefore put 3,073 of 8,160
macroblocks in segments with a directly changed UV DC step. Reconstruction
neighbors, subsequent mode decisions, and entropy can propagate effects beyond
those blocks, so this count predicts neither final RGB quality nor byte size.
The 55-byte size headroom makes a size regression a concrete risk.

## Prospective check and adoption boundary

First run the focused profile, header, synchronous/resumable, native and compiled
ABI tests. Regenerate the owned WASM and verify reproducible provenance
before any candidate measurement. Independently decode outputs with native VP8
and libvpx. The diagnostic screen uses the same 15 fixture IDs at q60/75/85,
plus actual-browser-RGB frames 0/19/38/57/76 at q60 and those five original
source references. Every applicable row keeps PSNR at least the shipped primary
minus 1 dB, SSIM at least primary minus 0.01, and raw VP8 bytes at most
`max(1.25 * primary, primary + 128)`. The five original-reference PSNR and
SSIM floors remain separate. Preserve all failures and never retune these
thresholds for this source after observing a result. A new source commit needs
its own frozen inputs, build, and first receipts. The full 77-frame and 687-case
cohorts, fresh held-out acceptance, actual software-route product performance,
resource and cancellation checks, and production asset removal remain separate.

## Engineering checkpoint

Pinned Rust 1.99.1 fmt and fmt-check, five focused mixed-profile tests,
all 163 ordinary native tests, all 17 explicitly invoked independent-decoder
and property tests, and all-targets Clippy with warnings denied pass.
Maintained WASM generation, an independent reproducible rebuild, prebuilt
verification and all 48 compiled ABI2 engineering cases pass. Direct local
static review reports no remaining defect in the bounded delta change.

The module is `39c9a6b72520e81c19d1740060749393d3a14f5fc17487237bf49028f4dfbf76`,
246,671 raw / 81,976 Node gzip level-9 bytes, with unchanged initial
1,114,112 and maximum 201,326,592 linear bytes. All 28 provenance inputs
and the artifact were independently rehashed. Provenance SHA-256:
`ae3afd2bdec94a81c52e35d79ef6c217e3e189d155fd11048e21b2498aa48ad8`.

Quality, size, performance, browser acceptance and delivery remain **NOT_RUN**
for this candidate. Freeze the clean signed source and exact module before
the one diagnostic screen. Production wasm-webp remains the runtime encoder.
