# Application update acceptance inputs

The normal Windows media profile runs when `app-update.json` is absent. To select
the focused application-update profile, create this ignored file:

```json
{"schemaVersion":1,"mode":"application-update","buildA":"validation/windows/inputs/deployment-a","baseline":"validation/windows/prior-dist","baselineSourceSha":"<40-character lowercase baseline commit SHA>","baselineTreeSha":"<40-character lowercase baseline tree SHA>"}
```

Place the complete, source-identified production build A in the ignored
`deployment-a/` directory. It must include `index.html`, `service-worker.js`,
`deployment-state.json`, `_headers`, and every `assets/` file. The normal
`dist/` is build B. The existing ignored `validation/windows/prior-dist/`
contains the before-fix baseline. The profile verifies that A and B have
different source identities, the same package version, and byte-identical
service workers before running the browser scenario. It also verifies the
baseline source and tree identities, every listed inventory file's size and
hash, and the `_headers` digest.

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
Cold JavaScript transfer must be positive and below 150,000 bytes in fresh
service-worker-blocked contexts; metadata request counts and bytes are recorded
separately.

The Windows packager copies and hashes this whole directory through
`profile.json`. Keep input source SHAs and distribution digests in the external
campaign receipt. Do not commit generated distributions or the selector file.
