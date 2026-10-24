// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { readGif } from './trim-submission.ts';

export const NARROW_OUTPUT_SCENARIO = 'narrow-output';
export const NARROW_OUTPUT_FIXTURE =
  'narrow-output-timecoded-1920x1080-30fps-long-filename-conversion-walkthrough.mp4';
export const NARROW_CANCEL_FIXTURE = 'narrow-output-cancel.mp4';

const ZOOM_PROFILE_PREFIX = 'wmc-narrow-output-chrome-';
const EXPECTED = {
  source: { width: 1920, height: 1080, frameRate: 30, durationSeconds: 10 },
  clip: { startSeconds: 1, endSeconds: 6, durationSeconds: 5 },
  output: { format: 'gif', quality: 'low', scale: 0.5, width: 960, height: 540 },
  frameCounts: { sourceUpperBound: 150, gifLowTargetFps: 8 },
  durationToleranceSeconds: 0.3,
} as const;

type FixtureManifest = {
  schemaVersion: number;
  files: Array<{
    file: string;
    sha256: string;
    bytes: number;
    codec: string;
    width: number;
    height: number;
    frameRate: string;
    sampleAspectRatio: string;
    durationSeconds: number;
  }>;
};

type FixturePaths = { main: string; cancel: string; manifest: string };

type Scenario = {
  id: 'css-390' | 'css-320' | 'chrome-zoom-200';
  viewport: { width: number; height: number };
  actualZoom: boolean;
};

const SCENARIOS: Scenario[] = [
  { id: 'css-390', viewport: { width: 390, height: 844 }, actualZoom: false },
  { id: 'css-320', viewport: { width: 320, height: 844 }, actualZoom: false },
  { id: 'chrome-zoom-200', viewport: { width: 1280, height: 900 }, actualZoom: true },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyFixtures(paths: FixturePaths) {
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as FixtureManifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.files.length, 2);
  const observations = [];
  for (const [name, path, expected] of [
    [NARROW_OUTPUT_FIXTURE, paths.main, { width: 1920, height: 1080, rate: '30/1', duration: 10 }],
    [NARROW_CANCEL_FIXTURE, paths.cancel, { width: 320, height: 180, rate: '120/1', duration: 24 }],
  ] as const) {
    const item = manifest.files.find((file) => file.file === name);
    assert(item, `Missing ${name} from the fixture manifest`);
    const bytes = await readFile(path);
    assert.equal(item.sha256, sha256(bytes), `Fixture hash changed: ${name}`);
    assert.equal(item.bytes, bytes.byteLength, `Fixture size changed: ${name}`);
    assert.equal(item.codec, 'h264');
    assert.equal(item.width, expected.width);
    assert.equal(item.height, expected.height);
    assert.equal(item.frameRate, expected.rate);
    assert.equal(item.sampleAspectRatio, '1:1');
    assert(Math.abs(item.durationSeconds - expected.duration) <= 0.05);
    observations.push(item);
  }
  return observations;
}

function captureBrowserErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let overflow = false;
  const append = (items: string[], value: string) => {
    if (items.length < 40) items.push(value);
    else overflow = true;
  };
  page.on('pageerror', (error) => append(pageErrors, error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') append(consoleErrors, message.text());
  });
  page.on('requestfailed', (request) =>
    append(failedRequests, `${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`)
  );
  return {
    pageErrors,
    consoleErrors,
    failedRequests,
    get overflow() {
      return overflow;
    },
  };
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const control = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim() ?? '',
        ariaLabel: element.getAttribute('aria-label'),
        dataProgress: element.getAttribute('data-progress'),
        disabled: element instanceof HTMLButtonElement ? element.disabled : null,
        bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        fontSizePx: Number.parseFloat(style.fontSize),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
      };
    };
    const option = (group: string, value: string) => {
      const selector = `[data-testid="option-${group}-${value}"]`;
      const label = document.querySelector<HTMLElement>(selector);
      const description = label?.querySelector<HTMLElement>('[id$="-desc"]');
      return {
        checked: label?.querySelector<HTMLInputElement>('input')?.checked ?? null,
        label: control(selector),
        description: description
          ? {
              text: description.textContent?.trim() ?? '',
              fontSizePx: Number.parseFloat(getComputedStyle(description).fontSize),
              bounds: description.getBoundingClientRect().toJSON(),
            }
          : null,
      };
    };
    return {
      language: document.documentElement.lang,
      direction: document.documentElement.dir,
      state: document.querySelector('#app-state')?.textContent?.trim() ?? null,
      focus:
        document.activeElement?.id || document.activeElement?.getAttribute('data-testid') || null,
      viewport: {
        innerWidth,
        innerHeight,
        devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? null,
        scrollY,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      dropzone: control('[data-testid="dropzone"]'),
      selectedFile: control('[data-testid="selection-preview-player"]'),
      trimSummary: control('[data-testid="trim-summary"]'),
      trimStart: document.querySelector<HTMLInputElement>('#trim-start-input')?.value ?? null,
      trimEnd: document.querySelector<HTMLInputElement>('#trim-end-input')?.value ?? null,
      formatGif: option('format', 'gif'),
      formatWebp: option('format', 'webp'),
      qualityLow: option('quality', 'low'),
      qualityHigh: option('quality', 'high'),
      scaleHalf: option('scale', '0.5'),
      convert: control('[data-testid="convert-button"]'),
      cancel: control('[data-testid="stop-conversion-button"]'),
      progress: control('[data-testid="dropzone"] [role="progressbar"]'),
      result: control('[data-testid="result-section"]'),
      resultSummary: control('[data-testid="result-summary"]'),
      download: control('[data-testid="download-result-button"]'),
      error: control('[data-testid="error-display"]'),
    };
  });
}

async function capture(page: Page, output: string, id: string, stage: string) {
  const observation = await snapshot(page);
  const file = `${id}-${stage}.png`;
  const image = await page.screenshot({ path: join(output, file), fullPage: true });
  const result = {
    ...observation,
    screenshot: { file, bytes: image.byteLength, sha256: sha256(image) },
  };
  await writeFile(join(output, `${id}-${stage}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function selectFile(page: Page, fixture: string, action: 'choose' | 'change') {
  const button = page.locator(
    action === 'choose'
      ? '[data-testid="choose-file-button"]'
      : '[data-testid="change-file-button"]'
  );
  await button.waitFor({ state: 'visible' });
  const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
  await button.click();
  await (await chooser).setFiles(fixture);
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="convert-button"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 45_000 }
  );
  const metadata = page.locator('[data-testid="video-metadata"]');
  await metadata.waitFor({ state: 'visible' });
  assert((await metadata.textContent())?.includes(basename(fixture)));
}

async function chooseOption(page: Page, group: string, value: string) {
  const option = page.locator(`[data-testid="option-${group}-${value}"]`);
  await option.click();
  assert(await option.locator('input').isChecked(), `${group}=${value} was not selected`);
}

async function confirmIfPrompted(page: Page) {
  const confirm = page.locator('[data-testid="modal-confirm-button"]');
  if (await confirm.isVisible()) await confirm.click();
}

async function exerciseCancellation(page: Page, fixture: string, output: string, id: string) {
  await selectFile(page, fixture, 'choose');
  await chooseOption(page, 'format', 'gif');
  await chooseOption(page, 'quality', 'high');
  await chooseOption(page, 'scale', '1');
  const advanced = page.locator('[data-testid="advanced-settings"]');
  await advanced.locator('summary').click();
  await chooseOption(page, 'smart-frame-skip', 'adaptive');
  const selected = await capture(page, output, id, 'cancel-input');
  await page.locator('[data-testid="convert-button"]').click();
  await confirmIfPrompted(page);
  const outcome = await page.waitForFunction(
    () => {
      const progress = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
      if (Number(progress?.getAttribute('data-progress')) > 0) return 'progress';
      if (document.querySelector('[data-testid="error-display"]')) return 'error';
      if (document.querySelector('[data-testid="result-section"]')) return 'completed';
      return false;
    },
    undefined,
    { timeout: 180_000 }
  );
  const state = await outcome.jsonValue();
  if (state === 'error') {
    throw new Error(
      `Cancellation fixture failed before progress: ${await page.locator('[data-testid="error-display"]').textContent()}`
    );
  }
  if (state === 'completed') {
    return {
      status: 'race' as const,
      reason: 'conversion-completed-before-positive-progress-was-observable',
      selected,
    };
  }
  assert.equal(state, 'progress');
  const before = await capture(page, output, id, 'after-positive-progress');
  const progressBefore = Number(before.progress?.dataProgress);
  const stop = page.locator('[data-testid="stop-conversion-button"]');
  if (!(progressBefore > 0) || !(await stop.isVisible())) {
    return {
      status: 'race' as const,
      reason: 'conversion-settled-between-positive-progress-and-cancel-click',
      selected,
      before,
    };
  }
  try {
    await stop.click({ timeout: 3_000 });
  } catch (error) {
    if (!(await page.locator('[data-testid="result-section"]').isVisible())) throw error;
    return {
      status: 'race' as const,
      reason: 'conversion-settled-during-cancel-click',
      selected,
      before,
    };
  }
  const afterClick = await snapshot(page);
  await page.waitForFunction(
    () => {
      const convert = document.querySelector('[data-testid="convert-button"]');
      return convert instanceof HTMLButtonElement && !convert.disabled;
    },
    undefined,
    { timeout: 45_000 }
  );
  const settled = await capture(page, output, id, 'cancelled-ready');
  assert.equal(await page.locator('[data-testid="result-section"]').count(), 0);
  assert.equal(await page.locator('[data-testid="error-display"]').count(), 0);
  return { status: 'effective' as const, progressBefore, selected, before, afterClick, settled };
}

async function exerciseMainFlow(
  page: Page,
  fixture: string,
  output: string,
  id: string,
  action: 'choose' | 'change'
) {
  await selectFile(page, fixture, action);
  const metadata = page.locator('[data-testid="video-metadata"]');
  await metadata.locator('summary').click();
  const metadataText = (await metadata.textContent())?.trim() ?? '';
  assert(metadataText.includes('1920×1080'), 'Selected source dimensions are not shown');
  assert(metadataText.includes(NARROW_OUTPUT_FIXTURE), 'Long source filename is not shown');
  const selected = await capture(page, output, id, 'selected-long-file');
  await metadata.locator('summary').click();

  const start = page.locator('#trim-start-input');
  const end = page.locator('#trim-end-input');
  await start.fill('1.0');
  const fieldFocused = await capture(page, output, id, 'focused-trim-draft');
  assert.equal(fieldFocused.focus, 'trim-start-input');
  await chooseOption(page, 'format', 'webp');
  const afterFieldTransition = await snapshot(page);
  assert.equal(
    await start.inputValue(),
    '0:01.0',
    'Valid focused trim draft did not commit on blur'
  );
  await end.fill('6.0');
  await end.press('Enter');
  assert.equal(await end.inputValue(), '0:06.0');
  await chooseOption(page, 'quality', 'high');
  await chooseOption(page, 'scale', '1');
  const beforeSharing = await capture(page, output, id, 'before-sharing-preset');

  const sharing = page.locator('[data-testid="sharing-settings"]');
  await sharing.locator('summary').click();
  await sharing.locator('[data-testid="sharing-settings-button"]').click();
  for (const [group, value] of [
    ['format', 'webp'],
    ['quality', 'low'],
    ['scale', '0.5'],
  ] as const) {
    assert(
      await page.locator(`[data-testid="option-${group}-${value}"] input`).isChecked(),
      `Sharing preset changed ${group} unexpectedly`
    );
  }
  assert.equal(await start.inputValue(), '0:01.0');
  assert.equal(await end.inputValue(), '0:06.0');
  assert.equal(await page.locator('[data-testid="result-section"]').count(), 0);
  const afterSharing = await capture(page, output, id, 'after-sharing-preset');

  await chooseOption(page, 'format', 'gif');
  const ready = await capture(page, output, id, 'before-convert');
  const summary = await page.locator('[data-testid="trim-summary"]').textContent();
  assert(summary?.includes('150'), 'Source-frame upper-bound estimate is absent');
  assert(ready.qualityLow.description?.text.includes('target 8 fps'));
  assert(ready.scaleHalf.description?.text.includes('960x540'));
  const convert = page.locator('[data-testid="convert-button"]');
  const beforeFindingConvert = await snapshot(page);
  await convert.scrollIntoViewIfNeeded();
  const foundConvert = await snapshot(page);
  assert(foundConvert.convert?.visible);
  assert(foundConvert.convert.bounds.left >= -1);
  assert(foundConvert.convert.bounds.right <= foundConvert.viewport.innerWidth + 1);
  assert(foundConvert.convert.bounds.top >= -1);
  assert(foundConvert.convert.bounds.bottom <= foundConvert.viewport.innerHeight + 1);
  await convert.focus();
  await page.keyboard.press('Enter');
  await confirmIfPrompted(page);
  const focusObservation = await page.evaluate(() => {
    const language = document.querySelector('[data-testid="language-selector"]');
    if (!(language instanceof HTMLSelectElement)) throw new Error('Language selector is absent');
    language.focus();
    const progress = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
    return {
      focused: document.activeElement === language,
      stopPresent: document.querySelector('[data-testid="stop-conversion-button"]') !== null,
      progressPresent: progress !== null,
      progressValue: progress?.getAttribute('data-progress') ?? null,
    };
  });
  const editingFocusDuringConversion =
    focusObservation.focused && focusObservation.stopPresent && focusObservation.progressPresent;
  let progress: Awaited<ReturnType<typeof snapshot>> | null = null;
  if (editingFocusDuringConversion) progress = await snapshot(page);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="result-section"]') !== null ||
      document.querySelector('[data-testid="error-display"]') !== null,
    undefined,
    { timeout: 180_000 }
  );
  const error = page.locator('[data-testid="error-display"]');
  if ((await error.count()) > 0) {
    throw new Error(`Conversion failed: ${await error.textContent()}`);
  }
  const afterCompletion = await capture(page, output, id, 'completed');
  if (editingFocusDuringConversion) {
    assert.equal(
      afterCompletion.focus,
      'language-selector',
      'Completion interrupted an editable control'
    );
  }
  const download = page.locator('[data-testid="download-result-button"]');
  await download.scrollIntoViewIfNeeded();
  const foundDownload = await snapshot(page);
  assert(foundDownload.download?.visible);
  assert(foundDownload.download.bounds.left >= -1);
  assert(foundDownload.download.bounds.right <= foundDownload.viewport.innerWidth + 1);
  assert(foundDownload.download.bounds.top >= -1);
  assert(foundDownload.download.bounds.bottom <= foundDownload.viewport.innerHeight + 1);
  const gif = await readGif(page, `${id}-converted.gif`, output);
  assert.equal(gif.width, EXPECTED.output.width);
  assert.equal(gif.height, EXPECTED.output.height);
  assert(
    Math.abs(gif.durationSeconds - EXPECTED.clip.durationSeconds) <=
      EXPECTED.durationToleranceSeconds,
    `GIF duration ${gif.durationSeconds}s disagrees with the selected 5s clip`
  );
  assert(gif.frameCount > 0);
  const targetFrameCeiling =
    Math.ceil(gif.durationSeconds * EXPECTED.frameCounts.gifLowTargetFps) + 1;
  assert(
    gif.frameCount <= targetFrameCeiling,
    `GIF contains ${gif.frameCount} frames, above the 8 fps target ceiling of ${targetFrameCeiling}`
  );
  return {
    selected,
    metadataText,
    fieldFocused,
    afterFieldTransition,
    beforeSharing,
    afterSharing,
    ready,
    summary,
    beforeFindingConvert,
    foundConvert,
    progress,
    focusObservation,
    editingFocusDuringConversion,
    afterCompletion,
    foundDownload,
    gif,
    targetFrameCeiling,
    timecodeReview: 'pending-review-of-first-and-last-decoded-frame-images',
  };
}

async function exerciseLayout(
  page: Page,
  url: string,
  paths: FixturePaths,
  output: string,
  scenario: Scenario,
  alreadyLoaded: boolean
) {
  const errors = captureBrowserErrors(page);
  const partial: Record<string, unknown> = {
    id: scenario.id,
    cssViewport: scenario.viewport,
    actualZoom: scenario.actualZoom,
    expected: EXPECTED,
  };
  try {
    if (!alreadyLoaded) {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert(response?.ok(), 'Production bundle failed to load');
    }
    const environment = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      isolated: crossOriginIsolated,
      language: document.documentElement.lang,
      devicePixelRatio,
      innerWidth,
      innerHeight,
      visualViewportScale: visualViewport?.scale ?? null,
    }));
    assert(environment.isolated, 'Production bundle lost cross-origin isolation');
    assert(environment.userAgent.includes('Chrome/') && !environment.userAgent.includes('Edg/'));
    assert.equal(environment.language, 'en');
    if (!scenario.actualZoom) {
      assert.equal(environment.innerWidth, scenario.viewport.width);
      assert.equal(environment.innerHeight, scenario.viewport.height);
    }
    partial.environment = environment;
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const empty = await capture(page, output, scenario.id, 'empty');
    partial.empty = empty;
    const cancellation = await exerciseCancellation(page, paths.cancel, output, scenario.id);
    partial.cancellation = cancellation;
    let mainAction: 'choose' | 'change' = 'change';
    if (cancellation.status === 'race') {
      // A fast completion did not exercise cancellation. Start a clean document
      // for the output task and retain the race as incomplete evidence.
      await page.reload({ waitUntil: 'domcontentloaded' });
      mainAction = 'choose';
    }
    const main = await exerciseMainFlow(page, paths.main, output, scenario.id, mainAction);
    partial.main = main;
    const horizontalOverflow = [
      empty,
      main.selected,
      main.fieldFocused,
      main.ready,
      main.afterCompletion,
      main.foundDownload,
    ].map((entry) => entry.viewport.scrollWidth - entry.viewport.clientWidth);
    assert(
      horizontalOverflow.every((amount) => amount <= 1),
      `Page-level horizontal overflow was observed: ${horizontalOverflow.join(', ')}`
    );
    assert.deepEqual(errors.pageErrors, [], 'Unhandled application errors');
    assert.deepEqual(errors.consoleErrors, [], 'Application console errors');
    assert.equal(errors.overflow, false, 'Browser error collection overflowed');
    const status =
      cancellation.status === 'effective' && main.editingFocusDuringConversion
        ? 'passed'
        : 'incomplete';
    return {
      ...partial,
      status,
      horizontalOverflow,
      browserErrors: {
        page: errors.pageErrors,
        console: errors.consoleErrors,
        failedRequests: errors.failedRequests,
        overflow: errors.overflow,
      },
      evaluation: {
        kind: 'scripted-evaluator-only',
        humanTaskWalkthrough: 'not-collected',
        actionDiscovery: 'pending-review',
        descriptionReadability: 'pending-review',
        compactOutputSummary: 'pending-review',
        stickyControls: 'pending-review',
      },
    };
  } catch (error) {
    await writeFile(
      join(output, `${scenario.id}-failure.json`),
      `${JSON.stringify(
        {
          ...partial,
          browserErrors: {
            page: errors.pageErrors,
            console: errors.consoleErrors,
            failedRequests: errors.failedRequests,
            overflow: errors.overflow,
          },
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )}\n`
    );
    throw error;
  }
}

async function exerciseActualChromeZoom(
  browser: Browser,
  bundleRoot: string,
  url: string,
  paths: FixturePaths,
  output: string
) {
  const scenario = SCENARIOS[2]!;
  const profilePath = await mkdtemp(join(bundleRoot, ZOOM_PROFILE_PREFIX));
  let context: BrowserContext | undefined;
  let settingsPage: Page | undefined;
  let appPage: Page | undefined;
  let previousZoom: string | undefined;
  let baseline:
    | { devicePixelRatio: number; innerWidth: number; visualViewportScale: number }
    | undefined;
  let zoomRestored = false;
  let contextClosed = false;
  let profileRemoved = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let result: Record<string, unknown> | undefined;
  try {
    context = await browser.browserType().launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: false,
      acceptDownloads: true,
      locale: 'en-US',
      colorScheme: 'light',
      viewport: scenario.viewport,
    });
    appPage = context.pages()[0] ?? (await context.newPage());
    const response = await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert(response?.ok());
    await appPage.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    baseline = await appPage.evaluate(() => ({
      devicePixelRatio,
      innerWidth,
      visualViewportScale: visualViewport?.scale ?? 0,
    }));
    settingsPage = await context.newPage();
    await settingsPage.goto('chrome://settings/appearance');
    const zoomControl = settingsPage.locator('select#zoomLevel');
    previousZoom = await zoomControl.inputValue();
    assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
    await zoomControl.selectOption('2');
    await appPage.bringToFront();
    await appPage.waitForFunction(
      (before) =>
        Math.abs(devicePixelRatio / before.devicePixelRatio - 2) < 0.02 &&
        Math.abs(innerWidth / before.innerWidth - 0.5) < 0.02 &&
        Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
      baseline,
      { timeout: 10_000 }
    );
    assert.equal(
      await appPage.locator('[data-testid="file-input"]').inputValue(),
      '',
      'Zoom was applied after file import'
    );
    result = await exerciseLayout(appPage, url, paths, output, scenario, true);
    result = { ...result, zoom: { baseline, factor: 2, appliedBeforeImport: true } };
  } catch (error) {
    primaryError = error;
  } finally {
    if (previousZoom !== undefined && settingsPage) {
      try {
        await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
        if (baseline && appPage) {
          await appPage.bringToFront();
          await appPage.waitForFunction(
            (before) =>
              Math.abs(devicePixelRatio / before.devicePixelRatio - 1) < 0.02 &&
              Math.abs(innerWidth / before.innerWidth - 1) < 0.02 &&
              Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
            baseline,
            { timeout: 10_000 }
          );
        }
        zoomRestored = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (settingsPage) {
      try {
        await settingsPage.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (context) {
      try {
        await context.close();
        contextClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (contextClosed) {
      try {
        assert.equal(dirname(profilePath), bundleRoot);
        assert(basename(profilePath).startsWith(ZOOM_PROFILE_PREFIX));
        await rm(profilePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        profileRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  const cleanup = { zoomRestored, contextClosed, profileRemoved };
  if (primaryError || cleanupErrors.length) {
    await writeFile(
      join(output, `${scenario.id}-zoom-failure.json`),
      `${JSON.stringify(
        {
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
          cleanupErrors: cleanupErrors.map((error) =>
            error instanceof Error ? error.message : String(error)
          ),
          profileName: basename(profilePath),
          cleanup,
        },
        null,
        2
      )}\n`
    );
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
      'Chrome 200% zoom scenario or cleanup failed'
    );
  }
  assert(result);
  return { ...result, cleanup };
}

export async function exerciseNarrowOutput(
  browser: Browser,
  bundleRoot: string,
  url: string,
  paths: FixturePaths,
  output: string
) {
  await mkdir(output, { recursive: true });
  const fixtures = await verifyFixtures(paths);
  await writeFile(
    join(output, 'narrow-output-expected.json'),
    `${JSON.stringify(
      {
        scenario: NARROW_OUTPUT_SCENARIO,
        expected: EXPECTED,
        fixtures,
        evaluatorQuestions: [
          'Before conversion, what duration and dimensions do you expect?',
          'What does the GIF target FPS mean compared with the source-frame upper bound?',
          'Can you find Convert, then Download, without losing your place?',
          'Do format, quality and sharing-setting descriptions match the output you expect?',
        ],
        participantEvidence: 'not-collected',
      },
      null,
      2
    )}\n`
  );
  const checks: Array<Record<string, unknown>> = [];
  for (const scenario of SCENARIOS.filter((item) => !item.actualZoom)) {
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: 'en-US',
      colorScheme: 'light',
      viewport: scenario.viewport,
    });
    try {
      checks.push(
        await exerciseLayout(await context.newPage(), url, paths, output, scenario, false)
      );
    } finally {
      await context.close();
    }
  }
  checks.push(await exerciseActualChromeZoom(browser, bundleRoot, url, paths, output));
  const report = {
    scenario: NARROW_OUTPUT_SCENARIO,
    profile: NARROW_OUTPUT_SCENARIO,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'incomplete',
    expected: EXPECTED,
    fixtures,
    checks,
    evaluation: 'pending-operator-visual-review',
  };
  await writeFile(join(output, 'narrow-output.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
