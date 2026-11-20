# #501 V14 prospective fixed-pixel cohort

V14 reserves 20 inputs in manifest order at q60, q75 and q85, for 60 conditions.
The admission thresholds remain primary minus 1 dB PSNR, primary minus 0.01
SSIM, and VP8 bytes at most `max(primary × 1.25, primary + 128)`. The prior
manifests and V13's 55/60 first result remain exposed regression evidence.

- 12 deterministic opaque RGBA patterns cover neutral, near-neutral, glyph
  edges, diagonal chroma, dark gradients, saturated boundaries, noise, mixed
  curvature, tiny, odd, wide-shallow, and large admitted inputs. The new noise
  seed is `0x501e1401`.
- Four registered disjoint source-axis rectangles in Daderot's *Wall garden -
  Red Butte Garden and Arboretum - DSC07483.JPG* are cropped and scaled to four
  fixed odd geometries. The manifest pins the original and [CC0 license](https://creativecommons.org/publicdomain/zero/1.0/).
- Four packet PTS from Saeed Jahed's *Growing Plant vimeo.webm* are selected by
  taking the first video packet at or after 1, 4, 6, and 8 seconds. The pinned
  stream index is 0, time base is 1/1000, and the selected PTS are 1000, 4000,
  6000, and 8000. Frame selection uses these PTS, bicubic resizes the video to
  fixed odd dimensions, and discards audio. The original and [CC BY 3.0 license](https://creativecommons.org/licenses/by/3.0/)
  are recorded in the manifest.

The committed recipes bind source and metadata before pixel generation. Keep
media originals and decoded pixels private and outside Git and delivered
assets. Acquire the exact original bytes from the manifest's download URLs,
then verify byte lengths and SHA-256. Keep comparator and candidate outputs
away from source-only preparation. This cohort covers packed RGBA fixed-pixel
encoding. Animation timelines, duplicate holds, ICC, resource bounds, and
whole-product behavior retain their separate acceptance scopes.

## Source-only preparation

Reserve an exclusive private request directory and record the manifest and
recipe SHA-256, original paths and digests, pinned Node and FFmpeg identities,
and command before starting. Run the generator once after review, redirecting
stdout to a new file in that directory. Retain the exit status and stderr,
including any guard failure.

```sh
node --experimental-strip-types scripts/test/owned-vp8-v14-fixtures.ts \
  --v14-photo "$V14_PHOTO" --v14-video "$V14_VIDEO"
```

The output stays `PROSPECTIVE_UNFROZEN` and changes only the 20 pixel SHA-256
fields. Review it by exact diff, then promote to `FROZEN_UNEXECUTED` by a
status-only change in a clean signed harness commit. The generator checks the
source URLs' byte identities, prior V1–V13 source and input collisions, distinct
V14 inputs, dimensions, and the exact FFmpeg version. The source-only operation
consumes no candidate attempt and supplies no tuning results.

## Sole first evaluation

After the current candidate clears its exposed regression, original-reference,
and indicative timing admissions, bind the clean signed candidate and harness
SHA/tree, core, module/provenance, patched comparator WASM and JavaScript, Node,
FFmpeg, manifest, originals, gate receipts, and a single canonical exclusive
attempt directory. Register those identities before launch. Reserve the one
attempt and write the request receipt before any candidate preflight, including
when preflight aborts. Changing the output path does not create a new attempt.

```sh
node --experimental-strip-types scripts/test/owned-vp8-v2-compare.ts \
  --cohort corrected-v14 --acceptance --v14-photo "$V14_PHOTO" \
  --v14-video "$V14_VIDEO" --candidate-root "$CANDIDATE" --output "$EVIDENCE"
```

The harness rejects an unfrozen draft, incomplete pins, tuning, acceptance
subsets, and premature regression use. Require 60 complete condition results
and check each gate before the decision. Preserve every receipt and move the
manifest to `EXPOSED_REGRESSION` after exposure. Any later evaluation requires
`--regression` and contributes exposed evidence only.
