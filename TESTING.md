# Testing Checklist – dropconvert-wasm

This checklist covers the SPA that converts a single video to GIF/WebP entirely in the browser.

## Pre-test setup

- `pnpm dev` → http://localhost:5173
- `pnpm build && pnpm preview` → http://localhost:4173
- Clear cache to re-test first-run FFmpeg download (~30MB)

## Environment & isolation

- DevTools console:
  - `crossOriginIsolated === true`
  - `typeof SharedArrayBuffer !== "undefined"`
- Network headers:
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Cross-Origin-Opener-Policy: same-origin`
- No environment warning banner when isolation is correct

## Core flow

- Dropzone visible; Convert disabled before a video is prepared
- First use shows FFmpeg download progress
- After analysis, format/quality/scale controls enable
- Convert shows progress, elapsed time, and status updates
- Preview and download work; extension is `.gif` or `.webp`
- "Convert Another" resets to the initial state

## Error handling

- Unsupported file shows validation error
- Missing isolation shows environment warning
- Network offline during FFmpeg download shows retry guidance
- Conversion failure suggests a next action (lower quality/scale or alternate format)

## Accessibility & themes

- Keyboard navigation reaches all interactive elements
- Focus rings visible; Enter/Space activates controls
- Labels present for radios and buttons
- Light/dark themes are legible and consistent

## Production verification

- `pnpm quality` passes
- `pnpm build` succeeds
- `pnpm preview` keeps isolation and conversion works for GIF and WebP
