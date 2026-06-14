import { Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * E2E test helpers for wasm-motion-converter.
 *
 * All browser-side state access goes through page.evaluate() because
 * __TEST_HELPERS__ lives in the browser and cannot be serialized.
 *
 * Pattern: each helper is a thin wrapper that calls page.evaluate()
 * with an inline function that accesses (globalThis as any).__TEST_HELPERS__.
 */

export async function attachTestHelpers(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import('/src/test-helpers' as string);
    await (mod as any).attachTestHelpers();
  });
}

export async function getAppState(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.getAppState());
}

export async function getProgress(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.getProgress());
}

export async function isConvertButtonEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.isConvertButtonEnabled());
}

export async function isResultVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.isResultVisible());
}

export async function isErrorVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.isErrorVisible());
}

export async function getVisibleResultStats(page: Page): Promise<Record<string, string> | null> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.getVisibleResultStats());
}

export async function getError(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.getError());
}

export async function getMetadata(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.getMetadata());
}

export async function injectFile(page: Page, filePath: string, metadata: {
  width: number;
  height: number;
  duration: number;
  codec: string;
  frameRate: number;
}): Promise<void> {
  const webPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
  await page.evaluate(async (opts: { filePath: string; metadata: any }) => {
    const response = await fetch(opts.filePath);
    const blob = await response.blob();
    const file = new File([blob], opts.filePath.split('/').pop() || 'test', { type: blob.type });
    await (globalThis as any).__TEST_HELPERS__.injectFile(file, opts.metadata);
  }, { filePath: webPath, metadata });
}

export async function resetApp(page: Page): Promise<void> {
  return page.evaluate(() => (globalThis as any).__TEST_HELPERS__.resetApp());
}

export async function waitForConversionComplete(page: Page, timeoutMs = 60_000): Promise<string> {
  return page.evaluate(async (timeoutMs: number) => {
    const h = (globalThis as any).__TEST_HELPERS__;
    await h.waitFor(() => {
      const s = h.getAppState();
      return s === 'done' || s === 'error';
    }, { timeoutMs });
    return h.getAppState();
  }, timeoutMs);
}

export async function waitForState(page: Page, targetState: string, timeoutMs = 30_000): Promise<void> {
  return page.evaluate(async (opts: { targetState: string; timeoutMs: number }) => {
    const h = (globalThis as any).__TEST_HELPERS__;
    await h.waitFor(() => h.getAppState() === opts.targetState, { timeoutMs: opts.timeoutMs });
  }, { targetState, timeoutMs });
}

export async function setFormat(page: Page, format: 'gif' | 'webp'): Promise<void> {
  await page.click(`label:has(input[value="${format}"])`);
}

export async function clickConvert(page: Page): Promise<void> {
  await page.click('[data-testid="convert-button"]');
}

export async function dismissWarningDialog(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.click('button:has-text("Proceed")');
  }
}

export async function downloadResult(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-testid="download-result-button"]');
  const download = await downloadPromise;
  const filePath = await download.path();
  if (!filePath) throw new Error('Download failed — no path');
  const fs = await import('node:fs');
  return fs.readFileSync(filePath);
}
