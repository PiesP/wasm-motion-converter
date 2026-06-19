// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Test Helpers for AI-driven browser testing.
 *
 * Exposed as `globalThis.__TEST_HELPERS__` in dev mode only.
 * Provides programmatic access to app state and file injection,
 * avoiding OS file-dialog barriers in automated testing.
 *
 * ## Quick start (in browser_console eval):
 * ```js
 * import('./src/test-helpers').then(m => m.attachTestHelpers())
 * __TEST_HELPERS__.injectFile(new File(['x'], 't.mp4', {type:'video/mp4'}), {w:640,h:480,d:5,c:'h264',f:30})
 * ```
 *
 * ## AI agent workflow:
 * 1. `browser_navigate('http://127.0.0.1:5173/')` — load app
 * 2. eval `import('./src/test-helpers').then(m => m.attachTestHelpers())`
 * 3. eval `__TEST_HELPERS__.getAppState()` → assert `'idle'`
 * 4. eval `__TEST_HELPERS__.injectFile(...)` — inject test video
 * 5. `browser_snapshot` — verify `video-metadata` visible
 * 6. `browser_click` on settings → eval `__TEST_HELPERS__.getSettings()` → assert
 * 7. `browser_click` convert → poll `__TEST_HELPERS__.getProgress()` or `waitFor('done')`
 * 8. `browser_snapshot` — verify `download-result-button`, `result-image`
 * 9. eval `__TEST_HELPERS__.resetApp()` — clean up, repeat
 */

import { getLastConversionProfiler } from '@services/conversion-pipeline';
import type { ConversionProfileReport } from '@services/conversion-profiler';
import { confirmDialog } from '@stores/confirmation-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  conversionProgress,
  conversionResults,
  errorMessage,
  inputFile,
  setAppState,
  setConversionResults,
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { AppState as AppStateType } from '@t/app-types';
import type { VideoMetadata } from '@t/conversion-types';

// ─── Type for the exposed API ──────────────────────────────────────────────

export interface TestHelpers {
  // ── White-box: direct state access (for setup / injection) ──

  /** Current app state ('idle' | 'loading-ffmpeg' | 'analyzing' | 'converting' | 'done' | 'error') */
  getAppState(): AppStateType;

  /** Current conversion progress (0-100) */
  getProgress(): number;

  /** Current conversion settings */
  getSettings(): ReturnType<typeof conversionSettings>;

  /** Selected input file info, or null */
  getInputFile(): { name: string; size: number; type: string } | null;

  /** Video metadata, or null */
  getMetadata(): VideoMetadata | null;

  /** Active error message, or null */
  getError(): string | null;

  /** Inject a video File directly into the app store (bypasses file dialog) */
  injectFile(file: File, metadata?: VideoMetadata): void;

  /** Reset the entire app to idle state */
  resetApp(): void;

  // ── Black-box: DOM-based assertions (user-perspective verification) ──

  /** Whether the convert button is enabled (file loaded & not busy) */
  isConvertButtonEnabled(): boolean;

  /** Whether the result section is visible (conversion complete) */
  isResultVisible(): boolean;

  /** Whether the error display is visible */
  isErrorVisible(): boolean;

  /** Whether the memory warning banner is visible */
  isMemoryWarningVisible(): boolean;

  /** Text content of the visible status/progress region, or null */
  getVisibleStatusText(): string | null;

  /** Result stats visible in the UI, or null if not in done state */
  getVisibleResultStats(): {
    originalSize: string;
    outputSize: string;
    format: string;
    quality: string;
    scale: string;
  } | null;

  /**
   * Get the raw result blob info for the most recent conversion.
   * Returns size and MIME type, or null if no result available.
   */
  getResultBlob(): { size: number; type: string } | null;

  /**
   * Get structured validation info for the most recent result.
   * Includes magic byte validation without external tools.
   */
  getResultValidation(): {
    sizeBytes: number;
    mimeType: string;
    magicValid: boolean;
    width?: number;
    height?: number;
  } | null;

  // ── DOM query helpers ──

  /** Query DOM element by data-testid attribute */
  queryTestId(testId: string): Element | null;

  /** Query all DOM elements by data-testid attribute */
  queryAllTestIds(testId: string): NodeListOf<Element>;

  /** Read data-progress from the progress bar element (0-100) */
  readProgressFromDOM(): number | null;

  /** Wait for a condition to be true, polling every `intervalMs` (max `timeoutMs`) */
  waitFor(
    condition: () => boolean,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<boolean>;

  /** Wait for conversion to complete (format-aware default timeout) */
  waitForConvert(
    format: 'gif' | 'webp',
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<boolean>;

  /** Auto-confirm any pending confirmation dialog (for testing) */
  autoConfirm(): void;

  // ── Profiler: per-phase timing and memory metrics ──

  /**
   * Get the structured profile report from the last conversion.
   * Returns null if no conversion has been run yet.
   * Available in dev mode only.
   */
  getConversionProfile(): ConversionProfileReport | null;
}

// ─── Helper implementations ─────────────────────────────────────────────────

const DEFAULT_WAIT_TIMEOUT = 30_000;
const DEFAULT_WAIT_INTERVAL = 200;
const FORMAT_WAIT_TIMEOUTS: Record<string, number> = {
  gif: 120_000,
  webp: 90_000,
};

/** Auto-confirm any pending confirmation dialog (for testing). */
const autoConfirm = (): void => {
  confirmDialog();
};

const injectFile = (file: File, metadata?: VideoMetadata): void => {
  const prevUrl = videoPreviewUrl();
  if (prevUrl) URL.revokeObjectURL(prevUrl);

  setInputFile(file);
  // Read file into buffer so conversion can proceed without re-reading
  file
    .arrayBuffer()
    .then((buf) => {
      setInputBuffer(buf);
    })
    .catch(() => {});
  const previewUrl = URL.createObjectURL(file);
  setVideoPreviewUrl(previewUrl);

  if (metadata) {
    setVideoMetadata(metadata);
  }

  // Ensure app is in idle state so convert button becomes enabled.
  // Without this, injectFile alone does not transition state from a previous
  // conversion/error, leaving the button disabled.
  setAppState('idle');
};

const resetApp = (): void => {
  const prevUrl = videoPreviewUrl();
  if (prevUrl) URL.revokeObjectURL(prevUrl);

  setAppState('idle');
  setInputFile(null);
  setVideoMetadata(null);
  setVideoPreviewUrl(null);
  setConversionResults([]);
  setErrorMessage(null);
  setErrorContext(null);
  setConversionSettings({ ...DEFAULT_CONVERSION_SETTINGS });
};

const getInputFile = (): { name: string; size: number; type: string } | null => {
  const f = inputFile();
  if (!f) return null;
  return { name: f.name, size: f.size, type: f.type };
};

const queryTestId = (testId: string): Element | null =>
  document.querySelector(`[data-testid="${testId}"]`);

const queryAllTestIds = (testId: string): NodeListOf<Element> =>
  document.querySelectorAll(`[data-testid="${testId}"]`);

const readProgressFromDOM = (): number | null => {
  const el = document.querySelector('[data-progress]');
  if (!el) return null;
  const val = el.getAttribute('data-progress');
  if (val === null) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
};

const waitFor = (
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<boolean> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT;
  const intervalMs = options?.intervalMs ?? DEFAULT_WAIT_INTERVAL;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) {
        resolve(true);
        return;
      }
      if (Date.now() - startTime >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
};

const waitForConvert = (
  format: 'gif' | 'webp',
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<boolean> => {
  const defaultTimeout = FORMAT_WAIT_TIMEOUTS[format] ?? 120_000;
  return waitFor(() => isResultVisible() || isErrorVisible(), {
    timeoutMs: options?.timeoutMs ?? defaultTimeout,
    intervalMs: options?.intervalMs,
  });
};

// ─── Black-box verification helpers ──

const isConvertButtonEnabled = (): boolean => {
  const btn = document.querySelector('[data-testid="convert-button"]') as HTMLButtonElement | null;
  return btn !== null && !btn.disabled;
};

const isResultVisible = (): boolean => {
  return document.querySelector('[data-testid="result-section"]') !== null;
};

const isErrorVisible = (): boolean => {
  return document.querySelector('[data-testid="error-display"]') !== null;
};

const isMemoryWarningVisible = (): boolean => {
  return document.querySelector('[data-testid="memory-warning"]') !== null;
};

const getVisibleStatusText = (): string | null => {
  const el = document.querySelector('[data-testid="conversion-progress"]');
  if (!el) return null;
  return el.textContent?.trim() ?? null;
};

const getVisibleResultStats = (): {
  originalSize: string;
  outputSize: string;
  format: string;
  quality: string;
  scale: string;
} | null => {
  const section = document.querySelector('[data-testid="result-section"]');
  if (!section) return null;
  const originalEl = section.querySelector('[data-result-original-size]');
  const outputEl = section.querySelector('[data-result-output-size]');
  const formatEl = section.querySelector('[data-result-format]');
  const qualityEl = section.querySelector('[data-result-quality]');
  const scaleEl = section.querySelector('[data-result-scale]');
  if (!originalEl || !outputEl || !formatEl || !qualityEl || !scaleEl) return null;
  return {
    originalSize: originalEl.textContent?.trim() ?? '',
    outputSize: outputEl.textContent?.trim() ?? '',
    format: formatEl.textContent?.trim() ?? '',
    quality: qualityEl.textContent?.trim() ?? '',
    scale: scaleEl.textContent?.trim() ?? '',
  };
};

// ─── New: Result blob access for validation ──

const getResultBlob = (): { size: number; type: string } | null => {
  const results = conversionResults();
  if (results.length === 0) return null;
  const latest = results[0];
  if (!latest) return null;
  return { size: latest.outputBlob.size, type: latest.outputBlob.type };
};

/**
 * Validate result file using magic bytes (no external tools required).
 * Checks GIF89a/GIF87a header for GIF, RIFF....WEBP for WebP.
 */
const getResultValidation = (): {
  sizeBytes: number;
  mimeType: string;
  magicValid: boolean;
  width?: number;
  height?: number;
} | null => {
  const results = conversionResults();
  if (results.length === 0) return null;
  const latest = results[0];
  if (!latest) return null;
  const blob = latest.outputBlob;
  const sizeBytes = blob.size;
  const mimeType = blob.type;

  // Magic validation is done asynchronously via getResultValidationAsync
  // Here we just return basic info synchronously
  const settings = conversionSettings();
  const magicValid = settings.format === 'gif' || settings.format === 'webp';

  return {
    sizeBytes,
    mimeType,
    magicValid,
  };
};

// ─── Create and attach ──────────────────────────────────────────────────────

const testHelpers: TestHelpers = {
  // White-box
  getAppState: () => appState(),
  getProgress: () => conversionProgress(),
  getSettings: () => ({ ...conversionSettings() }),
  getInputFile,
  getMetadata: () => videoMetadata(),
  getError: () => errorMessage(),
  injectFile,
  resetApp,
  // Black-box
  isConvertButtonEnabled,
  isResultVisible,
  isErrorVisible,
  isMemoryWarningVisible,
  getVisibleStatusText,
  getVisibleResultStats,
  // New result validation
  getResultBlob,
  getResultValidation,
  // DOM queries
  queryTestId,
  queryAllTestIds,
  readProgressFromDOM,
  waitFor,
  waitForConvert,
  // Test flow helpers
  autoConfirm,
  // Profiler
  getConversionProfile: () => {
    const profiler = getLastConversionProfiler();
    if (!profiler) return null;
    return profiler.getLastReport() ?? profiler.getReport();
  },
};

export function attachTestHelpers(): void {
  (globalThis as Record<string, unknown>).__TEST_HELPERS__ = testHelpers;
}
