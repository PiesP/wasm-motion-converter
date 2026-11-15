# Corrected-v10 fixed-pixel result: rejected 58/60

The first complete corrected-v10 evaluation rejected candidate adoption under
the unchanged gates. All 20 prospectively frozen inputs ran at q60/75/85:
PSNR and raw VP8 size passed 60/60, while SSIM passed 58/60. This does not
replace the earlier V9 59/60 rejection or qualify browser or product behavior.

## Source-bound evidence

- Candidate source: `04b1248022fcd2558653a88ab92b90164db4658d`; candidate WASM SHA256 `0c41ebe8fb81dd0447e64e217cdaf0d1bcedec87d6562818ad688cfbb1f0953b`.
- Clean harness source: `1172db4dbd03bbdf93a3be02ef554771cfe28d86`; [source-only manifest](501-owned-vp8-v10-fixtures.json) SHA256 `741d4674a4ef687be0e57ea02e8d0470bdbd7f21a74b16c17b25e66f9bc8db40`; generator SHA256 `446a8fea0aa56cbf77c1615a8f32843409a70270ba8c105c4e242b80faecfe4f`.
- Comparator: shipped patched wasm-webp@0.1.0, WASM SHA256 `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
- Complete 60-condition `results.json` SHA256 `ee5d0adf19f07b9547d193adcaa75314eac47d4ba24b202524bbaf2203b1dee5`; independent run summary SHA256 `8a2c1646d519a4946386e659c6592c3503244b9f46dcddc3193e13ad497be2e3`. The independent reconciliation found 60 unique complete conditions and recomputed the input binding and gates. Raw inputs, outputs, decoded pixels and metrics remain privately retained in `fresh-v10-acceptance-04b12480-attempt01`.

Both failures were q75 SSIM misses; PSNR and size passed for each:

| Input | Comparator SSIM | Required floor | Candidate SSIM | Shortfall | Comparator / candidate raw bytes | Comparator / candidate PSNR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `fresh10-tiny-11x1` (11 × 1) | −0.053560 | −0.063560 | −0.064036 | 0.000476 | 76 / 79 | 11.243936 / 11.232497 dB |
| `fresh10-photo-detail` (303 × 389) | 0.929125 | 0.919125 | 0.917097 | 0.002028 | 27,180 / 27,437 | 32.166156 / 32.219390 dB |

The negative SSIM values for the 11 × 1 input are valid measured values and
were not clamped or discarded. The failed inputs have frozen SHA256 values
`09984aa90b195ecdab8f13d9770e953e532226f51e289a5d2586db667e8cdf5d`
and `30f81afdab41be29efea176f71caf48b3100c85a60bc3a547588ee284fcdcb4d`,
respectively. No input, gate, quality or metric rule was changed after these
failures.

## Exposure and remaining qualification

All V1–V10 held-out fixtures have now been observed and require `--regression`
for later use. The known fixed-pixel corpus totals 567 exposed conditions;
at this V10 result checkpoint no fresh successor had been frozen. The later
[V11 source-only freeze](501-owned-vp8-v11-source-freeze.md) is separate. The 15
tuning inputs remain tuning-only controls. At the V10 result checkpoint, a
future candidate needed a new prospectively frozen independent cohort before
fresh quality acceptance. This result does not qualify animation
timing or fidelity, live conversion, cancellation, deployment, dependency
removal or product adoption.

The earlier 41-character photo SHA1 metadata attempt was corrected before
this evaluation. Its superseded manifest and source-freeze receipt remain
privately retained. That metadata error is separate from this 58/60 quality
rejection.
