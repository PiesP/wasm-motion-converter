# Corrected-v8 fixed-pixel result: rejected 59/60

The first complete corrected-v8 evaluation rejected candidate adoption under
the unchanged gates. All 20 prospectively frozen pixel inputs ran at q60/75/85;
PSNR and raw size passed 60/60, while SSIM passed 59/60. The existing patched
wasm-webp comparator remains the production route. This result does not replace
earlier failed receipts or qualify product behavior.

## Source-bound evidence

- Candidate source: `0d0fa7819b59e589913c4b5a8f2105b2a5fafd98`; WASM SHA256 `12e7c643be85907c776aa3f5ca095c3f09280dfb17d0d0ec2357e9065cda3aa3`.
- Clean harness source: `dc4e1e2587bc81188f53c1de205525a5988b9fb3`; [source-only manifest](501-owned-vp8-v8-fixtures.json) SHA256 `d4b17b2990ce5fbb96dfa75c3377c8b6fb20336e91e202a5440f5e5d2da24e19`; generator SHA256 `aca1734c0cda15f7375f0ca91f1a3269cd46f5922baa42eb7882d19a7d5cf46e`.
- Comparator: shipped patched wasm-webp@0.1.0, WASM SHA256 `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
- Complete 60-condition results JSON SHA256 `e1429548c07bc08d0620acbd3601bb36f23df7804474c7d4327be65b6abf4898`; identities JSON SHA256 `5fbfe68f308b2f5591bc582598cd464c4d5575ff87a6bf5196dd0a74fe3907a7`; run summary SHA256 `312c23db69ec2d7d3367168f2639d2ed9af723660535863a249e64fecfbc5836`. Raw inputs, outputs and metrics remain privately retained in `fresh-v8-acceptance-0d0fa781-attempt02`.

The sole failed condition was `fresh8-tiny-7x1` at q85. Its frozen source pixel
SHA256 is `98327a8e2b199892e85c2ff74865b026c6b4e478c3711a015a19590e02cf1c0e`.
Candidate raw VP8 SHA256 is
`fa6700e6fa5b7a77c24c094103429ddec6ff35a8bdfee44dde26360848d9327c`.
Candidate SSIM `0.351645` missed the required floor `0.390408` (comparator
`0.400408` minus `0.01`). Candidate PSNR `18.587919` dB passed against
comparator `18.361630` dB. Candidate size 68 bytes passed the 194-byte
allowed maximum derived from the 66-byte comparator frame. No threshold, input,
quality or metric rule was changed after the failure.

Earlier `attempt01` and wrapper preflight receipts ended before any codec
condition; they remain separate from this complete 60-condition result. The
largest observed Node engineering step and linear capacity are diagnostic data,
not browser or product performance evidence.

## Exposure and remaining qualification

All v1-v8 held-out fixtures have now been observed and require `--regression`
for any later use. No fresh successor is currently frozen. The 15 tuning inputs
remain tuning-only controls. The fixed-pixel result does not qualify live browser
conversion, animation timing or fidelity, Stop/cancellation, deployment,
dependency removal or product acceptance.
