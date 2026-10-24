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
  const href = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
  if (!href?.startsWith('blob:')) throw new Error('Result download did not retain its Blob URL');
  const decoded = await page.evaluate(async (resultUrl) => {
    const response = await fetch(resultUrl);
    if (!response.ok) throw new Error('Result Blob URL is unavailable');
    const encoded = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    const digestHex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const decoder = new ImageDecoder({ data: encoded, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount < 1) throw new Error('Decoded GIF has no frames');
      const samples = [];
      for (const frameIndex of [0, track.frameCount - 1]) {
        const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
        try {
          const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Cannot capture GIF timecode frame');
          context.drawImage(image, 0, 0);
          const png = await canvas.convertToBlob({ type: 'image/png' });
          samples.push({ frameIndex, png: Array.from(new Uint8Array(await png.arrayBuffer())) });
        } finally {
          image.close();
        }
      }
      return { digestHex, frameCount: track.frameCount, samples };
    } finally {
      decoder.close();
    }
  }, href);
  assert.equal(decoded.digestHex, sha256(bytes), 'Decoded Blob URL differs from downloaded GIF');
  assert.equal(decoded.frameCount, delaysCs.length, 'GIF image and delay counts disagree');
  const timecodeFrames = [];
  for (const [index, sample] of decoded.samples.entries()) {
    const image = Buffer.from(sample.png);
    const imageFile = `${file}-${index === 0 ? 'first' : 'last'}.png`;
    await writeFile(join(output, imageFile), image);
    timecodeFrames.push({ file: imageFile, frameIndex: sample.frameIndex, sha256: sha256(image) });
  }
  return {
    file,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    frameCount: delaysCs.length,
    durationSeconds: delaysCs.reduce((total, value) => total + value, 0) / 100,
    timecodeFrames,
  };
}

async function activateConvert(page: Page, activation: Case['activation']) {
  const convert = page.locator('[data-testid="convert-button"]');
  if (activation === 'pointer') await convert.click();
  else {
    await convert.focus();
    await page.keyboard.press('Enter');
  }
}

async function waitForResult(page: Page) {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="result-section"]') !== null ||
      document.querySelector('[data-testid="error-display"]') !== null,
    undefined,
    { timeout: 120_000 }
  );
  const error = page.locator('[data-testid="error-display"]');
  assert.equal(await error.isVisible(), false, `Conversion failed: ${await error.textContent()}`);
  await page.locator('[data-testid="result-section"]').waitFor({ state: 'visible' });
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

    await activateConvert(page, entry.activation);
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
    assert.equal(started, false, `${entry.id}: invalid trim started conversion`);
    await activateConvert(page, entry.activation);
    const repeatActivation = await snapshot(page, entry.field);
    assert.equal(repeatActivation.value, entry.value, `${entry.id}: invalid draft was discarded`);
    assert.equal(repeatActivation.invalid, 'true', `${entry.id}: invalid feedback disappeared`);
    assert.equal(
      repeatActivation.focus,
      `trim-${entry.field}-input`,
      `${entry.id}: first invalid field did not regain focus`
    );
    assert(repeatActivation.error, `${entry.id}: no visible field error`);
    assert.equal(
      await page.locator('[data-testid="result-section"]').count(),
      0,
      `${entry.id}: invalid submission produced a result`
    );
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
    assert(
      trace.every((state) => !/Converting|Converted animation|Conversion failed/.test(state)),
      `${entry.id}: invalid submission changed application state: ${trace.join(', ')}`
    );
    if (entry.viewport.width === 320) {
      assert(
        afterActivation.viewport.scrollWidth <= afterActivation.viewport.innerWidth,
        'Narrow invalid feedback introduced page-level horizontal overflow'
      );
      assert(
        afterActivation.inputBounds &&
          afterActivation.inputBounds.y >= 0 &&
          afterActivation.inputBounds.y + afterActivation.inputBounds.height <=
            afterActivation.viewport.innerHeight,
        'Narrow invalid input was not scrolled into view'
      );
    }

    let expectedDuration: number;
    let expectedRange: { start: number; end: number };
    if (entry.id === 'start-after-end') {
      await start.fill('3.0');
      await start.press('Tab');
      expectedRange = { start: 3, end: 8 };
      expectedDuration = 5;
    } else if (entry.id === 'end-before-start') {
      await end.press('Escape');
      expectedRange = { start: 2, end: 8 };
      expectedDuration = 6;
    } else if (entry.id === 'end-past-duration') {
      await page.locator('[data-testid="trim-preset-first-5"]').click();
      expectedRange = { start: 0, end: 5 };
      expectedDuration = 5;
    } else {
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
      await page.locator('[data-testid="trim-selector"]').waitFor({ state: 'visible' });
      await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
      expectedRange = { start: 0, end: 10 };
      expectedDuration = 10;
    }
    const beforeRecovery = await snapshot(page, entry.field);
    assert.equal(await start.inputValue(), `0:${String(expectedRange.start).padStart(2, '0')}.0`);
    assert.equal(await end.inputValue(), `0:${String(expectedRange.end).padStart(2, '0')}.0`);
    assert.equal(beforeRecovery.invalid, null, `${entry.id}: recovery left the field invalid`);
    await activateConvert(page, entry.activation);
    await waitForResult(page);
    const afterRecovery = await snapshot(page, entry.field);
    await page.screenshot({ path: join(output, `${entry.id}-recovered.png`), fullPage: true });
    const gif = await readGif(page, `${entry.id}-recovered.gif`, output);
    assert(
      Math.abs(gif.durationSeconds - expectedDuration) <= 0.3,
      `${entry.id}: output duration ${gif.durationSeconds} disagrees with ${expectedDuration}s selection`
    );
    assert.deepEqual(pageErrors, [], `${entry.id}: browser page errors`);
    assert.deepEqual(consoleErrors, [], `${entry.id}: browser console errors`);
    return {
      id: entry.id,
      input: { field: entry.field, value: entry.value },
      activation: entry.activation,
      blurBeforeSubmit: entry.blurBeforeSubmit,
      committed,
      beforeActivation,
      afterActivation,
      repeatActivation,
      trace,
      invalidResult: 'blocked',
      recovery: { expectedRange, beforeRecovery, afterRecovery, gif },
      pageErrors,
      consoleErrors,
    };
  } finally {
    await context.close();
  }
}

async function exercisePairedValidDrafts(
  browser: Browser,
  url: string,
  fixture: string,
  output: string
) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert(response && response.ok(), 'Built application did not load');
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await page
      .locator('[data-testid="trim-selector"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await selectLowGif(page);
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill('2.0');
    await start.press('Enter');
    await end.fill('8.0');
    await end.press('Enter');
    await start.fill('9.0');
    await start.press('Tab');
    assert.equal(await start.getAttribute('aria-invalid'), 'true');
    await end.fill('10.0');
    const beforeSubmission = {
      start: await snapshot(page, 'start'),
      end: await snapshot(page, 'end'),
    };
    await page.screenshot({ path: join(output, 'paired-valid-before.png'), fullPage: true });
    await activateConvert(page, 'pointer');
    await waitForResult(page);
    const afterSubmission = {
      start: await snapshot(page, 'start'),
      end: await snapshot(page, 'end'),
    };
    assert.equal(afterSubmission.start.value, '0:09.0');
    assert.equal(afterSubmission.end.value, '0:10.0');
    assert.equal(afterSubmission.start.invalid, null);
    assert.equal(afterSubmission.end.invalid, null);
    await page.screenshot({ path: join(output, 'paired-valid-result.png'), fullPage: true });
    const gif = await readGif(page, 'paired-valid.gif', output);
    assert(
      Math.abs(gif.durationSeconds - 1) <= 0.3,
      `Paired valid drafts produced ${gif.durationSeconds}s instead of 9–10s`
    );
    return {
      id: 'paired-valid-drafts',
      expectedRange: { start: 9, end: 10 },
      beforeSubmission,
      afterSubmission,
      gif,
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
    try {
      cases.push(await exercisePairedValidDrafts(browser, url, fixture, output));
    } catch (error) {
      failures.push(`paired-valid-drafts: ${error instanceof Error ? error.stack : String(error)}`);
    }
  } finally {
    await writeFile(
      join(output, 'trim-submission.json'),
      JSON.stringify({ cases, failures }, null, 2)
    );
  }
  assert.equal(failures.length, 0, `Trim submission probe failed: ${failures.join('; ')}`);
  return { profile: 'trim-submission', status: 'passed', cases };
}
