# Corrected-v6 prospective candidate freeze

Status: **PARTIAL, before first v6 codec evaluation**. This records a new
candidate; it does not replace any failed v1-v5 result or authorize runtime
removal. The production comparator remains the shipped patched wasm-webp.

Historical freeze retained unchanged below. Its first evaluation has now
completed and rejected the candidate, 53/54; see
[the result](501-owned-vp8-v6-result.md). V6 is now exposed regression evidence.

## Source and hypothesis

Coordinator owns `codex/501-vp8-rate-refinement` in the isolated qualification
worktree. Refreshed master remains `3d379275917f2ccaf8cba2c7b578ac58ce0f3db5`.
Engine commit `ea096ca50580e666509f88cb07d3e955c957f3ca` integrates the independently
reviewed flat-UV DC tie reduction. Harness/source-cohort commit
`c08f476e451d0f3d0556e06b8160147a38df0335` adds v6 without changing that engine.
The first evaluation must record its actual clean source, harness and manifest
identities, including this documentation commit.

The candidate retains complete residual/mode/filter/segment coding. Its q60
input-only chroma-loss estimate selects frozen UV deltas after color import;
q75 chromatic-flat blocks may discard a unit DC only when visible clamped
pixel SSE does not increase and same-context estimated coefficient cost falls.
Trials retain private reconstruction and contexts until selection. No geometry,
cadence, selected frames, color import, ABI or resource ceiling changed.

Owned module SHA256 is
`3abc7a2086a6f83c46da95558b881ec80adf2ecdcb2c184134bd0a1b4f0a0202`:
180952 raw bytes, 38079 gzip bytes using pinned Node 26.13.1 gzip level9/mtime0.
Initial linear capacity is 1179648 bytes; declared maximum is 201326592 bytes.
No new external production Cargo dependency was added.

## Evidence available before fresh evaluation

All 279 exposed conditions pass PSNR, SSIM and size independently: the existing
45 tuning conditions plus 234 v1-v5 regressions. The tuning receipt retains its
actual worker commit `4883e6d3bf9c765d5c1985318ea26c2d5c136072`, whose complete
tree was verified equivalent to integrated engine `ea096ca5`; it is reused,
not relabeled as a new run. The 234 regressions ran at clean `ea096ca5`.
Maximum observed retained linear capacity was 104660992 bytes, an accounting
observation rather than a process/GPU peak measurement.

Rust 1.99.1 default tests passed 87 with 14 explicitly ignored; those 14 then
passed separately, including independent decoder controls. fmt, Clippy with
warnings denied, reproducible WASM check, compiled ABI2 checks, 15 cohort tests
and maintained `verify` (9/9 tasks) passed on the integrated source. Local
correctness and exposed controls do not establish fresh acceptance or product
performance. Focused independent correctness/security reviews found no open
finding in the latest two corrections.

## Prospective v6 evaluation

The complete 18-input / 54-condition manifest SHA256 is
`7451495d9c36648193d6864d2e68318262989a32c5cb3e621acd9232dc7e9c2b`.
Generator SHA256 is
`2d2bbb3e87808874cb4d1857457240efe6ef0c68d9a2e1808372d76dc894dfc7`.
Use the full `corrected-v6 --acceptance` cohort at q60/75/85, no subsets.
Preserve every output and failure. Retire freshness after the first evaluation
regardless of its outcome; a corrected engine requires properly controlled new
acceptance evidence. No threshold changes follow observation of a failure.

Per condition require PSNR >= shipped baseline -1 dB, SSIM >= baseline -0.01,
and payload bytes <= max(1.25 * baseline, baseline +128). Finite negative SSIM
is valid; nonfinite metrics cannot manufacture a pass. The primary oracle is
wasm-webp@0.1.0 WASM SHA256
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`,
with the already frozen patch/glue identities. Independently decode all 54
candidate frames with FFmpeg native VP8 and libvpx and verify all three exact
duplicate-input groups. Fixed-pixel acceptance does not establish animation,
whole-product performance, actual browser or removal acceptance.

All existing resource/delivery and product gates remain binding: 512 MiB
aggregate with the stricter 90% guard, 128 MiB demux, 192 MiB frame/owned linear,
96 MiB output; owned WASM <=482273 raw /184377 gzip bytes. Product median
regression <=max(5% baseline,20 ms), active Stop-to-idle <=500 ms, and unchanged
initial/deferred/total delivery budgets require separate actual-route evidence.
Keep wasm-webp production behavior until M2-M4 and removal/delivery gates pass.

Next action: complete independent source-cohort review, record this candidate
in #501, then run all 54 fresh conditions once. M3/M4 latest-module animation,
browser, lifecycle, repeated-job and balanced product performance evidence and
M5 executable-asset/deployment reconciliation remain outstanding.
