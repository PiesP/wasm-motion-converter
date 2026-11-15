# Corrected-v7 fixed-pixel result: rejected 51/54

The prospectively frozen candidate is **REJECTED for adoption** under unchanged
gates. Issue #501 remains ACTIVE/PARTIAL and production retains wasm-webp.
The bounded profile-preview implementation is retained engineering progress;
its passing 333 exposed conditions do not override these fresh failures.

## Frozen source and evidence

Actual candidate/harness source:
`da3b60ed58b162bc1e929617e6a54f50b6f3b4aa`; integrated engine `1faca56d`,
tested engineering source `a0aa27b81f0c161e060bd9088146b767d5ad9a6a`.
WASM SHA256:
`4447c92b5ec8b896ec22b2cd52219458a49e97e220ebe6406d6f9e25002fd132`.
Manifest SHA256:
`0fe8e83f194f25c2ba1f6d9e68486c46a4567d631f7db3aee4e5681bd02fa6bb`.
The [prospective freeze](501-owned-vp8-v7-candidate-freeze.md) was committed
and recorded in #501 before every v7 codec output. The comparator remains
shipped patched wasm-webp@0.1.0 WASM
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.

All 18 inputs ran once at q60/75/85, 54 conditions. PSNR 54/54 and size 54/54 pass;
SSIM 51/54 passes. No fixture, threshold, settings or gate changed.

| Failed condition / SSIM | Baseline | Candidate | Required minimum | Other gates |
| --- | ---: | ---: | ---: | --- |
| fresh7-tiny-2x9 / q60 | 0.551978 | 0.540391 | 0.541978 | PSNR and size pass |
| fresh7-tiny-5x1 / q85 | 0.314908 | 0.266133 | 0.304908 | PSNR and size pass |
| fresh7-tiny-1x11 / q75 | 0.713024 | 0.685721 | 0.703024 | PSNR and size pass |

Payloads are respectively 98/81/92 bytes against baseline 80/76/86. Their tiny
metric inputs use the previously frozen nearest replication to minimum 8x8;
encoded geometry remains exactly 2x9/5x1/1x11. Preserve these failures rather
than revising metric/geometry/quality intent after observation.

Results JSON SHA256:
`3af151b666caff2dd8cac3fbc72c033fdd8c7aadf41bcd63797890f4e9c21a26`.
Identities JSON SHA256:
`7d29d4377b36f88b7d9a736d7c22383897237a1f805d79f4caf8b99c138a8bc5`.
Raw inputs, outputs, independent RGB metrics and source/build identities remain
privately retained in `m2-corrected-v7-acceptance-01` under the task artifact root.

## Independent correctness and resources

All 54 source/hash/geometry-bound candidate payloads decode to identical visible
YUV through explicitly selected FFmpeg native VP8 and separate libvpx decoders.
All three duplicate-input/preset groups have identical candidate payload hashes.
The separate proof retains `qualitySizeStatus: REJECTED`; SHA256
`1fde00ed7c69e5376370f12be5ae1dd863453bb6e233bf6d9c58781953d085fa`.
Verifier source/logs and decoded proof remain in `verify-v7-independent.py` and
`m2-corrected-v7-independent-01`; earlier verifiers and failures are unchanged.

Maximum recorded retained linear capacity 104726528 bytes is accounting, not
physical browser/GPU peak evidence. Module 190087 raw/41149 pinned-Node gzip,
initial linear 1179648 and declared maximum 201326592 remain within unchanged
ceilings. Fixed-pixel decoding does not qualify actual product speed, Stop,
animation/temporal fidelity, browsers or dependency/asset removal.

## Next owned action

V7 is now exposed and every later use requires `--regression`. No fresh
successor is frozen. The expanded known matrix is 387 conditions. Diagnose all
three tiny inputs across presets: source-import equality, import-only and
plane-mixed RGB metrics, visible/padded error and actual mode/quantizer choices.
Do not assume the q60-only profile causes q75/q85 failures or introduce a
geometry/fixture exception. A generic corrected algorithm requires controlled
evidence and all existing resource/quality gates. M2 stays ACTIVE; new-module
M3/M4 and M5 remain unfinished. This result does not close #501.
