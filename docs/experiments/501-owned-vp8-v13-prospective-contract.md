# #501 V13 fixed-pixel successor: source freeze

V13's source-only freeze reserved 20 input rows and q60/q75/q85 for 60
fixed-pixel conditions. Its sole fresh evaluation on signed candidate
`bab8e9a5537f5af86bede155793ad25d61ce4d5d` passed 55 of 60 conditions. The
result SHA-256 is
`4477e272c19688e0c63aa522a4c7857b6ab0a87a33ddd9fa2c715be18738fdf8`.
The manifest status is now `EXPOSED_REGRESSION`. This outcome keeps fallback
removal on hold and serves as an exposed regression check for successors.

## Frozen 20-input / 60-condition source cohort

- 13 deterministic, newly seeded packed opaque RGBA patterns: neutral and
  near-neutral, glyph-like edges, diagonal chroma, dark gradients, saturated
  boundaries, noise, mixed curvature, tiny and odd frames, a 2049-pixel-wide
  shallow frame, muted texture, and checker edges.
- Three nonoverlapping crops from each of **two genuinely new** appropriately
  licensed public photo originals, bound to source-byte pins.
- One intentional exact duplicate of `fresh13-photoA-1`, disclosed as a duplicate
  condition and never counted as a unique input.

The order and q60/q75/q85 schedule are frozen. The two source
identities and original dimensions are recorded. Six source-axis crop rectangles
are selected by a fixed rule: divide each original into three equal vertical
cells of `floor(width / 3)` pixels; for each fixture, choose the largest integer
multiple of its target width and height that fits its cell and original height,
then center by flooring the remaining horizontal and vertical margins. The
duplicate copies photoA-1's exact source and rectangle. FFprobe reported
5472×3648 and 4608×3456 with no stream rotation fields. The selected rectangles
were set before the source-only pixel generation:

| Fixture  | Source region `(x, y, width, height)` |
| -------- | ------------------------------------- |
| photoA-1 | `(110, 1282, 1604, 1084)`             |
| photoA-2 | `(1893, 1206, 1685, 1235)`            |
| photoA-3 | `(3693, 1245, 1734, 1158)`            |
| photoB-1 | `(166, 1321, 1203, 813)`              |
| photoB-2 | `(1630, 1234, 1348, 988)`             |
| photoB-3 | `(3117, 1245, 1445, 965)`             |

The generator uses FFmpeg `crop:exact=1` so chroma subsampling does not silently
round the specified odd crop dimensions or coordinates; this matches [FFmpeg's
crop contract](https://ffmpeg.org/ffmpeg-filters.html#crop). The generator was
run once after the source-only plan was frozen; it filled 20 actual pixel hashes
without candidate output. Do not search seeds, replace sources, adjust crops,
or change criteria after seeing candidate output. Photo originals
must be downloaded to private local paths outside delivered assets. Their page,
revision, download URL, license, author, exact byte count, dimensions, and SHA-256
must be verified and pinned before decoding. The selected CC0-1.0 originals and
their local byte/SHA-256 receipts are under the private
`fresh-v13-sources-01/acquire01/` evidence directory. The V8-V12 data-only
manifest snapshots and source revisions are indexed under its `prior-manifests/`
directory. Byte-identical canonical V8-V12 JSON input data resides under
`validation/windows/inputs/owned-vp8-prior-manifests/`; V1-V7 remain in
`docs/experiments/`. All twelve V13 prior-manifest paths are relative to the
harness root. No V8-V12 generator or historical result was
imported. The two original JPEGs remain private CLI inputs outside Git.
The source-only generator decoded both originals to create the selected packed
RGBA pixels; there is no separate visual crop acceptance. The FFmpeg version
and generator SHA-256 are source-frozen pins. The pixels use
packed RGBA with stride `width * 4`; this retains
the comparator's current RGB extraction and avoids introducing an unverified
padded-row or BGR oracle path.

The sole source-only generation attempt is retained at private
`fresh-v13-preparation-01/source-generation-01/attempt-01/`. Its stdout manifest
has SHA-256 `bd136a2aa9468851403ce57e54661b1547c7e57ba1ac688bd3f66a0936236b85`;
the launcher and child both exited `0`. The independent audit recorded 20 rows,
19 distinct new pixel inputs, zero collisions with 217 distinct prior inputs,
and zero candidate encodes. The generated manifest differed from the prior
source draft **only** in its 20 pixel SHA-256 fields. That output remained
`PROSPECTIVE_UNFROZEN` and was then promoted to the source freeze by changing
only the three status/ID/budget fields and relocating five V8-V12 prior-manifest
paths to byte-identical tracked data. Source pixel hashes, source identities,
crop regions, decoder, and criteria remain identical.

The source-only generation attempt used generator SHA-256
`24a8851bb802cd857049fcb4fbdfce5de67197c602bd080253b48a0c0eaf6411`.
A later typecheck exposed an unchecked `ffmpeg -version` first-line result. The
current generator validates that the line is present and nonblank before
returning the same line for valid output; its SHA-256 is
`7207b4b112f7fba5b07c51899459bdd4628d64c0e497c25eddf3006cbd9c5141`.
This revision changes no pixel recipe, source, crop, decoder command, or
criterion. The retained generation receipt remains bound to the original SHA;
the current revision has not run source generation.

## Freeze and execution boundary

The first-attempt manifest was `FROZEN_UNEXECUTED` with freeze ID
`vp8-v13-first-heldout-20261116-01` and `attemptBudget=1`. The source-only
manifest and generator were committed before candidate evaluation. The first
attempt bound candidate source, Rust inputs, WASM, comparator, patched
wasm-webp primary, original bytes, FFmpeg, frozen manifest, and the exclusive
output directory. The historical first-attempt manifest SHA-256 remains
`433ca0e360cc7f15c5bd8e8db6282878c337753f0fee90723c6868bc68a8a2ea`. A failed preflight or encoding receipt
must be retained. An input exposed to a diagnostic candidate run cannot later
be described as fresh for that candidate. A selected subset is diagnostic only;
the first fresh fixed-pixel decision requires all 20 inputs and 60 conditions.
The collision scan checks each prior manifest against its canonical V1-V12 role,
filename, SHA-256, schema, and cohort field before collecting input hashes. V1's
original manifest has no cohort field; its filename and digest identify that role.
After first exposure, change the manifest status to `EXPOSED_REGRESSION` before
any subsequent `--regression` run; an immutable external attempt ledger remains
necessary to enforce the one-attempt budget across output directories. The
source-only generation receipt does not consume the candidate attempt budget.
The first source-generation or candidate attempt runner must create an exclusive
request receipt before any preflight guard and record failures even if a guard
stops the command before Node or FFmpeg starts.

The existing primary and gates remain: patched wasm-webp, PSNR at least baseline
minus 1 dB, SSIM at least baseline minus 0.01, and VP8 bytes at most the greater
of 1.25 times baseline or baseline plus 128. Candidate memory/admission rules,
presets, geometry, timing, frame cadence, and product paths remain unchanged.
This fixed-pixel check does not replace full-video, temporal, product, browser,
or Windows acceptance. V1-V12 stay exposed regression evidence and must retain
their original harnesses and receipts; no historical generator import is needed
for the independent V13 first attempt.

Exposed regression entry point is `scripts/test/owned-vp8-v2-compare.ts --cohort corrected-v13
--regression --photo-a ORIGINAL_A --photo-b ORIGINAL_B --candidate-root CANDIDATE
--output EXCLUSIVE_EVIDENCE_DIRECTORY`. The preflight validates manifest shape,
source and pixel pins, prior manifest hashes and input collisions before codec
setup. Later results report exposed scope.
