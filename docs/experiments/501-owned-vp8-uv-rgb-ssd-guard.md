# #501 mixed-Y1-AC UV RGB SSD guard: partial diagnostic result

## Hypothesis and retained evidence

The BD170 V8 capture at product source `ffa113f5` was independently decoded by reader `4ca407d8` using native VP8 and libvpx for all 77 frames. The later qualification source `9698e01371fce297cf8ff15a44ae050f81d11320` produced byte-identical saved V8 outputs; its retained decoder evidence has that explicit artifact-equivalence basis. The original-reference diagnostic at reader `11f36894` failed PSNR rows 70, 75, and 76, with the worst delta at -1.7045 dB. The five actual-browser-RGB residual controls passed. The private primary q60 diagnostic reproduced 57/76 raw VP8, while a q100 import diagnostic remained lossy. The 24 independent YUV/RGBA child reports in `v8-primary-color-import-diagnostic-01/decode-01/status.json` (SHA-256 `1255d865427cf134710321cf73776c1401f65a6a3f00c3efd18e2e1dae513a10`) show aggregate owned q60 UV mean bias of about +0.23 to +0.40 relative to the imported source. Those aggregates do not establish import-plane identity or the cause of the PSNR failures.

One plausible contributor is that local UV trials selected by display-proxy SSIM can increase squared RGB error against the source. This point tests only that choice. It does not change import, color matrix, frame classification, presets, qindices, quantizer tables or steps, base prediction, filtering, rate and size gates, or frame cadence.

## Single bounded change

For the existing q60 `mixed_y1_ac` profile, both the selected single UV edit and each joint UV beam trial require non-increasing integer source-RGB SSD over changed metric samples. The score is accumulated once for each changed RGB sample in the existing `LocalCache` render pass, before that pixel is scattered into overlapping SSIM windows. The SSIM gain retains its previous summation order and decides among permitted trials. Rejected joint proposals still consume their original quota; the beam may exhaust early if no permitted path remains. No search-depth or proposal-quota increase, heap buffer, frame-wide buffer, ABI, or replay format is added. Other profiles continue to use the pure SSIM decision.

The guard uses the proxy's sampled display RGB: dimensions below eight are nearest-expanded for the metric, and incomplete four-pixel tails outside all SSIM windows are excluded. It is neither a full physical-pixel SSD check nor an independent decoded-RGB PSNR guarantee. Later prediction, deblocking, and profile selection can still change the completed frame. Retaining different UV coefficients can also affect raw VP8 size.

## Initial static proposal status and next gate

At the initial static handoff, engineering and codec checks had not run. The native checkpoint below records subsequent execution. Complete the remaining source-bound WASM and compiled ABI gates before the prospective 50-condition screen (45 tuning plus five actual-browser-RGB controls) and the five original-reference fidelity controls. Keep source-bound comparators and every prior failure. Only a promising result proceeds to the full cohorts. No PSNR, SSIM, size, performance, Windows, or product acceptance improvement is claimed here.

## Native engineering checkpoint

Pinned Rust 1.99.1 formatting and `cargo fmt --check` pass. The exact single
selection activation test passed first: it demonstrates an actual selected
SSIM-favorable, SSD-increasing UV edit and verifies guarded selection and
unchanged shared state. Independent static review reports no remaining defect.
The corrected source passes two focused sampled-SSD tests, all 163 ordinary
native tests, all 17 separately invoked independent-decoder/property tests,
and all-targets Clippy with warnings denied. The first Clippy arity failure
is retained: the constructor now takes an immutable U/V slice pair with the
same plane order; no warning allowance or scoring rule changed.

The native-check-02 source digests are:

- `display_rgb.rs`: `875a3eb54f6047df7267e60c241ceb931fb07032ffc699efc201310d0b2fd3a6`.
- `textured.rs`: `6bc0b0e786b621f49123b510185e68a0e0fcc251bd32bef1288e24472a4fd002`.
- `joint_refinement.rs`: `8e5dbfdc35b85cd6072b6efcb62335940dcb9684fc6a7969fd45904ef22d52dc`.

The source-bound WASM checks are recorded below. The diagnostic quality and size screen is recorded below. No performance,
browser or fresh V13 measurement has run for this trial. The
previous BD original-reference PSNR failures and product latency remain
unresolved; the test witness proves the guard path, not the cause or a fix
for those measured failures.

## Compiled artifact checkpoint

The maintained generator, reproducible rebuild and prebuilt checks passed with
pinned Node 26.13.1 and Rust 1.99.1. The artifact is
`6b4bbf1189f7c5685038d80d5ff0dc275afbdaeb232c8203e0a038ca8ba936a9`,
246,671 raw bytes and 81,975 bytes using Node gzip level 9, mtime 0.
It has zero imports, the unchanged ABI2 exports and fixed memory maximum.
All 48 compiled ABI2 engineering cases passed, including independent decoding
and pending input/output lease and stale-publication checks. Root independently
rehashed all 28 provenance inputs and the generated module. Provenance SHA-256:
`1b34bf9c51a5434a491623bc9e36f05c7a3f18851964051a758443628988fd8b`.

These checks establish engineering behavior for the compiled artifact, not the
required quality/size frontier or product latency. The measured source is signed commit `844cfcb9f084ff663ac8198f68372387394f1b71`.
The exposed screen results follow. Fresh V13 candidate encodes remain zero.

## Frozen diagnostic screen result

The source above completed the prospectively frozen 45 tuning conditions and
five actual-browser-RGB controls. Every row passed PSNR, SSIM and raw VP8 size
gates against the shipped patched wasm-webp comparator. All five actual controls
were independently decoded with native VP8 and libvpx. The saved 45-condition
artifacts also passed 180 decoder children for 90 primary/candidate streams,
with both decoder RGB hashes matching the retained metric RGB. No reencoding or
threshold change was used for that saved-stream verification.

The five separate original-source-reference comparisons passed SSIM, but
frame 76 failed PSNR: 40.996814 dB versus primary 42.701327 dB, a -1.704513 dB
delta against the unchanged -1 dB floor. Its raw VP8 and decoded RGB are
byte-identical to BD170. Frames 0/19/38/57 passed the original-reference gates.
This sampled-SSD policy therefore has not corrected the worst source-reference
failure and does not qualify production adoption. Its 10,760-byte frame 76
remains below the unchanged 10,815-byte size limit.

Private retained receipts under `uv-rgb-ssd-guard-01/quality-preparation`:

- Frozen five-screen lock: `8b87090d99ed72de1f87514a87715b89a0d631a190d603c1a5bfd5cab07ebe6f`.
- New 45-row results: `a44f20528deda76bb8d6ec49c420cbbaf80122f8d1fcde17ce71a3ccf5bb88dc`.
- Saved-stream decoder summary: `fe2a024094268e252e9a2d2015b4f86c33fbb96e74891b0b6ee718de69a8b4a1`.
- Independent root result audit: `e67dec6dfbb66bef13146a02becc8a88b57d041f58205e69e17a1f7754d0a80b`.

Status is PARTIAL / RETAIN_CURRENT. The full 77-frame screen, full 687-condition
cohort, fresh V13, product performance, resource and delivery acceptance were
not run for this source. Production wasm-webp stays in place. Continue with a
separately frozen correction candidate; preserve this result and all failures.
