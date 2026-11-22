# Completing WASM distribution and dependency verification

Execution plan for [historical GIF distribution](https://github.com/PiesP/wasm-motion-converter/issues/532), [VP8 delivery](https://github.com/PiesP/wasm-motion-converter/issues/501) and [the development dependency inventory](https://github.com/PiesP/wasm-motion-converter/issues/525). Each issue owns its final disposition. Dates below are in JST.

## Execution record

The historical build, replacement build and hosted verification ZIPs have been retained privately. Their GitHub archive digests, source trees, 24 historical files, 28 replacement files and the hosted 28-file inventory were verified. The [distribution decision record](https://github.com/PiesP/wasm-motion-converter/issues/532#issuecomment-7069786119) maps each of the 15 deployments and identifies seven earlier GitHub releases carrying production gifenc JavaScript. PiesP selected review of selective withdrawal. Deletion, history changes and third-party contact each require explicit authorization for their scope.

The existing 28 November timer originally stopped on any source after `02f1cc21`. Its local service now verifies the then-served release against CI and provider evidence. The November 22 KIX readback of `d0d7d265` found the archived caller in both request modes. [VP8 delivery tracker](https://github.com/PiesP/wasm-motion-converter/issues/501)

The original 1.66.2 patch was recovered and matched the SHA-256 below. The dependency tracker records the exact installation, capture provenance, qualification and final integration outcome. [Oracle tracker](https://github.com/PiesP/wasm-motion-converter/issues/525)

## Starting state and order

On 22 November 2026 the verified deployment was `d0d7d265`. The independent GIF encoder first shipped in #535. #536 repaired delivery verification. The maintained public profile passed 34 checks, and all 28 current files and four notice destinations matched. [Deployment record](https://github.com/PiesP/wasm-motion-converter/issues/532#issuecomment-7069308797)

1. Identify the current default and served revisions, their CI artifacts, the existing scheduled check, and who owns any shared worktree or Windows VM. Preserve the expiring receipts below. Start the #525 work and the #532 source inventory in parallel in isolated worktrees.
2. Submit each ready, tested change through the normal signed, protected integration path. A documentation or dev-only merge to master can also trigger Pages. Bind new observations to the release actually served and retain the previous record.
3. When an early canonical 404 or a confirmed provider invalidation changes the evidence, run #501's existing verification against that release. Otherwise use its existing retry. Handle the old GIF URL on its own evidence and clock. Continue other work while waiting for an external result.

## Evidence to preserve first

Verify any retained private archive by its GitHub SHA-256. If missing, recover it before expiry. Record the source commit/tree, provider deployment, artifact ID, digest and where the verified archive can be recovered. Keep old binaries in an appropriate private evidence location. Public issue updates can carry the identifiers, hashes and source links.

| Archive | SHA-256 | Expires (JST) |
| --- | --- | --- |
| [Last historical build, 02f1cc21](https://github.com/PiesP/wasm-motion-converter/actions/runs/44880877208/artifacts/14697379431) | `e069f98d04e8a06b92106065951ac4590927013f64ecb6e6b02d87ad29ed450a` | Nov 28, 16:35:55 |
| [Current build, d0d7d265](https://github.com/PiesP/wasm-motion-converter/actions/runs/44949533295/artifacts/14724836865) | `9738507696f8b9305c18e88128a3ced799ce8516698985765b1e6d29d49a0d16` | Nov 29, 06:05:07 |
| [Hosted verification for d0d7d265](https://github.com/PiesP/wasm-motion-converter/actions/runs/44950003121/artifacts/14724637906) | `0c1cc9889831abc00fa6e2e29f70b89b1e0fe3fbaedd99a0224391f30840d892` | Dec 6, 06:10:39 |

## Historical GIF distribution (#532)

Separate code lineage, release packaging and public access in the existing inventory. The 15 recorded deployment aliases map to three historical Rust `lib.rs` versions, four WASM digests, five notice digests and seven binary/notice pairs. The first generation shipped Rust palette selection and production gifenc JavaScript for mapping and LZW. The final two binaries shared Rust source but used different toolchains. All four binaries were also checked into Git history. Keep per-URL observations even when the bytes are identical. [Historical inventory and source links](https://github.com/PiesP/wasm-motion-converter/issues/532#issuecomment-7068074291)

- For each distinct code component, record which source and grant have been established, which notice applies, and any outstanding contribution. The nQuantCpp license deletion removed a duplicate GPLv3 file. Elliott's dated dedication covers his contribution and preserves Poskanzer's separate notice. Check the scope of Rowley and Weiner material independently. [PNN upstream record](https://github.com/mcychan/nQuantCpp/issues/4#issuecomment-769540860) · [Elliott and Poskanzer](https://github.com/geoserver/geoserver/blob/8f517dcb8c3e6db916e07ad97c9c1e723d744000/licenses/NOTICE.md#L96-L112)
- For each release, link the binary and relevant JS, exact historical source/build inputs and notices, URL/alias and Git object. Document the evidence available to prior recipients. The 13-file source bundle for the current independent module applies to its own binary.
- Give PiesP a concrete choice for any still-accessible historical copies: continued distribution under documented applicable permission or a reviewed compliant approach, or selective withdrawal with matching source and evidence preserved as appropriate. Record the scope and previous-recipient disposition separately. PiesP owns any legal decision, outreach or destructive hosting/history action. Carry out independently authorized work while this decision is outstanding.

## Development oracle provenance (#525)

Recover the previously evaluated 1.66.2 patch by SHA-256 `b35c5a479c1ae88cab856bb3a5b7b1394a45aa12cfa6a977a2cf79fa4913ea20`. The publication-age window has elapsed. If recovery fails, port from official package bytes and qualify that exact patch as a new candidate. A three-way trial encountered 18 conflicts in six source/distribution files out of 22 touched. [Earlier 41-fixture comparison](https://github.com/PiesP/wasm-motion-converter/issues/525#issuecomment-7029190994)

Change the development manifest, patch selection and lock together. Make the oracle freezer derive its identity from the installed package, reviewed patch and locked installation. Fail before emitting a new capture on disagreement. The current generator hardcodes both a patch path and an output version. Preserve the historical 1.65.2 captures and their reproducibility. Check a valid installation, an intentional mismatch with no new or overwritten capture, and correct version/hash on a new result. [Freezer in the baseline](https://github.com/PiesP/wasm-motion-converter/blob/d0d7d265f241198599ba0ede565e50313cb0e1c0/scripts/test/freeze-demux-oracle.ts#L153)

After preparing the intended lockfile, use the fixed install and the focused checks below. Repeat the original 41-fixture comparison, including parser resource rejections and positive controls. The reference difference was 17 duration values changing from 166666 to 167000 microseconds across seven Matroska/WebM fixtures. Compare bytes, timestamps, types and seek independently. Inspect the generated license diff and confirm the comparator stays outside production imports and delivered assets. Record adoption or retention and reconcile the remaining inventory with [the portfolio tracker](https://github.com/PiesP/.github/issues/46).

```sh
vp install --frozen-lockfile -- --no-runtime
node --experimental-strip-types scripts/build/generate-licenses.ts
vp test run --project unit test/unit/utils/mediabunny-*.test.ts test/unit/services/owned-demux-differential.test.ts
vp run verify:full
```

## Canonical delivery (#501) and the separate GIF check

Reuse the [six-path VP8 fixture](../../scripts/test/retired-webp-assets.ts) and [production verifier](../../test/e2e/deploy-smoke.spec.ts). At the last KIX observation the retired VP8 caller `/assets/index.D1rWSzxT.js` still returned its exact bytes. The hosted run passed. For each attempt capture the served revision and manifest hash, exact URL, UTC time, location/CF-Ray, request mode, status, headers, length and body hash. Store ordinary and revalidated GETs separately. The independent WebP retirement test requires HTTP 404 without redirects, the exact size and SHA-256 of the matched deployment’s `404.html`, HTML content type, a `no-store` policy and no WASM magic. Verify the public forced-owned WebP encode/decode and current CI/provider/artifact identity. Preserve conflicting regional observations and earlier failed runs. [Last VP8 readback](https://github.com/PiesP/wasm-motion-converter/issues/501#issuecomment-7069306954)

- **Nov 27 near 15:47** is an optional first KIX check derived from the observed Age and TTL. A passing trigger can advance the full gate. Keep **Nov 28 at 11:55** as the recorded #501 retry unless a qualifying earlier outcome is recorded.
- **Nov 28 near 16:40** is a separate estimate for the historical GIF `/assets/gif-scalar-quantizer-C4eFz0Ox.wasm`. The historical build artifact expires a few minutes earlier. Record the canonical response and the disposition of historical deployment aliases and Git access in #532. The six-path VP8 fixture has its own scope.
- Cache state can change early or differ by region. A cache-busted URL, another hostname or a build-cache purge cannot establish canonical retirement. An observed 403/1010 is inconclusive. Use the existing retry and owner when the region, provider or artifact is unavailable. [Pages asset retention](https://developers.cloudflare.com/pages/configuration/serving-pages/#asset-retention)

## Architecture, integration and completion

Keep the Solid UI, native decode and validated Canvas paths, lazy owned Rust/WASM, local processing and static delivery. Maintain the distinct responsibilities of the media runtime, dev-only comparator, source/notice generation and deployment verification. Extend existing manifests and verifiers when a specific gap is demonstrated. Preserve ABI, byte/lease ownership and cancellation/recovery contracts. Default to zero new production crates/packages. Use current stable major browsers on available equipment. Describe installed Safari, real mobile, exact Worker first-frame and whole-process/GPU peak as unverified until measured. Keep the private GIF size exception scoped to its approved input. Reopen a closed experiment only for a changed source, browser, workload or cost premise with a new prospective test.

Codex owns reversible engineering decisions, focused PRs, normal signing, required checks and source-bound verification. Report **ADOPTED**, **RETAIN_CURRENT**, **PARTIAL**, **DEFERRED** or **BLOCKED** per issue, with linked evidence and any remaining owner and resume condition. Keep #534's engineering closure intact. A waiting CDN edge or a maintainer rights decision does not block the dependency work.
