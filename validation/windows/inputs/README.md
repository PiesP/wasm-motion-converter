# Application update acceptance inputs

## Owned VP8 large admitted source

Use `{"scenario":"owned-vp8-product-large-admitted"}` in the ignored
`validation/windows/inputs/owned-vp8-product-large-admitted.json` after preserving
other focused selectors. Stage the exact source-bound prior distribution at
`validation/windows/prior-dist/`; the profile prepares the generated source before
`build:ci` and requires `validation/windows/owned-vp8-large-admitted.json` plus
`dist-validation/owned-vp8-large-admitted.webm` in the bundle. Its source is
4032×2457 VP9, two red/blue frames with 500ms holds, frozen at 7,762 bytes and
SHA-256 `d3aae8949721b4f278e0c12f5abe3b4b98edbfd37d2f7143e7d1e7fbf35abe10`.
The selector is local input, not a repository asset.

This prospective large-input check is separate from the unchanged 4096×2457
near-cap case, whose installed Edge decoded frame was 4160×2457 coded and
4096×2457 displayed. The product's existing decoder guard checks **both**
actual dimensions against 10,066,329 pixels. Rust's VP8 macroblock padding is
an independent encoder allocation for the visible RGB input; it does not predict
the decoder's coded dimensions. Do not assume the observed coded padding for the
new source or other decoders. The profile records actual decoded metadata on
both prior and candidate attempts and requires admitted dimensions on every
successful new-source output. The pinned prior must use its shipped legacy
wasm-webp bytes, and the candidate must use owned VP8. Candidate saved output,
owned begin/step/retire,
WebP structure, visible geometry and red/blue holds remain required. Run the
source-bound `scripts/test/owned-vp8-animations.ts` verifier on a completed
profile to check full-scene pixels, infinite loop, ICC and independent native
VP8/libvpx decode. The verifier reports each saved output's original requirement
status; inspecting a saved output from a failed row does not turn that row into
a passing functional requirement. No conversion timing or quality improvement
follows from a functional pass.

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

Select only this mode for the run. The runner verifies both complete
inventories and distinct worker bytes, observes the new worker
claiming retained tabs, checks preserved cached assets and unavailable resources,
then exercises explicit reload and offline document recovery. It writes
`service-worker-handoff.json` to the external evidence directory. Remove the
selector after the focused run.

### Owned VP8 final removal verification

Use the same selector path with mode `m5-legacy-removal` and keep the complete
archived 7d9e0f1b Pages distribution as the baseline. All 29 inventoried
files and the exact manifest are pinned to the previously verified served
bytes. The archived generated `_headers` is pinned to the matching CI artifact.
The candidate is the
bundled static production `dist/`. Supply its exact source, tree, core, and
owned VP8 WASM SHA-256. This mode requires the installed desktop Chromium
controller. Stage only this selector in the full bundle because the focused
scenario packager generates a selector with a different schema.

```json
{
  "schemaVersion": 1,
  "mode": "m5-legacy-removal",
  "baselineSourceSha": "7d9e0f1bc6cfcf01a04052674f1b500c8a4b9cd3",
  "baselineTreeSha": "0018da499f5e6217d19b13c834c0dbb54c3a49c8",
  "candidateSourceSha": "<40-hex-SHA>",
  "candidateTreeSha": "<40-hex-tree>",
  "candidateCoreSha": "<40-hex-SHA>",
  "candidateWasmSha256": "<64-hex-WASM-digest>"
}
```

The receipt requires an active old-tab legacy WebP conversion, an actual cold
legacy loader failure and explicit in-app reload, and the three existing
warm-cache positive checks on the exact 7d9e0f1b bytes. The archived 112-byte
Vite shim has a separate initial cache observation. A new offline tab opens
the current application during grace while both old documents remain open.
The current tab denies canonical and query-alias requests for all four archived
executables. In that same offline window, the old tab retrieves the three
warmed canonical assets through the updated worker and verifies their exact
bytes. The controlled origin checks below exercise online requests after
retirement.

After the final old tab closes, the current application returns to the
foreground in the same document with its existing result. A passive observer
records the controlling worker's grace and retirement acknowledgements. The
test checks physical eviction of all four archived executables, including the
query keys seeded during the old build. On the private loopback, the original
three canonical direct requests still establish 404 positive controls for the
origin recorder. A separate control serves the four exact archived responses
to direct requests with query aliases. The current controlled page then
requests those resources through normal and HTTP-cache-bypassing fetches.
The receipt preserves the raw origin recorder before and after each step,
verifies that the page sends no request to origin or adds a physical cache
key, and confirms that the normal origin returns direct 404s again.

During grace, a Chromium DevTools session stops the one activated service
worker version controlling both retained old documents. A normal offline
request from an old tab wakes that same version. The receipt binds the
registered scope, version, stopped and running observations, both live
document identities and result hashes, and retained cache keys. If the
installed browser lacks this DevTools capability, the exclusive removal run
fails with the grace restart marked unverified in its diagnostic. The original
handoff mode does not require this proof.

The separate browser-process restart uses the same persisted profile after
retirement and verifies its cache, archived URLs and offline owned WebP
conversion. The additional fresh-context checks cover owned WebP online and
offline. The original handoff mode retains its earlier scope and reporting.

After the qualified build lands and deploys, run the Pages checks against the
exact clean build artifact. The final mode checks the physical artifact
inventory before making public requests. It probes the four archived codec
files, including the 112-byte Vite shim, and the archived app entry and
conversion Worker that import the old loaders. It requests all six from a new
ordinary request context before a separate revalidation pass. It binds the observed forced
software encoder and the actual browser navigation and encoder-response CSP
rules to the served artifact. The final command requires exact manifest bytes
before and after the browser run and takes no automatic Playwright retries.

```sh
DEPLOY_REQUIRE_OWNED_VP8_ONLY=1 VERIFY_CURRENT_MASTER=1 \
  EXPECTED_SOURCE_SHA=MERGED_SOURCE_SHA DEPLOY_DIST=EXACT_CI_DIST_DIRECTORY \
  DEPLOY_URL=https://wasm-motion-converter.pages.dev/ vp run verify:deploy
```

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

For the built-app initialization recovery scenario, create ignored
`webp-initialization.json` containing `{"scenario":"webp-initialization"}`.
This selector runs before the older migration/recovery selectors. It exercises
an HTTP failure, an invalid owned VP8 module and cancellation of a pending
module request. After a load error, Retry starts a new module request in the
same document. After cancellation, the scenario checks for a stale result or
error before starting a new conversion. It downloads and decodes each recovered
WebP.
Run with installed Edge through the existing artifact profile. Remove only this
selector after collection. This is controlled fixture evidence, not a production
incident or a broad codec/browser campaign.
