# Exposed q60 luma correction: rejected 62/63 screen

The one-point candidate is **REJECTED**, retained on
`codex/501-vp8-v6-color` at
`b66d802c3fb1a7069312eec6865bbc53ca4b9e08`, and not integrated into the
qualification or product branch. Its parent is the frozen v6 source
`472666ae347d933f010ae261a65187357b424dfd`. The unchanged comparator remains
shipped patched wasm-webp. No fresh acceptance or production removal is claimed.

Input-only/plane-mixed diagnosis of the original v6 q60 chroma failure supported
a bounded luma-precision experiment, with no monotonic RGB-SSIM guarantee.
Only the existing high-input-loss q60 profile lowered all segment/base qindices
by four and raised UV deltas by four, preserving effective UV quantizer steps
including clamps. Lambda explicitly followed the new qindex. The profile was
frozen before analysis/header/count/emission in both sync and ABI2 paths;
import, threshold, classification, filter, geometry, cadence and ceilings stayed
unchanged. This exact point and screen were recorded in #501 before evaluation.

The module SHA256 is
`00e700da92577f74417e61678101c713eaf3f0e6c40bc4e73d2a5f3b082dbdf0`,
181502 raw /38348 pinned-Node gzip bytes. Rust default 88 plus separately selected
ignored 14 tests, fmt/Clippy, reproducible WASM and compiled ABI2 checks passed.
Independent source review found no actionable Standards/Spec issue. An initial
ignored test incorrectly expected the neutral textured q34 path to become 28;
the correct result is 30. The failed receipt and passing correction remain.

The unchanged clean harness at `a3df8e60750c5005c451dd1141bc069b71cef609`
ran the prospective exposed screen: tuning 45/45, v5 controls 6/6, v6 controls 11/12.

| q60 condition | Prior candidate SSIM | New candidate SSIM | Required minimum | Outcome |
| --- | ---: | ---: | ---: | --- |
| fresh6-chroma-edge | -0.090742 | -0.083493 | -0.088510 | Corrected |
| fresh6-tiny-3x7 | 0.039925 | 0.024346 | 0.032547 | New failure |

Both conditions pass PSNR and size. Chroma payload is 38,257 bytes, tiny 89 bytes.
The six v6 q75/q85 subset payloads match prior hashes; the two unflagged tiny
q60 controls also match. This does not assert untested controls are unchanged.

Results JSON SHA256 values: tuning
`dc464928de21fe44eecdb246be0b04cd8f78ba097b43aa2d774154e3890a33a4`, v5
`97b73c22e15ec7f788036cf3702e0456acacbb0caba006a66a285b2723696769`, v6
`a0a6eb8557d8fe4ae8b81ac73d40fa0de700c6dc564d23ed6e4989768e1b306b`.
Raw receipts, outputs and failed tests remain privately retained in
`v6-luma-point/` and `v6-luma-screen-*` under the task artifact root.

Per the prospective stop rule, the 333-condition matrix was **not run** and no
second parameter point was tried. Next: diagnose visible versus padded mode
distortion and old/new tiny reconstructed planes before a generic algorithmic
correction. Preserve admitted geometry and gates; do not add a fixture exception.
V7 source-only preparation is separate and no v7 codec output exists. M2 stays
ACTIVE/PARTIAL, latest-module product/lifecycle/performance gates remain open,
and wasm-webp stays in production. This result does not close #501.
