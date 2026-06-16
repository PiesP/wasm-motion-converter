# AGENTS.md

This file provides guidance for AI coding tools working in this repository.

## Scope

This file provides guidance for agentic coding tools working in this repository.
Follow all rules in this file, plus any newer scoped AGENTS.md files.

## Project Snapshot

- App: **dropconvert-wasm** (Vite + SolidJS + TypeScript SPA)
- Purpose: Convert a **single video** to GIF or animated WebP entirely in-browser
- User-facing output formats: **GIF** and **WebP** only
- Key constraints: no uploads, cross-origin isolation required for FFmpeg multithreading

## Commands (Build/Lint/Test)

### Core commands

- `pnpm dev` - Start Vite dev server
- `pnpm build` - Production build (runs `prebuild` = `pnpm quality`, then `vite build` which generates `public/cdn-integrity.json`, `public/LICENSES.md`, and `public/robots.txt`)
- `pnpm preview` - Preview production build
- `pnpm lint` / `pnpm lint:fix` - Biome lint (check / fix)
- `pnpm fmt` / `pnpm fmt:fix` - Biome format (check / fix)
- `pnpm check` / `pnpm typecheck` - TypeScript typecheck (no emit, alias pair)
- `pnpm quality` - Non-mutating quality gate (format check + lint + typecheck + knip)
- `pnpm quality:fix` - Quality gate with repository-standard format/lint fixes applied first
- `pnpm quality:ci` - Alias for the CI-friendly quality gate (`pnpm quality`)
- `pnpm knip` / `pnpm knip:full` - Unused dependency scans (full is informational)

### Tests / single-test guidance

- There is **no unit test runner** configured. Use `pnpm check` (or `pnpm typecheck`) for TS coverage.
- For manual verification, use `pnpm dev` or `pnpm build && pnpm preview`.
- Single-test equivalent: run targeted manual checks from `TESTING.md` against one flow.

#### AI-driven browser testing (dev mode)

The app exposes `globalThis.__TEST_HELPERS__` in dev mode for AI agents and automation tools.
This bypasses OS file-dialog barriers and provides direct store access.

**Start the dev server for AI testing:**

```bash
cd /home/piesp/projects/wasm-motion-converter
NODE_OPTIONS='--no-deprecation' npx vite &
# Wait for SERVER_READY
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/
# Then use browser tools: browser_navigate → browser_console → browser_snapshot
```

**Available test helpers (via `browser_console` eval):**

```js
// Load & attach (only needed once per page load)
await import('./src/test-helpers').then(m => m.attachTestHelpers())

// ── White-box: direct state access (setup / injection) ──
__TEST_HELPERS__.getAppState()      // 'idle' | 'loading-ffmpeg' | 'analyzing' | 'converting' | 'cancelling' | 'done' | 'error'
__TEST_HELPERS__.getProgress()      // 0-100
__TEST_HELPERS__.getSettings()      // { format, quality, scale, trimStart, trimEnd }
__TEST_HELPERS__.getInputFile()     // { name, size, type } | null
__TEST_HELPERS__.getMetadata()      // { width, height, duration, codec, frameRate } | null
__TEST_HELPERS__.getError()         // string | null

// Inject a file (bypasses OS file dialog)
const dummy = new File(['dummy'], 'test.mp4', { type: 'video/mp4' })
__TEST_HELPERS__.injectFile(dummy, { width: 1920, height: 1080, duration: 5, codec: 'h264', frameRate: 30 })

// Reset app to idle
__TEST_HELPERS__.resetApp()

// ── Black-box: DOM-based assertions (user-perspective) ──
__TEST_HELPERS__.isConvertButtonEnabled()   // boolean — convert button enabled?
__TEST_HELPERS__.isResultVisible()          // boolean — result section shown?
__TEST_HELPERS__.isErrorVisible()           // boolean — error display shown?
__TEST_HELPERS__.isMemoryWarningVisible()   // boolean — memory warning shown?
__TEST_HELPERS__.getVisibleStatusText()     // string | null — progress/status text
__TEST_HELPERS__.getVisibleResultStats()    // { originalSize, outputSize, format, quality, scale } | null

// ── DOM queries ──
__TEST_HELPERS__.queryTestId('dropzone')           // Element | null
__TEST_HELPERS__.queryAllTestIds('option-format')  // NodeListOf<Element>
__TEST_HELPERS__.readProgressFromDOM()             // number | null

// Wait for condition
await __TEST_HELPERS__.waitFor(() => __TEST_HELPERS__.getAppState() === 'done', { timeoutMs: 30000 })
```

**UI elements with `data-testid` (for `browser_snapshot` + `browser_click`):**

| testid | Element | Visibility |
|--------|---------|------------|
| `theme-toggle` | Dark/light mode button | Always |
| `app` | Main content region | Always |
| `status-alerts` | Error/offline banners | Always |
| `dropzone` | File drop area | Always |
| `choose-file-button` | File picker button | Always |
| `file-input` | Hidden file input | Always |
| `convert-button` | Convert button (enabled after file load) | After file load |
| `stop-conversion-button` | Stop button | During conversion |
| `option-format-gif` / `option-format-webp` | Format radio | Always |
| `option-quality-low/medium/high` | Quality radio | Always |
| `option-scale-0.5/0.75/1` | Scale radio | Always |
| `option-group-format` / `option-group-quality` / `option-group-scale` | Option group fieldsets | Always |
| `video-metadata` | File info panel | After file load |
| `trim-selector` | Trim range control | After file load |
| `trim-reset-button` | Trim reset button | After file load |
| `download-result-button` | Download link | After conversion |
| `result-image` | Output preview | After conversion |
| `result-section` | Result area | After conversion |
| `memory-warning` | Memory alert | Conditional |
| `memory-warning-dismiss` | Dismiss memory warning | Conditional |
| `memory-warning-reduce` | Reduce quality button | Conditional |
| `memory-warning-continue` | Continue anyway button | Conditional |
| `memory-warning-cancel` | Cancel conversion button | Conditional |
| `error-display` | Error panel | On error |
| `error-dismiss-button` | Dismiss error | On error |
| `error-retry-button` | Retry button | On error |
| `error-select-different-button` | Select different file | On error |
| `error-select-different-fallback-button` | Select different file (fallback) | On error |
| `modal-cancel-button` / `modal-confirm-button` | Modal actions | On validation warning |
| `conversion-progress` | Progress bar region | During conversion |
| `environment-warning` | Environment warning banner | Conditional |
| `offline-banner` | Offline banner | When offline |
| `export-logs-button` | Export logs button | Always |

**Black-box verification examples:**

```js
// Assert convert button becomes enabled after file injection
__TEST_HELPERS__.isConvertButtonEnabled() === true

// Assert result section appears after conversion
await __TEST_HELPERS__.waitFor(() => __TEST_HELPERS__.isResultVisible(), { timeoutMs: 60000 })

// Assert no error shown
__TEST_HELPERS__.isErrorVisible() === false

// Read result stats from DOM
const stats = __TEST_HELPERS__.getVisibleResultStats()
// → { originalSize: "2.4 MB", outputSize: "892 KB", format: "WEBP", quality: "MEDIUM", scale: "100%" }
```

**Standard AI test workflow:**

1. `browser_navigate('http://127.0.0.1:5173/')` — Load app
2. `browser_console` eval → verify `__TEST_HELPERS__` loaded, check `getAppState() === 'idle'`
3. `browser_console` eval → inject test file via `injectFile()`
4. `browser_snapshot` — verify `video-metadata` visible, `convert-button` enabled
5. `browser_click` settings (format/quality/scale) → verify via `getSettings()`
6. `browser_click` convert button → monitor progress via `waitFor()` or polling `getProgress()`
7. `browser_snapshot` — verify `download-result-button`, `result-image` after completion
8. Repeat for edge cases: error states, memory warnings, cancel flow

After testing:
```bash
kill $(lsof -t -i :5173)  # Stop dev server
```

## Cursor / Copilot Rules

- No `.cursor/rules` or `.cursorrules` files found.
- Copilot rules (from `.github/copilot-instructions.md`):
  - Source/comments/docs in English
  - Commits in English using conventional commits
  - Alias-first imports (see below)
  - Prefer FFmpeg built-in demuxer/decoder/encoder for broad codec support; use browser VideoFrame API for software-decode path when FFmpeg WASM cannot decode the codec (e.g. AV1)
  - Use COOP/COEP headers (`public/_headers`, `vite.config.ts`)
  - Keep diffs small, UI responsive, always handle loading/progress/error states
  - Do not document MP4 export as supported unless the UI and end-to-end workflow support it

## Import Rules (Critical)

- **Use alias-based, leaf imports** for cross-folder modules.
- Same-folder imports can use `./` relative paths.

Examples:

```ts
// ✅ Allowed
import { logger } from '@utils/logger';
import { convertVideo } from '@services/orchestration/conversion-orchestrator-service';
import type { ConversionSettings } from '@t/conversion-types';
import ProgressBar from './ProgressBar';

// ❌ Forbidden
import { logger } from '../../utils/logger';
import { Button } from '@components'; // barrel
import { logger } from 'src/utils/logger';
```

Aliases: `@/*`, `@components/*`, `@services/*`, `@utils/*`, `@stores/*`, `@hooks/*`, `@t/*`

## Formatting & Linting

- Use **Biome** for lint/format. Do not add new formatters.
- Prefer existing patterns for spacing, quotes, and JSX style.
- Keep JSX props readable; break long prop lists to multiple lines.
- Avoid adding inline comments unless necessary.

## Types & Naming

- Use explicit types for public APIs and cross-module boundaries.
- Use `type` imports for types.
- Prefer descriptive names over abbreviations.
- Components: `PascalCase` (e.g., `ConversionProgress`)
- Functions/vars: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Files: `kebab-case.ts` for utilities, `PascalCase.tsx` for components

## Error Handling

- Use `getErrorMessage()` for error normalization.
- Log with `logger.{info|warn|error|debug}`; include context objects.
- For non-critical cleanup failures, log at `debug` or `warn` and continue.
- Do not swallow conversion errors; pass them to UI classification.

## UI/UX Expectations

- Single dropzone for video input.
- Show loading/progress/error states at all times.
- Keep dark/light theme parity; ensure contrast and focus rings.
- Conversion settings (format/quality/scale) always visible after load.
- Surface environment, offline, and retry guidance when runtime prerequisites fail.

## Architecture Notes

### Conversion pipeline

```
File → path planner → FFmpeg path (default) or Software decode path
                                 ↓                              ↓
                    FFmpeg built-in demuxer +              HTMLVideoElement
                    decoder + encoder (WASM)                → VideoFrame / ImageBitmap
                    [all codecs]                           → raw RGBA → VFS
                                                                   ↓
                                                           FFmpeg encoder (WASM)
                                                                   ↓
                                                              output blob
```

### Service map

- `convertVideo()` / `cancelConversion()` (`src/services/orchestration/conversion-orchestrator-service.ts`) — top-level conversion lifecycle
- `selectSimplePath()` (`src/services/orchestration/simple-path-planner-service.ts`) — selects FFmpeg or software-decode path based on codec
- `capabilityService` (`src/services/video-pipeline/capability-service.ts`) — probes and caches browser media capabilities (VideoDecoder, WebP encode)
- `ffmpegService` (`src/services/cpu-path/ffmpeg-pipeline-service.ts`) — shared FFmpeg lifecycle, VFS, encoding; uses FFmpeg built-in demuxer/decoder/encoder
- `FrameExtractorService` (`src/services/orchestration/frame-extractor-service.ts`) —software-decode path frame extraction via `VideoFrame` + `createImageBitmap` + `OffscreenCanvas`
- `src/services/ffmpeg/core-assets-service.ts` + `init-service.ts` — FFmpeg WASM CDN loading and initialization

### Path selection

| Path | Codec condition | Demux | Decode | Encode |
|------|----------------|-------|--------|--------|
| `cpu` | FFmpeg-preferred (theora, vp6, mpeg4…) or unknown | FFmpeg built-in | FFmpeg built-in | FFmpeg built-in |
| `software` | WebCodecs-native (H.264, VP9, AV1, HEVC) or FFmpeg-unsupported decode (AV1) | Browser built-in (HTMLVideoElement) | Browser GPU via VideoFrame API | FFmpeg built-in (rawvideo → GIF/WebP) |

### Planned (not yet implemented)

- **WebCodecs VideoEncoder** — would enable full GPU pipeline (Chrome WebP only; GIF and cross-browser support unclear as of 2026). Requires Mediabunny as a prerequisite for demuxing.
- **Mediabunny** — unified demuxer needed only for the WebCodecs VideoEncoder path; FFmpeg path uses FFmpeg's built-in demuxer. No standalone benefit without WebCodecs encode support.

### Removed

- mp4box, web-demuxer — previously used as CDN-loaded per-format demuxers; replaced by FFmpeg built-in demuxer in current architecture

## Security Rules

- Avoid `eval()`, `new Function()`, or string-based timers.
- Use `textContent` instead of `innerHTML`. Do not inject raw HTML.
- Sanitize any user-controlled data before DOM insertion.
- Test helpers (`__TEST_HELPERS__`) must only be attached in dev mode (`import.meta.env.DEV`). Never expose in production builds.
- All CDN dependencies must use SRI (Subresource Integrity) hashes. Verify integrity in the service worker before caching.

## Performance & Safety

- Check `isMemoryCritical()` before decoding.
- Avoid heavy work on main thread; use workers or idle callbacks.
- Keep conversion status updates throttled to avoid log spam.

## Documentation References

- `README.md` for the product overview and current commands
- `CODE_STANDARDS.md` for detailed coding conventions
- `TESTING.md` for manual verification checklist
- `.github/copilot-instructions.md` for assistant rules
