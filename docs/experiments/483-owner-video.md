# WMC #483 owner-video follow-up: RETAIN_CURRENT

The full owner-supplied original passed installed-Windows qualification. The minimal exact TS alternative saved **244.97 ms (1.480%)** in production warm median, below the frozen **287.40 ms** noise screen. Retain the current traversal. Remaining best-TS signature construction also does not justify Rust's **10% AND 100 ms** product gate. No Rust candidate was introduced.

This is a separate input-bound cohort. The historical synthetic **RETAIN_CURRENT**, [component index](483-component-cohort.md), rejected candidate and private receipts remain unchanged. This result does not establish field prevalence or universal TS/WASM performance.

The [sanitized record](483-owner-video-cohort.json) contains all 120 raw workload samples, full identities, per-frame output oracles, ranges/MADs, calibration, budgets and receipt digests. Original receipts and media remain private.

## Input and frozen protocol

- Original and guest-staged copy: **1,092,710 bytes**, SHA-256 `c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c`, matching the supplied attachment fingerprint. Original bytes and filesystem modification time were preserved. Guest ZIP extraction changed its filesystem timestamp; that packaging timestamp is recorded separately from media timestamps.
- H.264 High, yuv420p, **720×720**, **671 decoded source frames**; video duration **11.157178 s**, versus AAC-LC 48-kHz stereo/container duration **11.221333 s**. Video PTS increase with intervals **7.1–18.855556 ms**. Integer-timestamp precision was refined after the cohort on the unchanged original; this did not amend the frozen plan. Neither nominal 60 fps nor the Worker's metadata estimate of 61.05 fps is an exact CFR assumption.
- Primary: **full original, GIF medium quality (12-fps target), scale 1, low smart frame skip**. No trim, scale reduction or re-encoding was needed. The same original/settings with skip off and the existing 160×90, 10-fps, 1-second small synthetic input (GIF low quality, 8-fps target) are separate controls.
- Conversion bound **180 s**, verifier bound **96 MiB**, independent decoder bound **400 output frames**, and product admission limits were unchanged.
- Immutable pre-candidate plan SHA-256: `722b2fcfdeb5a731eb41f133e5b1fc88a5b7267ec0b8a614578117f172e2d2eb`. Input/source/core/build/harness identities, budgets, output oracle and order were retained before candidate timing. Each invocation ran **primary first-use → same-document warm → context cleanup**, then the small pair and off pair. Each job created and terminated a new conversion Worker. Other workload contexts did not intervene in the primary pair.
- Five invocations per variant in each separate production and instrumented stratum; order by round was `A/B`, `B/A`, `A/B`, `B/A`, `A/B`, with production followed by instrumentation. Fresh browser processes/profiles define first-use; OS/hardware caches are not claimed cold. Saved-output verification occurs outside latency, before the next job.

| Identity | Production A / B | Instrumented A / B |
| --- | --- | --- |
| Source | `8bf2857f` / `c951f0bb` | `f89d8c5b` / `b38b2e74` |
| Product base / reviewed PR base | `8fbef739` / `bb079c22` | Same |
| Core gitlink | `4638d703806b38734430a761104ee73512cbdf5c` | Same |

The record binds full source/tree, build inventory, harness/controller and receipt SHA-256 values. An independent final audit matched all **20** actual build states, files, source/core/harness, inputs, worker settings, output oracles and successful guest cleanup against the retained records. **Plan limitation:** the small input SHA was not explicit in the original plan. All attempts independently matched the pre-candidate qualification bundle's `de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`; the omission was disclosed without backdating the plan.

Environment: prepared Windows 11 Pro **26300.9974**, installed Edge **157.0.4341.46**, approximately 16-GiB guest RAM, observed 192 DPI/3840×2160 remote display. Existing autostart browsers/session daemon were preserved. No task-owned heavy build/test overlapped timing; host-wide exclusivity and physical-GPU performance are not claimed.

## Production-equivalent result

Request click to visible matching download-ready button, **milliseconds**, five samples per cell. Parentheses show **range; MAD**. Instrumented samples are excluded.

| Condition | Current A | Exact TS B |
| --- | ---: | ---: |
| Primary first-use | 16,580.21 (16,460.21–16,881.71; 95.66) | 16,386.25 (16,314.79–16,725.90; 71.46) |
| Primary same-document warm | 16,556.19 (16,395.02–16,910.15; 43.74) | 16,311.22 (16,186.89–16,426.99; 95.80) |

Warm saving **244.97 ms** exceeds the TS minimum of 5 ms but **does not exceed** `3 × max(43.735, 95.800) = 287.400 ms`. This is a prospective noise screen, not a statistical-significance claim; no tail percentile is inferred.

Cold improved by 193.95 ms. Small fresh/warm medians increased 4.99/6.46 ms, below 30 ms. Off fresh/warm increased 206.59/113.84 ms, below their approximately 1,562/1,565-ms budgets. Static per-file gzip-9 estimates increased 49 initial-JS bytes and 55 deferred-JS bytes, below 1 KiB each; these are not wire/Brotli measurements. Existing WebP WASM was identical. B added 68 bytes of temporary typed-array backing storage and no persistent cache or full-frame copy; JS/allocator overhead was not measured.

## Separate component observations and correctness

The inert [instrumentation patch](483-owner-video-instrumentation.patch) enables the existing profiler and records actual signature geometry. It is not applied to the retained product. B reused the [historical exact tile-boundary patch](483-rejected-ts-candidate.patch), adding 720×720 to its differential test dimensions. Both strides, subarrays, tiny/nondivisible and large dimensions, every signature field and downstream comparisons/threshold decisions passed the exact tests.

Warm component medians, milliseconds:

| Workload | A construction / comparison | B construction / comparison | Actual calls, construction / comparison |
| --- | ---: | ---: | ---: |
| Owner, 720×720 RGBA | 958.75 / 3.28 | 666.00 / 3.32 | 134 / 133 |
| Small, 160×90 RGBA | 4.83 / 0.70 | 3.78 / 0.49 | 8 / 7 |
| Owner, skip off | 0 / 0 | 0 / 0 | 0 / 0 |

Both variants consumed/decoded **671** source frames and processed/selected/encoded/emitted **134** frames on the owner input. Signature entry dimensions/stride and pixel-copy counts were observed separately; source frames were not equated with signature calls. Construction includes geometry bookkeeping; comparison/decision and pixel preparation remain separate. Operation intervals can overlap and must not be summed as CPU shares.

Best correct TS construction is **666 / 16,311.215 ≈ 4.08%** of production warm latency. Even ideal removal of this observed interval does not plausibly clear the 10% product gate. Rust, copying/ABI refinements and SIMD were not introduced or tested. Instrumented primary warm medians differed from production by +176.77 ms for A and +34.27 ms for B, within the frozen overhead-investigation budget; those differences do not isolate causal instrumentation cost or replace production results. Main-realm observer calibration is partial and timer-quantized.

Every saved output matched its workload's frozen current-TS bytes and independently decoded composited RGBA frame hashes/delay timeline across implementations and conditions. Owner output: **19,607,211 bytes**, SHA-256 `efb2532834c56d2ae723e5c94ef05422a150b6391085bd9a0da62a21f5457169`, **134 distinct frames**, **11.160 s**, infinite-loop extension. GIF timestamps follow the decoded relative delays, including 70/80/90-ms durations. Enabled and off happened to match for this input; equality was checked separately, not assumed generally. Small output retained eight frames/1 s. Qualification screenshots and one requested 0.5-s source sample were reviewed privately; this is not human visual review of every frame or a source-pixel losslessness claim.

Separate owner-bound cancellation/recovery passed for A (`22aa7016`) and B (`913ad653`): **7.83/5.98 ms** Stop-to-idle against 500 ms, no stale completion, and a verified subsequent small GIF in the same document with a new Worker. These functional high-quality/adaptive cancellation runs are not timing-cohort samples.

## Limits, preservation and disposition

- The first preflight exhausted the Node V8 heap near 4 GiB before retaining a completed sample. Its receipt and guest root remain private and unchanged; a later exact-root audit found no owned task/process. Numeric-array transfer expansion is a consistent hypothesis, not a traced allocation-site diagnosis. Compact base64 verifier transfer then qualified the same 19.6-MB output without relaxing bounds or changing product settings.
- Renderer points include independent GIF verification allocations and GC effects before warm conversion. The qualification used approximately 109 MiB after first verification and 134 MiB after warm verification. **Product retained-growth/4-MiB adoption-gate pass is unverified**, and Worker/native peaks remain unmeasured. Worker/context/guest cleanup is separately verified and does not establish memory retention or peak usage. No memory gate is waived.
- The original remained in its owner's checkout. Builds used a separate clean independent clone whose `public/` omitted it; byte-identical staging was under private validation inputs. All `dist` files and deployment inventories omitted the input. Public artifacts contain no raw media or private machine paths. All successful guest roots, tasks and owned browser/worker/server contexts were cleaned; failed evidence was retained deliberately.
- One exact TS alternative, 20 measured invocations/120 samples, zero Rust candidates/refinements and zero confirmatory timing passes were used. There was no retry to obtain a favorable noise result.

A final packaging review also removed the literal private file from the default
full-profile required assets. The focused scenario now stages through a dedicated
tracked private-input directory and still validates the literal file digest/size;
normal checkouts need no owner media. A full campaign can still package a staged
file if present, so the dedicated task copy is cleared after collection. The
post-trial Windows qualification at `a5e1c84c` matched all six saved outputs to
the frozen oracle and verified distribution omission/guest cleanup. It is not
included in the 120 timing samples and does not relabel the frozen receipts.

**RETAIN_CURRENT.** Keep the current TS traversal and only useful consumer-owned manifest/scenario, oracle regression, compact verifier and source-bound records. No experimental profiler activation, kernel switch, Rust/Cargo configuration or generated kernel asset remains in the product. Revisit after a justified workload/pipeline change produces a correct TS saving above the same repeatability screen; introduce Rust only when remaining best-TS critical-path cost can plausibly support at least 10% AND 100 ms. XCOM remains independent. This PR is for human review; no merge, deployment, release or repository-settings change is included.
