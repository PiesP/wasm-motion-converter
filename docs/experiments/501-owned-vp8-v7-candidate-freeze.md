# Corrected-v7 prospective candidate freeze

Status: **PARTIAL, before the first v7 codec evaluation**. Production retains
wasm-webp. Preserve all earlier rejected candidates, cohorts and receipts.

## Candidate and bounded correction

Coordinator owns `codex/501-vp8-rate-refinement`. Refreshed master baseline is
`3d379275917f2ccaf8cba2c7b578ac58ce0f3db5`. Integrated engine source is
`1faca56d89492121ea05a04dcc06f04c6a7e2d10`; its complete crate and builder
match the tested worker source `a0aa27b81f0c161e060bd9088146b767d5ad9a6a`.
The first v7 report must retain its actual clean source and harness SHA,
including this prospective documentation commit, rather than relabel old runs.

The uniform high-loss q60 luma refinement fixed chroma but regressed tiny3x7;
its rejected 62/63 screen remains in the [retained result](501-owned-vp8-v6-luma-result.md).
The new input-content rule compares original and refined profiles only for the
already-defined high-input-chroma-loss q60 path. It scores chosen visible Y/U/V
reconstruction error plus each profile's frozen probability/skip/header/mode/
coefficient rate estimate under common original segment/base lambda values.
Strict improvement chooses refinement; ties choose the original. Actual mode
search retains each profile's q-derived lambda. UV quantization steps are equal.

An initial default-probability estimate reversed the actual modeled-size
frontier. That diagnostic is retained; the fixed implementation uses each
profile's existing signaling-adjusted Statistics/Model/SkipStats. There is no
new empirical threshold or quantizer sweep. The score remains an unfiltered
YUV/rate estimate, not a decoded RGB SSIM guarantee.

One reconstruction/context/coefficient working state is reused sequentially.
Preview/reset/statistics/model/rate work is resumable; large resets use at most
64 KiB and metadata resets have a separate bounded stage. No output is exposed
before the selected arithmetic-coded frame is finalized. Original wins require
a reset/reanalysis; refined wins retain their frozen analysis/model. No second
full-frame state, ABI layout/export, admission ceiling or production dependency
was added. Geometry, cadence, selected frames, import, filter, q75/q85 and the
unflagged q60 route remain unchanged.

WASM SHA256 is
`4447c92b5ec8b896ec22b2cd52219458a49e97e220ebe6406d6f9e25002fd132`:
190087 raw /41149 gzip bytes using pinned Node 26.13.1 gzipSync level9/mtime0
(zlib1.3.2.1-motley-456ae73). Both comparator and candidate delivery accounting
must use that same implementation, not a different compressor with equal flags.
Initial linear capacity 1179648 and maximum 201326592 bytes are unchanged.

## Evidence before first fresh evaluation

All **333 exposed conditions** pass every unchanged PSNR, SSIM and size gate:
45 tuning plus 288 v1-v6 regressions. Receipts retain actual candidate `a0aa27b8`
and harness `7599812e`. Maximum observed retained linear capacity 104660992 bytes
and step count 278485 are engineering/accounting observations, not physical
browser/GPU peaks or product performance acceptance.

The first v2 regression invocation supplied the wrong photo argument. The source
hash guard stopped before photo encoding; that incomplete attempt is retained
as a harness input-binding error and excluded from the 333 total. A new complete
attempt used the correct frozen original. No source, threshold or input changed.

Rust 90 default plus 14 separately selected tests, fmt, Clippy, reproducible WASM
and compiled ABI2 checks pass. Integrated maintained verify passes 9/9. Direct
Rust resource/state review found no actionable vulnerability/regression; its
Statistics comment conflict was corrected to distinguish private profile counts
from committed mode-trial state. A real-task Node probe observed all preview/
reset stages, both expected profile winners, repeated jobs, no early output,
active preview cancellation, retirement and explicit new-job recovery. Its
~1.29ms cancellation observation is Node engineering evidence, not browser Stop
acceptance. Product/browser evidence must execute this exact new module later.

## Prospective complete v7 evaluation

Full 18 inputs /54 conditions at q60/75/85, no acceptance subsets. Manifest SHA256:
`0fe8e83f194f25c2ba1f6d9e68486c46a4567d631f7db3aee4e5681bd02fa6bb`.
Generator SHA256:
`90837f385d9d5b8ab16b0716a027d25bc980238e54a46d040f43407b47d44d5c`.
Independent source-only review found no actionable finding and reproduced the
manifest byte-for-byte. No v7 codec output was read during preparation/review.

Per condition retain PSNR >= shipped baseline -1dB, SSIM >= baseline -0.01,
payload <=max(1.25*baseline,baseline+128). The primary comparator remains patched
wasm-webp@0.1.0 WASM
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`
and its already-frozen patch/glue identities. Independently decode all 54 frames
through native VP8 and libvpx and verify all three duplicate-input/preset groups.
Consume v7 freshness after this first complete evaluation regardless of result;
preserve failures and never adjust its thresholds after observation.

All existing resource/delivery/product gates remain binding: 512MiB aggregate
with stricter 90% guard, 128MiB demux, 192MiB external frame/owned linear, 96MiB
output; owned module <=482273 raw/184377 gzip. Whole-product median regression
<=max(5% baseline,20ms), active Stop-to-idle<=500ms, animations/lifecycle/current
browsers and initial/deferred/total delivery need separate actual-route evidence.
M3/M4 latest-module qualification and M5 removal/deployment remain unfinished.
No runtime removal or issue closure follows from this fixed-pixel evaluation.
