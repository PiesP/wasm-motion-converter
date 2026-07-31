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

The resource profile is intentionally separate from the regular and CI suites
because process memory varies by host. On Linux it samples Chromium process PSS,
RSS, and CPU time through CDP and `/proc`, alongside page JS heap and the optional
user-agent-specific memory API. It does not pass the deterministic
`--disable-gpu` setting used by regular tests; the actual hardware or software
GPU remains environment-dependent, and GPU VRAM is not measured. The profile
warms each encoder before five same-page conversions and also measures
cancellation latency and recovery.

## Media fixtures

Fresh CI checkouts generate `public/test-video-ci-h264.mp4` before the CI browser
profile. The larger codec matrix referenced by `lib/test-manifest.ts` is
local-only and intentionally excluded from Git; add compatible files under
`public/` before running matrix, variation, regression, or performance suites.

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

Fast CI runs the quality gate, unit coverage, the repository-backed E2E profile,
the production build, and duplication checks. Deep verification adds mutation
testing. The workflow files in `.github/workflows/` are authoritative when this
summary changes.

## Common pitfalls

- E2E behavior cannot be established by a successful TypeScript build alone.
- `SharedArrayBuffer` requires the configured cross-origin isolation headers.
- A cached browser-core submodule revision can hide fresh-checkout failures.
- Locale-sensitive assertions must specify the intended locale.
