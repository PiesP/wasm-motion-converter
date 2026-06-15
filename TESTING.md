# Testing Guide — wasm-motion-converter

## Quick Start

```bash
# Install dependencies
pnpm install

# Run typecheck + lint + format check
pnpm quality

# Build for production
pnpm build

# Preview production build (required for e2e tests)
pnpm preview
```

## Test Structure

```
test/
├── e2e/                    # Playwright browser tests
│   ├── dogfood-qa.spec.ts  # Production site health checks (21 tests)
│   ├── smoke.spec.ts       # Basic conversion smoke tests
│   ├── matrix.spec.ts      # Format/quality/scale matrix
│   ├── variations.spec.ts  # Edge cases and variations
│   └── regression.spec.ts  # Regression tests
├── unit/                   # Vitest unit tests (jsdom)
├── lib/                    # Shared test utilities
└── setup.ts                # Vitest setup
```

## Running Tests

### Unit Tests

```bash
cd test && pnpm test
```

### E2E Tests (Playwright)

Requires a running dev server or preview server:

```bash
# Start preview server (terminal 1)
cd /home/piesp/projects/wasm-motion-converter
NODE_OPTIONS='--no-deprecation' npx vite preview --host 127.0.0.1 --port 4173

# Run dogfood QA (terminal 2)
cd test && pnpm qa:dogfood
```

### Dogfood QA (Production Health Check)

21 Playwright tests against the production deployment:

```bash
cd test && pnpm qa:dogfood
```

Covers: page load, console errors, SEO meta tags, accessibility, theme toggle, performance, footer links.

## MCP Playwright Testing (AI Agent)

For AI-driven browser testing against production or preview:

### 1. Navigate

```
browser_navigate(url="https://wasm-motion-converter.pages.dev/")
```

### 2. Select a File

The file input uses `opacity-0` overlay (not `sr-only`), so `setInputFiles` works directly:

```javascript
// Via run_code_unsafe
const input = page.locator('#file-upload');
await input.setInputFiles('/path/to/video.mp4');
```

Or use the test helper (dev mode only):

```javascript
await import('./src/test-helpers').then(m => m.attachTestHelpers());
const file = new File(['dummy'], 'test.mp4', { type: 'video/mp4' });
__TEST_HELPERS__.injectFile(file, {
  width: 1920, height: 1080, duration: 5, codec: 'h264', frameRate: 30
});
```

### 3. Change Settings

Radio buttons are now clickable via their labels:

```javascript
// Click WebP option
await page.locator('label[for="format-webp"]').click();

// Click High quality
await page.locator('label[for="quality-high"]').click();

// Click 50% scale
await page.locator('label[for="scale-0.5"]').click();
```

### 4. Start Conversion

```javascript
await page.locator('[data-testid="convert-button"]').click();
```

### 5. Wait for Completion

Poll `data-state` attribute on the app container:

```javascript
// Wait for conversion to complete
await page.waitForSelector('[data-state="done"]', { timeout: 120000 });

// Or check current state
const state = await page.locator('[data-testid="app"]').getAttribute('data-state');
// States: 'idle' | 'loading-ffmpeg' | 'analyzing' | 'converting' | 'done' | 'error'
```

### 6. Verify Results

```javascript
// Check result section exists
const result = page.locator('[data-testid="result-section"]');
await expect(result).toBeVisible();

// Read stats
const stats = await page.locator('[data-testid="result-stats"]').textContent();

// Download
const downloadBtn = page.locator('[data-testid="download-result-button"]');
await expect(downloadBtn).toBeVisible();
```

## data-testid Reference

| testid | Element | Notes |
|--------|---------|-------|
| `app` | Main container | Has `data-state` attribute |
| `theme-toggle` | Dark/light toggle | Always visible |
| `dropzone` | File drop area | Always visible |
| `choose-file-button` | File picker button | Always visible |
| `file-input` | Hidden file input | `opacity-0`, accepts `setInputFiles` |
| `convert-button` | Convert button | Disabled until file loaded |
| `stop-conversion-button` | Stop button | Visible during conversion |
| `option-format-gif` / `option-format-webp` | Format radios | Click via `label[for]` |
| `option-quality-low/medium/high` | Quality radios | Click via `label[for]` |
| `option-scale-0.5/0.75/1` | Scale radios | Click via `label[for]` |
| `video-metadata` | File info panel | After file load |
| `result-section` | Result area | After conversion |
| `download-result-button` | Download link | After conversion |
| `result-image` | Output preview | After conversion |
| `error-display` | Error panel | On error |

## App State Values

The `data-state` attribute on `[data-testid="app"]` reflects the current conversion state:

| State | Description |
|-------|-------------|
| `idle` | No file selected or ready |
| `loading-ffmpeg` | Downloading/initializing FFmpeg WASM |
| `analyzing` | Extracting video metadata |
| `converting` | Actively converting frames |
| `done` | Conversion complete, results shown |
| `error` | Conversion failed |

## Test Video Files

Located in `public/`:

- `test-video-h264-baseline.mp4` — 1920x1080, H.264, ~10s, 823KB

## Troubleshooting

### "Element is outside of viewport" on radio buttons

Radio inputs use `opacity-0` overlay. Click the label instead:

```javascript
// ❌ Won't work
await page.locator('#format-webp').click();

// ✅ Works
await page.locator('label[for="format-webp"]').click();
```

### "setInputFiles requires modal state"

Use `run_code_unsafe` to call Playwright's `setInputFiles` directly:

```javascript
await page.locator('#file-upload').setInputFiles('/path/to/file.mp4');
```

### Conversion timeout

Default timeout is 300s. For large files, increase in `playwright.config.ts`:

```javascript
timeout: 600_000, // 10 minutes
```
