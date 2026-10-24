// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

import { parseGifDelaysCs } from './gif-playback.ts';

type Case = {
  id: string;
  field: 'start' | 'end';
  value: string;
  blurBeforeSubmit: boolean;
  activation: 'pointer' | 'keyboard';
  viewport: { width: number; height: number };
};

const CASES: Case[] = [
  {
    id: 'start-after-end',
    field: 'start',
    value: '9.0',
    blurBeforeSubmit: true,
    activation: 'pointer',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'end-before-start',
    field: 'end',
    value: '1.0',
    blurBeforeSubmit: false,
    activation: 'pointer',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'end-past-duration',
    field: 'end',
    value: '11.0',
    blurBeforeSubmit: true,
    activation: 'keyboard',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'nonnumeric-narrow',
    field: 'start',
    value: 'not-a-time',
    blurBeforeSubmit: false,
    activation: 'keyboard',
    viewport: { width: 320, height: 844 },
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function snapshot(page: Page, field: Case['field']) {
  return page.evaluate((selectedField) => {
    const input = document.querySelector<HTMLInputElement>(`#trim-${selectedField}-input`);
    const error = document.querySelector<HTMLElement>(`#trim-${selectedField}-error`);
    const convert = document.querySelector<HTMLButtonElement>('[data-testid="convert-button"]');
    const rect = (element: HTMLElement | null) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        visible:
          bounds.width > 0 &&
          bounds.height > 0 &&
          getComputedStyle(element).visibility !== 'hidden',
      };
    };
    return {
      field: selectedField,
      value: input?.value ?? null,
      invalid: input?.getAttribute('aria-invalid') ?? null,
      error: error?.textContent?.trim() ?? null,
      summary: document.querySelector('[data-testid="trim-summary"]')?.textContent?.trim() ?? null,
      appState: document.querySelector('#app-state')?.textContent?.trim() ?? null,
      focus:
        document.activeElement?.id || document.activeElement?.getAttribute('data-testid') || null,
      convertDisabled: convert?.disabled ?? null,
      inputBounds: rect(input),
      errorBounds: rect(error),
      convertBounds: rect(convert),
      viewport: {
        innerWidth,
        innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
    };
  }, field);
}

async function selectLowGif(page: Page) {
  for (const [group, value] of [
    ['format', 'gif'],
    ['quality', 'low'],
    ['scale', '0.5'],
  ] as const) {
    const option = page.locator(`[data-testid="option-${group}-${value}"]`);
    await option.click();
    assert(await option.locator('input').isChecked(), `${group}=${value} did not become selected`);
  }
}

async function readGif(page: Page, file: string, output: string) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  assert(stream, 'Browser download did not expose a stream');
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')), 'Output is not GIF');
  const delaysCs = parseGifDelaysCs(bytes);
  assert(delaysCs.length > 0, 'GIF has no timed frames');
  await writeFile(join(output, file), bytes);
  return {
    file,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    frameCount: delaysCs.length,
    durationSeconds: delaysCs.reduce((total, value) => total + value, 0) / 100,
  };
}

async function exerciseCase(
  browser: Browser,
  url: string,
  fixture: string,
  output: string,
  entry: Case
) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: entry.viewport,
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert(response && response.ok(), 'Built application did not load');
    assert(
      await page.evaluate(() => crossOriginIsolated),
      'Built application lost cross-origin isolation'
    );
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await page
      .locator('[data-testid="trim-selector"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
    await selectLowGif(page);

    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill('2.0');
    await start.press('Enter');
    await end.fill('8.0');
    await end.press('Enter');
    assert.equal(await start.inputValue(), '0:02.0');
    assert.equal(await end.inputValue(), '0:08.0');
    const committed = await snapshot(page, entry.field);

    await page.evaluate(() => {
      const states: string[] = [];
      const capture = () => {
        const state = document.querySelector('#app-state')?.textContent?.trim() ?? '';
        if (state && states.at(-1) !== state) states.push(state);
      };
      capture();
      const observer = new MutationObserver(capture);
      const state = document.querySelector('#app-state');
      if (!state) throw new Error('Application state element is missing');
      observer.observe(state, { childList: true, characterData: true, subtree: true });
      Reflect.set(globalThis, '__trimSubmissionTrace', { states, observer });
    });
    const input = entry.field === 'start' ? start : end;
    await input.fill(entry.value);
    if (entry.blurBeforeSubmit) await input.press('Tab');
    const beforeActivation = await snapshot(page, entry.field);
    await page.screenshot({ path: join(output, `${entry.id}-before.png`), fullPage: true });

    const convert = page.locator('[data-testid="convert-button"]');
    if (entry.activation === 'pointer') await convert.click();
    else {
      await convert.focus();
      await page.keyboard.press('Enter');
    }
    if (await page.locator('[data-testid="modal-confirm-button"]').isVisible()) {
      await page.locator('[data-testid="modal-confirm-button"]').click();
    }
    const started = await page
      .waitForFunction(
        () => {
          const trace = Reflect.get(globalThis, '__trimSubmissionTrace') as { states: string[] };
          return (
            trace.states.some((state) =>
              /Converting|Converted animation|Conversion failed/.test(state)
            ) ||
            document.querySelector('[data-testid="result-section"]') !== null ||
            document.querySelector('[data-testid="error-display"]') !== null
          );
        },
        undefined,
        { timeout: 5_000 }
      )
      .then(() => true)
      .catch(() => false);
    if (started) {
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="result-section"]') !== null ||
          document.querySelector('[data-testid="error-display"]') !== null,
        undefined,
        { timeout: 120_000 }
      );
    }
    const afterActivation = await snapshot(page, entry.field);
    const trace = await page.evaluate(() => {
      const result = Reflect.get(globalThis, '__trimSubmissionTrace') as {
        states: string[];
        observer: MutationObserver;
      };
      result.observer.disconnect();
      return result.states;
    });
    await page.screenshot({ path: join(output, `${entry.id}-after.png`), fullPage: true });
    const resultVisible = await page.locator('[data-testid="result-section"]').isVisible();
    const errorVisible = await page.locator('[data-testid="error-display"]').isVisible();
    const gif = resultVisible ? await readGif(page, `${entry.id}.gif`, output) : null;
    return {
      id: entry.id,
      input: { field: entry.field, value: entry.value },
      activation: entry.activation,
      blurBeforeSubmit: entry.blurBeforeSubmit,
      committed,
      beforeActivation,
      afterActivation,
      trace,
      result: resultVisible
        ? 'converted'
        : errorVisible
          ? 'error'
          : started
            ? 'pending'
            : 'no-start-observed',
      error: errorVisible
        ? await page.locator('[data-testid="error-display"]').textContent()
        : null,
      gif,
      pageErrors,
      consoleErrors,
    };
  } finally {
    await context.close();
  }
}

/** Observe baseline and candidate through the same built-app action path. */
export async function exerciseTrimSubmission(
  browser: Browser,
  url: string,
  fixture: string,
  output: string
) {
  await mkdir(output, { recursive: true });
  const cases: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const entry of CASES) {
      try {
        cases.push(await exerciseCase(browser, url, fixture, output, entry));
      } catch (error) {
        failures.push(`${entry.id}: ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  } finally {
    await writeFile(
      join(output, 'trim-submission.json'),
      JSON.stringify({ cases, failures }, null, 2)
    );
  }
  assert.equal(failures.length, 0, `Trim submission probe failed: ${failures.join('; ')}`);
  return { profile: 'trim-submission', status: 'observed', cases };
}
