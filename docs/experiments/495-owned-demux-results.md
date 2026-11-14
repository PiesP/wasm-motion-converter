# Owned demux qualification (#495)

Coordinator: [#494](https://github.com/PiesP/wasm-motion-converter/issues/494), implementation: [PR #500](https://github.com/PiesP/wasm-motion-converter/pull/500). **Qualification PASS.** Protected integration, landed source and automatic Pages verification will be recorded separately in the coordinator after those gates complete; local qualification alone does not establish deployment. The prospective contract remains unchanged. The accompanying [JSON report](495-owned-demux-results.json) contains all 140 raw timings, medians, ranges, MAD, immutable identities and evidence digests.

## Scope and ownership

Production MediaBunny metadata and conversion demux are replaced together by lazily loaded owned Rust/WASM ABI4 and a thin bounded Blob-range host. Current successful MP4/QuickTime, Matroska/WebM and MPEG-TS routes retain decoder configuration, decode order/B-frame dependencies, verified keys/preroll/nonzero trim, timestamps/presentation durations, fragmented/cue-less input, rotation/aspect/color and existing browser orchestration. Ordinary contiguous compressed packets remain host ranges; reconstructed TS packets use explicitly admitted scratch. There is no runtime MediaBunny fallback or automatic whole-conversion retry. Load, ABI, resource, parse and conversion failures remain distinct across the Worker boundary; cancellation/deadline and bootstrap-only main fallback preserve their meanings.

Selected-input reuse is separately owned: one <=8 MiB snapshot, exact immutable Blob identity and generation, supplementary bounded first/last fingerprint, checked fixed-width import into a fresh conversion-owned core. The idle selected input retains no WASM instance. A fingerprint is not a whole-content identity. Preserve 500 MiB input, 16 MiB contiguous/packet, 32 MiB live metadata/index, 64 MiB queued compressed chunks/linear capacity and 128 MiB aggregate demux limits. Live index storage is inside linear capacity, not another allocation to double-count. Reserved capacity and native allowances are not measured process/GPU peaks.

A 64 KiB conversion-owned Blob payload window is enabled only after aggregate admission. Independent packet copies prevent reuse aliasing; misses, large packets, TS, release and failures evict correctly. Read credit remains held until outstanding physical I/O settles after cancellation. Optional credit refusal chooses exact reads before I/O starts; failed, short or cancelled reads are terminal. No physical zero-copy or peak-memory reduction is claimed.

## Sources, correctness and lifecycle

Production baseline is `95f14d1f2e46fb5ab6db59ace03bc2b157c7982a`; measured baseline `1d9fcd6deabdd215a092270351f3ffa6086a4cef` adds only the common diagnostic observer. Measured candidate is `44656b350ccb0b836cb3421efc868f198a07f4e8`; core is `4638d703806b38734430a761104ee73512cbdf5c`. Actual Windows product/cancellation source `00820ae90159a8b8002fe37d2d7a02f84679c78f` differs only in five later test-fixture/cancellation-double files; production source/build/tooling/manifests/locks are identical. Receipts retain their actual tested SHA.

Node 26.13.1, pnpm 12.18.0, Vite+ 1.5.1 and pinned Rust 1.99.1 were used. The import-free module is 138,868 raw bytes, SHA-256 `09ca2d7162d384ff53994c5fef20cbdf2741523f930663ece43d39892fa67c45`. Locked/offline regeneration, source/manifest/ABI checks, native Rust 39/39, fmt, strict Clippy and direct unsafe/alias/resource review passed. JavaScript/Actions CodeQL does not cover Rust source. Optional installed rust-src initially changed embedded sysroot paths; retained failed reproduction led to explicit compiler-commit path normalization, with minimal CI and installed-rust-src builds reproducing the same module.

Actual compiled differential tests cover 41 frozen synthetic inputs, 619 packets and 205 seeks, full decoder metadata and snapshot replay. Existing 40 canonical records remain unchanged; the signed-CTTS VFR control is additional. Four separately retained private compiled proofs cover a baseline-admitted 700k-sample compact index, all 671 owner packets plus five seeks and 27,015-byte snapshot replay, and two baseline-admitted 200k CTTS controls. The overlapping control exercises a real pending native query, abort, no stale publication and same-session recovery. The disproved 4.2M CTTS old-admission hypothesis remains a failed premise: the actual patched oracle reserves 128 bytes per timing sample and rejects it. No successful-admission or candidate performance claim is made for that input. Original FFmpeg default-sync 670 decoded frames and explicit passthrough 671 decoded frames remain separate; compressed packet equality is independently established.

Actual Windows 11 Pro 26300.9974, Chrome 157.0.8103.79 and Edge 157.0.4341.57 each ran 48 product cases: 43 saved/independently decoded GIFs, all byte-identical to the prior normalized route, and five unsupported native HEVC selections whose output is UNVERIFIED. Edge conversion options separately passed. Twelve active Worker/main Stop and same-document recovery cases passed at 4.420–7.535 ms (limit 500 ms), with no cancelled/stale publication and matching saved/decoded recovery. The small Worker observation is native retained initialization, not a post-frame point.

Final `vp run verify:full` passed 13/13 tasks: 39 policy tests, 1,856 unit/browser passes with five native capability skips, and 78 E2E passes. Managed native browser comparisons total 91 passes/32 capability skips (Firefox/WebKit separately 55/27); resource E2E has ten passes. Managed Chromium 158/Firefox 159/WebKit 27.2 do not establish installed-browser or Safari acceptance. Windows Firefox 160 is installed, but the prepared controller's available Firefox route is extension-only and lacks a WMC media adapter: actual Firefox product GUI is UNVERIFIED. Actual Safari/mobile and unavailable newer-browser GUI execution remain UNVERIFIED. Keep capability-based native/Canvas fallbacks; no accepted input or preset was narrowed.

## Prospective comparison and retained failures

V5 was frozen before its first complete invocation, digest `d75f4cb3a7085dac456e327630f4c5c10c740b48fd01570a9c077f13fd04aef5`. Five balanced/interleaved samples per variant and each of 14 conditions produced 40 logical invocations, 140 latency values and 60 GIF conversions. Every condition requires candidate median increase <=max(5% baseline median, 20 ms); criteria, settings and workloads were not loosened. Whole-product latency is request click to matching download readiness, including initialization, copies and finalization. Diagnostics and saved-output checks are outside this interval. First use does not mean cold HTTP/OS/native caches. Warm GIF/demux WASM bodies, headers and source identities were checked without prewarming the measured route.

All 14 V5 gates passed. Every saved GIF, independent composited frame/timeline/loop oracle, complete 671/10-packet File trace, metadata identity, source/build/cache, collection and owned cleanup check passed. No V5 attempt override or retry was used. Audit SHA-256: `014306abcd7f7f96fb2333d11240d29c259054f06a6a5971a7e76f426b65e189`.

| Condition | Baseline median ms | Candidate median ms | Delta ms | Allowed increase ms | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| service/owner/firstMetadata | 24.105 | 22.550 | -1.555 | 20.000 | PASS |
| service/owner/warmMetadata | 1.905 | 3.965 | +2.060 | 20.000 | PASS |
| service/owner/firstSeek | 2.965 | 5.290 | +2.325 | 20.000 | PASS |
| service/owner/warmSeek | 1.390 | 3.460 | +2.070 | 20.000 | PASS |
| service/small/firstMetadata | 21.670 | 19.185 | -2.485 | 20.000 | PASS |
| service/small/warmMetadata | 1.140 | 1.300 | +0.160 | 20.000 | PASS |
| service/small/firstSeek | 3.395 | 3.120 | -0.275 | 20.000 | PASS |
| service/small/warmSeek | 1.130 | 1.530 | +0.400 | 20.000 | PASS |
| whole/primary/first-use | 13380.850 | 13441.785 | +60.935 | 669.043 | PASS |
| whole/primary/warm | 13326.610 | 13357.525 | +30.915 | 666.330 | PASS |
| whole/default/first-use | 10721.605 | 10655.595 | -66.010 | 536.080 | PASS |
| whole/default/warm | 10511.240 | 10467.075 | -44.165 | 525.562 | PASS |
| whole/small/first-use | 184.760 | 164.640 | -20.120 | 20.000 | PASS |
| whole/small/warm | 129.995 | 120.430 | -9.565 | 20.000 | PASS |

Some owner metadata/seek service operations increased by about 2 ms and pass the declared 20 ms floor; percentages on these tiny timings are not a general speedup claim. V4 remains a complete FAILED cohort: primary warm +796.550 ms (allowance 711.187), default first +702.360 ms (565.233), default warm +586.290 ms (562.708). Its 40 invocations/140 samples and exact outputs are preserved separately, never pooled with V5. Earlier pre-comparison byte-identity, opt-in packaging and favicon failures and a pre-guest Node TLS transport failure also remain preserved. The transport recovery did not retry a failed conversion. Independent review fixed an internal duplicate-read lease defect and a prior-window source-lifetime accounting caveat before V5; no observed physical-memory overrun is claimed. Synthetic Git fixtures isolate their own unsigned temporary commits from the maintainer's enabled signing setting; actual branch commits, hooks and protections remain signed/enforced.

The actual native-File diagnostic exposed the V4 cost: owner streaming 869.120 ms, 673 arrayBuffer calls and 783.950 ms read wait, versus baseline 4.820 ms with streamed reads. The admitted window diagnostic retained all packets and reduced candidate calls to 19 and stream time to 26.565 ms; small calls fell 11 to 2, stream 14.750 to 1.670 ms. Owner completed read bytes **increased** 1,020,301 to 1,221,659 because of read-ahead. This isolated main-route diagnosis is not a whole-Worker CPU attribution, fewer-byte claim or memory-peak measurement.

## Dependencies, distribution and review limits

One additional external runtime package is removed by #495: MediaBunny. Production dependencies are owned browser-core plus external SolidJS 1.9.19 and patched wasm-webp 0.1.0. MediaBunny 1.65.2 with its existing memory patch and gifenc 1.0.3 stay pinned **development-only** oracles. Build/test packages remain; no third-party demux crate, vendored parser or renamed encoder replacement is introduced. External production Cargo dependencies remain zero. Upstream attribution and generated licenses are preserved even where a development oracle is no longer executable runtime code.

The fresh normal production graph has 16 diagnostic source maps / 167 compiled source identities and zero MediaBunny/gifenc modules across main, conversion worker, WebP worker and service worker. Diagnostic maps are not delivered. All normal JS/WASM bytes match the diagnostic graph after the exact existing postbuild WASM-URL deduplication; generated Vite helpers are build-owned executable bytes, separate from external application packages.

All delivered JS/WASM totals (all lazy chunks/workers, not just startup) changed **1,754,174 -> 1,269,603 raw bytes (-484,571)**. Separately computed Python 3.13.5 / zlib 1.3.1 per-file gzip level 9, mtime 0 changed **552,260 -> 448,224 bytes (-104,036)**; these are estimates, not measured HTTP wire bytes. The normal manifest has 27 -> 29 files, totaling 1,963,588 -> 1,479,126 raw bytes. Owned demux is 54,872 bytes by that gzip method (55,353 with default Node gzip). Do not mix compression methods or interpret these totals as process memory.

Focused final lifecycle review found no actionable defect. The measured candidate's eight app-bound required PR checks passed; skipped full OSV/tool-freshness and neutral imported dependency results remain distinct from success. Processed JavaScript/TypeScript and Actions CodeQL, Semgrep and PR OSV analyses reported no findings at their actual tested merge revision. Final exact-head checks, protected merge, default-branch checks and Pages source/provider/served-byte identity will be recorded in #494 after those gates complete. #496 GIF fusion remains ADOPTED without another package removal; direct VideoFrame ingress remains a separately bounded DEFERRED experiment. #497 remains RETAIN_CURRENT; wasm-webp/native Canvas routes and #483/#487 motion-signature decisions remain.

## Documentation/code conflict inventory

This is the complete confirmed inventory for the inspected program scope, including resolved/private-report errors. All are corrected or retained with the stated scope; the installed upstream DOM declaration gap is handled at the checked boundary. This is not a repository-wide audit. Historical issue SHAs and receipts remain historical, not conflicts merely because the revision differs.

1. decoder-service.ts:16 named gifenc after owned writer integration; corrected902f912e.

2. constants.ts:68 named gifenc output storage; corrected902f912e.

3. streaming-webp-encoder.ts:5-18 claimed wasm-webp-only mux; shared/native routes present; corrected902f912e.

4. crates/owned-vp8/README.md neutral-only claim after textured DC residual implementation; corrected in lane.

5. crates/owned-demux/src/lib.rs step comment claimed only top-level boxes/copy despite incremental sample work; correctedeb4fdf.

6. docs/experiments/494-owned-media-program.md stage2 and private gif-stage2-design.md:37-39 fixedB+4N protected-slot assumption; tiny-frame LZW bound can exceed4N; corrected root toB+max(4N,N+bound), initial private copy preserved.

7. private gif-stage2-design.md:50 required status/handle record but first ABI overloaded signedhandle; correctedcd963992 to8-byte reprC record.

8. pinned DOM CICP enum types omit modern current-standard/actual-oracle values; scoped checked native boundary cast preserves those values, upstream installed types left untouched.

9. src/types/conversion-types.ts:27-34 described MediaBunny and claimed standard WebCodecs omits aspect fields; current standard includes displayAspectWidth/Height and owned config supplies fields. Root corrected docs and renamed typeContainerVideoDecoderConfig.

10. constants.ts:74,78 described MediaBunny as production demux owner after owned callers; root corrected owned reserve vs remaining development-oracle read constant.

11. owned-demux-config.ts timestamp comment initially claimed plain1e6 multiplier preserved oracle; actual pinnedmisc.js:663 tiltsNumber.EPSILON. Root62f5e771 fixes conversion and comment with actual EncodedPacket differential tests.

12. owned-demux-session.ts top comment Blob-only vsArrayBuffer supported; corrected2e723f3c.

13. private gif-stage2-design.md:17-20 claimed one LZW crossing per selected distinct frame; duplicate/split semantics differ; corrected root per mapped candidate/per actual image-data write, same as public plan/profiler counts.

14. gif-encoder-service.ts:9 said retained RGBA scratch after stage1 removed it; root corrected actual admitted arena+protected indexes/JSfallback description.

15. use-handle-file-selected.ts:111 said BlobSource/MediaBunny after owned metadata switch; root corrected bounded owned source reads.

16. conversion-types.ts:266 BlobSource, app-types.ts:8 MediaBunny analysis, decoder-service.ts:1369 MediaBunny producer, main-thread-proxy.ts:365 MediaBunny fallback, resource-profile.spec.ts:677 MediaBunny initialization comments were stale after owned routes; root corrected allfive.

17. .github/SECURITY.md:23-26 and .github/threat-model.md:6-8,29-33,48 named gifenc/MediaBunny runtime and GIF quantizer-only scope after owned fullGIF/demux; root updated owned modules, dev-only oracles, snapshot trust boundary and scanner limits. CONTRIBUTING.md:152-177 described MediaBunny object units as production MP4 policy after owned routes; root distinguishes historical oracle units from current bounded Rust records/lifetimes.

18. crates/owned-vp8/README.md's RFC section list omitted13.5 and14.1 identified by src/default_coeff_probs.rs:1 and src/dc_quant.rs:1. Expanded exact table provenance15aa8b9c (root32cd2d5f). This is incomplete reference coverage; bounded primary-source review did not establish an imported encoder implementation or a missing Google source-code notice. Existing RFC/IETF attribution remains.

19. Private compact-positive.test.ts:1 retained the negative-proof comment after deriving an unexecuted positive ABI4 harness with acceptance assertions. Corrected the comment and preserved compact-positive-preexecution-original.test.ts; no measurement/result was rewritten.

20. CONTRIBUTING.md:153 still linked the demux README as ABI3 after the admitted compact/query upgrade changed native and host checks to ABI4. Updated to ABI4 before qualification; the old ABI3 measurement receipts retain their actual versions.

21. Private wmc-495-compact-ctts/plan and the initial #495 comment6876549346 claimed a few-run4.2M CTTS MP4 was old-admitted because its table was tiny. Actual patched isobmff-demuxer.js:387-388 reserves128 bytes per timing sample for nonempty CTTS; sample-budget.js:36-43 rejects537.6MB against32MiB. Preserved frozen hypothesis/input/failed receipts, corrected the authoritative issue comment with an explicit superseding explanation, and separated a new200k control for optional owned-workspace reduction. No candidate timing or old successful-admission claim is retained for4.2M.

22. Private wmc-495-owner/README.md kept the initialf418 comparison/result-name description after owner-differential.test.ts was changed to the presentation-fixed module/result. Appended explicit historical-snapshot scope and exact current ABI4 test/config/result paths, plus the separately verified671 passthrough-frame supplement; original670 default-sync trace and failed receipts remain intact.

23. patches/README.md:6 and its Matroska-input paragraph still described application/runtime MediaBunny imports and src/utils/mediabunny-utils.ts limit setup after production moved to owned demux. Updated to the actual development-only test/helpers/mediabunny-oracle.ts caller and retained patch behavior; production src has no MediaBunny runtime import.

24. Generated private result-report-v5-draft.md, normalized-module functional-proof paragraph, called the independent FFmpeg passthrough supplement a "671-packet" trace. Actual wmc-495-owner/independent-passthrough-supplement.json and FFmpeg framehash evidence contain671 decoded frames; the671 compressed packet trace is separately verified by the compiled product oracle. Preserved agent-original draft and corrected to "671-frame". This is a report unit-label error, not observed frame loss or a product change. Also narrowed the review wording to an internal duplicate-lease defect plus source-accounting lifetime caveat, without claiming an observed physical-memory overrun.

25. Final pre-integration report wording in docs/experiments/495-owned-demux-results.md opening/completion paragraphs, results JSON qualification field and docs/experiments/494-owned-media-program.md result link said integration/deployment facts "are recorded" while PR500 was still open/unmerged. Preserved the original private report and changed to explicit prospective wording; qualification PASS does not establish merge or deployment. No integration result was fabricated.
