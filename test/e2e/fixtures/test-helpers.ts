import { Page, expect } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * E2E test helpers — uses __TEST_HELPERS__ exposed by the app in dev mode.
 *
 * All state inspection goes through the test helper API, not raw DOM queries.
 * This makes tests resilient to UI refactors as long as data-testid attributes
 * are preserved.
 */

// ── Types ──────────────────────────────────────────────────────

export interface TestHelpers {
  getAppState(): string;
  getProgress(): number;
  getSettings(): {
    format: string;
    quality: string;
    scale: string;
    trimStart: number;
    trimEnd: number;
    smartFrameSkip: string;
  };
  getInputFile(): { name: string; size: number; type: string } | null;
  getMetadata(): { width: number; height: number; duration: number; codec: string; frameRate: number } | null;
  getError(): string | null;
  injectFile(file: File | { name: string; size: number; type: string }, metadata?: { width: number; height: number; duration: number; codec: string; frameRate: number }): Promise<void>;
  resetApp(): Promise<void>;
  isConvertButtonEnabled(): boolean;
  isResultVisible(): boolean;
  isErrorVisible(): boolean;
  isMemoryWarningVisible(): boolean;
  getVisibleStatusText(): string | null;
  getVisibleResultStats(): { originalSize: string; outputSize: string; format: string; quality: string; scale: string } | null;
  waitFor(condition: () => boolean, options?: { timeoutMs?: number }): Promise<void>;
}

declare global {
  interface Window {
    __TEST_HELPERS__?: TestHelpers;
  }
}

// ── Low-level helpers ──────────────────────────────────────────

import { existsSync } from 'node:fs';

/** Parse human-readable size string to bytes. */
export function parseSizeString(sizeStr: string): number | undefined {
  const match = sizeStr.match(/^([\d.]+)\s*(KB|MB|GB)/i);
  if (!match) return undefined;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  switch (unit) {
    case 'KB': return value * 1024;
    case 'MB': return value * 1024 * 1024;
    case 'GB': return value * 1024 * 1024 * 1024;
    default: return undefined;
  }
}

/** Wait for the app to be idle (FFmpeg loaded, no file selected). */
export async function waitForIdle(page: Page, timeoutMs = 30_000): Promise<void> {
  // Ensure __TEST_HELPERS__ is attached (dev mode only)
  await page.evaluate(async () => {
    if (!window.__TEST_HELPERS__) {
      await import('./src/test-helpers').then((m) => m.attachTestHelpers());
    }
  });
  await page.waitForFunction(
    () => window.__TEST_HELPERS__?.getAppState() === 'idle',
    { timeout: timeoutMs },
  );
}

/** Wait for the app to be ready (file loaded, convert button enabled). */
export async function waitForReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => window.__TEST_HELPERS__?.getAppState() === 'ready',
    { timeout: timeoutMs },
  );
}

/** Wait for the app to reach a specific state. */
export async function waitForState(page: Page, state: string, timeoutMs = 120_000): Promise<void> {
  await page.waitForFunction(
    (s) => window.__TEST_HELPERS__?.getAppState() === s,
    state,
    { timeout: timeoutMs },
  );
}

/** Get the test helpers object from the page. */
export async function getHelpers(page: Page): Promise<TestHelpers> {
  const helpers = await page.evaluate(() => window.__TEST_HELPERS__);
  if (!helpers) throw new Error('__TEST_HELPERS__ not available — ensure dev server is running');
  return helpers;
}

// ── File injection ─────────────────────────────────────────────

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  codec: string;
  frameRate: number;
}

/** Inject a real test video file via file input (uses test video files from public/). */
export async function injectTestFile(page: Page, filename: string): Promise<void> {
  // Ensure __TEST_HELPERS__ is attached (dev mode only)
  await page.evaluate(async () => {
    if (!window.__TEST_HELPERS__) {
      await import('./src/test-helpers').then((m) => m.attachTestHelpers());
    }
  });
  const input = page.locator('input[type="file"]').first();
  const resolvedPath = filename.startsWith('/')
    ? `/home/piesp/projects/wasm-motion-converter/public${filename}`
    : `/home/piesp/projects/wasm-motion-converter/public/${filename}`;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Test video not found: ${resolvedPath}`);
  }
  await input.setInputFiles(resolvedPath);
  // Wait for the app to process the file and enable the convert button
  await page.waitForFunction(
    () => window.__TEST_HELPERS__?.isConvertButtonEnabled() === true,
    { timeout: 15_000 },
  );
}

/** Create and inject a synthetic test file (no real video needed). */
export async function injectSyntheticFile(
  page: Page,
  name: string,
  metadata: VideoMetadata,
): Promise<void> {
  await page.evaluate(
    ({ name, meta }) => {
      const helpers = window.__TEST_HELPERS__;
      if (!helpers) return;
      // Create a minimal valid video file (will fail decode, but tests UI path)
      const dummy = new File(['dummy'], name, { type: 'video/mp4' });
      helpers.injectFile(dummy, meta);
    },
    { name, meta: metadata },
  );
  await page.waitForTimeout(500);
}

// ── Settings ───────────────────────────────────────────────────

export async function setFormat(page: Page, format: 'gif' | 'webp'): Promise<void> {
  await page.click(`label:has(input[value="${format}"])`);
}

export async function setQuality(page: Page, quality: 'low' | 'medium' | 'high'): Promise<void> {
  await page.click(`label:has(input[value="${quality}"])`);
}

export async function setScale(page: Page, scale: '50%' | '75%' | '100%'): Promise<void> {
  const scaleValue = scale === '50%' ? '0.5' : scale === '75%' ? '0.75' : '1';
  await page.click(`label:has(input[value="${scaleValue}"])`);
}

// ── Actions ────────────────────────────────────────────────────

export async function clickConvert(page: Page): Promise<void> {
  await page.click('button[data-testid="convert-button"]');
}

export async function clickStop(page: Page): Promise<void> {
  await page.click('button[data-testid="stop-conversion-button"]');
}

export async function dismissWarningDialog(page: Page): Promise<void> {
  const btn = page.locator([
    'button:has-text("Proceed")',
    'button:has-text("Continue Anyway")',
    'button:has-text("OK")',
    '[data-testid="modal-confirm-button"]',
  ].join(', ')).first();
  const visible = await btn.isVisible({ timeout: 5000 }).catch(() => false);
  if (visible) {
    await btn.click();
  }
}

// ── Assertions ─────────────────────────────────────────────────

export async function isConvertButtonEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__TEST_HELPERS__?.isConvertButtonEnabled() ?? false);
}

export async function isResultVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__TEST_HELPERS__?.isResultVisible() ?? false);
}

export async function isErrorVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__TEST_HELPERS__?.isErrorVisible() ?? false);
}

export async function getVisibleResultStats(page: Page): Promise<Record<string, string> | null> {
  return page.evaluate(() => window.__TEST_HELPERS__?.getVisibleResultStats() ?? null);
}

export async function getErrorMessage(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__TEST_HELPERS__?.getError() ?? null);
}

export async function getAppState(page: Page): Promise<string> {
  return page.evaluate(() => window.__TEST_HELPERS__?.getAppState() ?? 'unknown');
}

export async function getProgress(page: Page): Promise<number> {
  return page.evaluate(() => window.__TEST_HELPERS__?.getProgress() ?? 0);
}

// ── Conversion flow ────────────────────────────────────────────

/**
 * Run a complete conversion: inject file → configure → convert → wait for result.
 * Returns the final state ('done' | 'error' | 'timeout').
 */
export async function runConversion(
  page: Page,
  options: {
    file: string;
    format: 'gif' | 'webp';
    quality: 'low' | 'medium' | 'high';
    scale: '50%' | '75%' | '100%';
    timeoutMs?: number;
  },
): Promise<{ state: string; stats: Record<string, string> | null; error: string | null }> {
  const { file, format, quality, scale, timeoutMs = 120_000 } = options;

  await injectTestFile(page, file);
  await setFormat(page, format);
  await setQuality(page, quality);
  await setScale(page, scale);

  const enabled = await isConvertButtonEnabled(page);
  if (!enabled) {
    return { state: 'error', stats: null, error: 'Convert button not enabled after file injection' };
  }

  await clickConvert(page);
  await dismissWarningDialog(page);

  const finalState = await waitForConversionComplete(page, timeoutMs);
  const stats = finalState === 'done' ? await getVisibleResultStats(page) : null;
  const error = finalState === 'error' ? await getErrorMessage(page) : null;

  return { state: finalState, stats, error };
}

/** Wait for conversion to complete (done/error/timeout). */
export async function waitForConversionComplete(
  page: Page,
  timeoutMs = 120_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getAppState(page);
    if (state === 'done') return 'done';
    if (state === 'error') return 'error';
    await page.waitForTimeout(2000);
  }
  return 'timeout';
}

// ── Download ───────────────────────────────────────────────────

export async function downloadResult(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-testid="download-result-button"]');
  const download = await downloadPromise;
  const filePath = await download.path();
  if (!filePath) throw new Error('Download failed — no path');
  const fs = await import('node:fs');
  return fs.readFileSync(filePath);
}
