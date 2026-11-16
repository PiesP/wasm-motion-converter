# Corrected-v5 prospective fixed-pixel candidate

This freezes the candidate before the first corrected-v5 encoded output.
It is a fixed-pixel quality/size evaluation, not product adoption or runtime
removal. Issue #501 owns execution and the later outcome. Preserve this file
and failed receipts if the candidate is rejected.

## Candidate and prior evidence

- Engine source: `187dd82ef931bd72603796676f6cc5d27193c376`.
- Bounded WASM: `cc08cc7dba6c8325581d765e058c91b6886c9b77bf482822921db70b2d2090cf`.
- Artifact: 179,706 raw / 37,500 gzip level-9/mtime-0 bytes; initial linear
  capacity 1,179,648 bytes, declared maximum 201,326,592 bytes.
- Presets, source classification, quantization and frame-selection settings
  remain those of candidate26. The corrected coefficient objective uses a
  separate rate price, scaled uniformly by visible UV coverage, and preserves
  padding-only patches. See the retained rate-refinement result.
- The complete 45 tuning plus 180 exposed regression conditions passed all
  PSNR, SSIM and size gates on this exact source and module. The minimum known
  margins were 0.008663652 dB PSNR, 0.000162 SSIM and 7.5 raw VP8 bytes, on
  different conditions. These are margins, not new thresholds or averages.
- Full Rust 94/94 including 12 explicit independent-decoder tests, fmt/Clippy,
  compiled ABI2, reproducible WASM check and maintained `vp run verify` 9/9 pass
  at that source. Independent source review found no actionable defect.
  These checks do not qualify browser timing, Stop, resources or animations.

## Unobserved input contract and unchanged gates

The source-only manifest is `501-owned-vp8-v5-fixtures.json`, SHA256
`c8929d67d57c6df20e2c152c85ac4178b9b4a4c9c7184892b62df130de8faf83`;
the generator SHA256 is
`80439385265334842a772e4b2560f5243fe8f7118ec05d83fe85c60b78a550a3`.
All 18 new held-out inputs must run at q60/75/85: 54 conditions, no subset.
The old v1-v4 cohorts remain exposed and require `--regression`.

Use the unchanged shipped patched `wasm-webp@0.1.0` comparator binary
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
Every condition must satisfy:

- Decoded RGB PSNR at least comparator minus 1 dB.
- Decoded RGB SSIM at least comparator minus 0.01.
- Raw VP8 size at most max(1.25 times comparator, comparator plus 128 bytes).
- Valid exact visible geometry, complete identities and finite/valid metrics
  under the existing explicit exact-image handling.

All frozen input/layout, resource, delivery and product gates remain unchanged.
Do not alter thresholds after observing a failure. The complete source/fixture/
toolchain/comparator/module identities and each output must be retained. The
private original photograph and pinned video stay outside Git and public assets.

## Execution

Use the project-selected Node with a clean, committed candidate and a new
external evidence directory. Supply the pinned Toronto photograph via
`--fresh-photo` and pinned V8 video via `--video`:

```sh
vp exec node scripts/test/owned-vp8-v2-compare.ts \
  --cohort corrected-v5 --acceptance \
  --fresh-photo /absolute/private/cohort5-street-toronto.jpg \
  --video /absolute/private/nature.webm \
  --output /absolute/private/new-evidence-directory
```

Record the actual committed harness source in #501 before running. No candidate
or harness edit is allowed during measurement. Inspect all 54 gate records;
the command's exit status alone does not establish acceptance. After this first
evaluation, retain all evidence and make v5 regression-only for later runs.
Full animations, balanced whole-product performance, final-source browser and
lifecycle/resource checks, protected integration and served-byte verification
remain required before wasm-webp removal.
