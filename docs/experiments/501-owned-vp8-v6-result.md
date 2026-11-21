# Corrected-v6 fixed-pixel result: rejected 53/54

The frozen complete candidate is **REJECTED for adoption** under unchanged
gates. Issue #501 remains ACTIVE / PARTIAL and production retains wasm-webp.
This is one remaining color-quality failure in a complete residual encoder;
continue corrective work rather than treating the old DC-only failure as a ban.

## Frozen identities and complete outcome

Candidate/harness source is `472666ae347d933f010ae261a65187357b424dfd`;
engine source `ea096ca50580e666509f88cb07d3e955c957f3ca`. The prospective
freeze and issue registration preceded every v6 codec output. The complete
279-condition exposed matrix passed before this evaluation. Module SHA256 is
`3abc7a2086a6f83c46da95558b881ec80adf2ecdcb2c184134bd0a1b4f0a0202`;
manifest `7451495d9c36648193d6864d2e68318262989a32c5cb3e621acd9232dc7e9c2b`.
The comparator remains shipped patched wasm-webp@0.1.0 WASM
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.

All 18 inputs ran at q60/75/85, 54 conditions. PSNR passes 54/54, size passes
54/54, SSIM passes 53/54. No inputs, settings, gates or thresholds changed.

| Failed condition | Baseline | Candidate | Frozen minimum | Other gates |
| --- | ---: | ---: | ---: | --- |
| fresh6-chroma-edge / q60 SSIM | -0.078510 | -0.090742 | -0.088510 | PSNR and size pass |

The failed frame's PSNR is 8.071345 dB versus baseline 8.152050 dB. Payload
38273 bytes versus baseline 33038 is within the 41297.5-byte ceiling. Finite
negative SSIM is valid data, not a missing metric. Preserve this failure; no
rounding, averaging, gate relaxation or decoder agreement converts it to a pass.

Results JSON SHA256:
`cd4bdad56f833956ee00becca202f5ba5fb935c4c1879ee161097716717e0ce8`.
Identities JSON SHA256:
`a2aa31f9cd492230e2bd65565806596b262ecc239ce50d2cfcdb6088c7aae2e1`.
Raw originals, outputs, RGB metrics and source identities remain privately
retained under `m2-corrected-v6-acceptance-01` in the task artifact root.

## Independent correctness and resource observations

All 54 finalized candidate payloads match their recorded hashes and visible
dimensions. Explicit FFmpeg native VP8 and separate libvpx decoding agree on
every visible YUV byte. All three duplicate-input/preset groups have identical
payload hashes. The independent verifier preserves `qualitySizeStatus: REJECTED`;
its report SHA256 is
`7c5908d6dee7c5769af0d9ed45282f31b0663cfbcd1f54a18a446548838e8327`.
Verifier source and logs remain separately retained as `verify-v6-independent.py`
and `m2-corrected-v6-independent-01`; the v5 verifier/results remain unchanged.

Maximum retained linear capacity is 104464384 bytes; declared maximum remains
192 MiB. Module delivery is 180952 raw /38079 pinned-Node gzip bytes. These
are fixed-pixel retained-capacity and artifact measurements, not physical
browser/GPU peaks, whole-product speed, active Stop, animation or delivery
acceptance. Old product PR #505 evidence uses an earlier module.

## Next owned action

V6 is exposed and every later use requires `--regression`. Preserve the original
source-only manifest, generator, photo/video originals and frozen candidate.
At the V6 decision, the next cohort had yet to be frozen. Diagnose the failed q60 chroma condition using
input-only loss, independent import-only/plane-mixed decoded RGB controls and
the actual selected UV profile before choosing one bounded correction.
Recheck the expanded 333-condition known matrix before properly controlled new
acceptance evidence. Product/browser/performance/lifecycle qualification and
M5 removal remain outstanding; this result does not close #501.
