# Resource testing

The resource profile is intentionally separate from the regular and CI suites
because process memory varies by host. Run it from the repository root after
completing the setup in the [testing guide](./README.md):

```bash
pnpm test:e2e:resource
```

## Workload

The profile warms each encoder before five same-page conversions and also
measures cancellation latency and recovery. Its contract workload is
`motion-cadence-gif`: the 320×180
`test-video-contract-motion-120fps.mp4` fixture is converted to GIF at high
quality, full duration, 100% scale, with smart frame skipping off. The decoded
output is checked against the shared color order, visible scene holds, geometry, and
cadence contract.

The profile also measures GIF/WebP high-motion workloads and small VFR WebP
conversions through automatic routing, serial Canvas, and WASM. Each record
retains the observed encoder route and exact decoded, selected, encoded, and
emitted frame counts. Consumed packet counts remain null when the serial Canvas
decoder does not expose them. Backend overrides belong only to the two
explicit fallback measurements. Cold initialization is recorded separately from
the five warmed conversions; it is excluded from leak slopes. The WASM override
disables Canvas WebP encoding while retaining Canvas pixel-copy support.

Two additional 21-fps GIF workloads compare normal and critical preflight
pressure with identical input and settings. The injected `performance.memory`
values select the policy and appear in embedded profiler heap fields; the CDP
resource sampler measures actual renderer heap separately. Each result records
the controlled values and
asserts 21 native decoded frames and 20/15 admitted frames. These scenarios
exercise approximate memory-driven sampling, not representation compression.

`cfr-trim-gif` remains a separate output-contract test; it is not the current
resource-profile workload. Measurements from the older `cfr-trim-gif` profile
and the current `motion-cadence-gif` profile are not a direct before/after
comparison because the input, settings, and measured frame work differ. Compare
revisions with the same source except for the targeted change, fixture, settings,
harness, browser, host, and run order.

The resource pretest additionally generates a small VP9/WebM fixture with coded
dimensions of 520×520 and a 100:1 pixel aspect ratio. MediaBunny exposes this as
52,000×520 display-aspect dimensions, just beyond the conservative per-frame
working-memory limit. The profile verifies the real container metadata, samples
the fast rejection path at 20 ms intervals, and checks repeated post-GC PSS/RSS
slopes. This demonstrates rejection before large Canvas, Worker, or frame-buffer
allocations; it is not a GPU VRAM measurement.

## Signals and evidence

On Linux, the profile samples Chromium process PSS, RSS, and CPU time through
CDP and `/proc`, alongside renderer JS heap from CDP `Runtime.getHeapUsage` and the optional user-agent-specific
memory API. It does not pass the deterministic `--disable-gpu` setting used by
regular tests; the actual hardware or software GPU remains
environment-dependent, and GPU VRAM is not measured.

PSS is the primary process-memory signal. RSS is retained as a diagnostic because
shared mappings are counted in every Chromium process's RSS. Every process in a
CDP snapshot must have readable PSS and RSS before a sample can contribute to a
peak or slope. If a process exits while `/proc` is read, the sampler replaces
the whole CDP snapshot once. A second incomplete snapshot fails with PID,
process-type, source, and missing-field evidence. RSS from
`/proc/<pid>/status` remains diagnostic data and is never substituted for
unavailable PSS.

Each measured conversion retains its encoded output and SHA-256 after the timed
interval. Playwright attachments bind input digest, settings, wall time, CPU,
sampled memory, output bytes, and decoded frames in one evidence record. All
outputs are decoded after the measured cycles and post-GC samples. A failed
color contract preserves all measured outputs and fails the test. An older
incorrect output is an error baseline, not a performance advantage.

## Limits and interpretation

The profiler's non-overlapping stage durations describe demuxing, combined
streaming decode/encode, and finalization. Fine-grained operation totals such as
pixel copy and GIF palette mapping can overlap one another; do not add them or
interpret them as stage percentages. `transcodingWallMs` is the combined
decode/encode stage duration. `elapsedMs` spans the UI conversion request
through observed completion and includes resource sampling and completion
detection, so it is not encoder-only time.

Unavailable heap measurements remain null. Conversion-owned admission estimates
are separate from heap and process memory. Fixed frame/task backpressure remains
the primary bound; additional memory-driven frame skipping changes sampling and
is not lossless compression. WebP encoding, queue wait, muxing, finalization,
and output copying are overlapping operation observations.

The equal-size, non-rotated Canvas copy shortcut avoids creating an intermediate
`ImageBitmap` for that path. It still calls `drawImage()`, reads pixels with
`getImageData()`, and converts those pixels; conversions using native
`VideoFrame.copyTo()`, scaling, or rotation do not exercise this shortcut. This
is a path-specific optimization, not a claim that every conversion is faster or
that pixel copying has been removed.

Wall time includes UI completion detection and resource sampling at 150 ms
intervals, so short conversions cannot establish fine encoder timing. Memory
peaks are observed sample maxima. CPU covers the Chromium processes reported by
CDP; a change in sampled process IDs makes its delta unavailable and fails the
measurement gate. Processes that start and exit between samples are outside that
CPU observation.

Repeated identical settings must retain the same output digest, without claiming
stability across browser, codec, or dependency versions. Compare revisions with
the same fixtures, settings, harness, browser, and host, and retain the source
binding and run order alongside the attachments.
