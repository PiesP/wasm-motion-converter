// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Test Helpers for AI-driven browser testing.
 *
 * Exposed as `globalThis.__TEST_HELPERS__` in dev mode only.
 * Provides programmatic access to app state and file injection,
 * avoiding OS file-dialog barriers in automated testing.
 *
 * Usage (in browser console or browser_console tool):
 * ```js
 * // Read current app state
 * __TEST_HELPERS__.getAppState() // → 'idle'
 *
 * // Inject a video file (bypasses file dialog)
 * await __TEST_HELPERS__.injectFile(new File([buf], 'test.mp4', { type: 'video/mp4' }))
 *
 * // Read conversion progress
 * __TEST_HELPERS__.getProgress() // → 45
 *
 * // Reset app
 * __TEST_HELPERS__.resetApp()
 * ```
 */

import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  conversionProgress,
  errorMessage,
  inputFile,
  setAppState,
  setConversionResults,
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { AppState } from '@t/app-types';
import type { VideoMetadata } from '@t/conversion-types';

// ─── Type for the exposed API ──────────────────────────────────────────────

export interface TestHelpers {
  /** Current app state ('idle' | 'loading-ffmpeg' | 'analyzing' | 'converting' | 'done' | 'error') */
  getAppState(): AppState;

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
}

// ─── Helper implementations ─────────────────────────────────────────────────

const DEFAULT_WAIT_TIMEOUT = 30_000;
const DEFAULT_WAIT_INTERVAL = 200;

const injectFile = (file: File, metadata?: VideoMetadata): void => {
  // Clean up previous state
  const prevUrl = videoPreviewUrl();
  if (prevUrl) URL.revokeObjectURL(prevUrl);

  setInputFile(file);
  const previewUrl = URL.createObjectURL(file);
  setVideoPreviewUrl(previewUrl);

  if (metadata) {
    setVideoMetadata(metadata);
  }
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

// ─── Create and attach ──────────────────────────────────────────────────────

const testHelpers: TestHelpers = {
  getAppState: () => appState(),
  getProgress: () => conversionProgress(),
  getSettings: () => ({ ...conversionSettings() }),
  getInputFile,
  getMetadata: () => videoMetadata(),
  getError: () => errorMessage(),
  injectFile,
  resetApp,
  queryTestId,
  queryAllTestIds,
  readProgressFromDOM,
  waitFor,
};

export function attachTestHelpers(): void {
  (globalThis as Record<string, unknown>).__TEST_HELPERS__ = testHelpers;
}
