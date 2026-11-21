# Owned demux differential fixtures

Synthetic inputs generated from owned FFmpeg color/testsrc2 sources. No owner
media is included. `oracle.json` freezes patched MediaBunny 1.65.2 metadata and
decode-order packet identities, verified-key seeks and independent FFmpeg
decoded-frame hashes. Its source/patch/toolchain/input digests retain provenance.
The owned fixture generator and maintained E2E generator own reproducible input
commands; existing no-index/no-cues fixtures retain their original test source.

The four `owned-lacing-*.webm` files are derived from the independently decoded
`mediabunny-clustered-no-cues.webm` key packet by
`scripts/test/generate-owned-demux-lacing.ts`. Their frozen trace was captured
under the same patched MediaBunny 1.65.2 oracle at a later source revision;
`oracle.json` retains the original source identity and records the additional
source and manifest hashes separately. Xiph, fixed-size, and EBML lacing plus a
long default-duration case are distinct fixtures. The captured independent
FFmpeg packet and decoded-frame evidence stays attached to each oracle entry.

Six codec and timing variants are generated with
`generate-owned-demux-fixtures.ts OUTPUT --variants`: VP9 10-bit and full-range
WebM, AVC and HEVC full-range BT.709 with 2:1 sample aspect, AVC3 in-band
configuration, and a positive MP4 edit prefix. Each succeeded under the pinned
patched development oracle and has its own input digest and independent FFmpeg
packet/decode record. The additional source and generator-manifest digests in
`oracle.json` identify this later cohort; they do not replace the original
29-fixture source identity. Generated compressed inputs remain test-only and
outside `public/`.

Run focused actual compiled-WASM checks through the maintained Vitest unit
project to qualify the owned demux. The MediaBunny comparator is a development
dependency. Additional malformed/codec-variant inputs must be frozen
before their candidate comparisons; do not rewrite previous failed receipts.

The later `avc-fragmented-audio-first.mp4` regression uses AAC track1 before
AVC video track2 and ordered `trex` entries1,2. Generate it alone with
`generate-owned-demux-fixtures.ts OUTPUT --audio-first-fragment`; `--variants`
also includes it. Its extension provenance and the unchanged prior39-entry
array digest are recorded separately in `oracle.json`. The actual patched
oracle, independent packet/decode trace and compiled comparison guard selection
of video fragment defaults when audio precedes video.

The later `avc-bframes-vfr-signed-ctts.mp4` fixture combines B-frame decode order,
variable presentation intervals and signed composition offsets. Generate it
alone with `generate-owned-demux-fixtures.ts OUTPUT --presentation`. Its pinned
oracle and independent FFmpeg packet/frame trace use explicit
`-fps_mode passthrough`; source/tool/manifest identities and the unchanged prior
40-entry array digest remain in the new extension record. It guards duplicate
presentation timestamps and presentation-derived packet durations, separately
from the private owner input whose original failure receipts stay private.
