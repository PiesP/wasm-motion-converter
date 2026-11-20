# #501 M3 bounded ABI2 step batch: prospective control

Status: **PARTIAL ENGINEERING**. This change is not codec or product adoption. Its source baseline is `9698e01371fce297cf8ff15a44ae050f81d11320` on
`codex/501-vp8-bounded-step-batch`. The engineering checkpoint below records tests and compiled WASM decoding.
The source-bound Node comparison below is complete; its joint timing criterion fails.
No browser run or Windows acceptance has been performed for this batch.
The existing BD170 quality failures and the reported roughly 45 s owned versus
17 s prior V8 product result remain failed evidence; neither is superseded.

## Single change and invariants

The production `vp8_v2_step` export now runs at most 16 existing
`FrameEncoder::step` internal units. It validates the ticket, cancellation and
phase before the loop; after each unit it publishes the current `ResourcePlan`
into ABI state and checks actual linear capacity. It returns immediately on
completion/output lease, any internal stage change, any reported public/variant
stage change, or any resource-plan change. The plan change before
`PrepareOutput` is an export boundary: the host must admit the published plan
before the next call can allocate final output. An internal error retires the
instance. Host task yielding and Stop occur between exports, never inside one.

The ABI2 twelve-word request, 96-byte response, status/ticket/lease protocol,
eleven exports plus memory, imports, dependency set, limits and output format
remain fixed. No new heap buffer or unsafe code is introduced. One ABI export
can now advance multiple internal units, so prior step-count and exact-response
traces cannot be reused as cadence evidence. The host `steps` metric counts
actual export calls. A fixed count does **not** bound any call's elapsed time
or prove Stop-to-idle within 500 ms.

The original V8 observation was 7,972,274 ABI step calls. Amortizing call,
mutex and response-refresh cost is a hypothesis, not a measured gain. The
current release profile already uses `opt-level = 3`; this is not an O3 trial.

## Frozen local comparison before performance claims

Use the exact source/module/build identity, five fixed actual RGB frames and
unchanged input bytes, presets, settings and resource ceilings on both controls.
First run one 20-row exact-output and control check. Require identical raw VP8
bytes, ticket/lease outcomes, stage and plan admission barriers, and retained
capacity. Then take 10 warm-up runs and 40 balanced measurements across the
five frames with the one-unit control and fixed-16 candidate. Save every sample,
median, range, MAD, module/source IDs, capacity and actual ABI export-call count.
Further product qualification requires at least 5% median improvement in at
least four of five frame controls and no frame more than 2% slower. This is a
local screen, not a replacement for product acceptance.

The product still requires prepared-Windows, source-bound Stop-to-idle <=500 ms,
no cancelled/stale publication, same-document recovery, and whole-product median
increase <= max(5% of prior median, 20 ms), with exact output and independent
animation acceptance. Keep the 512 MiB conversion, 128 MiB demux, 192 MiB frame,
96 MiB output and 482273 raw / 184377 gzip asset limits. Retain wasm-webp until
all independent M2/M3/M4/M5 and product gates pass. No new V13, product or
benchmark evidence is claimed here.

## Engineering checkpoint

Pinned Rust1.99.1 fmt/check, the focused1-vs16 state-consistency test,162 ordinary
native tests,17 explicit independent-decoder/property tests and all-targets
Clippy with warnings denied pass. The test checks capacity after each internal
unit, stage/plan fences and ticket/output-lease behavior. It uses independent
states with the same implementation, so it does not replace the planned old
binary comparison. Direct defensive review found no confirmed vulnerability.

Maintained WASM generation, byte-identical rebuild and prebuilt verification
pass. The initial compiled command failed its old stage43 per-export progress
limit1. Exact script/module/provenance/temp streams remain in private
`compiled-work-contract-first-failure-01`. Per-internal-unit limits remain
unchanged; an independent fixed16 export contract now bounds progress by
16 times those limits. A separate corrected command passes all48 compiled
ABI2 cases, including unchanged known bytes, independent decoding and leases.
The original failed command is not relabeled PASS. Static follow-up review
found no regression from that contract adaptation.

Module `a88a2855f59564cfad824e527f9da40b74798f86b7861e6ad06eee224c6cc1c2`
is246058 raw/81966 Node gzip level-9 bytes, with initial
1114112 and maximum201326592 linear bytes, zero new imports or dependencies.
All28 closed inputs and the artifact were independently rehashed. Provenance:
`a0e9b78f265032b0d89342ee21be8a448e489cd7229f5c208a1b4fb4235f98b3`.

Maintained application verification at the measured source passes all11 tasks
with the required sourced environment, no cache and task concurrency1. An earlier
explicit-Node pass omitted the shell setup; its receipt remains separate. The
four focused product adapter/core/memory/failure test files also pass28 tests.
Actual-browser cancellation and final platform/resource/delivery gates remain
unrun for this point. A fixed16 quantum is not elapsed-time evidence.

## One completed Node comparison: defer product qualification

Measured source `bc6fe7bc8e5a9f516ceccba7210cc223b25bd069` and module above
were clean and signed before execution. Control source
`9698e01371fce297cf8ff15a44ae050f81d11320` uses module
`bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e`.
The installed ABI driver is source `b9b7e8939cf6139db6db778d11f2519567fe61c2`,
file SHA256 `12bc2db34d6ea56853c8c3d0c3264fd31ed9a34125badf5a4ca6c30e1b1baba3`.
Exact Node26.13.1 and five captured1920x1080 packed-RGB q60 frames were pinned
before measurement. No pixel, preset, frame selection or safety ceiling changed.
The control is an owned encoder, not the shipped wasm-webp primary comparator.

The immutable phase1 lock is
`21d28be5a71cefa7816f8c7637dea1b7658e31f8dbb453ec8c970bd431181f60`.
All20 first/warm encodes match exact raw bytes, final retained linear capacity
and logical stage/plan-admission transitions between variants. Within-conversion
bytes, final capacity and stage order also match. Phase1 summary:
`54b7fb94c8b0e078d165a43fb728fa2a53e37650d5e89aeeb6f673334365e224`.
Physical growth trajectories and export counts were observed separately.
First-frame calls decrease from103168–103823 to6514–6597 across the five inputs.

A separate phase2 lock
`cf88ab74b2f0ed1e9eb788350e54a7511ee292ce7aa6a242fca0ee1b7b2bb961`
binds the unchanged first lock and settled summary. Exactly10 warm-up conversion
jobs and40 balanced timed jobs ran once, each with first and warm frames:
100 encodes total. Each timed variant/frame/cache has four samples. The actual
process exits0 with no timeout or output/hash/size/final-capacity mismatch.
Process success does not establish the timing criterion.

| Input | First median gain | Warm median gain |
| ----- | ----------------: | ---------------: |
| 0     |            7.572% |           8.213% |
| 19    |            7.941% |           7.687% |
| 38    |            8.284% |           7.763% |
| 57    |            0.456% |           7.860% |
| 76    |            2.738% |          10.405% |

The prospective condition requires at least5% median improvement on at least
four of five inputs and none more than2% slower, **separately for first and
warm**. Warm passes5/5; first passes only3/5. The joint criterion **FAILS**.
Disposition: **DEFER_PRODUCT_QUALIFICATION**, with no unchanged rerun or Windows
product qualification for this point. All samples, ranges and median absolute
deviations remain retained; no threshold changed after observation.

Phase2 summary SHA256:
`26680b975d8a671ad034831167ddb47a6d2ba036fe7eb2a0d0e855e1830ade3c`.
Samples SHA256:
`f3b0ceb9ab136b8877261c574b8097f823be15d72b6aba4812f0687c389fdb23`.
Every retained linear capacity is20512768 bytes. This is not physical peak
memory or zero-copy evidence. Maximum observed Node step time12.051ms is not
actual browser Stop-to-idle proof. Driver ABI validation, copies, cooperative
yields and per-export duration sampling are included in these Node encode
timings; module compilation, input reads and post-encode hashing are excluded.
They do not establish whole-product performance.

Production wasm-webp remains. Prior M2 quality failures and product latency
remain open; any successor needs a material change and new prospective evidence.
