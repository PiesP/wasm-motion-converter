# Owned GIF runtime removal: prospective qualification contract

Issue #492 is the authoritative execution tracker. Baseline product source is
`60902dc9d3c7cf6c9c08d43e3df7c332a2ba8654`, refreshed against origin/master on
2026-11-14 JST. Core remains `4638d703806b38734430a761104ee73512cbdf5c`.
Node `.node-version` is 26.13.1, pnpm is 12.18.0. Use a frozen installation;
an initial baseline build found installed solid-js 1.9.18 and was discarded,
then reinstalled locked 1.9.19 before the retained baseline build.

## Reference and scope

The installed oracle is gifenc 1.0.3, lockfile integrity
`sha512-xdr6AdrfGBcfzncONUOlXMBuc5wJDtOueE3c5rdG0oNgtINLD+f2iFZltrBRZYzACRbKr+mSVU/x98zv2u3jmw==`.
Its ESM SHA-256 is `217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093`;
mapper source is `70f8e191d8f6f6e51bc6fc853a51f1b008c0a2fe144c4a3390b6342aaa9857bb`;
LZW source is `f25e485eda237d20c7780f1cd456c4b346b6dbff8e3f5215fb4ee5b32793b33a`;
writer source is `cabba5e290b21e40611f1cb972c1e6fee912139b727a254aacb05605cbd61c5c`.
Keep this exact oracle as a development dependency for compiled differential
verification. Production imports, dependency declarations and emitted loading
graph must exclude the package. Preserve attribution for owned adaptations.

Existing references occur in the service, package/lock, type declaration,
Vite chunk/prebundle rules, license generator/notices, configuration tests and
GIF service/unit tests. Historical #490 reports remain historical evidence.
No new external Cargo runtime dependency is admitted. Frame selection, timing,
dithering, codec fallbacks and browser orchestration retain their current owners.

## Frozen measurement gates

Before any candidate timing, freeze baseline output identities for primary,
default and small input/settings using the maintained Windows saved-output and
independent ImageDecoder oracle. Preserve baseline receipts, failures, exact
source/build/harness hashes and task-owned copies outside public assets.

- Owner input: 1,092,710 bytes, SHA-256
  `c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c`.
- Primary: full owner GIF medium, scale 1, skip off.
- Default: full owner GIF medium, scale 0.75, skip off.
- Small: maintained 5,184-byte MP4, SHA-256
  `de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`,
  GIF low, scale 1, low skip.
- Five balanced/interleaved invocations per variant/workload; each fresh
  process/profile runs first use then same-document warm with a new Worker.
  Alternate variant order between rounds; serialize timing with heavy work.
- Latency: request click to matching download readiness, including initialization,
  copies and finalization; diagnostics and saved-output verification outside it.
- Each condition's candidate median increase <= max(5% baseline median, 20 ms).
  Report raw samples, median, range and MAD; no required extra speedup.
- Active-work Stop-to-idle <=500 ms, no stale completion, successful recovery;
  Worker and controlled fallback evidence remain distinct.
- Timeout 180 seconds, saved output <=96 MiB, independently decoded <=400 frames.
- Record actual browser/OS versions and cache/controller/request evidence.
  First use is not an assertion of cold cache. Preserve the existing WASM
  CacheStorage inference limits. Safari/mobile without execution are UNVERIFIED.

## Frozen byte and owned-memory budgets

Use identical gzip level 9, mtime 0 for baseline/candidate assets; bind all
measures to the corresponding built inventory. Initial application JS gzip
increase <=1 KiB; deferred JS gzip increase <=8 KiB; owned GIF WASM <=128 KiB raw
and <=48 KiB gzip. Report total delivered bytes separately from package counts.
These allowances are ceilings, not target increases.

Retain initial WASM <=8 MiB; primary steady linear memory <=12 MiB and growth
old+new <=24 MiB. For larger RGBA frames retain the existing page-rounded
12 MiB + max(0, RGBA bytes - 720*720*4) bound, charging old+new capacities.
Use checked in-place mapping into the RGBA region, copy indices to the existing
JS pending owner, and compress one frame into remaining RGBA workspace. This
avoids retaining whole-output WASM alongside the JS output stream. Tiny-frame
workspace is checked and admitted explicitly.

Charge JS RGBA scratch, up to two pending indices, comparison scratch,
32 KiB palette ownership allowance, full WASM capacity, output stream and its
old+new growth overlap concurrently. Final copy charges stream capacity plus
used output plus WASM/palette. Preserve existing aggregate Worker 512 MiB,
frame pipeline 192 MiB, maximum frame pixels floor(192 MiB/20), GIF 256 MiB
output/9,000-frame ceilings, and stricter caller limits. Source-defined buffer
accounting is not browser/native/GPU peak measurement.

## Bounded optional work

After required mapping/LZW/writer work, inspect current profile/copy ownership
for dithering, compaction, hashing and exact duplicate comparison. Record ADOPT
or REJECT; no fusion is needed to complete runtime removal. Keep #483/#487
RETAIN_CURRENT and #490/#491 completed. WebP retirement, parser replacement,
motion-signature changes and infrastructure remain outside this implementation
with their issue #492 resume conditions.
