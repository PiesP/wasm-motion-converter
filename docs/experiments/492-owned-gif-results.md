# Owned GIF runtime removal: qualification result

**Decision: adopt the qualified runtime-removal candidate.** All six frozen
latency conditions passed, every measured saved GIF and independently decoded
frame/timeline matched the fresh baseline, and actual Worker/fallback
cancellation and recovery passed. This is a source-bound qualification record;
[issue #492](https://github.com/PiesP/wasm-motion-converter/issues/492) is the
single authoritative tracker for final protected integration, exact-head checks,
and automatic Pages production/source/served-byte closeout. Related PR: [#493](https://github.com/PiesP/wasm-motion-converter/pull/493).

The [prospective plan](492-owned-gif-plan.md) preceded candidate timing. No
numeric gate, setting, sample count or output requirement was relaxed. The
17.236% result in #490 remains its historical quantizer experiment, not a gain
or measurement of this work. #490/#491 stay completed and #483/#487 retain TS.

## Source and ownership

| Source | Identity / scope |
| --- | --- |
| Refreshed product baseline | `60902dc9d3c7cf6c9c08d43e3df7c332a2ba8654` |
| Measured baseline | `b8a770b47b443a4eb545eeb4f84b39f4e5d06c30`; unchanged product plus plan/default-pair harness |
| Measured complete candidate | `4d6742173115dfeb8d05742041a399702cde3106` |
| Full installed-Edge offline/output qualification | `f3c05fce1089987ff0fb32064ea7f081e73f4c3d`; later changes are harness/tests only |
| Core gitlink | `4638d703806b38734430a761104ee73512cbdf5c`, unchanged |
| Toolchains | Node 26.13.1, pnpm 12.18.0, Vite+ 1.5.1, Rust 1.99.1, Playwright 1.65.0 |

Product files are unchanged after the measured candidate: `src`, `crates`,
`worker`, build scripts, Vite preset, package/lock and public notices. Later
harness-only corrections keep their actual source identity; they are not new
performance runs. Final integration must compare the landed GIF Worker and
WASM to their measured identities. The measured candidate Worker is
`5f587505f276344667e1eba06c76c2e9cb11e21a45ff126dc5f0174de90b35aa`
(the retained numeric record contains the inventory-derived exact digest), and
WASM is `fe8e5086cbf89d43ad962f18ab3b506d5821b51138ee83770d54715dacf07dbf`.

The owned Rust module now performs exact RGB565 mapping and per-frame LZW.
Mapping preserves the actual `0x03e0` green mask, first pixel per key, ordered
palette and last-index equal-distance tie. It overwrites the already consumed
RGBA prefix with indices, resets the cache each mapping, and rejects another
mapping/quantization until a fresh reservation. The JavaScript owner copies
indices for pending-frame timing/compaction/comparison. LZW consumes those
indices, reuses the static quantizer workspace, and writes a bounded image-data
block after them inside the admitted RGBA region. It preserves width changes,
clear/end/reset behavior and **254-byte** subblocks. The owned TypeScript writer
implements only used opaque full-frame GIF89a headers, palettes, GCE, loop 0,
delays and termination. Existing TS owns dithering, selection, compaction,
exact duplicate policy, delay splitting, terminal frames and browser routing.

## Frozen inputs and output oracle

Private owner input: 1,092,710 bytes, SHA-256
`c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c`.
The original was preserved; task-owned copies stayed outside public assets.
Distribution inventories and postbuild exact-input exclusion were checked.

- Primary: full owner, GIF medium, scale 1, skip off, 720×720.
- Default: full owner, GIF medium, scale 0.75, skip off, 540×540.
- Small: maintained 5,184-byte MP4, SHA-256
  `de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`,
  GIF low, scale 1, low skip.

| Workload | Saved bytes | Frames / duration | Saved SHA-256 |
| --- | ---: | --- | --- |
| Primary | 19,607,211 | 134 / 11,160,000 µs | `efb2532834c56d2ae723e5c94ef05422a150b6391085bd9a0da62a21f5457169` |
| Default | 12,160,731 | 134 / 11,160,000 µs | `d95a12d69bf0f10eb42eb40b112def61fdb66ad8987123661f47720d6fe78026` |
| Small | 17,590 | 8 / 1,000,000 µs | `ccf94435e52830cc74a4ac4a8223e69634fe4b71b412ace49ab7110f06586214` |

All outputs retain loop 0. Before candidate timing, baseline first/warm saved
bytes and every independent installed-browser ImageDecoder composited RGBA
hash, frame order and duration were frozen. All 60 measured conversions match
those records. Separate candidate low-skip first/warm correctness also matches
the primary oracle; its times are excluded from the timing medians.

## Complete-product latency

Five balanced/interleaved invocations per variant/workload each started a fresh
browser process/profile, then first use and same-document warm with a new
Worker. Request-click to matching download readiness includes initialization,
fetch, copies and finalization. Diagnostics and saved-output decoding are
outside that interval. Heavy local suites and other task VM work were
serialized outside repeated timing. No timing trial was discarded or repeated.

All values below are milliseconds, rounded to 0.001 for display. The
[sanitized numeric record](492-owned-gif-results.json) preserves raw floating
values, full identities and receipt digests. MAD is median absolute deviation.

| Variant | Workload | Condition | Five samples in execution order | Median | Range | MAD |
| --- | --- | --- | --- | ---: | --- | ---: |
| baseline | primary | first-use | 14217.330, 15185.250, 14891.885, 14986.585, 14541.490 | 14891.885 | 14217.330–15185.250 | 293.365 |
| baseline | primary | warm | 15801.385, 14820.335, 14778.415, 14033.495, 13982.135 | 14778.415 | 13982.135–15801.385 | 744.920 |
| baseline | default | first-use | 12617.030, 11578.640, 12342.520, 11591.885, 11357.385 | 11591.885 | 11357.385–12617.030 | 234.500 |
| baseline | default | warm | 11679.815, 11428.320, 12100.380, 11308.860, 10907.810 | 11428.320 | 10907.810–12100.380 | 251.495 |
| baseline | small | first-use | 206.700, 206.595, 203.640, 194.215, 208.350 | 206.595 | 194.215–208.350 | 1.755 |
| baseline | small | warm | 137.050, 152.530, 147.100, 132.800, 141.525 | 141.525 | 132.800–152.530 | 5.575 |
| candidate | primary | first-use | 14432.660, 14960.395, 16090.015, 14216.680, 14686.895 | 14686.895 | 14216.680–16090.015 | 273.500 |
| candidate | primary | warm | 14821.840, 15316.065, 15493.395, 14063.640, 14772.565 | 14821.840 | 14063.640–15493.395 | 494.225 |
| candidate | default | first-use | 12118.830, 11398.180, 12242.835, 11542.780, 11293.485 | 11542.780 | 11293.485–12242.835 | 249.295 |
| candidate | default | warm | 12135.305, 11324.450, 11627.675, 10936.295, 10916.090 | 11324.450 | 10916.090–12135.305 | 388.155 |
| candidate | small | first-use | 220.765, 192.080, 214.460, 208.835, 227.245 | 214.460 | 192.080–227.245 | 6.305 |
| candidate | small | warm | 150.045, 132.385, 161.935, 137.805, 155.450 | 150.045 | 132.385–161.935 | 11.890 |

The prospective median increase ceiling is `max(5% of baseline median, 20 ms)`
for each condition. These are tolerances, not a claim that every run is faster.

| Workload | Condition | Candidate median change(ms) | Change | Allowed increase(ms) | Gate |
| --- | --- | ---: | ---: | ---: | --- |
| primary | first-use | -204.990 | -1.377% | 744.594 | PASS |
| primary | warm | +43.425 | +0.294% | 738.921 | PASS |
| default | first-use | -49.105 | -0.424% | 579.594 | PASS |
| default | warm | -103.870 | -0.909% | 571.416 | PASS |
| small | first-use | +7.865 | +3.807% | 20.000 | PASS |
| small | warm | +8.520 | +6.020% | 20.000 | PASS |

The primary warm median increased 43.425 ms (0.294%), below its 738.921 ms
ceiling. Small warm increased 8.520 ms (6.020%), below its 20 ms ceiling; it is
not described as a sub-5% increase. Dependency removal is the primary benefit;
no additional 10%/100 ms speedup rule was introduced and no historical #490
measurement was relabeled.

Every warm row has source-bound Worker Resource Timing `deliveryType:
cache-storage`, stable `/service-worker.js` controller and no added host Worker
request. All first/warm WASM CacheStorage entries match the inventory body,
MIME and admission/source headers. All 30 warm pairs have no added host WASM
request. WASM CacheStorage reuse is **inferred**, not a native Worker Resource
Timing observation. The helper's `cold-first-use` label means first use in its
fresh process/profile; it does not prove empty cache or network-cold startup.

## Dependency and byte accounting

| Category | Baseline | Candidate |
| --- | ---: | ---: |
| Direct runtime npm packages | 5 | 4 |
| Production npm closure, unique name/version identities (including type packages/local core) | 11 | 10 |
| Direct development/test/build declarations | 13 | 14 |
| External runtime Cargo dependencies | 0 | 0 |
| Distributable JS(raw bytes) | 1,245,341 | 1,234,468 |
| Distributable JS(gzip9 bytes) | 360,510 | 354,773 |
| GIF WASM(raw bytes) | 19,408 | 22,039 |
| GIF WASM(gzip9 bytes) | 7,795 | 8,937 |

The exact pinned `gifenc@1.0.3` remains **development-only** for real compiled
module and writer differential tests. Its lockfile integrity/source hashes are
in the prospective plan. It has no production imports, runtime fallback,
prebundle/manual chunk assignment or executable asset occurrence. Production
module declarations moved to test ownership. This is runtime removal, not
repository-wide or installation-wide package disappearance.

Initial JS gzip decreases 33 bytes (allowance +1 KiB); deferred JS decreases 5,704
bytes (allowance +8 KiB). GIF WASM remains within 128 KiB raw/48 KiB gzip. Combined
JS+GIFWASM inventory decreases 8,242 raw and 4,595 gzip9 bytes; unchanged WebP
WASM is 482,273 raw bytes. Gzip uses level 9/mtime 0 for both builds. These are
same-build asset inventories across all routes, not an assertion that every
conversion downloads every asset or that gzip9 equals negotiated wire encoding.
Final served-byte verification remains part of issue closeout.

Owned source maintenance replaces the package's runtime mapper/compressor/
writer: one existing Rust crate plus the small TS block writer, with MIT,
PNN and LZW attribution retained in source and generated `LICENSES.md`. No
`gif`/`weezl` dependency relocation occurred. The normal Pages bootstrap still
installs development build inputs before production builds; the dev oracle
also supplies source attribution. Runtime package counts and adapted/vendored
code ownership are reported separately.

## Memory, failures and lifecycle

The existing 8 MiB initial, 12 MiB primary steady and 24 MiB primary old+new growth
limits remain. Larger frames keep the page-rounded `12 MiB + max(0, RGBA bytes -
720*720*4)` allowance, with aggregate old+new capacity admission. No 720 px cap
was added. Initial output reservation, two JS indices, exact RGBA scratch,
comparison/palette allowances, WASM workspace, stream growth and final-copy
overlap stay charged under existing 512 MiB aggregate, 192 MiB frame-pipeline,
256 MiB GIF output and 9,000-frame limits and any stricter caller bounds.

Compiled ABI reservation observations (not a whole conversion or peak study):
initial linear memory 5,832,704 bytes; 540²: 6,946,816; 720²: 7,864,320; 1080p: 14,090,240.
At 720² the LZW bound is 780,874 bytes and fits the already admitted RGBA region.
Tiny and1080p reservations also fit. A whole-output WASM design would retain
another output owner (primary 19.6 MB already exceeds the 12 MiB primary limit)
alongside JS output/finalization; bounded frame output avoids that ownership.

The design still copies JS RGBA to WASM, indices to their JS pending owner,
pending indices back for compression, compressed bytes into the JS stream,
and final output. Views refresh after growth. Guard accounting and compiled
layout observations do **not** establish browser/native/GPU peak reduction,
zero-copy operation or garbage-collector release timing. Linux resource checks
separately sampled process PSS/RSS and renderer heap; Windows timing receipts
contain renderer heap points, including verification effects, not Worker/native
or GPU peaks.

Load, ABI, admitted-memory and conversion-result failures retain separate error
types/messages; conversion failures/cancellation do not trigger gifenc or a
whole-job automatic retry. Synchronous WASM does not poll AbortSignal. Worker
Stop retires its owned Worker; fallback observes cancellation between guarded
calls/yields and settles before UI idle.

| Actual route | Active owner settings | Stop-to-idle | Subsequent conversion |
| --- | --- | ---: | --- |
| Worker / Chrome 157.0.8103.52 | high, scale 1, adaptive; encoded progress 74 | 6.350 ms | Same-document small GIF exact; Worker terminated once, no stale completion |
| Controlled main fallback / Edge 157.0.4341.57 | medium, scale 1, off; encoded progress 74 + inventoried WASM request | 7.255 ms | Same-document small GIF exact; no Worker, one lifetime output publication |

Both satisfy 500 ms on the declared active owner validation. They are separate
functional observations, not fallback latency medians or a universal bound on
all synchronous calls/dimensions. The observer does not identify an instruction
pointer inside the kernel. Controlled constructor failure is injected before
conversion starts, not an automatic retry after active-work failure.

## Qualification and limits

- Real compiled-WASM tests execute the installed locked oracle across 64/128/256
  presets, packing/ties, flat/text/gradient/noise, tiny/odd/1080p, repeated state,
  malformed lengths/indices, bounded output canaries, LZW code-width/reset and
  subblock boundaries. Writer bytes and service timing/compaction/duplicates/
  terminal-frame contracts also pass.
- `vp run verify:full` at substantive source `1bcc4c41` passed 1,626 unit/browser
  tests and 78 E2E cases. Later harness-only publication/removed-asset tests and
  type/lint/format checks passed. Six extra relevant Linux resource scenarios
  passed, including pressure, plateau, hostile PAR and cancel/recovery.
- Installed Edge full profile at `f3c05fce` passed 29 checks: real prior-build
  upgrade, retained result and active tab, removed asset 404/non-immutable policy,
  polluted-cache rejection, offline app/static recovery/settings, output/
  playback/timing/geometry, critical pressure and zoom. Identical service-worker
  bytes correctly retained their controller; no worker-update event is claimed.
  Separate Edge Worker/fallback gradient+CFR output/invalid-options/nativeWebP
  qualification passed. Owned collection and cleanup passed.
- Actual VM: Windows 11 Pro 26300.9974, managed RDP 192 DPI; installed Chrome
  157.0.8103.52 and Edge 157.0.4341.57. Managed Chromium/Firefox/WebKit suites are
  separate evidence. Version readback on Linux WSL2 6.18.58.1 was Chromium
  158.0.8127.18, Firefox 159.0 and WebKit 27.2 under locked Playwright 1.65.0;
  these do not qualify installed Firefox 160 or Apple Safari. **Actual Firefox, Safari and mobile execution are
  UNVERIFIED**: the installed Firefox 160.0 cannot enter this WMC web profile
  through the controller's extension-only Firefox route; Safari/mobile runtime
  is unavailable. No infrastructure port, recruitment or new device was added.
- Google published 157.0.8103.78/.79 in the [November11 stable rollout](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_01744469280.html),
  then 158.0.8127.36/.37 for a small cohort in [November12 Early Stable](https://chromereleases.googleblog.com/2026/11/early-stable-update-for-desktop_0520415684.html).
  Observed Chrome 157.0.8103.52 is not the newest 157 patch; Chrome 158 execution
  is UNVERIFIED. [Edge stable notes](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel)
  identify major157; the observed .57 patch is not asserted to be latest.
  [Firefox 160](https://www.mozilla.org/en-US/security/advisories/mfsa2026-125/)
  is the installed current major. [Safari release notes](https://developer.apple.com/documentation/safari-release-notes/)
  list 27.2 stable/27.3 beta; neither is an executed Safari observation. Support
  policy remains latest stable majors without legacy shims, input-format
  narrowing, quality changes or removal of required codec/Canvas fallbacks.
- Rust 1.99.1 locked/offline regeneration matched the artifact; source/manifest/
  export checks, Cargo check/format, compiled differential tests and direct
  unsafe/alias/bounds review were performed. Optional `cargo clippy -Dwarnings`
  fails on two **pre-existing unchanged** quantizer `chunks_exact_to_as_chunks`
  lints (current 199/328, baseline 190/319); no suppression was added. It is not a
  configured required gate. JS/Actions CodeQL and routine Semgrep secrets scans
  do not establish Rust semantic coverage. Final exact-head CI/security is
  recorded in #492.

## Optional fusion disposition

**REJECT additional fusion for this issue.** Fresh synthetic resource profiles
show 9.900 ms total GIF pixel preparation in the high-motion cold diagnostic's
867 ms transcoding interval; this is not an owner-workload timing claim.
Compaction/remapping/hashing/exact comparison have no separate current timing
attribution and already operate on owned JS indices in place. Moving dithering
could remove a JS scratch/copy, but its owner-workload benefit is unqualified
and would reopen the checked pixel-preparation/ABI boundary. Existing admitted
memory and all dependency-removal gates pass without that expansion. No new
WASM seam, approximate palette reuse, worker pool or SIMD is introduced. This
rejection completes stage D; WebP fallback retirement, MediaBunny replacement
and motion-signature changes retain issue #492's separate dispositions.

## Retained failures and reusable verification corrections

Original failures are retained separately from later success:

1. A first baseline build used stale installed solid-js 1.9.18 against locked
   1.9.19; discarded, then frozen installation and retained baseline build.
2. The provenance-tamper test hardcoded the previous WASM digest after this
   migration; fixed to mutate parsed manifest data, with its failed receipt kept.
3. VM preparation found an unrelated missing pool VM, then the maintained
   runner's independent-clone/fixture/managed-desktop requirements. No VM safety
   guard or trust configuration was bypassed.
4. Review found per-measurement readiness reset could erase a stale cancelled
   publication during recovery preparation. Non-resetting lifetime counts and
   a real observer regression close that window before actual fallback tests.
5. The first full Windows profile refused a prior-build fixture with no changed
   locale chunk. The maintained helper now uses a real **inventoried** removed,
   uncached JS asset for codec-only changes, preserving the 404/cache/recovery
   gate and distinguishing it from language fallback or synthetic controls.
   The failed guest's five output files were preserved/rehashed; exact owned
   guest cleanup has a later explicit receipt. The original failed transport
   receipt is not relabeled as successful.

These corrections live in the existing owning tests/harness; no new benchmark
framework, skill or generated-memory edit was needed. No confirmed code/
documentation conflict was found in the inspected GIF/build/validation scope.

Retained audit digests (raw media, screenshots and logs remain private):

- Balanced audit: `2117de318f45c48545f698e08e1ed180cd93e3a3caa005640b05171e951b69da`.
- Baseline oracle freeze: `1fc6cbbdebf21f373f2455c4c6cb4b0c08d60f8f97c4d766a43fb05c6fbbda74`.
- Final prospective schedule: `203ef969b084b4cea6efbb3919ce02ce02a127837d7e00947543a46b31e13c27`.
- Full installed-Edge result: `fbf81596ba8f77e302409fdb888090e21b5e3fa0b32dcc153166eaf0db34c224`.
- Worker recovery result: `1704fcb25fcc88b03955d6c6ee0e960ffc4ec913a2df33da03796dbafc8feecd`.
- Fallback recovery result: `a4b06e09c58bdca510467c34adce3d5bfb5742bf8600485d09f013a92be3e574`.
