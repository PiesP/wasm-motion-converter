# #501 V8 controller attempt join

`scripts/test/owned-vp8-product-attempts.ts` joins 15 retained **actual** Windows controller attempt directories to the existing `owned-vp8-product-timing.ts` numeric verifier. It reads files only. Each `--attempt` is a complete controller output root containing `bundle.json`, `transport.json`, `collection.json`, `payload/`, `output/result.json`, `output/environment.json`, and the collected `owned-vp8-product-v8-*.json`. Naked timing JSON files are insufficient. Retain failed attempts separately; this tool admits only complete, passing attempts and does not relabel earlier failures.

```bash
source /home/piesp/.config/shell/env.sh
vp exec node --experimental-strip-types scripts/test/owned-vp8-product-attempts.ts \
  --prior-dist /private/recorded/prior-dist \
  --candidate-dist /private/recorded/final-candidate-dist \
  --candidate-source-sha '<final 40-hex source SHA>' \
  --candidate-module-sha256 '<final 64-hex owned VP8 module SHA-256>' \
  --attempt /private/attempt-01
```

Add 14 more distinct `--attempt` arguments. The command shown is incomplete and will return `NOT_VERIFIED`. The prior distribution is pinned to source `be35f5fa89a60189475fe2ef7fd446e9fa18cef4` and legacy module `4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`; the final candidate source and module must be supplied explicitly. `readBuild` checks both complete distributions. The existing verifier enforces five balanced, chronological AB/BA invocations per quality, 60 first/warm samples, input/settings/cache identity and the frozen numeric gate. This join does not change its arithmetic.

For each attempt, the join hashes the complete physical payload inventory against `bundle.json` (including its copied manifest), then uses the existing `readBuild` admission on both payload distributions to check module bytes, compiled source, HTML app entry, service worker and exact distribution inventories against the supplied distributions. It also checks collected output file bytes against `collection.json`, guest artifact observations against those collected bytes, result/bundle identity, controller and build-log hashes, scenario, browser channel, mode, source/core and profile. It requires confirmed collection and guest cleanup, passed result and environment readiness/drift, and one VM GUID before and after. Cross-attempt checks bind VM, boot, observed OS/build, memory capacity, GPU, display, browser version and controller/profile identities. Output uses attempt ordinals and nonsecret digests; keep raw paths, profiles, media and logs outside tracked reports. CLI errors use fixed stage labels and never echo receipt contents. The channel is `msedge` or `chrome`. Chromium engine is inferred from the maintained Playwright launcher route, while the executable fingerprint is not collected.

The maintained profile forces Canvas WebP unavailable before app load; the same source/build contains the owned module, and the separate candidate functional conversion records actual V8 ABI begin calls after the timed samples. These facts corroborate the timed software route at that scope. They do not directly attest execution in every timed job. File `bytes` in the collected artifacts are receipt sizes, not physical pixel-copy counts. Production V8 copied bytes and relevant retained linear capacity still need separate source-bound evidence outside the clock. CPU model/core count, neighboring load and executable fingerprint are also absent from the current controller snapshot. The join reports those gaps and leaves whole-program qualification `NOT_VERIFIED` even if the numeric gate passes. It makes no Safari, mobile, fresh-profile cold, or adoption claim.

The tool exits 1 for a verified numeric regression and 2 for incomplete evidence or a numeric pass with open qualification. Pure fabricated validation fixtures run through `vp test run --project unit test/unit/validation/owned-vp8-product-attempts.test.ts`; they are not performance results.
