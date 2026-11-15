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

For each quality and condition it reports all five values per build, median, range, median absolute deviation (MAD), and candidate median increase. The output retains the validated prior/candidate source, tree, core, inventory and module identities, frozen input/manifest and settings, timing/cache scope, and each sample's source receipt SHA-256, document/context identity and WASM resource paths and sizes. Receipt hashes cover the input JSON file bytes; output omits private absolute paths. The numeric gate passes only when the increase is at most `max(0.05 × prior median, 20 ms)`. A regression produces `status: FAIL` and exit code 1. Missing, duplicated, nonfinite, mismatched, or incomplete evidence produces `status: NOT_VERIFIED`, `numericGate: NOT_VERIFIED`, and exit code 2. A numerically passing complete cohort reports `numericGate: PASS` but overall `status: NOT_VERIFIED` and exit code 2 because the maintained V8 receipt does not prove the actual executed encoder route for **each timed conversion**, copied bytes, or retained capacity. Its WASM Resource Timing entry proves a resource was fetched, and the separate candidate ABI cadence call is outside the timing interval. `browserVersion` is recorded, but the receipt does not name the browser engine, machine, hardware or controller invocation identity; compare these using retained controller evidence. First means first in a document/context, not a proven cold profile. The current verifier does not qualify a candidate for adoption.

To close this gap in a later authorized change, retain an outside-timing per-job route/ABI attestation for both builds and source-bound copy/capacity accounting, plus browser engine/machine/controller identity in each maintained receipt. Do not move parsing, independent decoding, or instrumentation inside the timed interval. A future campaign must still apply any stricter applicable timing or resource gate and separately assess output correctness and functional acceptance.

Pure verifier tests run with `node --experimental-strip-types --test test/unit/validation/owned-vp8-product-timing.test.ts`. Their fabricated receipt objects test rejection and arithmetic only; they are not performance evidence.
