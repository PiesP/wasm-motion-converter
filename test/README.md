# Testing

dropconvert uses Vitest for unit and integration coverage and Playwright for
browser conversion flows. Tests are tracked in the main repository and run from
the repository root.

## Setup

Use the Vite+ toolchain selected by `.node-version`, `packageManager`, and
`pnpm-workspace.yaml`; initialize the shared submodule before installing:

```bash
git submodule update --init --recursive
vp install --frozen-lockfile -- --no-runtime
```

Browser Mode unit tests and Playwright require a Chromium installation. Install
it with `vp exec playwright install chromium`. The CI and resource profiles also
require FFmpeg on `PATH` to generate their deterministic H.264 fixtures.

## Test layout

- `browser/**/*.browser.test.{ts,tsx}`: native Chromium DOM, Solid, and browser lifecycle tests
- `unit/**/*.test.{ts,tsx}`: Node tests for pure logic, configuration, files, and VM tooling
- `e2e/`: Playwright conversion, i18n, regression, and visual flows
- `e2e/fixtures/`: browser helpers and output validation
- `lib/`: local codec matrix, baseline data, and result recording
- `setup.ts`: shared Vitest setup
- `../vitest.config.ts`: Vitest and coverage configuration
- `../playwright.config.ts`: Playwright profiles and development server setup

## Commands

| Command | Purpose |
| --- | --- |
| `vp run test` | Run both the Node and Chromium Browser Mode unit projects once |
| `vp test run --project unit path/to/file.test.ts` | Run a focused Node unit file |
| `vp test run --project browser path/to/file.browser.test.tsx` | Run a focused Chromium Browser Mode file |
| `vp run test:watch` | Watch both unit projects and rerun changed files |
| `vp run test:cov` | Run Vitest with coverage thresholds |
| `vp run test:e2e:ci` | Generate the CI fixture and run the CI Playwright profile |
| `vp run test:e2e:resource` | Generate fixtures and run the opt-in Linux Chromium resource profile (requires FFmpeg) |
| `vp run test:e2e` | Run the local Playwright profile |
| `vp exec playwright test test/e2e/smoke.spec.ts` | Run one browser test file |
| `vp run verify:full` | Run quality, build, coverage, and browser validation |

The Playwright configuration starts a local Vite server unless
`SKIP_WEB_SERVER` is set. Use `PLAYWRIGHT_TEST_PROFILE=ci` or `deploy` only when
you need the corresponding restricted profile.

Use `e2e/ci-conversion-smoke.spec.ts` for deterministic GIF/WebP conversion and
console health, `e2e/matrix.spec.ts` with the local codec corpus for broader
codec and timing records, and `e2e/resource-profile.spec.ts` for resource
measurements. The earlier `e2e/debug/` scripts were excluded from Playwright
discovery and their Vitest invocation comments did not select those tests.

See [Resource testing](./RESOURCE-TESTING.md) for the opt-in resource profile's
workload, signals, limits, and interpretation rules.

## Media fixtures

Fresh CI checkouts generate `public/test-video-ci-h264.mp4` before the CI browser
profile. The same generator creates a compact output-contract corpus: H.264/MP4
CFR inputs with and without B-frames, a VP9/WebM CFR input, an H.264 VFR input
with 2:1 pixel aspect ratio, and a fixture with 90-degree display rotation and
distinct corner markers. Fixture generation uses `ffprobe` to reject a B-frame
input without actual B pictures and reordered presentation/decode timestamps.
`e2e/output-contract.spec.ts` checks GIF trimming across frame boundaries and
WebP geometry/timing, then uses the browser's `ImageDecoder` to fully decode
every downloaded frame and assert display geometry, color-marker order,
per-frame timing, and total playback duration. It also checks the serial Canvas
WebP and WASM WebP encoders against the same VFR/PAR contract when Worker
construction is unavailable. The WASM case disables only Canvas WebP encoding,
keeping Canvas pixel copying available. A failure after the GIF Worker
initialization message cannot silently retry on the main thread.

The [presentation policy](../docs/presentation-timing.md) states sampling and GIF timing tradeoffs.
The corpus also covers a 110-ms GIF tail, a sparse three-scene trimmed interval
inside a nominal 60-fps track, and 21-fps normal/critical pressure conversions.
All five UI encoder routes assert production admission counts and observable
intermediate progress in the same document. Pressure inputs are controlled
preflight values; they are separate from native decode/encode observations.

The prepared Windows profile displays the downloaded short-tail GIF as an
ordinary Blob-backed `<img>`. `../validation/windows/gif-playback.ts` records
bounded, timestamped compositor PNGs and checks repeated visible color cycles.
It declares display sampling tolerance separately from serialized delay error.
`ImageDecoder` verifies source-scene timing and the full-composited exact
representation oracle; neither that metadata nor a self-comparison establishes
ordinary-image playback. Keep these three acceptance oracles separate.

The shared contract in `../validation/windows/output-contract.json` is consumed
by both Playwright and the production-bundle Windows profile. Codec skips are
allowed only when `VideoDecoder.isConfigSupported()` explicitly rejects the
input configuration; an unexpected extraction, conversion, geometry, ordering,
or timing result fails the test.

The larger codec matrix referenced by `lib/test-manifest.ts` is local-only and
intentionally excluded from Git; add compatible files under `public/` before
running matrix, variation, regression, or performance suites.

Browser codec support is detected at runtime with
`VideoDecoder.isConfigSupported()`. Do not replace capability detection with a
static browser or codec allowlist.

For an optional local input inspection, use the [media diagnosis procedure](../CONTRIBUTING.md#local-media-diagnosis).

## Results and artifacts

- Conversion measurements are written under `.results/` and are not release
  artifacts.
- Playwright output is written to the root `test-results/` and
  `playwright-report/` directories.
- Keep screenshots, traces, and temporary fixtures out of commits unless they
  are intentional test assets.

## CI coverage

Fast CI runs the quality gate, unit coverage, the repository-backed E2E profile
(including deterministic output contracts), the production build, and
the retained quality checks. The workflow files in `.github/workflows/` are
authoritative when this summary changes.

`quality` retains `test:ci` locally and owns that policy suite in CI when selected.
For unit-only routing, unit runs `test:ci`, installs Chromium, then runs its
independent `test:cov` step across both unit projects;
uncertain classification enables every gate. The policy suite is only part of
unit validation, and `verify` does not run full product coverage or browser E2E.

## Common pitfalls

- E2E behavior cannot be established by a successful TypeScript build alone.
- `SharedArrayBuffer` requires the configured cross-origin isolation headers.
- A cached browser-core submodule revision can hide fresh-checkout failures.
- Locale-sensitive assertions must specify the intended locale.
