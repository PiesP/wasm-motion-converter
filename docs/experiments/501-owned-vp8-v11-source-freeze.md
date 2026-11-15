# Corrected-v11 prospective source-only freeze

This cohort proposes 20 new held-out pixel inputs at q60/75/85 (60 joint
conditions) before any V11 candidate or primary encoding. It retains the
existing 15 tuning controls and numeric gates. All V1–V10 held-out inputs
remain exposed regression evidence and require `--regression`; their original
results, including rejected 58/60 and 565/567 runs, remain separate.

The [frozen manifest](501-owned-vp8-v11-fixtures.json) binds each input's SHA256,
visible geometry, layout and row stride, generator digest, external source
metadata and hashes, FFmpeg version and filters, and all ten predecessor
manifest digests. The source original and decoded pixels remain outside Git and
public assets. This freeze does not establish a codec outcome.
Generator SHA256: `76fbb7319a630651ef6013d71cb340f00c0f3bc54e1f6896d667c646128fa53a`.
Manifest SHA256: `9c1699d8ad0a3d31de638cb0f816fe7fa0b6119dc7c05452aeadc33e1d652419`.
Two source-only generations produced byte-identical manifests. The 20 inputs
have 19 distinct hashes; only the intentional frame-111 duplicate hold repeats.
None of the 20 hashes matches any of the 189 predecessor inputs (567 conditions).

The previously unused original photograph is
[20190831 Montagne.jpg](https://commons.wikimedia.org/wiki/File:20190831_Montagne.jpg),
[pinned page revision](https://commons.wikimedia.org/w/index.php?title=File:20190831_Montagne.jpg&oldid=850548619),
by Gb89.2 (own work), CC0 1.0. The [original download](https://upload.wikimedia.org/wikipedia/commons/2/28/20190831_Montagne.jpg)
is a 5152 × 3864 JPEG with 3,797,100 bytes, SHA1
`0d8423320e903f65d44bb1c93746a2bd9bdd2719` and SHA256
`7e3d85269a6d4178c6af24b30c6132b2b3744aed50d8737658fa29e680c156a8`,
verified from downloaded bytes. Two disjoint regions `(300,250,1500,1300)`
and `(2500,700,1250,1600)` are cropped and bicubic scaled to 463 × 587 and
307 × 391. These derived views do not qualify full-original geometry.

The retained [V8.webm](https://commons.wikimedia.org/wiki/File:V8.webm) by BMKME
is CC0 1.0 with SHA256
`c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`
and 192 zero-based frames at 30 fps. Frames 111 and 171 were selected from
indices absent from all V1–V10 manifests before codec output inspection. Both
are bicubic scaled to 536 × 302; duplicate hold repeats frame 111 exactly.
The frame choices, scale, cadence and visible geometry must not change during
candidate measurement.

Generated sources use seed `0x501b7d29` and distinct formulas for grayscale,
gradient, chroma edges, text, noise, two tiny geometries, one-column and one-row,
a 4001 × 2515 (10,062,515-pixel) admitted frame, BGRA, RGBX, BGRX,
row-padded opaque RGBA, and packed RGB24. The padded RGBA has 36 padding bytes
per row filled with `0x6d`; X bytes vary deterministically and are ignored by
RGB comparison. RGB24 has three bytes per pixel and ABI layout 4. The codec
receives original stride, layout and visible dimensions. Only the established
RGB metric path uses canonical 8 × 8 minimum nearest replication for tiny inputs;
encoded geometry remains unchanged. No class, import-loss or encoder-state proxy
was used to select inputs.

For every condition, candidate PSNR must be at least primary minus 1 dB, SSIM
at least primary minus 0.01, and raw VP8 size at most the greater of primary
× 1.25 or primary plus 128 bytes. All 60 conditions must pass jointly. Fixture
subsets are diagnostic only. Source preparation, fixed-pixel metrics and later
product/browser qualification are separate scopes. The first actual candidate
run requires root registration and independent source review after this freeze.
