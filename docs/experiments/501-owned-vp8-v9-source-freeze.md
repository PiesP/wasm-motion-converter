# Corrected-v9 prospective source-only freeze

This cohort freezes 20 new held-out pixel inputs at q60/75/85 (60 conditions)
before any V9 candidate or comparator encoding. The 15 existing tuning inputs
are unchanged. All V1–V8 held-out inputs have been observed and require explicit
`--regression`; the rejected V8 59/60 result remains intact. A V9 held-out subset
is rejected before evidence directory creation or codec initialization.

The [frozen manifest](501-owned-vp8-v9-fixtures.json) records each input's SHA256,
geometry, layout and row stride, plus source digests, FFmpeg version and filters,
generator and predecessor manifest digests. Generator SHA256:
`199726a9fa055d1ed2761240cb2042fcfa85ebc321baa976d2beb095ac69c343`.
Manifest SHA256:
`8eeae4aeb52b433ff2936ee7973d31795b6d39edc5f734e0a33de84ebf176c54`.
The duplicate hold intentionally repeats the frame-86 input and digest.

The new original photograph is
[20190710_copenhagen_jpeg2_11.jpg](https://commons.wikimedia.org/wiki/File:20190710_copenhagen_jpeg2_11.jpg),
[pinned revision](https://commons.wikimedia.org/w/index.php?title=File:20190710_copenhagen_jpeg2_11.jpg&oldid=963886723),
by SeanDaRos, CC0 1.0. It is a 6000 × 4000 JPEG, 2,940,346 bytes, SHA1
`bb722366844eb60130c50c8f0ae68999ef07e39b`, SHA256
`c73dc8ab9bac25caa802d3e5195590e3f9a7dd18042539d6f3a7e4b9605de143`.
The original remains outside Git and public assets. The source-only derivation
crops `(0,0,1600,2400)` and the disjoint `(3600,2300,1200,1500)` region, then
bicubic scales them to 451 × 601 and 297 × 397. The 24-million-pixel original
exceeds the existing 10,066,329-pixel admission cap; only the derived fixtures
are proposed comparison inputs. This does not establish a full-geometry product
claim.

The pinned CC0 [V8.webm](https://commons.wikimedia.org/wiki/File:V8.webm) by
BMKME has SHA256
`c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`
and 192 zero-based frames at 30 fps. Previously unused frames 86 and 176 are
scaled to 552 × 310. The duplicate hold repeats frame 86. V9 also uses seed
`0x5019b47e`, new generated formulas and text, three tiny geometries, one-row
and one-column cases, a 10,065,160-pixel admitted frame, four layouts, and an
opaque RGBA input with 24 padding bytes per row filled with `0x6d`. X bytes
vary deterministically and are ignored in RGB comparison.

The numeric gates are unchanged: candidate PSNR at least baseline minus 1 dB,
SSIM at least baseline minus 0.01, and candidate raw VP8 size at most the greater
of baseline × 1.25 or baseline plus 128 bytes. This source freeze establishes
input provenance and selection only. At the time of this freeze, no V9 quality
outcome, encoder adoption, browser behavior, animation fidelity, or product
performance was established.

The [first complete V9 result](501-owned-vp8-v9-result.md) rejected candidate
adoption at 59/60 conditions after a q60 SSIM failure on
`fresh9-chroma-edge`. All V1–V9 held-out inputs are now exposed regression
evidence and require `--regression`; at that result no fresh successor had been
frozen. The original generator, manifest, source digests and failed result
remain intact.

The [V10 source-only freeze](501-owned-vp8-v10-source-freeze.md) subsequently
introduced a distinct prospective cohort. The V9 failure and source identities
above remain historical evidence.
