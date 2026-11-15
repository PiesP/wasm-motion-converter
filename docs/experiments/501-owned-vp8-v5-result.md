# Corrected-v5 fixed-pixel result: rejected 50/54

The complete candidate is **REJECTED for adoption** under the unchanged gates.
Issue #501 remains ACTIVE / PARTIAL. Production retains wasm-webp and M5 stays
queued. This is a residual-correct encoder with incomplete quality/rate
qualification, not a repeat of the historical DC-only experiment.

## Frozen identities

- Actual candidate/harness source: `6b1f848b359df9c6a088ea90950f4a5f9fbb1e47`;
  engine source: `187dd82ef931bd72603796676f6cc5d27193c376`.
- WASM SHA256: `cc08cc7dba6c8325581d765e058c91b6886c9b77bf482822921db70b2d2090cf`.
- Source-only manifest SHA256:
  `c8929d67d57c6df20e2c152c85ac4178b9b4a4c9c7184892b62df130de8faf83`.
- Primary comparator: patched wasm-webp@0.1.0 binary
  `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
- Results JSON SHA256:
  `56c1d9b254164d563ea4c4d25f3f584f75855d4cab3464852cd41a978ddff441`.
- Identities JSON SHA256:
  `37965deb28f49c3f0542a128d528512267f783b316e9155c9011f8530a64c09c`.

The prospective candidate document was committed and recorded in #501 before
encoding. All 18 held-out inputs ran at q60/75/85, 54 conditions. The complete
225 known tuning/exposed conditions and engineering checks had passed before
the fresh evaluation. No threshold or fixture changed after observing results.

## Four failed conditions

| Fixture / quality | Comparator | Candidate | Frozen requirement | Other gates |
| --- | ---: | ---: | ---: | --- |
| Chroma edge / 60, SSIM | -0.065674 | -0.079630 | >= -0.075674 | PSNR and size pass |
| Tiny 5x3 / 60, SSIM | 0.225453 | 0.207630 | >= 0.215453 | PSNR and size pass |
| Admitted large / 75, VP8 bytes | 68,492 | 89,390 | <= 85,615 | PSNR and SSIM pass |
| Admitted large / 85, VP8 bytes | 84,972 | 114,229 | <= 106,215 | PSNR and SSIM pass |

Negative SSIM is a valid finite observation here, not missing data. All other
50 conditions satisfy every gate. The large input is 4000x2516, 10,064,000
pixels, below the preserved 10,066,329-pixel policy. Its failure cannot be
removed by shrinking geometry, skipping frames or raising a resource ceiling.

## Independent correctness and resource observations

All 54 candidate payloads were separately bound to their recorded SHA256,
checked for visible dimensions and decoded through FFmpeg's explicitly selected
native VP8 and separate libvpx decoders. Every visible YUV byte agrees for each
condition. All three duplicate-input/preset groups have identical candidate
payload hashes, preserving deterministic compressed-frame identity. These
checks establish decoded bitstream agreement and determinism, not quality gates.
Their report explicitly retains `qualitySizeStatus: REJECTED`.

Maximum recorded retained linear capacity is 104,464,384 bytes. The module's
declared maximum remains 192 MiB; conversion, demux and output safety ceilings
are unchanged. This is accounted/retained WASM capacity, not physical browser
or GPU peak evidence. No whole-product speed, Stop or delivery acceptance is
inferred from these fixed-pixel results.

Raw outputs, independent decoded RGB, metrics and identities remain in
`m2-corrected-v5-acceptance-01`; independent YUV/hash proof remains in
`m2-corrected-v5-independent-01`, with its external verifier source and logs.
Preserve the prospective candidate, manifest, generator and private originals.
Corrected-v5 is now exposed and requires `--regression` for every later run.

## Next owned work

Separate q60 chroma/tiny precision from q75/q85 large-input rate allocation.
First compare the unchanged candidate26 module on the two newly exposed quality
controls to distinguish the coefficient decision from the underlying residual
precision. Inspect segment/mode contribution on the large fixture before
changing preset allocation. Continue bounded implementation and the complete
279-condition known matrix, then freeze genuinely unobserved controls before
another acceptance evaluation. Do not relabel this result or close #501.
