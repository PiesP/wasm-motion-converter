# Corrected-v12 prospective source-only freeze

This cohort freezes 20 new held-out pixel inputs at q60/75/85: 60 joint
conditions. The existing 15 tuning controls and numeric gates remain unchanged.
The 627 prior conditions include 45 tuning and 582 exposed held-out conditions.
V1–V11 held-out inputs require `--regression`. This document and the [manifest](501-owned-vp8-v12-fixtures.json)
were prepared before candidate or primary encoding on V12 inputs. No codec
output, decoded result, quality metric or candidate selection informed these
inputs. The freeze is source evidence, not a codec or product result.

Generator SHA256: `acb0eae52ecf91877693e901ac1dae525ada4a94727713233ca5b1d7baeb479a`.
Manifest SHA256: `56ce94096af1c1d4424e55854b933f5c82ebc14e06bf8360b6cd9470f1a91d95`.
Two source-only generations produced byte-identical manifests. The common
source-pin preflight checks the frozen V1–V11 generator and manifest chain plus
the V12 generator and manifest before creating evidence or initializing either
codec. V1–V11 generators and manifests are byte-identical to the selected
baseline. The 20 V12 inputs have 19 distinct hashes, with only the intentional
frame-37 duplicate hold repeated. No V12 hash matches any of the 209 predecessor
inputs. Originals, decoded pixels and repeat-generation receipt stay outside Git
and public assets.

Two new, independent CC0 originals supply four disjoint photograph crops:

| Source | Primary metadata and downloaded-byte binding | Disjoint crop and output |
| --- | --- | --- |
| [Image of a forest.jpg](https://commons.wikimedia.org/wiki/File:Image_of_a_forest.jpg), [revision 1270624296](https://commons.wikimedia.org/w/index.php?title=File:Image_of_a_forest.jpg&oldid=1270624296) | Akum20, own work, CC0 1.0; original JPEG 4160 × 3120, 3,384,891 bytes, SHA1 `f89d802d8f72eebd30f31487d96c374ec4a7fb95`, SHA256 `fad0d6b48507ac4d6792430a01470b60f926aae1ab8097ae85d8bea55d036819` | `(240,180,1500,1250)` → 463 × 587; `(2200,1000,1300,1600)` → 307 × 391 |
| [Long exposure of urban cityscape at night.jpg](https://commons.wikimedia.org/wiki/File:Long_exposure_of_urban_cityscape_at_night.jpg), [revision 701678803](https://commons.wikimedia.org/w/index.php?title=File:Long_exposure_of_urban_cityscape_at_night.jpg&oldid=701678803) | Peng LIU, CC0 1.0; original JPEG 1734 × 1158, 996,324 bytes, SHA1 `b9d846e178a22fdae4de8f3e9cf0e1fd1b2919b3`, SHA256 `38dbe09d4a50885a7a824d6a07fc0a455d67a311128f410a05cf8b5702e65eda` | `(100,100,650,900)` → 421 × 281; `(950,100,650,900)` → 389 × 263 |

The URLs, revision IDs, dimensions, byte counts, SHA1 values and CC0 license
were checked against Wikimedia Commons imageinfo and file pages; SHA1 and SHA256
were independently computed from the downloaded originals. Each original is
checked against both digests before FFmpeg decodes its crops. The two scene
origins differ from each other and from all V1–V11 photographs.

The retained [V8.webm](https://commons.wikimedia.org/wiki/File:V8.webm) is CC0
with SHA256 `c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`.
Previously unused zero-based frames 37 and 157 are bicubic scaled to 548 × 308;
the duplicate hold repeats frame 37 exactly. Thirteen deterministic synthetic
inputs use seed `0x501c912b`: grayscale, gradient, chroma edge, text, noise,
two tiny geometries, one-column and one-row, a 3997 × 2517 admitted frame,
BGRA, 44-byte-per-row padded RGBA and tightly packed RGB24. The padding byte is
`0x73`. The manifest fixes exact dimensions, layouts, row strides, pixel hashes,
FFmpeg version/filters and all eleven predecessor manifest digests. The codec
must receive each original stride, layout and visible geometry.

For each condition, candidate PSNR must be at least primary minus 1 dB, SSIM
at least primary minus 0.01, and raw VP8 size at most the greater of primary
× 1.25 or primary plus 128 bytes. All 60 conditions must pass jointly. Fixture
subsets are diagnostic only. The established 8 × 8 nearest-replication recipe
is used only for tiny-image RGB metrics; it does not change encoded geometry.
Source preparation, fixed-pixel comparison and later product/browser evidence
are separate scopes. The first V12 candidate comparison requires independent
review and exact source binding after this freeze.
