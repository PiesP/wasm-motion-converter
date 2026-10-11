# Application update acceptance inputs

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
