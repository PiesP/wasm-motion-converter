# Corrected-v10 prospective source-only freeze

This cohort freezes 20 new held-out pixel inputs at q60/75/85 (60 conditions)
before any V10 candidate or comparator encoding. The existing 15 tuning inputs
and numeric gates are unchanged. All V1–V9 held-out inputs are exposed and
require `--regression`. The first V9 59/60 failure remains rejected; the
subsequent source-bound 507-condition regression pass is separate evidence and
does not reinterpret that first failure. At the time of the freeze, a V10
held-out acceptance subset was rejected before evidence directory creation or
codec initialization.

The [frozen manifest](501-owned-vp8-v10-fixtures.json) records each input's SHA256,
geometry, layout and row stride, plus source digests, FFmpeg version and filters,
generator digest and all nine predecessor manifest digests. Generator SHA256:
`446a8fea0aa56cbf77c1615a8f32843409a70270ba8c105c4e242b80faecfe4f`.
Manifest SHA256:
`741d4674a4ef687be0e57ea02e8d0470bdbd7f21a74b16c17b25e66f9bc8db40`.
Two source-only generations produced byte-identical manifests. The duplicate
hold intentionally repeats the frame-101 input and digest.

The new original photograph is
[Landscape_of_a_wild_forest.jpg](https://commons.wikimedia.org/wiki/File:Landscape_of_a_wild_forest.jpg),
[pinned revision](https://commons.wikimedia.org/w/index.php?title=File:Landscape_of_a_wild_forest.jpg&oldid=1142609642),
by SpessiG (own work), CC0 1.0. It is a 3136 × 2091 JPEG with 4,978,501 bytes,
SHA1 `77503952fb9f6245d2c5c0f70eb6f2f92ea87399` and SHA256
`2f9f01326230bf9166eec430eb6d14cac69412d6cf6e2ecc7a25970683e4ddea`.
The original remains outside Git and public assets. Source-only derivation crops
`(108,125,1360,1350)` and the disjoint `(1740,430,1100,1280)` region, then
bicubic scales them to 457 × 593 and 303 × 389. These derived inputs are the
qualification proposal; this freeze makes no full-original-geometry product
claim.

The pinned CC0 [V8.webm](https://commons.wikimedia.org/wiki/File:V8.webm) by
BMKME has SHA256
`c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`
and 192 zero-based frames at 30 fps. Frames 101 and 143 are absent from all
V1–V9 frozen manifests and scaled to 544 × 306. The duplicate hold repeats
frame 101. Generated sources use seed `0x501a9c73`, new patterns and text,
three tiny geometries, one-row and one-column cases, a 10,063,576-pixel
admitted frame, four layouts, and opaque RGBA with 28 padding bytes per row
filled with `0x73`. X bytes vary deterministically and are ignored in RGB
comparison.

An earlier metadata attempt recorded a 41-character photo SHA1. It was
superseded before any codec comparison; the original attempt and its digest
remain in the private qualification evidence. The corrected generator checks
both SHA1 and SHA256 against the unchanged source file.

Candidate PSNR must be at least baseline minus 1 dB, SSIM at least baseline
minus 0.01, and raw VP8 size at most the greater of baseline × 1.25 or baseline
plus 128 bytes. This source freeze establishes input provenance and selection
only. At the time of the freeze it established no V10 quality outcome.

The [first complete V10 result](501-owned-vp8-v10-result.md) rejected candidate
adoption at 58/60 conditions after two q75 SSIM failures. All V1–V10 held-out
inputs are now exposed regression evidence and require `--regression`; at that
V10 rejection checkpoint no fresh successor had been frozen. The subsequent
[V11 source-only freeze](501-owned-vp8-v11-source-freeze.md) is a separate
prospective input cohort. The original generator, manifest, source
digests, earlier metadata correction and failed result remain intact. Neither
the freeze nor that fixed-pixel result qualifies browser behavior, animation
fidelity or product performance.
