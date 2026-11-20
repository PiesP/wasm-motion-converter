# #501 V15 fixed-pixel source freeze

V15 registers 20 inputs at q60, q75 and q85 in manifest order, for 60
conditions. Each condition requires PSNR at least primary minus 1 dB, SSIM
at least primary minus 0.01, and VP8 bytes at most
`max(primary × 1.25, primary + 128)`. The first candidate attempt budget is one.

V13's first 55/60 and V14's first 59/60 remain historical exposed results.
The V14 original source freeze stays byte-identical. Its separate
[disposition](501-owned-vp8-v14-disposition.json) binds the consumed
first result. On this harness revision, V14 requires `--regression`.

## Inputs and custody

- Twelve deterministic opaque patterns cover neutral, near-neutral, glyph
  edges, diagonal chroma, dark gradients, saturated boundaries, seeded noise,
  mixed curvature, tiny, odd, wide-shallow and large admitted inputs. The
  noise seed is `0x501e1501`.
- Four disjoint source-axis rectangles sample Acediscovery's *Rotterdam
  aerial photograph.jpg* at fixed odd dimensions. The original is a
  1581×1383 JPEG of 2,326,693 bytes. The manifest retains the exact
  revision and author attribution. [Source revision](https://commons.wikimedia.org/w/index.php?title=File:Rotterdam_aerial_photograph.jpg&oldid=1226096299),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Four packet PTS sample Chazzie1769's *River Bank-Closeup.webm*. The
  original is 1920×1080 VP9/Opus and 23,973,140 bytes. The first video
  presentation packet at or after each predeclared time, 1, 4, 6 and 8
  seconds, has PTS 1001, 4004, 6006 and 8008 at a 1/1000 time base on
  stream 0. The container signals an alpha mode. The fixed-pixel recipe
  explicitly uses FFmpeg's native VP9 color decoder, produces opaque
  RGBA, verifies output alpha, bicubic scales to the prescribed odd
  dimensions and discards audio. [Source revision](https://commons.wikimedia.org/w/index.php?title=File:River_Bank-Closeup.webm&oldid=1204104561),
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)

Geometry, crop rectangles, times and noise seed were declared before
retrieval. The acquisition verified publisher byte lengths and SHA-1
before computing the manifest SHA-256 pins. The source-only demux receipt
binds the packet selection. The original bytes, receipt paths, and all
generated or decoded pixels stay in private custody outside Git, fixture
shipping and distributions. Source URLs and binary digests in the
manifest identify the originals.

The sole source-only run used Node 26.13.1 and the pinned FFmpeg 7.1.5
build. It verified the prior V1–V14 manifest chain and distinct source
and input identities. Its emitted manifest
`2f76960b6f0bfc73c0a47809b9ae4404355ce933f84f1be0a24dd712f28619d3`
changed the twenty pixel digest fields. The reviewed promotion then
changed only `status` to `FROZEN_UNEXECUTED`. The result is the
[V15 registry](501-owned-vp8-v15-fixtures.json), SHA-256
`2025389427eaac1f938b827410156f89149df91556141b97a7bcd2cee4a55d05`.
The source-only operation used no candidate or primary encoder and spent
no candidate attempt.

## Admission and one-shot execution

Before registering, require one exact signed candidate with complete
exposed regression (747 earlier conditions plus V14's 60), paired
original-reference whole-preset quality and all three first/warm
indicative AB+BA comparisons. The owner registers the exact signed
candidate, registry SHA/tree, core, module, patched primary, toolchain,
source hashes, evidence and attempt lock. Use the one approved canonical
private directory and reserve it before any candidate preflight. Failed
preflight, interruption and a failed condition consume the attempt.

Only the coordinator's one-shot launcher should invoke the comparator
below. It checks the current issue registration and reserves the canonical
directory before starting the child. Pass its new `rows` subdirectory
as the output. Before reading originals, the comparator verifies the
reservation, admission lock and owner readback, checks the committed
candidate and registry identities, verifies the candidate prebuilt and
both patched primary files, and creates the output directory exclusively.
On the qualification host, each receipt is opened without following its
leaf symlink. The comparator validates the owner, mode, file type and length
on that same descriptor before reading it. Requests and owner readbacks
are capped at 16 KiB each, and the admission lock is capped at 1 MiB.
It rejects V15 tuning, acceptance subsets, wrong-purpose manifests,
existing output and foreign fixture inputs.

```sh
node --experimental-strip-types scripts/test/owned-vp8-v2-compare.ts \
  --cohort corrected-v15 --acceptance --v15-photo "$V15_PHOTO" \
  --v15-video "$V15_VIDEO" --candidate-root "$CANDIDATE" --output "$ATTEMPT/rows"
```

Read all 60 retained row identities and their independently recomputed
gates before classifying the outcome. Preserve the original source
manifest and first result. After exposure, later executions contribute
exposed regression evidence only. Whole-product timing, Stop, timeline,
ICC, memory, assets and installed-browser routes have separate gates.
