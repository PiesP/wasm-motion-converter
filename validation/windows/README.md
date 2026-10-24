# Windows stable-browser acceptance

This profile adds a selective Windows acceptance layer above the deterministic
Playwright suites. It is intended for release candidates and changes to the
media, browser, or visual path. It is not a required CI gate and does not
replace `pnpm test:e2e:ci` or `pnpm verify:full`.

## Build inputs

In a prepared environment, use the Node.js and pnpm versions pinned by the
repository to build the production application and deterministic media fixtures
from the repository root. The fixture command requires FFmpeg's `ffmpeg` and
`ffprobe` on `PATH`.

```bash
pnpm install --frozen-lockfile
pnpm prepare:e2e:fixture
pnpm build:ci
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

For the focused trim-submission regression, prepare the ignored 10-second
timecoded fixture with `PREPARE_TRIM_SUBMISSION_FIXTURE=true pnpm prepare:e2e:fixture`
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
`PREPARE_NARROW_OUTPUT_FIXTURE=true pnpm prepare:e2e:fixture`. This gated command
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
