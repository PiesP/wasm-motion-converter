# Corrected-v4 owned VP8 result

Outcome: **REJECTED44/45; PARTIAL; no runtime removal**.

The frozen candidate clean source `9071b71842e2dcd83163d047e49329aafe336aea`
uses owned WASM SHA256
`a53d77301d020c892b08048a02293515daa56e30a023fcd68fa4c228da5868c0`
(177501 raw /36622 gzip9-mtime0 bytes). The primary comparator remains shipped
patched wasm-webp@0.1.0 WASM
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
The source-only v4 manifest hash is
`13c723fe5e5839fc3cc48a06056ada04cce0127b2b04931163a25f9619fd23b7`;
selection and unchanged gates were registered before any candidate outputs.

The candidate passes45 tuning conditions and all135 exposed v1/v2/v3 conditions.
Fresh v4 passes44/45. The sole failure is `fresh4-tiny`,2x5,q60:

| Metric | Baseline | Candidate | Gate |
| --- | ---: | ---: | --- |
| PSNR dB | 15.9060667704 | 15.0323735615 | PASS, minimum14.9060667704 |
| SSIM | 0.559910 | 0.525307 | FAIL, minimum0.549910 |
| Raw VP8 bytes | 66 | 73 | PASS, maximum194 |

Input SHA256:`ceb529a7aa1f2b48a24dfd4042fee3cc5201af556b9f153f722afbff6fd6e378`.
Candidate VP8 SHA256:`2d796c86b0432a01197b6895112c796211d08b88299342c301aa47479bdf0a7b`.
All other44 conditions, including admitted-large geometry, pass all gates.
No averaging, dimensions, selected frames, thresholds or metric method changed.

Private evidence:`m2-corrected-v4-acceptance-01/{identities,results}.json` plus
per-condition source/output/decode/metric records. Prior rate20's44/45 tuning
failure remains in `m2-flat-rate-20`, despite its exposed-v3 pass. Rate21 records
and all original candidate failures remain intact. Rust83/83, independent native
VP8/libvpx reconstruction, fmt/Clippy, compiled ABI2 and offline artifact checks
passed at the same Rust inputs; these do not override the fresh SSIM failure.

V4 is now exposed regression evidence and requires `--regression`. Next: separate
tiny-image color import/chroma sampling, residual quantization and padded-region
distortion effects before a bounded generic correction. No fresh successor is
frozen yet. Full product performance/resource/browser and delivery gates remain
open; production master retains wasm-webp. Canonical ledger:[issue501](https://github.com/PiesP/wasm-motion-converter/issues/501).
