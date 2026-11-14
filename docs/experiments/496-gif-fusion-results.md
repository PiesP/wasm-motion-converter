# Exact GIF data movement: qualification results

Coordinator: #494. Milestone: #496. Candidate PR: #498.

**Qualification decision: ADOPT the complete retained-state candidate.** Performance, deterministic output, resource and actual Chrome/Edge lifecycle gates passed. Final protected CI, integration and deployment disposition are tracked in #494/#496; this source report is not a claim that landing has already occurred.

## Source and method

The complete retained-state candidate is `7c7348c2d7a837a3aee267bbf61b2c5d52b52fd3`; the comparison baseline is `eba3cebad1f8234a2bc44b2ccbc8ac67472cfef2`, whose production source/package/lock are the qualified #492 source `f2d6bf67` with the same validation observer. Core is `4638d703806b38734430a761104ee73512cbdf5c`. Later validation-only commits preserve the measured production bytes.

Five balanced/interleaved attempts per variant/workload each contain first-use and same-document warm conversions: 30 invocations, 60 conversions. Actual installed Chrome **157.0.8103.79**, Windows 11 Pro **26300.9974**, prepared shared VM under exclusive guarded ownership. First use is not a cold HTTP-cache claim. Warm cache evidence distinguishes actual CacheStorage delivery from inferred WASM cache reuse; exact response bodies and stable controller identities match.

The measured interval runs from request click to the matching download becoming ready, including initialization, copies and finalization. Saved-output validation and diagnostics are outside it. The prospective per-condition increase is at most max(5% of the baseline median, 20 ms); criteria were not changed after measurement. Earlier stage-1 results used Chrome 157.0.8103.52 and remain separate, nonadditive evidence.

The [JSON companion](496-gif-fusion-results.json) preserves all raw samples, medians, ranges, MAD, schedule/oracle hashes, per-invocation source/build/receipt identities, settings and input/output hashes. Original local audit SHA256 is `f43833909877c2b0cadb062d34b3979c4bf3edf9d4d49271913b12875ae1181f`. Private inputs remain outside public assets; their contents are not distributed.

## Complete-candidate latency

| Workload | Condition | Baseline median ms | Candidate median ms | Change ms | Change % | Gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| primary | first-use | 15772.535 | 14947.705 | -824.830 | -5.23% | PASS |
| primary | warm | 15875.345 | 14996.110 | -879.235 | -5.54% | PASS |
| default | first-use | 12348.215 | 11796.650 | -551.565 | -4.47% | PASS |
| default | warm | 12520.405 | 11644.400 | -876.005 | -7.00% | PASS |
| small | first-use | 227.515 | 232.210 | +4.695 | +2.06% | PASS |
| small | warm | 145.035 | 160.830 | +15.795 | +10.89% | PASS |

Small warm latency increases 15.795 ms (10.89%); it passes the prospectively frozen 20 ms allowance. This is reported as a regression within the accepted bound, not a speedup.

## Ownership and material benefit

Stage 1 applies exact dithering directly to the admitted WASM input and removes the separate 4N JavaScript RGBA scratch/copy. Stage 2 retains palettes and compacted indices in Rust, with two protected N-byte slots for pending/deferred frames and a disjoint transient/compressed-output arena. Generation-checked handles prevent stale access; hash equality remains only a rejection prefilter before exact expanded-color comparison. Timing, selection, terminal holds and the owned GIF writer retain their existing owners.

| Workload | Mapping / image-data writes | Linear capacity bytes | Removed N-byte host crossings per conversion |
| --- | ---: | ---: | ---: |
| Primary | 134 / 134 | 8,912,896 | 138,931,200 |
| Default | 134 / 134 | 7,536,640 | 78,148,800 |
| Small | 8 / 8 | 5,898,240 | 230,400 |

These are observed route counts and source-defined crossing/capacity quantities. The internal N-byte promotion and final output copies remain. Reserved linear capacity is not live JavaScript allocation, native/GPU memory or measured process peak; no physical zero-copy or comparative native-peak reduction is claimed.

The module is 27,206 raw/11,291 gzip bytes, SHA256 `b9ac86604ce9fbd372139cc53446e173cb4c4ca4b28cd3d15e7e56f6b5728156`, with zero external Cargo dependencies. The retained layout is B+max(4N,N+LZWbound(N)) plus two protected N-byte slots. The existing linear/aggregate caps remain. A 4K retained layout does not fit its old cap and uses the complete owned JavaScript-index route instead; this is not a gifenc fallback and does not narrow accepted inputs.

The 19 emitted executable JS/WASM files total 1,738,780 ->1,754,174 raw bytes (+15,394) and 548,079 ->552,262 per-file gzip9 bytes (+4,183). The JSON inventories bind each delivered file to its size/hash and keep owned module growth separate from external packages. This milestone removes no additional runtime package after #492. gifenc1.0.3 remains a pinned development-only differential oracle. MediaBunny and wasm-webp remain production dependencies at this GIF candidate; #495 owns the separate demux removal and #497 retains the existing VP8 route.

## Correctness, resources and lifecycle

All 60 conversions match deterministic GIF bytes on the fixed same-decoder route and independently decoded composited frame hashes, geometry, frame order, individual delays/duration and loop. Focused tests cover palette ordering/compaction/reuse, identical colors with different indices, repeated state, tiny/odd/noisy input, pending/deferred/terminal timing, generation/lease rejection and bounded fallback.

Final combined `vp run verify:full` at `e406a8fa2a79c37aad8be0026cc0172785c4692a`, after merging current master, passed 39 policy checks, 1,643 unit/browser tests and 78 E2E tests across 11 tasks. This later result-document revision changes no executable source. The integrated type check passed 354 files. Pinned Rust regeneration, manifest/ABI checks and direct unsafe/aliasing review are Rust evidence; JavaScript/Actions CodeQL does not establish Rust-source coverage. Final exact-head gates remain required.

The maintained resource profile on production-identical source passed 10/10 checks across 3 tasks: eight workload plateaus, hostile pixel-aspect rejection and cancellation/recovery. Managed Linux Chromium observed Stop-to-idle 111.500425 ms and 795 ms of quiet recovery observation. Its PSS/RSS observations are not Windows process peaks or a baseline/candidate physical-memory comparison.

Actual Chrome 157.0.8103.79 and Edge 157.0.4341.57 on Windows 11 Pro 26300.9974 each passed all six conditions at validation source `88476a039293b023fb721bd1507e09776354c713` (same measured production bytes):

| Browser | Primary Worker | Default Worker | Small Worker | Primary main fallback | Default main fallback | Small main fallback |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chrome Stop-to-idle ms | 8.140 | 5.480 | 6.565 | 5.695 | 4.815 | 9.045 |
| Edge Stop-to-idle ms | 5.995 | 4.830 | 5.270 | 6.695 | 4.525 | 13.180 |

All have zero cancelled GIF publication, no stale completion and successful same-document same-settings recovery with saved-output/independent-decoding checks. Collection and guarded guest cleanup passed for both attempts. Full case and bundle digests plus sanitized output records are in the JSON companion.

Primary/default Worker Stop follows actual encoding progress 74; primary/default fallback uses DOM progress 74. Small fallback uses the third distinct successful Canvas readback with a prior encoded frame and a real user-blocking task. Small Worker uses a separate nonpausing CDP diagnostic after successful real native enable_retained initialization, before completion. It proves initialization work, not an encoded frame. Original b0853667/b93576c8 small Worker completed-before-progress observations remain UNVERIFIED; later native-init evidence is a distinct observation method, not a rewrite of those failures. Missing/late diagnostic evidence cannot pass. A focused independent local review found no actionable false-pass/production mutation; actual Chrome/Edge runtime observations are separate evidence.

Actual latest Safari/mobile execution is UNVERIFIED. Managed WebKit is separate evidence. Existing capability-based Canvas/native/browser fallbacks remain; no browser, format or quality preset is removed.

## Optional direct VideoFrame ingress

**DEFERRED.** The accepted candidate keeps the existing validated Canvas geometry/color route and one 4N host-to-WASM ingress. Direct asynchronous VideoFrame ingress would need separate geometry/color equivalence, destination leases that prohibit growth/reuse/release until copies settle, actual supported-browser capability evidence and a prospectively measured benefit. No additional runtime package would be removed. It is not required to complete this retained-state milestone.
