# GIF quantization experiment 490: measured result

**Decision: `ADOPT_WASM` as the evaluated product candidate, subject to final
integration and release gates.** The scalar candidate passed the frozen timing,
correctness, byte, regression, cache, and diagnostic cancellation and owned
memory checks described below. This is a source-bound experiment decision; it
does not assert a merged, published, or deployed product.

The [prospective plan](490-quantization-plan.md) was frozen before candidate
timing. Its browser cache wording received the pre-candidate CacheStorage
amendment (private receipt SHA-256
`a2ebe8fe0d5ba5274f4f4a7b231f60c15aa146917e2f64c4ea5bbd0179c45eaa`).
The original 30-row TypeScript schedule was retained. Its first six rows had
completed before the conditional scalar schedule was frozen; five scalar rounds
were then interleaved with the four remaining TypeScript rounds. No timing
gate, noise screen, workload, or attempt limit was relaxed. The 45 valid
controller invocations each ran a fresh browser process/profile, then one
first-use conversion and one same-document conversion with a new Worker.

## Source and output identity

| Variant | Measured source commit | Role |
| --- | --- | --- |
| Baseline TS | `ae676d228b7a3a05e8a4c0860982a580095a9a25` | Locked gifenc RGB565 PNN route |
| Candidate TS | `023673400e1d9529deb7f7703d4e31b32b2fa2a8` | One histogram/bin-reuse candidate |
| Scalar WASM | `17478a2dba35caf3e3fd1cf54b8f402fb55db81f` | One Rust/WASM candidate with passive cache verifier |

The frozen-installed gifenc 1.0.3 ESM digest was
`217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093`,
and its PNN source digest was
`267a6034fee19ccf783a6ca6dc32bdb2ffea637e633abb6fd9929f8692ec932a`.
The differential tests preserve its actual green mask `0x03e0`, f64 operation
order, rounding, palette order and ties against the compiled scalar artifact.

All measured builds used core gitlink
`4638d703806b38734430a761104ee73512cbdf5c`. The scalar distribution
inventory bound the GIF module to `19,408` bytes and SHA-256
`fb6b33b702fb4aae6a0e9f2cc36a799c16ef6db46be942ac2fa409a9795264c3`.
The first scalar correctness build used source `be035a8f9baecfe09ca357adc332aa6b5d6a1c36`;
the measured `17478a2d` build added validation and cache evidence only. Its
compiled GIF Worker and WASM asset were verified as byte-identical to that
correctness build; source-SHA-derived references changed and were recorded
separately. The private first all-asset equality check failed on those expected
references and was retained, not relabeled as a pass.

The owner MP4 was `1,092,710` bytes, SHA-256
`c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c`.
Primary used GIF medium, scale 1, skip off; secondary used the same input and
settings with low skip. The synthetic control was `5,184` bytes, SHA-256
`de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`,
GIF low, scale 1, low skip. Every measured build staged a byte-identical
private copy outside public assets; the original was preserved at its existing
location. Final postbuild checks exclude the declared exact input bytes from
distribution, regardless of a copied filename.

The independent saved-file and installed-browser `ImageDecoder` oracle matched
all valid variants and samples, including ordered composited pixel hashes and
frame durations. Primary and secondary saved bytes were identical: `19,607,211`
bytes, SHA-256 `efb2532834c56d2ae723e5c94ef05422a150b6391085bd9a0da62a21f5457169`,
134 frames, `11,160,000` µs, loop count 0. The small output was `17,590` bytes,
SHA-256 `ccf94435e52830cc74a4ac4a8223e69634fe4b71b412ace49ab7110f06586214`,
8 frames, `1,000,000` µs, loop count 0. A separate scalar default-setting
correctness run, GIF medium/scale 0.75/skip off, verified 134 frames and a
`12,160,731`-byte saved GIF; it is excluded from the timing medians.

## Production timing

Values are request-click to matching download-ready milliseconds in execution
order, shown to 0.001 ms. The companion
[sanitized numeric record](490-quantization-results.json) preserves the exact
reported floating-point values, ranges, and MAD. `Warm` means the second
conversion in the same document; cache qualification is stated separately.

| Variant | Workload | Condition | Five raw samples (ms) | Median | MAD |
| --- | --- | --- | --- | ---: | ---: |
| Baseline TS | primary | first use | 19765.505, 16072.130, 16149.065, 16149.570, 17204.870 | 16149.570 | 77.440 |
| Baseline TS | primary | warm | 19381.455, 15922.855, 16041.665, 16036.465, 17212.455 | 16041.665 | 118.810 |
| Baseline TS | secondary | first use | 20895.485, 17018.320, 16997.190, 16941.445, 18046.950 | 17018.320 | 76.875 |
| Baseline TS | secondary | warm | 21050.640, 16887.790, 16896.515, 16812.170, 18143.160 | 16896.515 | 84.345 |
| Baseline TS | small | first use | 240.490, 181.680, 169.640, 184.755, 202.165 | 184.755 | 15.115 |
| Baseline TS | small | warm | 167.775, 121.825, 120.310, 124.375, 173.470 | 124.375 | 4.065 |
| Candidate TS | primary | first use | 18931.980, 15767.795, 15937.000, 15869.065, 16819.445 | 15937.000 | 169.205 |
| Candidate TS | primary | warm | 18924.595, 15740.185, 15846.310, 16708.490, 17032.125 | 16708.490 | 862.180 |
| Candidate TS | secondary | first use | 20137.120, 16739.790, 17099.830, 17880.190, 17957.225 | 17880.190 | 780.360 |
| Candidate TS | secondary | warm | 20518.825, 16773.390, 16861.260, 18010.195, 18069.605 | 18010.195 | 1148.935 |
| Candidate TS | small | first use | 228.025, 178.415, 195.110, 262.590, 178.780 | 195.110 | 16.695 |
| Candidate TS | small | warm | 156.050, 126.700, 120.045, 128.885, 121.890 | 126.700 | 4.810 |
| Scalar WASM | primary | first use | 13152.220, 13340.600, 13278.235, 14284.665, 14204.285 | 13340.600 | 188.380 |
| Scalar WASM | primary | warm | 13101.445, 13264.960, 13276.755, 14127.130, 14187.445 | 13276.755 | 175.310 |
| Scalar WASM | secondary | first use | 14179.465, 14243.205, 14257.215, 15373.445, 15043.300 | 14257.215 | 77.750 |
| Scalar WASM | secondary | warm | 14056.240, 14178.035, 14160.030, 15225.090, 15179.115 | 14178.035 | 121.795 |
| Scalar WASM | small | first use | 185.065, 174.045, 186.795, 182.080, 210.375 | 185.065 | 2.985 |
| Scalar WASM | small | warm | 125.420, 122.540, 126.825, 121.025, 123.090 | 123.090 | 2.065 |

The TypeScript candidate's primary warm median was **666.825 ms slower** than
baseline, so it failed the required saving and noise gates despite passing the
separate regression ceilings. The predeclared best-correct-TypeScript rule
therefore selected baseline for every scalar comparison. Scalar primary warm
saved **2,764.910 ms (17.236%)** against baseline, exceeding both the 100 ms
and 10% thresholds and the `3 × max(MAD)` screen of 525.930 ms. All first-use,
secondary, and small-control regression ceilings passed; the small first-use
median increased by only 0.310 ms against its 30 ms allowance. These are
median comparisons, not per-run speed guarantees or diagnostic-stage timings.

## Cache, memory, and cancellation qualification

The separate Worker JS resource was classified as service-worker CacheStorage
delivery in all 45 warm rows, with a source-bound Worker URL, controlling
`/service-worker.js`, and no new host Worker request. The scalar's WASM fetch
cannot be observed through the page's Worker JS Resource Timing. Its passive
verifier instead read the exact manifest-bound CacheStorage entry after
download readiness and GIF verification, outside the latency interval: all 15
first and 15 warm scalar snapshots matched the expected path, 19,408-byte
body SHA-256, status 200, WASM MIME type, admission header, and source key. All
15 warm pairs retained the same cache and controller, with no new host WASM
request and no request-log overflow. This supports **WASM CacheStorage reuse by
inference**, not a native Worker Resource Timing claim. The first-use label
does not itself claim a cold browser or empty cache.

The source-bound byte comparison recorded zero initial-JS gzip increase and
1,906 deferred-JS gzip bytes, within the prospective 1 KiB/8 KiB scalar
limits. The same-build WASM measured 19,408 raw and 7,795 gzip bytes under
the frozen gzip level-9/mtime-0 method, within the 128 KiB/48 KiB limits.

Private diagnostic conversions were excluded from every table value. The
first scalar active-cancel diagnostic recorded a 8.100 ms Stop-to-idle and no
stale completion, but its stage flag covered the palette wrapper, including
possible growth and copy; the first complete-owner memory receipt also dropped
memory fields during serialization. Both original receipts remain limited to
those observations. One specifically budgeted confirmation at diagnostic
source `2d8e9601da5827d38333fe128a4944b2211138b5` moved the flag to the
direct synchronous WASM `quantize` call region after RGBA copy. It recorded
stage flag 1 at Stop, 6.170 ms Stop-to-idle, zero stale completions, exact
same-document small recovery, and a new-Worker complete owner conversion with
134 kernel entry/exit pairs and the full saved-GIF oracle. The marker brackets
the call; it is not an instruction-pointer trace.

The prospectively frozen scalar limits were 8 MiB initial linear memory,
12 MiB steady primary-input linear memory, and 24 MiB old-plus-new linear
capacity during growth, in addition to charged JS scratch and output buffers.
That confirmation observed 5,832,704 bytes of initial WASM linear memory,
growth to 7,864,320 bytes, and 7,864,320 bytes at the last quantization and
final copy. The growth guard charged old plus new linear capacity alongside
the named stream, RGBA scratch, indexed and palette buffers: 24,192,000 bytes
at the observed growth; the final named-buffer charge was 49,027,659 bytes.
These are owned linear-memory and source-defined overlapping-buffer checks.
They do **not** measure whole-browser, native, GPU, or transient heap peak.
Algorithm refinements used: 0; confirmation budget used: 1.

## Evidence and remaining gates

The private, retained audit records are identified by SHA-256 without
publishing their raw logs or media: `ts-production-audit.json`
`86f156529566972941b96a13a39bab42d7b48a94500ef7b2cc004a7dac1b5ba3`,
`scalar-production-audit.json`
`28f235b04ab5652b9e764e00c7bca2b7e74d4988576e885c35b6026187b9a2ae`,
the 45-row conditional schedule
`7a11ffa0fada627c5065934165fd1eb96682c501fd23ca446415f3181bd5c863`,
and the confirmation summary
`b1ca9e1004b9cb58d14ec5b4b8688eb7adbb5a8fb3f3c41d13879bab86a071c2`.
The timing environment was the prepared Windows 11 Pro build 26300 with
installed Chromium-based browser 157.0.8103.52, Node 26.13.1, and Playwright
1.65.0. The original first-row/preflight failures and diagnostic failures
were retained separately; a later successful row does not rewrite them.

A separate installed Edge 157.0.4341.57 functional check passed at prepared
source `7cf1ac46aa9cea73a614cccbdca0efe50c195401`, bundle SHA-256
`8d4dddf53460dd3ecf91f337392eba69859c989a5cf741e9b5591af00c0544f0`.
The collected bundle and distribution inventories were rehashed, including
the same scalar WASM digest. GIF Worker and controlled constructor-failure
main-thread fallback produced byte-identical gradient and CFR outputs; five
invalid option cases were rejected, and serial native Canvas WebP passed.
Browser errors were zero, and guest collection and cleanup completed. These
small synthetic functional cases do not extend the owner-video timing cohort
or establish a visual/DPI matrix. The private source-bound summary is
`final-edge-conversion-option-summary.json`.

This decision still requires final integrated-head provenance, applicable
CI/security checks, and any publication-specific gates. The report does not
claim Pages publication, public release, or whole-system memory qualification.
