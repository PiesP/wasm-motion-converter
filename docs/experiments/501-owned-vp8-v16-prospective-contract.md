# #501 V16 fixed-pixel source freeze

V16 defines 20 opaque RGBA inputs at q60, q75 and q85 in manifest order. Each
of its 60 conditions requires PSNR at least primary minus 1 dB, SSIM at least
primary minus 0.01, and raw VP8 bytes at most `max(primary × 1.25, primary + 128)`.
The first candidate attempt budget is one.

V13's first 55/60, V14's first 59/60 and [V15's first
57/60](501-owned-vp8-v15-disposition.json) remain exposed evidence. V15's original
source registry and first result are preserved byte for byte. The current
comparator requires `--regression` for V15.

## Source decisions and custody

- Twelve deterministic patterns cover neutral, near-neutral, glyph edges,
  diagonal chroma, dark gradients, saturated boundaries, seeded noise,
  mixed curvature, tiny, odd, wide-shallow and large admitted geometry. The
  noise uses xorshift32 seed `0x501e1601`.
- Four fixed source-axis crops use David Iliff's *Grand Central Station Main
  Concourse Rectilinear projection Jan 2006.jpg*. The original is a 2500×1287
  JPEG, 1,182,771 bytes. Crop coordinates and output sizes were declared before
  obtaining the original. [Source revision](https://commons.wikimedia.org/w/index.php?title=File:Grand_Central_Station_Main_Concourse_Rectilinear_projection_Jan_2006.jpg&oldid=927156370), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Four fixed timestamps use Jan Ainali's *Escalator Södra station 2019.webm*.
  The original is 2560×1440 VP9/Opus, 18,092,630 bytes. In absolute presentation
  time, the first video packet at or after 1375, 4750, 7875 and 11125 ms has
  PTS 1407, 4774, 7907 and 11140 respectively. Stream 0 has time base 1/1000.
  The recipe uses FFmpeg's native VP9 decoder, bicubic scaling to fixed odd
  sizes, and checks opaque RGBA. [Source revision](https://commons.wikimedia.org/w/index.php?title=File:Escalator_S%C3%B6dra_station_2019.webm&oldid=813105970), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

The acquisition verified publisher byte counts and SHA-1 before computing the
manifest SHA-256 identities. The source-selection declaration SHA-256 is
`9c2f31d078338fce680f05097a812a9116b16172a2105e0c28c16c6178ba8b28`.
The source-only demux receipt is
`25f9ecdc2a4a066f200692bcd5a5dfbf63d044485a4c76b5f6366de00b9a8a76`.
The generation ran on Node 26.13.1 with pinned FFmpeg 7.1.5 and checked the
V1–V15 registry chain for distinct originals, IDs and packed input digests.
It filled 20 pixel digests and emitted manifest
`af6bee74db549de604c2c6f6b384162188256c922ee0d27161d41bfce7d37477`.
Changing the status field to `FROZEN_UNEXECUTED` sealed the
[V16 registry](501-owned-vp8-v16-fixtures.json), SHA-256
`a3760f36a26c821677becdddb87732f04a77327dfe445072ddc046e4d101a2be`.
The originals, decoded or generated pixels, and private source receipts remain
outside Git and distributions. The source-only operation used zero candidate
and primary encodes and left the candidate attempt budget untouched.

## Admission and one-shot execution

Register only after one exact signed candidate passes all 867 exposed conditions,
full installed original-reference whole-preset quality, and all six indicative
first/warm groups from AB and BA. The owner registers the exact signed
candidate source, tree, core, module, registry source and tree, patched primary,
toolchain, source identities, receipts and admission lock in issue #501.
Each attempt includes preflight. Interruption, preflight failure and failed
conditions consume the one canonical reservation.

The coordinator's private launcher reserves the sole attempt directory and
validates the prospective issue registration before launching the comparator.
The comparator checks that reservation, the signed checkout identities and the
867-condition admission. On the qualification host, it opens each receipt once
with no-follow and nonblocking flags and verifies user ownership, single-link
regular-file status, mode 0400 and size on the descriptor. Limits are 16 KiB for
the request and issue-owner readback and 1 MiB for the admission lock. It verifies
the prebuilt module and both development comparator files, then creates the
`rows` subdirectory exclusively and reads the private originals. It rejects
V16 tuning, regression, incomplete acceptance subsets, and pre-existing output.

```sh
node --experimental-strip-types scripts/test/owned-vp8-v2-compare.ts \
  --cohort corrected-v16 --acceptance --v16-photo "$V16_PHOTO" \
  --v16-video "$V16_VIDEO" --candidate-root "$CANDIDATE" --output "$ATTEMPT/rows"
```

Read back all 60 output identities and gates before recording the disposition.
Product timing, Stop, temporal/ICC, memory, browser routes, assets and delivery
retain their own qualification evidence.
