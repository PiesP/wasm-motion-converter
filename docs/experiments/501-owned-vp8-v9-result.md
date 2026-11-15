# Corrected-v9 fixed-pixel result: rejected 59/60

The first complete corrected-v9 evaluation rejected candidate adoption under
the unchanged gates. All 20 prospectively frozen inputs ran at q60/75/85:
PSNR and raw VP8 size passed 60/60, while SSIM passed 59/60. This result does
not replace the earlier V8 59/60 failure or qualify browser or product behavior.

## Source-bound evidence

- Candidate source: `9c308303c5cc0da8d2be0a45355275a24e4aaf59`; candidate WASM SHA256 `caf1d2c21de43a34581cae079261073d3c49b7c2df3c324734bf61e3ead81515`.
- Clean harness source: `39852d52c3c27ae953c3499c5f415badcb8059fe`; [source-only manifest](501-owned-vp8-v9-fixtures.json) SHA256 `8eeae4aeb52b433ff2936ee7973d31795b6d39edc5f734e0a33de84ebf176c54`; generator SHA256 `199726a9fa055d1ed2761240cb2042fcfa85ebc321baa976d2beb095ac69c343`.
- Comparator: shipped patched wasm-webp@0.1.0, WASM SHA256 `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
- Complete 60-condition results JSON SHA256 `4cf2c0b14dc1a3507833b09d87602b252e8a9fa8efae367a4fe5d7d9215565d1`; identities JSON SHA256 `ff65a9dcb670cdeef992c97ab336fd3c2326c453e8028da525e765edf4ef451f`; independent run summary SHA256 `c2881b591466e910d1aab65e6ac313767250b19eb02ed302592b0912492ff468`. Raw inputs, outputs, decoded pixels and metrics remain privately retained in `fresh-v9-acceptance-9c308303-attempt01`. The independent result reconciliation confirmed all 60 distinct conditions and recomputed the gates and manifest binding.

The sole failed condition was `fresh9-chroma-edge` (407 × 277 opaque RGBA) at
q60. Its frozen input SHA256 is
`5eb62c1a42930b9bec9eeed26ae60778b4c80243e890cf9c6a40d7005896f313`;
candidate raw VP8 SHA256 is
`6a28cab41414b251666f5eac7de221235d338a1ab1806c1fc724ad65046df361`.
The comparator SSIM was `-0.062949`, so the unchanged floor was `-0.072949`.
Candidate SSIM `-0.074856` missed it by `0.001907`. These negative SSIM values
are valid measured values and were neither clamped nor discarded. Candidate
PSNR `9.232514879` dB passed against comparator `9.280112484` dB (floor
`8.280112484` dB). Candidate size `39762` bytes passed the `43637.5`-byte
ratio ceiling derived from the `34910`-byte comparator frame. No input, gate,
quality or metric rule was changed after this failure.

## Exposure and remaining qualification

All V1–V9 held-out fixtures have now been observed and require `--regression`
for later use. The known fixed-pixel corpus totals 507 exposed conditions; no
fresh successor is currently frozen. The 15 tuning inputs remain tuning-only
controls. A future candidate needs a new prospectively frozen independent
cohort before fresh quality acceptance. This result does not qualify animation
timing or fidelity, live conversion, cancellation, deployment, dependency
removal, or product adoption.
