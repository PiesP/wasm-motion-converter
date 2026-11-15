# #501 V8 whole-product timing receipt verifier

`scripts/test/owned-vp8-product-timing.ts` reads retained **actual** Windows controller JSON receipts after the browser campaign. It does not run a browser, encoder, VM, or build. The script requires 15 completed V8 receipts: five controller invocations each for low, medium, and high quality. Each invocation contributes one prior and one candidate sample for each of `first-in-document` and `same-document-warm`. For each quality, AB and BA must occur 3/2 or 2/3 and alternate chronologically. Do not supply five AB plus five BA as one cohort, or mix small, near-cap, or instrumented functional conversion timings into the 60 timed samples.

Prepare the recorded, immutable prior and final candidate production distributions separately. Supply their complete directories as `--prior-dist` and `--candidate-dist`; the verifier reuses the controller's `readBuild` admission to check the exact file inventory, hashes, compiled source SHA in the app entry, HTML app link, and service worker. It binds each receipt's deployment manifest digest and source/tree/core identity to that distribution, including the shipped WASM module. The prior source is fixed at `be35f5fa89a60189475fe2ef7fd446e9fa18cef4`, with legacy WebP WASM SHA-256 `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`. Supply the **final** candidate's source SHA and owned VP8 module SHA-256 explicitly. The verifier refuses a merely self-consistent, arbitrarily staged candidate.

```bash
node --experimental-strip-types scripts/test/owned-vp8-product-timing.ts \
  --prior-dist /path/to/recorded/prior-dist \
  --candidate-dist /path/to/final/candidate-dist \
  --candidate-source-sha '<final 40-hex source SHA>' \
  --candidate-module-sha256 '<final 64-hex owned VP8 WASM SHA-256>' \
  --receipt /path/to/low-ab-1.json \
  --receipt /path/to/low-ba-2.json
```

The example is intentionally incomplete: add the other 13 distinct completed V8 controller receipts with separate `--receipt` arguments. Keep private paths and media outside tracked documentation. Retain the raw JSON, controller logs, failed attempts, distribution inventories, and external source/build provenance. The verifier's receipt paths are not a substitute for those artifacts.

For each quality and condition it reports all five values per build, median, range, median absolute deviation (MAD), and candidate median increase. The output retains the validated prior/candidate source, tree, core, inventory and module identities, frozen input/manifest and settings, timing/cache scope, and each sample's source receipt SHA-256, document/context identity and WASM resource paths and sizes. Receipt hashes cover the input JSON file bytes; output omits private absolute paths. The numeric gate passes only when the increase is at most `max(0.05 × prior median, 20 ms)`. A regression produces `status: FAIL` and exit code 1. Missing, duplicated, nonfinite, mismatched, or incomplete evidence produces `status: NOT_VERIFIED`, `numericGate: NOT_VERIFIED`, and exit code 2.

New V8 receipts include one invocation UUID and a unique epoch for each timed UI job. A validation-only probe counts successful ABI2 begin, step and retire calls and observed explicit JS copies crossing a known WASM memory boundary. It records peak capacity and capacity at the last observed job operation. The existing Worker completion message carries only fixed scalar fields, which the validation listener removes before the product handler sees it. The pinned prior loader patch reports the final iteration count of its existing binary `HEAPU8` copy loop after the loop completes; the on-disk prior distribution and WASM bytes are unchanged. The verifier binds the exact loader patch digest, Worker source patch identities, and each timing epoch. It rejects stale epochs, duplicate Worker request IDs, unknown copy kinds, and incomplete new receipts. Old receipts lack these fields and remain unverified. A fetched WASM resource alone still does not establish executed code.

A numerically passing complete cohort still reports `numericGate: PASS`, overall `status: NOT_VERIFIED`, and exit code 2. The prior loop and WASM-boundary copies do not classify codec-internal or physical copies, and a capacity observation at retirement does not measure retained memory after the app owner releases the instance. Guest CPU and selected-browser identity are checked by the attempt join; host neighboring load has no qualified source in this profile. The separate candidate cadence conversion remains outside the timed cohort. First means first in a document/context, not a proven cold profile. No source-only result qualifies adoption.

The probe performs only numeric accounting inside the timed interval; file writes, hashes, output parsing and independent decoding remain after it. A future campaign still needs source-bound Windows execution, host-neighbor coverage, retained-memory evidence and the separate functional/output gates before adoption.

Pure verifier tests run with `vp test run --project unit test/unit/validation/owned-vp8-product-timing.test.ts`, using the repository's maintained unit runner. Their fabricated receipt objects test rejection and arithmetic only; they are not performance evidence.
