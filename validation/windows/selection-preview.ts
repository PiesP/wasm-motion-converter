// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Browser, Download, FileChooser, Page } from '@playwright/test';

import { parseGifDelaysCs } from './gif-playback.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  assert(stream, 'Browser download stream is unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const control = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return {
        text: element.textContent?.trim() ?? '',
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        disabled: element instanceof HTMLButtonElement ? element.disabled : null,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      };
    };
    const player = document.querySelector('[data-testid="selection-preview-player"]');
    const video = document.querySelector<HTMLVideoElement>('#selection-preview-video');
    const change = player?.parentElement?.querySelector('button') ?? null;
    const dropzone = document.querySelector('[data-testid="dropzone"]');
    const fileName = player?.parentElement?.querySelector('div.grid span')?.textContent?.trim();
    return {
      language: document.documentElement.lang,
      navigatorLanguage: navigator.language,
      state: document.querySelector('#app-state')?.textContent?.trim() ?? null,
      focus:
        document.activeElement?.getAttribute('data-testid') || document.activeElement?.id || null,
      fileName: fileName ?? null,
      fileInputPresent: document.querySelector('[data-testid="file-input"]') !== null,
      dropzoneText: dropzone?.textContent?.trim() ?? null,
      choose: control(document.querySelector('[data-testid="choose-file-button"]')),
      change: control(change),
      previewButton: control(document.querySelector('[data-testid="trim-preview-button"]')),
      previewUnavailable:
        document
          .querySelector('[data-testid="selection-preview-unavailable"]')
          ?.textContent?.trim() ?? null,
      logs: control(document.querySelector('[data-testid="export-logs-button"]')),
      resultDownload: control(document.querySelector('[data-testid="download-result-button"]')),
      resultHref:
        document.querySelector('[data-testid="download-result-button"]')?.getAttribute('href') ??
        null,
      error: document.querySelector('[data-testid="error-display"]')?.textContent?.trim() ?? null,
      retry: control(document.querySelector('[data-testid="error-retry-button"]')),
      selectDifferent: control(
        document.querySelector(
          '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
        )
      ),
      trimStart: document.querySelector<HTMLInputElement>('#trim-start-input')?.value ?? null,
      trimEnd: document.querySelector<HTMLInputElement>('#trim-end-input')?.value ?? null,
      video: video
        ? {
            readyState: video.readyState,
            networkState: video.networkState,
            errorCode: video.error?.code ?? null,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            width: video.videoWidth,
            height: video.videoHeight,
            canPlayH264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
            canPlayMatroskaVp9: video.canPlayType('video/x-matroska; codecs="vp9"'),
          }
        : null,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  });
}

function captureBrowserErrors(page: Page) {
  const errors = { page: [] as string[], console: [] as string[] };
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  return errors;
}

function selectedChange(page: Page) {
  return page
    .locator('[data-testid="selection-preview-player"]')
    .locator('..')
    .locator('button')
    .first();
}

async function fileChooserFromAction(
  page: Page,
  action: () => Promise<void>
): Promise<FileChooser | null> {
  const chooser = page.waitForEvent('filechooser', { timeout: 1_500 }).catch(() => null);
  await action();
  return chooser;
}

async function chooseFile(page: Page, file: string, keyboard = false): Promise<void> {
  const button = page.locator('[data-testid="choose-file-button"]');
  await button.waitFor({ state: 'visible' });
  const chooser = await fileChooserFromAction(page, async () => {
    if (keyboard) {
      await button.focus();
      await page.keyboard.press('Enter');
    } else await button.click();
  });
  assert(chooser, 'Choose video did not open a file picker');
  await chooser.setFiles(file);
  await waitForConversionReady(page);
}

async function waitForConversionReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="convert-button"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30_000 }
  );
  await page.locator('[data-testid="selection-preview-player"]').waitFor({ state: 'visible' });
}

async function activateChange(page: Page, keyboard = false) {
  const button = selectedChange(page);
  await button.waitFor({ state: 'visible' });
  const before = await snapshot(page);
  const chooser = await fileChooserFromAction(page, async () => {
    if (keyboard) {
      await button.focus();
      await page.keyboard.press('Enter');
    } else await button.click();
  });
  // An empty FileList stands in for cancellation at the DOM boundary. This is
  // not evidence that the Windows native dialog itself was cancelled.
  if (chooser) await chooser.setFiles([]);
  return { before, openedPicker: !!chooser, afterEmptySelection: await snapshot(page) };
}

async function downloadResult(page: Page, output: string, id: string) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const download = await pending;
  const bytes = await readDownload(download);
  assert(/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')), 'Output is not GIF');
  const delays = parseGifDelaysCs(bytes);
  await writeFile(join(output, `${id}.gif`), bytes);
  return {
    file: `${id}.gif`,
    suggestedFilename: download.suggestedFilename(),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    durationSeconds: delays.reduce((sum, delay) => sum + delay, 0) / 100,
  };
}

async function exportLogs(page: Page) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="export-logs-button"]').click();
  const download = await pending;
  const bytes = await readDownload(download);
  return {
    suggestedFilename: download.suggestedFilename(),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
}

async function convertLowGif(page: Page, output: string, id: string, start: number, end: number) {
  for (const [group, value] of [
    ['format', 'gif'],
    ['quality', 'low'],
    ['scale', '0.5'],
  ] as const) {
    await page.locator(`[data-testid="option-${group}-${value}"]`).click();
  }
  if (start !== 0) {
    const input = page.locator('#trim-start-input');
    await input.fill(String(start));
    await input.press('Enter');
  }
  if (end !== 0) {
    const input = page.locator('#trim-end-input');
    await input.fill(String(end));
    await input.press('Enter');
  }
  await page.locator('[data-testid="convert-button"]').click();
  if (await page.locator('[data-testid="modal-confirm-button"]').isVisible()) {
    await page.locator('[data-testid="modal-confirm-button"]').click();
  }
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="result-section"]') !== null ||
      document.querySelector('[data-testid="error-display"]') !== null,
    undefined,
    { timeout: 120_000 }
  );
  const error = page.locator('[data-testid="error-display"]');
  if (await error.isVisible()) throw new Error(`Conversion failed: ${await error.textContent()}`);
  await page.locator('[data-testid="download-result-button"]').waitFor({ state: 'visible' });
  const state = await snapshot(page);
  await page.screenshot({ path: join(output, `${id}-result.png`), fullPage: true });
  return { state, output: await downloadResult(page, output, id) };
}

async function exerciseSelection(browser: Browser, url: string, fixture: string, output: string) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });
  const observations: Record<string, unknown> = { id: 'selection-replacement-and-recovery' };
  try {
    const page = await context.newPage();
    observations.browserErrors = captureBrowserErrors(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok(), 'Built application did not load');
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    observations.initial = await snapshot(page);
    assert.equal(
      (observations.initial as Awaited<ReturnType<typeof snapshot>>).choose?.text,
      'Choose video'
    );
    await page.screenshot({ path: join(output, 'selection-empty.png'), fullPage: true });
    await chooseFile(page, fixture);
    observations.selected = await snapshot(page);
    await page.screenshot({ path: join(output, 'selection-selected.png'), fullPage: true });
    const converted = await convertLowGif(page, output, 'selection-first', 2, 8);
    observations.converted = converted;
    assert(Math.abs(converted.output.durationSeconds - 6) <= 0.3);
    const exportedLogs = await exportLogs(page);
    observations.exportedLogs = exportedLogs;
    assert(exportedLogs.suggestedFilename.includes('logs'));
    assert(converted.output.suggestedFilename.toLowerCase().endsWith('.gif'));

    const pointerChange = await activateChange(page);
    observations.pointerChange = pointerChange;
    assert(pointerChange.openedPicker, 'Change video did not open the picker');
    assert.equal(pointerChange.afterEmptySelection.fileName, 'trim-submission.mp4');
    assert.equal(pointerChange.afterEmptySelection.trimStart, '0:02.0');
    assert.equal(pointerChange.afterEmptySelection.trimEnd, '0:08.0');
    await page.screenshot({ path: join(output, 'selection-after-change.png'), fullPage: true });
    observations.outputAfterChange = await downloadResult(page, output, 'selection-after-change');
    observations.outputAfterChangeMatchesFirst =
      (observations.outputAfterChange as { sha256: string }).sha256 ===
      (observations.converted as { output: { sha256: string } }).output.sha256;
    assert.equal(observations.outputAfterChangeMatchesFirst, true);

    if (await page.locator('[data-testid="choose-file-button"]').isVisible()) {
      const chooser = await fileChooserFromAction(page, () =>
        page.locator('[data-testid="choose-file-button"]').click()
      );
      assert(chooser, 'Choose video did not open a file picker for empty-selection check');
      await chooser.setFiles([]);
      observations.emptyPickerSelection = await snapshot(page);
      await chooseFile(page, fixture, true);
    } else {
      const chooser = await fileChooserFromAction(page, () => selectedChange(page).click());
      assert(chooser, 'Change did not open a file picker for same-file reselection');
      await chooser.setFiles(fixture);
      await waitForConversionReady(page);
    }
    observations.sameFileReselection = await snapshot(page);
    assert.equal(
      (observations.sameFileReselection as Awaited<ReturnType<typeof snapshot>>).fileName,
      'trim-submission.mp4'
    );
    assert.equal(
      (observations.sameFileReselection as Awaited<ReturnType<typeof snapshot>>).trimStart,
      '0:00.0'
    );
    observations.outputAfterReselection = await downloadResult(
      page,
      output,
      'selection-reselected'
    );
    observations.outputAfterReselectionMatchesFirst =
      (observations.outputAfterReselection as { sha256: string }).sha256 ===
      (observations.converted as { output: { sha256: string } }).output.sha256;
    assert.equal(observations.outputAfterReselectionMatchesFirst, true);

    const keyboardChange = await activateChange(page, true);
    observations.keyboardChange = keyboardChange;
    assert(keyboardChange.openedPicker, 'Keyboard Change video did not open the picker');
    assert.equal(keyboardChange.afterEmptySelection.fileName, 'trim-submission.mp4');
    const invalid = {
      name: 'unsupported.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not video'),
    };
    if (await page.locator('[data-testid="choose-file-button"]').isVisible()) {
      const chooser = await fileChooserFromAction(page, () =>
        page.locator('[data-testid="choose-file-button"]').click()
      );
      assert(chooser);
      await chooser.setFiles(invalid);
    } else {
      const chooser = await fileChooserFromAction(page, () => selectedChange(page).click());
      assert(chooser);
      await chooser.setFiles(invalid);
    }
    await page.locator('[data-testid="error-display"]').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('data-testid') ===
        'error-select-different-fallback-button',
      undefined,
      { timeout: 5_000 }
    );
    const unsupported = await snapshot(page);
    observations.unsupported = unsupported;
    assert.equal(unsupported.retry, null, 'Unsupported input offered Retry without a current file');
    assert(unsupported.selectDifferent, 'Unsupported input did not offer a different file');
    assert.equal(unsupported.focus, 'error-select-different-fallback-button');
    await page.screenshot({ path: join(output, 'selection-unsupported.png'), fullPage: true });
    const retry = page.locator('[data-testid="error-retry-button"]');
    if (await retry.isVisible()) {
      await page.evaluate(() => {
        const state = document.querySelector('#app-state');
        const states: string[] = [];
        const capture = () => {
          const current = state?.textContent?.trim() ?? '';
          if (current && states.at(-1) !== current) states.push(current);
        };
        capture();
        const observer = new MutationObserver(capture);
        if (state) observer.observe(state, { childList: true, characterData: true, subtree: true });
        Reflect.set(globalThis, '__selectionRetryTrace', { states, observer });
      });
      await retry.click();
      await page.waitForTimeout(750);
      observations.unsupportedRetryStates = await page.evaluate(() => {
        const trace = Reflect.get(globalThis, '__selectionRetryTrace') as {
          states: string[];
          observer: MutationObserver;
        };
        trace.observer.disconnect();
        return trace.states;
      });
    }
    observations.afterUnsupportedRetry = await snapshot(page);
    assert.equal(
      (observations.afterUnsupportedRetry as Awaited<ReturnType<typeof snapshot>>).retry,
      null
    );
    if (await page.locator('[data-testid="download-result-button"]').isVisible()) {
      observations.outputAfterUnsupportedRetry = await downloadResult(
        page,
        output,
        'selection-after-unsupported-retry'
      );
    }
    if (await page.locator('[data-testid="error-display"]').isVisible()) {
      await page
        .locator(
          '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
        )
        .click();
    }
    if (await page.locator('[data-testid="choose-file-button"]').isVisible()) {
      await chooseFile(page, fixture);
    }
    observations.recoveredValidFile = await snapshot(page);
    assert.equal(
      (observations.recoveredValidFile as Awaited<ReturnType<typeof snapshot>>).fileName,
      'trim-submission.mp4'
    );
    return observations;
  } catch (error) {
    await writeFile(
      join(output, 'selection-partial.json'),
      JSON.stringify({ ...observations, failure: String(error) }, null, 2)
    );
    throw error;
  } finally {
    await context.close();
  }
}

async function exerciseLocale(
  browser: Browser,
  url: string,
  fixture: string,
  output: string,
  locale: 'en-US' | 'ko-KR' | 'ja-JP'
) {
  const labels = {
    'en-US': { choose: 'Choose video', change: 'Change video' },
    'ko-KR': { choose: '동영상 선택', change: '동영상 변경' },
    'ja-JP': { choose: '動画を選択', change: '動画を変更' },
  }[locale];
  const context = await browser.newContext({
    acceptDownloads: true,
    locale,
    viewport: { width: 320, height: 844 },
  });
  const observations: Record<string, unknown> = { id: `locale-${locale}` };
  try {
    const page = await context.newPage();
    observations.browserErrors = captureBrowserErrors(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok());
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const empty = await snapshot(page);
    observations.empty = empty;
    assert.equal(empty.choose?.text, labels.choose);
    assert(empty.choose?.bounds.height >= 44 && empty.choose.bounds.width >= 44);
    assert(empty.viewport.scrollWidth <= empty.viewport.width);
    await page.screenshot({ path: join(output, `locale-${locale}-empty.png`), fullPage: true });
    await chooseFile(page, fixture, true);
    const selected = await snapshot(page);
    observations.selected = selected;
    assert.equal(selected.change?.text, labels.change);
    assert(selected.change?.bounds.height >= 44 && selected.change.bounds.width >= 44);
    assert(selected.viewport.scrollWidth <= selected.viewport.width);
    await page.screenshot({ path: join(output, `locale-${locale}-selected.png`), fullPage: true });
    const change = await activateChange(page, true);
    observations.change = change;
    assert(change.openedPicker);
    assert.equal(change.afterEmptySelection.fileName, 'trim-submission.mp4');
    return observations;
  } catch (error) {
    await writeFile(
      join(output, `locale-${locale}-partial.json`),
      JSON.stringify({ ...observations, failure: String(error) }, null, 2)
    );
    throw error;
  } finally {
    await context.close();
  }
}

async function exerciseNativePreview(
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
  const observations: Record<string, unknown> = {
    id: 'matroska-native-preview',
    fixture: basename(fixture),
  };
  try {
    const page = await context.newPage();
    observations.browserErrors = captureBrowserErrors(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok());
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await waitForConversionReady(page);
    observations.selected = await snapshot(page);
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill('0.1');
    await start.press('Enter');
    await end.fill('0.8');
    await end.press('Enter');
    observations.selectedRange = await snapshot(page);
    await page.locator('#selection-preview-video').evaluate((video) => {
      if (!(video instanceof HTMLVideoElement)) throw new Error('Selection preview is not video');
      Reflect.set(globalThis, '__selectionPreviewEvents', []);
      for (const type of [
        'loadedmetadata',
        'canplay',
        'play',
        'playing',
        'pause',
        'error',
        'ended',
      ]) {
        video.addEventListener(type, () => {
          const events = Reflect.get(globalThis, '__selectionPreviewEvents') as string[];
          events.push(type);
        });
      }
    });
    await page.locator('[data-testid="trim-preview-button"]').click();
    await page.waitForTimeout(750);
    const afterPlay = await snapshot(page);
    observations.afterPlay = afterPlay;
    const events = await page.evaluate(
      () => Reflect.get(globalThis, '__selectionPreviewEvents') as string[]
    );
    observations.events = events;
    assert((afterPlay.video?.readyState ?? 0) >= 1);
    assert.equal(afterPlay.video?.errorCode, null);
    assert((afterPlay.video?.currentTime ?? 0) > 0.1);
    assert(events.includes('playing'), 'Real Matroska preview did not play');
    assert.equal(afterPlay.previewUnavailable, null);
    await page.screenshot({ path: join(output, 'matroska-preview.png'), fullPage: true });
    const converted = await convertLowGif(page, output, 'matroska-converted', 0.1, 0.8);
    observations.converted = converted;
    assert(Math.abs(converted.output.durationSeconds - 0.7) <= 0.2);
    return observations;
  } catch (error) {
    await writeFile(
      join(output, 'matroska-partial.json'),
      JSON.stringify({ ...observations, failure: String(error) }, null, 2)
    );
    throw error;
  } finally {
    await context.close();
  }
}

async function exerciseScopedPreviewFailure(
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
  const observations: Record<string, unknown> = {
    id: 'scoped-preview-failure-harness',
    limitation:
      'Synthetic play rejection and media error affect only #selection-preview-video; they do not reproduce a field incident.',
  };
  try {
    await context.addInitScript(() => {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.id === 'selection-preview-video') {
          const count =
            (Reflect.get(globalThis, '__selectionPlayRejections') as number | undefined) ?? 0;
          Reflect.set(globalThis, '__selectionPlayRejections', count + 1);
          return Promise.reject(
            new DOMException('Scoped preview test rejection', 'NotSupportedError')
          );
        }
        return original.call(this);
      };
    });
    const page = await context.newPage();
    observations.browserErrors = captureBrowserErrors(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok());
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await waitForConversionReady(page);
    await page.waitForFunction(
      () =>
        (document.querySelector<HTMLVideoElement>('#selection-preview-video')?.readyState ?? 0) >=
        HTMLMediaElement.HAVE_METADATA,
      undefined,
      { timeout: 15_000 }
    );
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill('2.0');
    await start.press('Enter');
    await end.fill('3.0');
    await end.press('Enter');
    observations.before = await snapshot(page);
    await page.locator('[data-testid="trim-preview-button"]').click();
    await page.waitForTimeout(100);
    const afterRejectedPlay = await snapshot(page);
    observations.afterRejectedPlay = afterRejectedPlay;
    const rejectedPlayCount = await page.evaluate(
      () => (Reflect.get(globalThis, '__selectionPlayRejections') as number | undefined) ?? 0
    );
    observations.rejectedPlayCount = rejectedPlayCount;
    assert.equal(rejectedPlayCount, 1);
    assert(afterRejectedPlay.previewUnavailable?.includes('preview is unavailable'));
    assert.equal(afterRejectedPlay.error, null, 'Preview failure became a conversion error');
    assert.equal(afterRejectedPlay.trimStart, '0:02.0');
    assert.equal(afterRejectedPlay.trimEnd, '0:03.0');
    assert(afterRejectedPlay.previewButton?.text.includes('Retry preview'));
    await page.locator('#selection-preview-video').dispatchEvent('error');
    const afterSyntheticMediaError = await snapshot(page);
    observations.afterSyntheticMediaError = afterSyntheticMediaError;
    assert(afterSyntheticMediaError.previewUnavailable?.includes('preview is unavailable'));
    await page.screenshot({ path: join(output, 'scoped-preview-failure.png'), fullPage: true });
    const converted = await convertLowGif(page, output, 'preview-rejected-converted', 2, 3);
    observations.converted = converted;
    assert(Math.abs(converted.output.durationSeconds - 1) <= 0.2);
    return observations;
  } catch (error) {
    await writeFile(
      join(output, 'scoped-preview-failure-partial.json'),
      JSON.stringify({ ...observations, failure: String(error) }, null, 2)
    );
    throw error;
  } finally {
    await context.close();
  }
}

/** A focused same-element retry probe; only its first selected play is synthetic. */
export async function exercisePreviewRetry(
  browser: Browser,
  url: string,
  fixture: string,
  output: string
) {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });
  const observations: Record<string, unknown> = {
    id: 'same-source-preview-retry',
    fixture: basename(fixture),
    limitation:
      'One synthetic play rejection on the selected preview; retry uses native media playback.',
  };
  try {
    const page = await context.newPage();
    observations.browserErrors = captureBrowserErrors(page);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok(), 'Built application did not load');
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await waitForConversionReady(page);
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('#selection-preview-video');
      return video && video.readyState >= HTMLMediaElement.HAVE_METADATA;
    });

    const preview = page.locator('#selection-preview-video');
    const button = page.locator('[data-testid="trim-preview-button"]');
    await preview.evaluate((video) => {
      if (!(video instanceof HTMLVideoElement)) throw new Error('Missing preview video');
      const events: { type: string; atMs: number; time: number }[] = [];
      for (const type of ['loadedmetadata', 'play', 'playing', 'pause', 'ended', 'error']) {
        video.addEventListener(type, () => {
          if (events.length < 40)
            events.push({ type, atMs: performance.now(), time: video.currentTime });
        });
      }
      Reflect.set(globalThis, '__previewRetryProbe', {
        video,
        source: video.currentSrc,
        events,
        loadCalls: 0,
        rejections: 0,
      });
      const nativeLoad = video.load;
      video.load = function () {
        const probe = Reflect.get(globalThis, '__previewRetryProbe') as { loadCalls: number };
        probe.loadCalls++;
        return nativeLoad.call(this);
      };
    });
    observations.initial = await snapshot(page);
    await button.click();
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('#selection-preview-video');
      return video && !video.paused && video.currentTime > 0.12;
    });
    observations.healthyPlaying = await snapshot(page);
    await button.click();
    observations.healthyStopped = await snapshot(page);

    await preview.evaluate((video) => {
      if (!(video instanceof HTMLVideoElement)) throw new Error('Missing preview video');
      video.play = function () {
        const probe = Reflect.get(globalThis, '__previewRetryProbe') as { rejections: number };
        probe.rejections++;
        Reflect.deleteProperty(this, 'play');
        return Promise.reject(
          new DOMException('Scoped transient preview rejection', 'NotAllowedError')
        );
      };
    });
    await button.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="selection-preview-unavailable"]') !== null
    );
    observations.rejected = await snapshot(page);
    await page.screenshot({ path: join(output, 'preview-retry-rejected.png'), fullPage: true });

    await button.click();
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('#selection-preview-video');
      return video && !video.paused && video.currentTime > 0.12;
    });
    observations.retryPlaying = await snapshot(page);
    await page.screenshot({ path: join(output, 'preview-retry-playing.png'), fullPage: true });
    await button.click();
    observations.retryStopped = await snapshot(page);
    observations.probe = await page.evaluate(() => {
      const probe = Reflect.get(globalThis, '__previewRetryProbe') as {
        video: HTMLVideoElement;
        source: string;
        events: { type: string; atMs: number; time: number }[];
        loadCalls: number;
        rejections: number;
      };
      return {
        sameElement: probe.video === document.querySelector('#selection-preview-video'),
        sameSource: probe.source === probe.video.currentSrc,
        source: probe.source,
        events: probe.events,
        loadCalls: probe.loadCalls,
        rejections: probe.rejections,
      };
    });
    await writeFile(join(output, 'preview-retry.json'), JSON.stringify(observations, null, 2));

    const healthy = observations.healthyPlaying as Awaited<ReturnType<typeof snapshot>>;
    const rejected = observations.rejected as Awaited<ReturnType<typeof snapshot>>;
    const playing = observations.retryPlaying as Awaited<ReturnType<typeof snapshot>>;
    const stopped = observations.retryStopped as Awaited<ReturnType<typeof snapshot>>;
    const probe = observations.probe as {
      sameElement: boolean;
      sameSource: boolean;
      events: { type: string }[];
      loadCalls: number;
      rejections: number;
    };
    assert.equal(healthy.previewUnavailable, null);
    assert(healthy.video && healthy.video.currentTime > 0.12 && !healthy.video.paused);
    assert(rejected.previewUnavailable?.includes('preview is unavailable'));
    assert(rejected.previewButton?.text.includes('Retry preview'));
    assert((rejected.video?.readyState ?? 0) >= HTMLMediaElement.HAVE_METADATA);
    assert.equal(rejected.video?.errorCode, null);
    assert.equal(probe.rejections, 1);
    assert.equal(probe.sameElement, true);
    assert.equal(probe.sameSource, true);
    assert.equal(probe.loadCalls, 0);
    assert.equal(probe.events.filter((event) => event.type === 'loadedmetadata').length, 0);
    assert(probe.events.filter((event) => event.type === 'playing').length >= 2);
    assert(playing.video && playing.video.currentTime > 0.12 && !playing.video.paused);
    assert(playing.video.readyState >= HTMLMediaElement.HAVE_METADATA);
    assert.equal(playing.video.errorCode, null);
    assert.equal(
      playing.previewUnavailable,
      null,
      'Successful native retry kept stale failure feedback'
    );
    assert.equal(stopped.previewUnavailable, null);
    assert(stopped.previewButton?.text.includes('Preview selection'));
    return { profile: 'preview-retry', status: 'passed', observations };
  } catch (error) {
    await writeFile(
      join(output, 'preview-retry-partial.json'),
      JSON.stringify({ ...observations, failure: String(error) }, null, 2)
    );
    throw error;
  } finally {
    await context.close();
  }
}

/** Source-bound selection and preview checks through the built application's conversion path. */
export async function exerciseSelectionPreviewBaseline(
  browser: Browser,
  url: string,
  fixture: string,
  matroska: string,
  output: string
) {
  await mkdir(output, { recursive: true });
  const cases: unknown[] = [];
  const failures: string[] = [];
  for (const [id, exercise] of [
    ['selection', () => exerciseSelection(browser, url, fixture, output)],
    ['locale-en', () => exerciseLocale(browser, url, fixture, output, 'en-US')],
    ['locale-ko', () => exerciseLocale(browser, url, fixture, output, 'ko-KR')],
    ['locale-ja', () => exerciseLocale(browser, url, fixture, output, 'ja-JP')],
    ['native-preview', () => exerciseNativePreview(browser, url, matroska, output)],
    ['scoped-preview-failure', () => exerciseScopedPreviewFailure(browser, url, fixture, output)],
  ] as const) {
    try {
      cases.push(await exercise());
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.stack : String(error)}`);
    }
    await writeFile(
      join(output, 'selection-preview.json'),
      JSON.stringify(
        { status: failures.length === 0 ? 'passed' : 'failed', cases, failures },
        null,
        2
      )
    );
  }
  assert.equal(
    failures.length,
    0,
    `Selection/preview baseline probe failed: ${failures.join('; ')}`
  );
  return { profile: 'selection-preview', status: 'passed', cases };
}
