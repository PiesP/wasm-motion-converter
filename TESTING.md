# Testing Checklist – dropconvert-wasm

This checklist focuses on the SPA that converts a single image into a short MP4 or GIF using ffmpeg.wasm entirely in the browser.

## Pre-test setup

- `pnpm dev` → http://localhost:5173
- `pnpm build && pnpm preview` → http://localhost:4173
- Clear cache between first-run tests to re-download ffmpeg core (~30MB).

## Environment & isolation

- In DevTools console, confirm:
  - `crossOriginIsolated === true`
  - `typeof SharedArrayBuffer !== "undefined"`
- In the Network tab, response headers include:
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Cross-Origin-Opener-Policy: same-origin`
- No environment warning banner should appear when isolation is correct.

## UI & theme

- Initial load respects system theme (light/dark) and the toggle switches instantly.
- Theme preference persists on reload.
- All text/icons remain legible in both themes.

## Core flow (single image)

### Initial state

- Dropzone visible with image-only hint.
- Format, quality, and scale selectors shown but disabled until an image is prepared.
- Convert button disabled.

### Image selection & preparation

- Drop a supported image (PNG/JPEG/WebP/HEIC where supported).
- On first use, FFmpeg download progress appears (`Loading FFmpeg (~30MB)...`).
- After FFmpeg loads, a short preparation/analyze step runs.
- Once ready:
  - Metadata or basic info is shown (if available).
  - Any performance warnings surface for very large images.
  - Format/quality/scale controls enable and the Convert button activates.

### Conversion

- Click **Convert**:
  - Progress bar updates from 0 → 100%.
  - Elapsed time increments (mm:ss).
  - Status text updates during work.
- Small image (<5MB) finishes quickly; larger images still complete within the 5-minute timeout.

### Result preview & download

- Preview shows the generated loop.
- Download saves with the correct extension (`.mp4` or `.gif`) and the file opens/plays correctly.
- Size stats make sense (output vs. input).

### Reset / convert another

- "Convert Another" resets to the initial state.
- Dropzone reappears and settings reset to defaults.

## Error handling

- Unsupported file (e.g., .txt) → clear validation error, conversion blocked.
- Oversized image beyond limits → friendly error or warning.
- Missing isolation (no COOP/COEP) → environment warning banner appears.
- Network offline during FFmpeg download → init timeout with guidance to retry.
- If a conversion fails, the error message includes a suggestion to proceed (lower quality/scale, try GIF/MP4 alternate).

## Accessibility

- Keyboard navigation reaches all interactive elements in a logical order.
- Focus rings are visible; Enter/Space activates buttons and radio inputs.
- Labels are present for radios (format/quality/scale) and buttons.
- Contrast is acceptable in light and dark themes.

## Production build verification

- `pnpm quality` passes (lint, format check, typecheck).
- `pnpm build` succeeds without errors.
- `pnpm preview` serves the built app with COOP/COEP headers; `crossOriginIsolated` remains `true`.
- Conversion succeeds for both MP4 and GIF outputs.

## Success criteria

- Cross-origin isolation confirmed.
- FFmpeg loads and shows progress on first run.
- Single-image flow completes with working MP4 and GIF outputs.
- Clear progress, error, and warning messages at every stage.
- Accessible and theme-consistent UI.
