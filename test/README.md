# Testing

dropconvert uses Vitest for unit and integration coverage and Playwright for
browser conversion flows. Tests are tracked in the main repository and run from
the repository root.

## Setup

Use the toolchain pinned in `package.json`, initialize the shared submodule, and
install dependencies:

```bash
git submodule update --init --recursive
pnpm install
```

Playwright requires a Chromium installation. The CI and resource profiles also
require FFmpeg on `PATH` to generate their deterministic H.264 fixtures.

## Test layout

- `unit/`: Vitest component, service, store, and utility tests
- `e2e/`: Playwright conversion, i18n, regression, and visual flows
- `e2e/fixtures/`: browser helpers and output validation
- `e2e/debug/`: opt-in diagnostics and benchmarks
- `lib/`: local codec matrix, baseline data, and result recording
- `setup.ts`: shared Vitest setup
- `../vitest.config.ts`: Vitest and coverage configuration
- `../playwright.config.ts`: Playwright profiles and development server setup

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm test` | Run all Vitest tests once |
| `pnpm test -- path/to/file.test.ts` | Run a focused Vitest file |
| `pnpm test:cov` | Run Vitest with coverage thresholds |
| `pnpm test:e2e:ci` | Generate the CI fixture and run the CI Playwright profile |
| `pnpm test:e2e:resource` | Generate fixtures and run the opt-in Linux Chromium resource profile (requires FFmpeg) |
| `pnpm test:e2e` | Run the local Playwright profile |
| `pnpm exec playwright test test/e2e/smoke.spec.ts` | Run one browser test file |
| `pnpm mut:fast` | Run the focused mutation profile used by deep CI |
| `pnpm verify:full` | Run quality, build, coverage, and browser validation |

The Playwright configuration starts a local Vite server unless
`SKIP_WEB_SERVER` is set. Use `PLAYWRIGHT_TEST_PROFILE=ci` or `deploy` only when
you need the corresponding restricted profile.

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
duplication checks. Deep verification adds mutation testing. The workflow files
in `.github/workflows/` are authoritative when this summary changes.

## Common pitfalls

- E2E behavior cannot be established by a successful TypeScript build alone.
- `SharedArrayBuffer` requires the configured cross-origin isolation headers.
- A cached browser-core submodule revision can hide fresh-checkout failures.
- Locale-sensitive assertions must specify the intended locale.
