# #501 M3 bounded ABI2 step batch: prospective control

Status: **PARTIAL ENGINEERING**. This change is not codec or product adoption. Its source baseline is `9698e01371fce297cf8ff15a44ae050f81d11320` on
`codex/501-vp8-bounded-step-batch`. The engineering checkpoint below records tests and compiled WASM decoding.
No benchmark, browser run or Windows acceptance has been performed for this batch.
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

Maintained application verification, actual-browser cancellation, exact old
binary comparison, performance and final platform/resource/delivery gates
remain unrun for this point. A fixed16 quantum is not elapsed-time evidence.
Production wasm-webp remains; prior M2 failures and product latency are open.
