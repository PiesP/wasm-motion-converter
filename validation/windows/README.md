# Windows stable-browser acceptance

This profile adds a selective Windows acceptance layer above the deterministic
Playwright suites. It is intended for release candidates and changes to the
media, browser, or visual path. It is not a required CI gate and does not
replace `pnpm test:e2e:ci` or `pnpm verify:full`.

## Build inputs

Prepare the production build and the two deterministic media fixtures from the
repository root. The fixture command requires FFmpeg.

```bash
source /home/piesp/.config/shell/env.sh
pnpm install --frozen-lockfile
pnpm prepare:e2e:fixture
pnpm build:ci
```

The common Windows acceptance runner reads `profile.json` and bundles exactly
these repository-relative assets:

- `dist/`, including `dist/_headers`
- `public/test-video-ci-h264.mp4`
- `public/test-video-ci-high-motion-120fps.mp4`

The generated MP4 fixtures and `dist/` are ignored build artifacts. Their
presence in the runner bundle is therefore a required precondition, not a
tracked-source guarantee.

## Runner contract

The guest runner imports `profile.mjs` and calls:

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
- the CI H.264 fixture converted to low-quality, 50% GIF and WebP;
- an 80 x 45 decoded preview for each output;
- browser download bytes, format magic, size, and SHA-256;
- headed-browser screenshots for both result states;
- high-motion GIF cancellation when the stop control is observable before the
  fixture finishes;
- stable-browser API and renderer observations for diagnosis.

If the high-motion fixture finishes before the stop control can be used, the
JSON records that race as an observation rather than claiming cancellation
coverage. A clicked stop control must return the app to its ready state without
a result or error.

## Evidence boundary

File selection uses Playwright's `setInputFiles`, and downloads are read from
the browser download event. This proves the application upload and download
paths; it does not exercise Windows Open/Save dialogs, Explorer, SmartScreen,
or filename-collision UI. The screenshots are visual acceptance inputs, not
pixel baselines.

The environment report describes the installed browser, exposed Web APIs, and
WebGL renderer. It does not measure or qualify GPU, codec, or conversion
performance. VM results must not be used as host-hardware benchmark evidence.
