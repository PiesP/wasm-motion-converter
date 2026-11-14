# Windows stable-browser acceptance

This profile adds a selective Windows acceptance layer above the deterministic
Playwright suites. It is intended for release candidates and changes to the
media, browser, or visual path. It is not a required CI gate and does not
replace `vp run test:e2e:ci` or `vp run verify:full`.

## Build inputs

In a prepared environment, use the Vite+-selected Node and pnpm versions
pinned by the repository to build the production application and deterministic media fixtures
from the repository root. The fixture command requires FFmpeg's `ffmpeg` and
`ffprobe` on `PATH`.

```bash
vp install --frozen-lockfile -- --no-runtime
vp run prepare:e2e:fixture
vp run build:ci
```

The common Windows acceptance runner reads
[`profile.json`](./profile.json) for the exact repository-relative asset list,
including production `dist/`, deterministic media, output contracts, and
playback helpers.

The profile also requires two generated, ignored evidence inputs before
packaging. `validation/windows/prior-dist/` must contain the complete production
distribution built from the recorded prior source SHA, including `_headers`,
`service-worker.js`, `index.html`, and `assets/`. Keep its file hashes in the
external campaign receipt. `validation/windows/public-target.json` has this
schema when public testing is not authorized or no exact deployment is ready:

```json
{"schemaVersion":1,"targets":[]}
```

For an authorized public smoke, populate one or two targets with the canonical
or immutable Pages URL and the provider-confirmed deployment identity:

```json
{"schemaVersion":1,"targets":[{"url":"https://wasm-motion-converter.pages.dev/","sourceSha":"<40-hex-source-sha>","deploymentId":"<provider-uuid>"}]}
```

The target file is bundled and hashed with the test artifact; it is not a
repository setting. The profile rejects unknown hosts and source mismatches.

Public checks verify deployment metadata status, MIME, schema, and source;
compare every listed output byte digest with served bytes; exercise document
isolation, a real GIF Worker, WebP WASM fallback, downloads, invalid recovery,
and effective cancellation; and record cold/warm and conversion traffic.
Public evidence files keep a target-specific prefix in the flat output
directory required by the shared guest collector. Failure diagnostics use the
same layout so collection cannot mask the original assertion.
Executable response bodies are captured when observed, before later navigation.
Edge's local downloads UI requests are recorded separately; application console
errors and external HTTP requests remain failures.

The generated MP4/WebM fixtures and `dist/` are ignored build artifacts. Their
presence in the runner bundle is therefore a required precondition, not a
tracked-source guarantee.

For motion-signature regression and timing in #483, prepare the small CI H.264
and 320×180/120-fps high-motion fixtures with `vp run prepare:e2e:fixture`.
Select `--scenario motion-signature` with installed Edge or Chrome in desktop
mode. The focused controller builds the ordinary production source and packages
that build, both fixtures, and `validation/windows/motion-signature.ts`; it
needs no prior build, public target, profiler flag, or development global.
Historical instrumented component timings are recorded in the issue evidence,
not produced or inferred by this retained scenario.

Each controller invocation measures one primary first-use conversion in a fresh
browser profile, then one same-document warm conversion with a new conversion
Worker. Small enabled and primary skip-off controls use fresh contexts in the
same browser process; their first conversions are not fresh-profile cold starts.
Run five separate, balanced controller invocations per compared variant/cache
condition, keeping all raw samples and failed attempts. The fixed GIF settings
are low quality, scale 1, and low smart-frame-skip for the enabled workloads;
the off control differs only in skip mode. Each primary output must decode to at
least 16 frames, 15 adjacent composited pixel changes, positive frame durations,
and 3 seconds within 250 ms. The scenario records the owned GIF Worker route
from its start options and completed saved bytes, plus
request-click to a visible matching GIF download button (with Blob publication
recorded separately), bounded page/console/request/HTTP failures and separately
classified Blob `net::ERR_ABORTED` events, and downloaded
file hashes. Each sample also retains the bounded static-server JavaScript
request list, the built Worker's declared `dist/_headers` cache policy,
available Resource Timing transfer sizes and delivery type for its exact URL,
and the service-worker controller path. These observations do not by
themselves establish a cache hit. Renderer heap point samples cover before click, after button
readiness, and after saved-output verification; the last sample includes harness
decoding. Worker heap, native GPU memory, and memory peaks remain unmeasured.
The scenario decodes
the saved bytes with the installed browser's `ImageDecoder` after timing and
records every frame's duration and composited RGBA hash. Compare those frame
records across variants and independently inspect the retained screenshot and
failure receipts. This scenario does not perform service-worker offline or
recovery qualification; run those checks separately.

For the separately identified owner-video follow-up, use
`--scenario motion-signature-owner-video`. Stage the unchanged private original
as `validation/windows/private-inputs/motion-owner-video.mp4`, outside `public/`, in an
independent clean controller-admitted clone. The source-owned
[`motion-owner-video.json`](motion-owner-video.json) binds its size, SHA-256,
video timeline, geometry and frozen settings. This input is ignored and must
never be committed or included in a public build. Build only in a checkout
whose `public/` contains no private video; postbuild's synthetic-name cleanup
is not a private-media exclusion policy. Inspect `dist/` and its deployment
inventory before staging the bundle. The guest verifies the staged input's
size and digest before conversion. The dedicated staging directory contains only
task-owned inputs and its tracked README; the default full profile does not
require this private file. Controller planning checks the directory, while
staging checks and the focused guest scenario validate the literal file.

This cohort starts with the full 720×720 original, GIF medium quality (12 fps),
scale 1, low smart frame skip, plus the same-input skip-off and synthetic small
controls. Its video PTS are variable and its video duration is 11.157178 s;
audio/container duration is not the output oracle. Retain the 180-second,
96-MiB and 400-decoded-output-frame bounds. Independently decode saved output,
check geometry, positive durations, infinite looping, visible variation and
video duration within 250 ms; freeze the qualified current-TS composited-frame
and timeline record before candidate timing. Synthetic 3-second/count/change
assertions do not apply. Each workload runs first use, same-document warm with
a new Worker, then context cleanup before the next workload. Historical
synthetic receipts retain their original protocol and result unchanged.

For [GIF quantization experiment 490](../../docs/experiments/490-quantization-plan.md),
use one of `--scenario gif-quantization-primary`,
`gif-quantization-secondary`, or `gif-quantization-small` per controller
invocation. Each selector packages one declared input/workload and launches a
fresh browser process/profile. The helper records first use and same-document
warm use with a new Worker, source-bound saved GIF bytes and independent
`ImageDecoder` composited-frame hashes/timeline/loop after latency, then closes
its context and browser. The primary is full owner video, medium, scale 1,
skip off; secondary is identical except low skip; small is the maintained
synthetic control. Five balanced invocations per variant and workload are
required for the timing comparison. `--scenario gif-quantization-default` runs
the owner video at medium, scale 0.75, skip off with the same first-use/warm pair.
Issue #492 repeats this default workload five times per variant; historical #490 single-correctness results
remain separate. The source-owned
[`gif-quantization-owner-video.json`](gif-quantization-owner-video.json) fixes
input digests, settings and verification bounds. Keep the private MP4 outside
`public/` and confirm the built `dist/` omits it.

For a scalar GIF WASM build, each sample reads the source-inventory-bound
WASM CacheStorage entry after download readiness and GIF verification. The
first snapshot finishes before the warm click; the second follows warm use.
Both snapshots include a bounded body SHA-256 and cache-admission headers. A
warm WASM cache classification requires matching first/warm entries, the same
controlling service worker, and no new host `.wasm` request. This is an
inference from CacheStorage and host-request evidence; the page's Worker JS
Resource Timing does not observe the Worker's WASM fetch. Missing or ambiguous
evidence stays unqualified. Baseline builds without GIF WASM record
`not-applicable` for this additional field.

Use `--scenario motion-signature-owner-recovery` for the separate owner-video
cancel-and-recover gate. It stages the same unchanged private input, exercises
the existing high-quality adaptive-skip cancellation flow, requires effective
Stop-to-idle within 500 ms and no stale Worker completion, then independently
verifies a successful small GIF in the same document. This functional run is
separate from the frozen medium-quality timing cohort.

The verifier transfers saved GIF bytes to the independent browser decoder as
base64 after the timing interval to keep the transport compact. The first
owner-video attempt exhausted the Node heap while using numeric-array transfer;
the retained byte-exact transfer repair completed the 19.6 MB output within the
original bounds. The exact original allocation site was not traced.
Verification allocations can remain until garbage collection before the warm
job, so renderer heap observations include harness effects and do not establish
product retention or peak memory.

Select `--scenario motion-signature-recovery` for the separate functional
cancel-and-recover check. It uses the same high-motion fixture for the existing
GIF high-quality adaptive-skip cancellation exercise, requiring observed
nonzero progress, an effective Stop action, Worker termination, no stale result,
and return to an idle conversion control within 500 ms of the actual Stop click.
It then converts the small fixture in the same document with GIF low quality,
scale 1, and low smart-frame-skip, verifies the downloaded bytes and independent
decoded timeline, and checks that the cancelled Worker did not complete later.
If the high-motion job finishes before Stop can take effect, the attempt records
that limitation; it does not qualify cancellation. This scenario has its own
source-bound receipt and is not pooled with timing samples.

For analysis cancellation and idle worker recovery, prepare the CI fixture and
select `{"scenario":"analysis-worker-recovery"}` in the ignored
`validation/windows/inputs/analysis-worker-recovery.json`, preserving other
focused selectors outside the input directory for the attempt. The built-app
Edge scenario holds the advisory decoder query, cancels and reselects, then
separately gates decoder frames while failing only the WebP worker module.
It checks the bounded worker count, error outcome and same-document retry after
restoring the route. These are controlled injections, not field incidence.
The same selector file accepts `{"scenario":"worker-cancellation"}` to run
only the worker case, cancel before frame dispatch, check that the pool has
retired and no worker task was submitted, and recover in the same document.

For a focused conversion-settings compatibility check, select
`--scenario settings-schema` on the shared `vmctl.py plan`, `bundle`, or `run`
command with Edge desktop mode. The controller builds the application, writes
the selector only into the new task-owned bundle, and retains the checkout's
other ignored inputs. This selection does not require `prior-dist/`,
`public-target.json`, or generated media fixtures. The default full profile
still requires its declared assets. The focused profile loads a future-version
settings record into a new tab, waits for the
initial save and user edit, then checks exact stored bytes and the visible
session-only notice. A second already-loaded tab observes a newer record written
by another document and must also leave it intact after an edit. The Browser
Mode tests separately exercise app unmount flush, migration and storage errors;
this Windows fixture does not simulate a power failure or claim atomic cross-tab
writes. The same source-bound profile also checks the built language selector's
ordered options, saved Korean preference across reload, English browser auto
resolution, and Arabic direction across reload. The focused selector does not
consume `prior-dist/` or a public target.

For current-browser native UI changes, select `--scenario native-ui` on the
shared controller with installed Edge or Chrome in desktop mode. First generate
the small CI H.264 fixture with `vp run prepare:e2e:fixture`; the controller then
builds `dist/` from the selected clean commit. The profile checks the built
app's CSS-anchored tooltip with focus,
Escape, long RTL content, viewport edges, and scrolling, then drags a captured
trim handle outside its track, rejects a foreign pointer ID, and checks its
displayed value and keyboard adjustment. It also opens an owned installed
Chrome profile, sets real browser-tab zoom to 200%, measures the viewport and
tooltip, restores the prior zoom setting, and removes the owned profile after
closure. This selector does not consume `prior-dist/` or public targets.
The current conversion warnings do not present a confirmation dialog, so this
built-app scenario does not claim installed-browser coverage of that component;
the source-mounted browser test exercises its native keyboard and dismissal
behavior separately.

For the focused conversion-option contract, first generate the small H.264 and
CFR color-marker fixtures with `vp run prepare:e2e:fixture`, then select
`--scenario conversion-option-contract` on the shared `vmctl.py plan`, `bundle`,
or `run` command in Edge desktop mode. The controller builds `dist/` from the
selected source and packages only that build, the two small fixtures, the
existing output contract, and source modules.
The profile verifies a GIF download and an app-owned built Worker `start` and
`complete` with matching request ID and output SHA-256. It opens a fresh instance
of that Worker to require bounded `INVALID_REQUEST` responses for unsupported
format, quality, frame-skip, and memory-limit values. A second app page forces
Worker construction to fail. Each GIF route independently checks the existing
CFR source-marker contract for dimensions, scene colors, ordering, and timing.
Before that contract, both routes also retain the original H.264 gradient GIF,
its 80×45 preview, compressed hash, and per-frame delays as diagnostics. The
source-marker GIF previews must decode to 96×64. Distinct files prevent either
route from overwriting the other's output. Cross-backend byte or exact-pixel
equality is not a conversion-option requirement; prior failed comparisons remain
failed evidence and the upstream gradient color difference is not classified as
harmless. A third page forces the WebP encoder pool Worker to fail and verifies
serial native Canvas encoding with an 80×45 preview. These route injections are
controlled capability failures; they do not prove a field Worker failure. This
scenario does not need `prior-dist/`, a public target, or the full
output-contract corpus. It retains a completed-result screenshot for each of
the three routes and fails on unexpected page or console errors.

For focused packet-lookup qualification, run `vp run prepare:e2e:fixture` and put
`{"scenario":"packet-lookup"}` in the ignored
`validation/windows/inputs/packet-lookup.json` selector, with other focused
selectors preserved outside the input directory for the attempt. The standard
Edge desktop route runs the generated no-index fragmented MP4 and clustered
WebM through nonzero-trim GIF/WebP conversion and the decoded-output oracle.
It then cancels a real conversion and verifies a subsequent conversion in the
same document. This selective profile does not claim the broader visual or
codec matrix; installed-parser unit tests separately cover cold/full-scan/warm
key-packet lookup and reduced-budget rejection. The generated inputs and the
retained downloaded outputs are bound by the bundle and result hashes.

For the focused trim-submission regression, prepare the ignored 10-second
timecoded fixture with `PREPARE_TRIM_SUBMISSION_FIXTURE=true vp run prepare:e2e:fixture`
and put `{"scenario":"trim-submission"}` in the ignored
`validation/windows/inputs/trim-submission.json` selector. The standard
`hyperv-control validate --kind browser --repo ... --output ... -- --browser msedge
--mode desktop` route then runs only this scenario. Its result records the
selected range, invalid-edit focus and feedback, recovery, downloaded GIF bytes
and durations, and first/last decoded timecode frames. Inspect those images
against the source fixture before claiming timestamp agreement. Use a new
external output directory for every attempt.

For the selection and source-preview regression, reuse that 10-second fixture and
put `{"scenario":"selection-preview"}` in the ignored
`validation/windows/inputs/selection-preview.json` selector. Remove other
focused selectors before packaging. The standard built-app Windows route records
file-choice labels, Change pointer/keyboard behavior, empty picker selection,
same-file reselection, retained result downloads, unsupported input recovery,
English/Korean/Japanese narrow layouts, actual Matroska native preview behavior,
and two explicitly synthetic failures scoped to `#selection-preview-video`.
The candidate profile asserts Change picker behavior, target bounds, retained
result bytes, recovery focus, and separate preview and conversion outcomes. The
empty FileList simulates cancellation at the DOM boundary; it does not prove
that a native Windows picker was cancelled. The synthetic play rejection and
media-error event do not reproduce a field incident or change the conversion
pipeline. The probe preserves partial observations and screenshots externally.

For the focused same-source preview retry, prepare the same 10-second fixture and
put `{"scenario":"preview-retry"}` in the ignored
`validation/windows/inputs/preview-retry.json` selector. Remove other focused
selectors before packaging, then run the standard built-app Windows route. The
probe first confirms native playback, injects one rejected `play()` promise only
for `#selection-preview-video`, and restores its native method before the next
user retry. It records the element/source identity, media events, readiness,
playback progress, status and button labels before asserting recovery. Its
synthetic rejection is a lifecycle regression, not a field or codec incident.

For the narrow-layout and output-comprehension evaluation, prepare the ignored
1920×1080, 30 fps, 10-second timecoded video with a long filename and a separate
24-second cancellation input using
`PREPARE_NARROW_OUTPUT_FIXTURE=true vp run prepare:e2e:fixture`. This gated command
generates only those two inputs and an FFprobe-verified, SHA-256-bound
`validation/windows/inputs/narrow-output-fixtures.json`. Add the ignored
`validation/windows/inputs/narrow-output.json` selector with
`{"scenario":"narrow-output"}`. No other focused selector may be present in
`validation/windows/inputs/` for this run. The selector requires the source-bound
**Chrome desktop** route, `--browser chrome --mode desktop`; Edge and headless
diagnostics cannot satisfy the actual Chrome 200% zoom case.

The focused profile runs the real built app at 390×844 and 320×844 CSS viewports,
then uses an owned persistent Chrome profile to set 200% page zoom **before**
file import. It checks the zoom factor with device-pixel ratio, layout width and
visual-viewport scale, and restores the prior zoom during cleanup. Each layout
uses the owned cancellation input, then selects the long timecoded input,
commits a 1–6 second clip, evaluates the sharing preset's format/clip retention,
and converts low-quality 50% GIF. Expected output is 960×540 and approximately
five seconds within the existing 0.3-second trim tolerance; low GIF targets 8
fps while the displayed ~150-frame estimate is the 30 fps source upper bound.
The report records actual GIF dimensions, delays, bytes, first/last decoded
timecode images, focus/scroll/overflow, progress, cancellation, and downloads.
A completion race or unobserved focused-edit transition is reported as
`incomplete`, not a pass. `narrow-output-expected.json` records the scripted
predictions before output; action discovery, readability and proposed UI changes
remain pending operator review. The probe supplies no participant evidence or
deployed-app claim. Preserve every attempt's external receipt and inspect the
screenshots before deciding whether a UI change is justified.

## Runner contract

The guest runner imports `profile.ts` and calls:

```js
await run({ browser, root, output });
```

`browser` is an already launched, headed Playwright `Browser` backed by an
installed stable browser. `root` is the deployed bundle root. `output` is an
external evidence directory. The common runner owns browser launch, portable
Windows Node and `playwright-core`, bundle deployment, result serialization,
and VM lifecycle.

The profile starts an ephemeral loopback HTTP server for `dist/`. Static paths
remain inside the real distribution root, MIME types are explicit, and the
catch-all CSP, COOP, and COEP values are loaded from `dist/_headers`. The server
and profile-owned browser context are closed in `finally`.

The returned value is plain JSON. Functional failures throw. Successful runs
record:

- production app load with CSP and cross-origin isolation;
- a compact over-budget MP4 sample declaration rejected before expansion, followed
  by a successful normal GIF conversion/download in the same application document;
- a small Matroska VP9 fixture with descriptive tags and an attachment selected and
  converted to a downloadable GIF after the recovery flow;
- the CI H.264 fixture converted to low-quality, 50% GIF and WebP;
- observed metadata analysis samples, when its transient state is caught,
  with indeterminate progress, task-correct cancellation labels, and no
  conversion diagnostics; an unobserved analysis is recorded as such;
- reduced-motion GIF and WebP results that start with no animated `<img>`, then
  show through Enter and hide through Space while the control keeps focus;
- result summaries and Blob downloads that remain available after hiding,
  including a hide choice that survives a motion-preference change;
- an 80 x 45 decoded preview for each output;
- default intrinsic-size preview geometry, explicit fit geometry, and a scale
  indicator that matches the rendered-to-natural size ratio;
- result summary, primary-download ordering, and opaque 12px-or-larger metadata
  contrast of at least 4.5:1 in light and dark themes; Forced Colors emulation
  checks control visibility and horizontal overflow;
- browser download bytes, format magic, size, and SHA-256;
- headed-browser screenshots for both result states;
- headed-browser screenshots of the reduced-motion default, shown and hidden
  results, dark appearance, and emulated Forced Colors;
- supported Spanish and Arabic result flows at an 800px-wide desktop viewport,
  with product-language selection, translated preview actions, RTL direction,
  control bounds, text size, no horizontal overflow, unchanged Blob download,
  and headed-browser screenshots;
- actual Chrome 200% page zoom through a fresh task-owned persistent Chrome
  profile's Settings page and a separate real GIF conversion from the same
  bundled production site and loopback server,
  confirmed by doubled device-pixel ratio, halved layout viewport, and unchanged
  visual-viewport scale; keyboard preview controls and the hidden result's Blob
  download remain available in the Arabic result flow, and prior zoom is restored;
- native metadata and advanced-settings disclosures, including keyboard toggling
  and frame-skip selection;
- the collapsed sharing-settings disclosure after the primary Convert action,
  including its low-quality/50% application, preservation of format, trim, and
  frame-skip settings, manual override, and absence of automatic conversion;
- the shared deterministic output corpus decoded in full with `ImageDecoder`,
  checking normal, non-square-pixel, and rotated display geometry plus CFR/VFR
  frame order and timing for downloaded GIF and WebP files;
- the same VFR/PAR WebP output contract through the production WASM fallback,
  with Worker construction and native WebP encoding disabled under the deployed
  CSP; the real WASM binary must initialize without JavaScript string evaluation;
- short-tail GIF raw delays and ordinary `<img>` playback observed through
  bounded timestamped compositor PNGs; repeated red-return cycles containing
  lime have a declared sampling tolerance separate from serialized endpoint
  error. Qualifying transition brackets must be at most 35 ms, each cycle must
  be within 35 ms of the 120 ms serialized cycle, and the median error must be
  at most 20 ms, with at least three consecutive qualifying cycles. Sparse
  cycles remain unknown in the retained record. Full red/lime/blue observations
  remain a separate diagnostic: this cadence check does not establish the
  visible duration of every 20 ms blue hold;
- integer-ratio sparse VFR outputs through GIF and parallel/serial/WASM WebP,
  plus controlled critical-pressure conversions with real GIF Worker terminal
  counts and native WebP decoder/encoder-task observations;
- high-motion GIF cancellation from a non-zero progress value, including an
  inspector assertion that the same progress bar and value remain visible while
  both cancellation controls are disabled and accurately named, the operation
  remains busy, and diagnostics stay collapsed and readable, followed by a
  settled, drawable first-frame preview and known non-black fixture content;
- stable-browser API and renderer observations for diagnosis.

If the high-motion fixture finishes before the stop control and non-zero progress
can be observed, the JSON records that race as an observation rather than
claiming cancellation coverage. A clicked stop control must expose the continuous
cancelling state, then return the app to its ready state without a result or
error.

## Evidence boundary

File selection uses Playwright's `setInputFiles`, and downloads are read from
the browser download event. This proves the application upload and download
paths; it does not exercise Windows Open/Save dialogs, Explorer, SmartScreen,
or filename-collision UI. The screenshots are visual acceptance inputs, not
pixel baselines.

The environment report describes the installed browser, exposed Web APIs, and
WebGL renderer. It does not measure or qualify GPU, codec, or conversion
performance. Forced Colors in this profile is browser emulation; it does not
prove the VM's native high-contrast setting. The Settings adapter checks Chrome
page zoom in a separate persistent profile because Chrome Settings cannot open
in Playwright's ordinary isolated context. That profile is created under the
supplied bundle root, closed, then removed on successful cleanup; a failed
launch or cleanup leaves a diagnostic record and preserves any profile whose
browser close could not be confirmed. Edge records that case as not run. Physical
DPI and comprehensive screen-reader behavior require separate source-bound
observations. VM results must not be used as host-hardware benchmark evidence.

The production service-worker scenario in `offline-recovery.ts` uses a separate
task-owned browser context and loopback origin. It serves the recorded prior
distribution, creates a downloadable result and caches a prior JS asset, then
switches the same origin to the candidate distribution. It checks the retained
tab and result, the prior asset while offline, a removed never-fetched JS
chunk's 404, polluted asset rejection, and recovery online. It also seeds a
prior polluted document cache, verifies activation removes it while preserving
an unrelated cache, and checks offline application recovery and settings. The
server, contexts, and offline state are restored in `finally`. This is
isolated browser evidence; public verification uses the separate, optional
target file above.
