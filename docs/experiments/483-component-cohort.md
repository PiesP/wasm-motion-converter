# WMC #483 instrumented component cohort

The [sanitized sample index](483-component-cohort.json) records 60 successful workload samples from ten independent controller invocations: five each for A and B. This is the matched **instrumented** cohort. It does not establish the performance of an uninstrumented production build or a WASM candidate.

## Source and workload identity

- Refreshed product base: `8fbef7391eb7fbc2f2cc6aeb960e032e02871b5c`; A application and harness: `814893f031e2d95c4d8128a476b50f05076dcf99`; B application and harness: `fdf7879060e419c84458f693cc203b6bd8891ff9`; core gitlink: `4638d703806b38734430a761104ee73512cbdf5c`.
- The index binds the shared harness files, controller, packager, and ten original result, bundle, and collection receipts by SHA-256. The original receipts remain private; the index contains no VM identifier, private file path, or media bytes.
- Primary and off use the same 320×180, 120 fps, 3 s input (SHA-256 `36dd064afeefde15ecceea49109fffee6b17cdf0962de6eb21e0255fdd0cb8f8`). Small uses the 160×90, 10 fps, 1 s input (SHA-256 `de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`). Each uses GIF, low quality, scale 1, and full duration; off disables smart frame skip.
- The retained amended plan has SHA-256 `f0d6f3001663d839dee0c914fcc95ab18eec2374a84437c09b74ed57b6cb0de7`. It includes the correction to low quality and later amendments. The digest of the original pre-amendment freeze is unavailable; this amended digest must not be presented as its substitute.

Each invocation ran primary first-use, small first-use, and off first-use in three fresh documents, followed by their warm second conversions in those same documents and browser process. The primary warm conversion therefore followed the small and off first conversions in that process. First-use for small and off means a fresh context, not a new browser process. Invocation order alternated `A1/B1`, `B2/A2`, `A3/B3`, `B4/A4`, `A5/B5`.

## Observed timings

Construction / unchanged comparison medians in milliseconds; each row contains five samples per variant. Exact per-sample values and call counts are in the index. Operation intervals can overlap and are not CPU shares. This index does not recompute or replace the historical end-to-end result comment.

| Workload and condition | A construction / comparison | B construction / comparison | Calls per sample |
| --- | ---: | ---: | --- |
| Primary, first-use | 27.25 / 0.74 | 22.52 / 0.73 | 24 / 23 |
| Primary, warm | 25.35 / 0.67 | 21.42 / 0.70 | 24 / 23 |
| Small, fresh context | 3.96 / 0.56 | 4.93 / 0.71 | 8 / 7 |
| Small, warm | 4.01 / 0.67 | 3.52 / 0.49 | 8 / 7 |
| Off, fresh context | 0 / 0 | 0 / 0 | 0 / 0 |
| Off, warm | 0 / 0 | 0 / 0 | 0 / 0 |

Construction covers 320×180 RGBA for primary and 160×90 RGBA for small. The unchanged comparison follows the construction call; the retained profiler still keeps the area-level motionFeatures timer separately. These component values do not change the production RETAIN_CURRENT decision or establish isolated causal savings.

## Output and limits

Every original receipt records the same saved-byte SHA-256 and the same independently decoded frame hashes and durations for a given input, across A, B, enabled/off, first-use, and warm conditions. Primary saved output is 7,717 bytes, 22 decoded frames, and 3,000,000 µs; small is 17,590 bytes, eight frames, and 1,000,000 µs. The index carries the exact compact output records and their canonical SHA-256 `3abb6a073fa2c6fe097d9b4d597e01d14150d1c7aede68c7eceac9d60a2b9791`.

Primary construction measured 24 calls over 320×180 RGBA input with stride 4; small measured eight calls over 160×90 RGBA with stride 4. The primary source decoded 360 frames and selected 22 with skip enabled; off selected 24, while both saved outputs have 22 composited frames. The input and cadence are a bounded synthetic fixture, not evidence of field prevalence. Renderer heap observations, Worker/native memory, instrumentation overhead, cancellation, and uninstrumented controls require separate evidence. No tail percentile is inferred from five invocations.
