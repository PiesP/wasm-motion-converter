# Corrected-v8 prospective source-only freeze

This source-only cohort contains 20 new held-out pixel fixtures at q60/75/85
(60 fixed-pixel conditions). The existing 15 tuning fixtures and every v1-v7
held-out cohort are exposed controls; old held-out evidence requires
`--regression`. The selector rejects a held-out subset before comparison starts.
No candidate or comparator output was encoded while preparing this freeze.

The [frozen manifest](501-owned-vp8-v8-fixtures.json) records every RGBA/BGRA/
RGBX/BGRX input digest, visible geometry, row stride, source identity, FFmpeg
version and filters, generator digest, prior manifest digests, and the unchanged
PSNR/SSIM/size gates. Generator SHA256:
`aca1734c0cda15f7375f0ca91f1a3269cd46f5922baa42eb7882d19a7d5cf46e`.
Manifest SHA256:
`d4b17b2990ce5fbb96dfa75c3377c8b6fb20336e91e202a5440f5e5d2da24e19`.
The manifest's duplicate hold intentionally repeats the frame-63 input digest.

The photograph is [Architecture along Wall Street, New York City.jpg](https://commons.wikimedia.org/wiki/File:Architecture_along_Wall_Street,_New_York_City.jpg),
[pinned revision](https://commons.wikimedia.org/w/index.php?title=File:Architecture_along_Wall_Street,_New_York_City.jpg&oldid=1298939179),
by Z3lvs, own work, CC0 1.0. Its original is a 3024 × 4032 JPEG, 5,289,121
bytes, SHA1 `c6d9b52d1534df3d01404ff9d881767b7161e433`, SHA256
`46a843f7cbf299faa7bb5d3a97267e6dadbf4cf6ee0bccaff492af188ca92136`.
It remains outside the repository and delivered assets. The source-only process
derives a primary crop `(0,0,1512,2016)` and disjoint detail crop
`(2016,2688,1008,1344)`, then bicubic scales them to 429 × 571 and 281 × 375.
The original exceeds the product's pixel admission cap, so only the generated
pixel fixtures are proposed as admitted comparison inputs.

The video is the existing pinned CC0 [V8.webm](https://commons.wikimedia.org/wiki/File:V8.webm)
by BMKME, SHA256
`c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`.
It contains 192 zero-based frames at 30 fps. Fresh frames 63 and 159 are scaled
to 544 × 306; the duplicate hold reuses frame 63. The manifest fixes a new
seed `0x5018d00d`, three tiny geometries, row and column cases, an admitted
10,065,500-pixel frame, the four channel layouts and a padded opaque RGBA row.

This freeze alone establishes input provenance and selection behavior. It does
not establish the 60 gate outcomes, candidate adoption, browser behavior,
animation fidelity or product performance. Candidate/harness commit identities
and frozen criteria must be registered before any first V8 comparison.
