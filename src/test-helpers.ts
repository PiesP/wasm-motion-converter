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

import { getLastConversionProfileReport } from '@services/conversion-profile-store';
import type { ConversionProfileReport } from '@services/conversion-profiler';
import type { OwnedVp8Stats } from '@services/owned-vp8-core';
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
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { AppState as AppStateType } from '@t/app-types';
import type { ConversionFormat, VideoMetadata } from '@t/conversion-types';

// ─── Type for the exposed API ──────────────────────────────────────────────

export interface TestHelpers {
  // ── White-box: direct state access (for setup / injection) ──

  /** Current app state ('idle' | 'analyzing' | 'converting' | 'cancelling' | 'done' | 'error') */
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
  injectFile(file: File, metadata?: VideoMetadata): Promise<void>;

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
   * Get result file info (size, mime type).
   * Note: Magic byte validation is done asynchronously in the conversion pipeline
   * (use-perform-conversion.ts). For sync helpers, use getResultValidationAsync.
   */
  getResultValidation(): {
    sizeBytes: number;
    mimeType: string;
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
    format: ConversionFormat,
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

  /** Compiled owned VP8 kernel checks that do not require VideoDecoder or the UI pipeline. */
  encodeOwnedVp8Fixture(request: OwnedVp8FixtureRequest): Promise<OwnedVp8FixtureResult>;
  cancelOwnedVp8AfterStep(request: OwnedVp8FixtureRequest): Promise<OwnedVp8CancellationResult>;
}

export interface OwnedVp8FixtureRequest {
  width: number;
  height: number;
  quality: 60 | 75 | 85;
  seed: number;
  repeats?: number;
}

export interface OwnedVp8FixtureResult {
  rawFrames: number[][];
  stats: OwnedVp8Stats[];
  releases: number;
}

export interface OwnedVp8CancellationResult {
  moduleSha256: string;
  abiVersion: number;
  realSteps: number;
  firstStepStatus: number;
  errorName: string;
  releases: number;
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

const injectFile = async (file: File, metadata?: VideoMetadata): Promise<void> => {
  const prevUrl = videoPreviewUrl();
  if (prevUrl) URL.revokeObjectURL(prevUrl);

  setInputFile(file);
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
  options?: { timeoutMs?: number | undefined; intervalMs?: number | undefined }
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
  format: ConversionFormat,
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
 * Get result file info (size, mime type).
 * Note: Magic byte validation requires async blob reading.
 * The conversion pipeline already validates output in use-perform-conversion.ts.
 */
const getResultValidation = (): {
  sizeBytes: number;
  mimeType: string;
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

  // Note: Magic byte validation requires async blob reading (blob.slice().arrayBuffer()).
  // Use getResultValidationAsync for actual validation, or check the download manually.
  // For synchronous helpers, we skip magic validation — the conversion pipeline already
  // validates output in use-perform-conversion.ts (line ~274).

  return {
    sizeBytes,
    mimeType,
  };
};

function ownedVp8Pixels(request: OwnedVp8FixtureRequest): Uint8Array {
  const { width, height, seed } = request;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 64 ||
    height > 64 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 255
  ) {
    throw new Error('Invalid owned VP8 test fixture');
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      pixels[at] = (x * 31 + y * 17 + seed) & 255;
      pixels[at + 1] = (x * 7 + y * 43 + seed * 3) & 255;
      pixels[at + 2] = (x * 53 + y * 11 + seed * 5) & 255;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

function ownedVp8Accounting(): {
  accounting: {
    reserve(linearCapacityBytes: number, hostOutputCopyBytes: number): void;
    observe(actualCapacityBytes: number): void;
    release(): void;
  };
  releases(): number;
} {
  let releaseCount = 0;
  return {
    accounting: {
      reserve: () => undefined,
      observe: () => undefined,
      release: () => {
        releaseCount++;
      },
    },
    releases: () => releaseCount,
  };
}

function ownedVp8Settings(request: OwnedVp8FixtureRequest, sourceBytes: number) {
  return {
    width: request.width,
    height: request.height,
    stride: request.width * 4,
    layout: 0,
    quality: request.quality,
    outputLimit: 96 * 1024 * 1024,
    externalLiveBytes: sourceBytes,
    retainedOutputBytes: 0,
  };
}

const encodeOwnedVp8Fixture = async (
  request: OwnedVp8FixtureRequest
): Promise<OwnedVp8FixtureResult> => {
  const pixels = ownedVp8Pixels(request);
  const repeats = request.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 2)
    throw new Error('Invalid owned VP8 test repeat count');
  const { createOwnedVp8Encoder } = await import('@services/owned-vp8-core');
  const ledger = ownedVp8Accounting();
  const encoder = await createOwnedVp8Encoder({ accounting: ledger.accounting });
  const rawFrames: number[][] = [];
  const stats: OwnedVp8Stats[] = [];
  try {
    for (let i = 0; i < repeats; i++) {
      stats.push(
        await encoder.encode(pixels, ownedVp8Settings(request, pixels.byteLength), (raw) => {
          // Copy while the SDK still owns the output lease.
          rawFrames.push(Array.from(raw));
        })
      );
    }
  } finally {
    encoder.retire();
  }
  return { rawFrames, stats, releases: ledger.releases() };
};

const cancelOwnedVp8AfterStep = async (
  request: OwnedVp8FixtureRequest
): Promise<OwnedVp8CancellationResult> => {
  const pixels = ownedVp8Pixels(request);
  const sdk = await import('@services/owned-vp8-core');
  const assetUrl = new URL('../crates/owned-vp8/owned-vp8.wasm', import.meta.url);
  const response = await fetch(assetUrl, { redirect: 'error', credentials: 'same-origin' });
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/wasm'
  )
    throw new Error('Owned VP8 test module response is invalid');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const moduleSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const module = await WebAssembly.compile(bytes as BufferSource);
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new Error('Owned VP8 test module unexpectedly imports a runtime');
  const instance = new WebAssembly.Instance(module, {});
  const api = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    vp8_v2_abi_version(): number;
    vp8_v2_step(generation: number, frame: number): number;
  };
  const abiVersion = api.vp8_v2_abi_version();
  const controller = new AbortController();
  let realSteps = 0;
  let firstStepStatus = -1;
  // WASM export properties are immutable; copy values before wrapping one real call.
  const wrappedExports = {
    ...instance.exports,
    vp8_v2_step(generation: number, frame: number): number {
      const status = api.vp8_v2_step(generation, frame);
      realSteps++;
      if (realSteps === 1) {
        firstStepStatus = status;
        controller.abort('after a compiled VP8 step');
      }
      return status;
    },
  };
  const wrappedInstance = new Proxy(instance, {
    get(target, property, receiver) {
      return property === 'exports' ? wrappedExports : Reflect.get(target, property, receiver);
    },
  });
  const ledger = ownedVp8Accounting();
  const initialCapacity = api.memory.buffer.byteLength;
  ledger.accounting.reserve(initialCapacity, 0);
  const encoder = new sdk.OwnedVp8Encoder(
    wrappedInstance,
    { signal: controller.signal, accounting: ledger.accounting },
    initialCapacity
  );
  let errorName = '';
  try {
    await encoder.encode(pixels, ownedVp8Settings(request, pixels.byteLength), () => {
      throw new Error('Cancelled VP8 output must not be consumed');
    });
  } catch (error) {
    if (!(error instanceof sdk.OwnedVp8CancelledError)) throw error;
    errorName = error.name;
  } finally {
    encoder.retire();
  }
  if (realSteps < 1 || firstStepStatus < 0 || !errorName)
    throw new Error('Owned VP8 cancellation did not follow a compiled step');
  return {
    moduleSha256,
    abiVersion,
    realSteps,
    firstStepStatus,
    errorName,
    releases: ledger.releases(),
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
  getConversionProfile: getLastConversionProfileReport,
  encodeOwnedVp8Fixture,
  cancelOwnedVp8AfterStep,
};

export function attachTestHelpers(): void {
  (globalThis as Record<string, unknown>).__TEST_HELPERS__ = testHelpers;
}
