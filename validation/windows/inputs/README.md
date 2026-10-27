# Application update acceptance inputs

## Output finalization comparison

The original motion workload uses a task-owned, ignored 12-second 1280×720 input:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=1280x720:rate=20:duration=12' -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart -y validation/windows/inputs/output-finalization-motion.mp4
sha256sum validation/windows/inputs/output-finalization-motion.mp4
```

The expected input SHA-256 is
`6133c0de0831fe6ef3d48e9d3f9aec288de4a6cbd1741a9d0c2f5372903fcbec`.
Keep this exact file for both builds. After preserving any existing selector files,
put `{"scenario":"output-finalization"}` in the ignored
`validation/windows/inputs/output-finalization.json`; no other focused selector
may be present in the packaged input directory. Build the clean source with
`vp run build:ci`, then run the standard installed-Edge desktop browser profile
with a new external evidence directory. The profile checks the production
distribution inventory and both input digests before serving the app. It
records three cold and three same-document warm WebP conversions per workload,
streamed download digests, Blob API observations, renderer heap point samples,
and bounded decoded frame hashes. Partial samples are saved on failure.

The observer records explicit WebP `Blob.arrayBuffer()` calls and the interval
from the first output-sized Blob construction to the product's Blob URL. It
cannot see browser-internal Blob copies, Worker memory, native/GPU allocations,
or process peaks. The private campaign plan fixes workloads and adoption
criteria before the baseline. Do not treat this interval as the DEV profiler's
post-mux `finalizing` span.

For the fixed 1024×576 texture workload, generate its input once with FFmpeg
7.1.5 and a single encoder thread:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=1024x576:rate=20:duration=12' -vf 'noise=alls=12:allf=t+u:all_seed=397' -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -threads 1 -movflags +faststart -n validation/windows/inputs/output-finalization-noisy-1024x576.mp4
sha256sum validation/windows/inputs/output-finalization-noisy-1024x576.mp4
```

Its expected SHA-256 is
`d50e66f509de3858eeb6ecc1863a75117d28faab9f93a86c13337e8ea0da36a5`.
Select it with exactly `{"scenario":"output-finalization-v2"}` in the ignored
`validation/windows/inputs/output-finalization-v2.json`, after preserving and
removing other focused selectors. Both variants keep the same small workload.
The texture variant records the actual production encoder branch and decodes
every large output after timing. Compare complete frame hashes, durations,
loop behavior and output bytes before interpreting timing differences. The
compact UI does not expose its terminal frame counter; decoded output counts
do not establish internal decoder selection or every dynamic skip reason.
Treat an output below the predeclared size or unequal emitted work as an
inadequate comparison, rather than changing quality, budgets or thresholds.

## Service-worker migration handoff

Place a complete clean baseline distribution at the ignored
`service-worker-baseline/` path and add `service-worker-handoff.json`:

```json
{"schemaVersion":1,"mode":"service-worker-handoff","baselineSourceSha":"<40-hex-SHA>","baselineTreeSha":"<40-hex-tree>","candidateSourceSha":"<40-hex-SHA>","candidateTreeSha":"<40-hex-tree>"}
```

This selector takes priority over other validation modes. The runner verifies
both complete inventories and distinct worker bytes, observes the new worker
claiming retained tabs, checks preserved cached assets and unavailable resources,
then exercises explicit reload and offline document recovery. It writes
`service-worker-handoff.json` to the external evidence directory. Remove the
selector after the focused run.

## Application update

The normal Windows media profile runs when `app-update.json` is absent. To select
the focused application-update profile, create this ignored file:

```json
{"schemaVersion":1,"mode":"application-update","buildA":"validation/windows/inputs/deployment-a","baseline":"validation/windows/prior-dist","baselineSourceSha":"<40-character lowercase pre-detector commit SHA>","baselineTreeSha":"<40-character lowercase pre-detector tree SHA>","cleanupBaseline":"validation/windows/inputs/cleanup-baseline","cleanupBaselineSourceSha":"6d2463937b46df629c406500bb06685ac115a98f","cleanupBaselineTreeSha":"3a5c34857aa9e5a9d3dfbb7429d648004fd2fe44"}
```

Place the complete, source-identified production build A in the ignored
`deployment-a/` directory. It must include `index.html`, `service-worker.js`,
`deployment-state.json`, `_headers`, and every `assets/` file. The normal
`dist/` is build B. The existing ignored `validation/windows/prior-dist/`
contains the pre-detector baseline. Put the complete production build from
`6d2463937b46df629c406500bb06685ac115a98f` in the ignored
`cleanup-baseline/` directory. That exact build is the original response-cleanup
behavior for issue #295; the older `prior-dist/` remains the update-detection
control. The profile verifies that A and B have
different source identities, the same package version, and byte-identical
service workers before running the browser scenario. It also verifies the
baseline source and tree identities, every listed inventory file's size and
hash, and the `_headers` digest.

For both the original cleanup baseline and fixed build B, the focused profile
serves three genuine loopback metadata responses with headers and a small prefix
while deliberately leaving each body unfinished: `200 text/html`, `200
application/json` with `Content-Length: 65537`, and `503 application/json`.
Each build receives an initial attempt and a second event after a real 61-second
quiet period. The event for this resource-release probe is test-dispatched; the
A/B update and result flows below retain real offline/online transitions. The
profile records response `close` and `finish` times and unfinished bodies before
closing its contexts and servers. The original MIME response is also observed
after 11 real seconds; it may close earlier in Edge than in Node. Build B must
abort both Fetch signals and close both bodies in each case within 3,000 ms of
response headers. A pooled idle TCP connection does not count as unfinished body
work. Invalid responses must produce no update notice. After both rejected
responses close, each fixed-build page waits another real 61 seconds and receives
the original `6d246393` artifact's valid JSON through a third same-origin HTTP
request. The same observer must then show an update notice without navigating;
its third Fetch signal remains unaborted and the completed response leaves no
unfinished work. The original-build cases stop after two rejected responses.
All three cases retain page, request and CSP health checks.

For the active-conversion cancellation case, prepare the ignored 24-second input
from the existing three-second high-motion fixture at the repository root:

```sh
ffmpeg -stream_loop 7 -i public/test-video-ci-high-motion-120fps.mp4 -map 0:v:0 -c:v copy -an -movflags +faststart validation/windows/inputs/cancel-high-motion.mp4
```

The focused profile validates and bundles this task-owned input. It reuses the
existing video stream without adding a published fixture or dependency.

The focused scenario observes real offline/online events after a 61-second
quiet period while A tabs remain open and the owned loopback server switches
to B. It checks the notice during conversion and with a retained download,
uses normal cancellation and reselection controls, and clicks **Clear result**
before an explicit reload to B. Both input builds must include that control.
For the two A/B online transitions, a temporary page-only metadata Fetch gate
holds the observer's request until Playwright finishes restoring both the page
and controlling service-worker network sessions. The original request arguments
and AbortSignal then pass to native Fetch unchanged. The gate restores native
Fetch in `finally`, and the run requires exactly one queued request, one actual
response, and the existing two-request cadence for each tab. The direct
stalled-response cleanup probes do not use this gate.
Cold JavaScript transfer must be positive and below 150,000 bytes in fresh
service-worker-blocked contexts; metadata request counts and bytes are recorded
separately.

The Windows packager copies and hashes this whole directory through
`profile.json`. Keep input source SHAs and distribution digests in the external
campaign receipt. Do not commit generated distributions or the selector file.

## WebP initialization recovery

For the focused built-app failure/reload/output scenario, create ignored
`webp-initialization.json` containing `{"scenario":"webp-initialization"}`.
This selector runs before the older migration/recovery selectors. It injects
one failed WASM fetch and a separate dependency-module evaluation failure,
verifies the locked factory's retained dependency watcher, tests cancelled late
work, uses the real protected Reload page action and decodes the recovered WebP.
Run with installed Edge through the existing artifact profile. Remove only this
selector after collection. This is controlled fixture evidence, not a production
incident or a broad codec/browser campaign.
