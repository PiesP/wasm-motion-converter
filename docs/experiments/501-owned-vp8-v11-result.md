# Corrected-v11 first fixed-pixel result: rejected 58/60

The first complete, prospectively registered corrected-v11 comparison rejected
candidate adoption. It ran all 20 frozen held-out inputs at q60/75/85 (60
conditions) against the unchanged primary comparator and numeric gates. The
candidate passed 58/60 joint conditions: all 60 SSIM gates and all 60 size gates
passed, but two PSNR gates failed on the same `fresh11-photo` input. This fixed-
pixel result does not qualify product conversion, animation fidelity, browser
behavior or deployment.

- Candidate source: `9ce9b7b193c84ee6228b3f427657fcbde8cc6fd1`; compiled module SHA256
  `80184995deeb02027de2ee83e7fab214292c63d15e46461e2cf34b08614129eb`.
- Clean measurement harness: `1c8bb21e86471107c763eb62aa18ce6c2f6bb0f1`;
  frozen [V11 manifest](501-owned-vp8-v11-fixtures.json) SHA256
  `976a1365e7eeb13759df8f00d8b9ff296875c531ad10c707d445a25ac5c298a0`;
  generator SHA256
  `df1531d4d98387c23ed55a35536fcf275a20f3f0c8558efdc73a4c978edb0eae`.
- Complete `results.json` SHA256
  `5aa8079985f2170d9a52294ff6ce0ef5ebda14a4bcb7fe5004917947ff6fd7f5`.
  Independent reconciliation verified all 60 unique input/geometry/quality
  pairs, recomputed every gate, and confirmed duplicate-hold bit identity.
  Raw inputs, outputs, decoded pixels and metrics remain in private evidence.

The failed input is the 463 × 587 opaque RGBA `fresh11-photo`, SHA256
`1a55a04aed506b9c1ec15e1a5689e4ca3501c3b18b30dd7a8082e88d14e45259`.

| Quality | Primary VP8 bytes | Candidate VP8 bytes | Primary PSNR | Candidate PSNR | Primary SSIM | Candidate SSIM | PSNR miss below floor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 1,314 | 1,251 | 44.702571 dB | 42.990062 dB | 0.976202 | 0.977026 | 0.712509 dB |
| 75 | 1,516 | 1,527 | 44.895285 dB | 43.622733 dB | 0.976384 | 0.977142 | 0.272552 dB |

Both misses are measured against the frozen PSNR floor of primary minus 1 dB.
There is no new threshold or exception. The q60 and q75 candidate raw VP8
SHA256 values are respectively
`76f87264be6bce455b3ec1895f3d67d807acc617d3a6d9a90e175b59925acf08`
and `3f96905057d3a2a642444bf6514485b0bbd950ff94b86563366209ec8a1d6268`.

The coordinator's post-run reader still asserted `corrected-v10` and produced
an incorrect 0/0 incomplete summary after the full V11 process had finished.
The original failed reader, log and summary SHA256
`0d166133a48b378f09e1f3df0303a97fc8db071226a3c5bd8cc2de5089dd097f`
remain preserved. Independent reconciliation inspected the same existing 60
results and did not rerun either encoder or change any measured gate. The
bookkeeping failure does not invalidate or overturn the two PSNR failures.

All V1–V11 held-out inputs have now been observed and are exposed regression
only: 627 known conditions at three qualities. The compare selector requires
`--regression` for V11, including a full 20-input request; diagnostic subsets
also require regression purpose. The original V11 measurement harness identity
above remains attached to the rejected first result. The later retirement edit
has its own source identity and must not relabel that result. Further candidate
quality acceptance requires a newly frozen prospective independent cohort.
