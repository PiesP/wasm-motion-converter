// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

function assertWithinViewport(
  rect: { x: number; y: number; width: number; height: number } | null,
  width: number,
  height: number
) {
  assert(rect, 'Expected a rendered tooltip');
  assert(rect.x >= -1 && rect.y >= -1, `Tooltip starts outside viewport: ${JSON.stringify(rect)}`);
  assert(
    rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1,
    `Tooltip ends outside viewport: ${JSON.stringify(rect)}`
  );
  return rect;
}

/** Exercise the source-bound production UI without changing its conversion policy. */
export async function exerciseNativeUi(page: Page, fixturePath: string) {
  const viewport = { width: 320, height: 480 };
  const trigger = page.getByRole('button', { name: 'Information about Output Format' });
  const tooltip = page.getByRole('tooltip');
  await trigger.focus();
  await tooltip.waitFor({ state: 'visible' });
  const tooltipId = await tooltip.getAttribute('id');
  assert(tooltipId && (await trigger.getAttribute('aria-describedby')) === tooltipId);
  await page.keyboard.press('Escape');
  assert.equal(await tooltip.count(), 0, 'Escape did not dismiss the focused tooltip');

  await page.setViewportSize(viewport);
  await page.locator('[data-testid="language-selector"]').selectOption('ar');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  const rtlTrigger = page.locator('fieldset legend button').first();
  await rtlTrigger.evaluate((element) => {
    const anchor = element.parentElement;
    if (!anchor) throw new Error('Tooltip anchor is missing');
    Object.assign(anchor.style, { position: 'fixed', top: '2px', right: '2px' });
  });
  await rtlTrigger.focus();
  await tooltip.waitFor({ state: 'visible' });
  await tooltip.evaluate((element) => {
    element.textContent = 'شرح طويل للمساعدة في اختيار صيغة الإخراج. '.repeat(12);
  });
  const tooltipRect = assertWithinViewport(
    await tooltip.boundingBox(),
    viewport.width,
    viewport.height
  );
  const anchorPosition = await tooltip.evaluate((element) => ({
    anchor: getComputedStyle(element).positionAnchor,
    area: getComputedStyle(element).positionArea,
    fallbacks: getComputedStyle(element).positionTryFallbacks,
  }));
  assert(anchorPosition.anchor.startsWith('--tooltip-'), 'Tooltip lost its named CSS anchor');
  assert(anchorPosition.fallbacks !== 'none', 'Tooltip overflow alternatives are inactive');
  await page.evaluate(() => {
    document.body.style.minHeight = '1600px';
    window.scrollTo(0, 300);
  });
  assertWithinViewport(await tooltip.boundingBox(), viewport.width, viewport.height);
  const tooltipObservation = { id: tooltipId, rect: tooltipRect, anchorPosition };

  await rtlTrigger.blur();
  await rtlTrigger.evaluate((element) => element.parentElement?.removeAttribute('style'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-testid="language-selector"]').selectOption('en');
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.locator('[data-testid="file-input"]').setInputFiles(fixturePath);
  const start = page.getByTestId('trim-start-handle');
  const track = page.getByTestId('trim-timeline');
  await start.waitFor({ state: 'visible', timeout: 30_000 });
  await start.scrollIntoViewIfNeeded();
  const startRect = await start.boundingBox();
  const trackRect = await track.boundingBox();
  assert(startRect && trackRect, 'Trim handle or track has no layout');
  await page.mouse.move(startRect.x + startRect.width / 2, startRect.y + startRect.height / 2);
  await page.mouse.down();
  assert.equal(await page.locator('body').evaluate((body) => body.style.cursor), 'ew-resize');
  await start.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 999, clientX: 9999 })
    );
  });
  assert.equal(await start.getAttribute('aria-valuenow'), '0', 'Foreign pointer changed trim');
  await page.mouse.move(trackRect.x + trackRect.width + 100, trackRect.y + 20);
  const selectedStart = Number(await start.getAttribute('aria-valuenow'));
  const selectedEnd = Number(
    await page.getByTestId('trim-end-handle').getAttribute('aria-valuenow')
  );
  assert(selectedStart > 0 && selectedStart < selectedEnd, 'Captured drag did not clamp range');
  await page.mouse.up();
  assert.notEqual(await page.locator('body').evaluate((body) => body.style.cursor), 'ew-resize');
  const displayedStart = await page.locator('#trim-start-input').inputValue();
  assert(displayedStart.endsWith(selectedStart.toFixed(1)), 'Displayed trim differs from slider');
  await start.focus();
  await page.keyboard.press('ArrowLeft');
  const keyboardStart = Number(await start.getAttribute('aria-valuenow'));
  assert(keyboardStart < selectedStart, 'Keyboard did not adjust the captured trim value');

  return {
    tooltip: tooltipObservation,
    trim: { selectedStart, selectedEnd, displayedStart, keyboardStart },
  };
}

/** Observe real browser-tab zoom in an owned installed Chrome profile. */
export async function exerciseNativeTooltipZoom(
  browser: Browser,
  bundleRoot: string,
  url: string,
  output: string
) {
  const profilePath = await mkdtemp(join(bundleRoot, 'wmc-native-ui-zoom-'));
  let context: BrowserContext | undefined;
  let settingsPage: Page | undefined;
  let appPage: Page | undefined;
  let previousZoom: string | undefined;
  let baseline: { dpr: number; width: number; scale: number } | undefined;
  let actual: typeof baseline;
  let result: Record<string, unknown> | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  let zoomRestored = false;
  let contextClosed = false;
  let profileRemoved = false;
  try {
    context = await browser.browserType().launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: false,
      locale: 'en-US',
      colorScheme: 'light',
      viewport: { width: 1280, height: 900 },
    });
    appPage = context.pages()[0] ?? (await context.newPage());
    const response = await appPage.goto(url, { waitUntil: 'domcontentloaded' });
    assert(response?.ok(), 'Installed Chrome did not load the source-bound app');
    const trigger = appPage.getByRole('button', { name: 'Information about Output Format' });
    await trigger.waitFor({ state: 'visible' });
    baseline = await appPage.evaluate(() => ({
      dpr: devicePixelRatio,
      width: innerWidth,
      scale: visualViewport?.scale ?? 0,
    }));
    settingsPage = await context.newPage();
    await settingsPage.goto('chrome://settings/appearance');
    const zoomControl = settingsPage.locator('select#zoomLevel');
    previousZoom = await zoomControl.inputValue();
    assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
    await settingsPage.bringToFront();
    await zoomControl.selectOption('2');
    await appPage.bringToFront();
    await appPage.waitForFunction(
      (before) =>
        Math.abs(devicePixelRatio / before.dpr - 2) < 0.02 &&
        Math.abs(innerWidth / before.width - 0.5) < 0.02 &&
        Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
      baseline,
      { timeout: 10_000 }
    );
    actual = await appPage.evaluate(() => ({
      dpr: devicePixelRatio,
      width: innerWidth,
      scale: visualViewport?.scale ?? 0,
    }));
    await trigger.focus();
    const tooltip = appPage.getByRole('tooltip');
    await tooltip.waitFor({ state: 'visible' });
    await tooltip.evaluate((element) => {
      element.textContent = 'Long localized explanation. '.repeat(16);
    });
    const height = await appPage.evaluate(() => innerHeight);
    const rect = assertWithinViewport(await tooltip.boundingBox(), actual.width, height);
    await appPage.screenshot({ path: join(output, 'native-ui-chrome-zoom.png'), fullPage: true });
    result = { baseline, actual, rect, factor: 2 };
  } catch (error) {
    failure = error;
  } finally {
    if (previousZoom !== undefined && settingsPage) {
      try {
        await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
        if (baseline && appPage) {
          await appPage.bringToFront();
          await appPage.waitForFunction(
            (before) =>
              Math.abs(devicePixelRatio / before.dpr - 1) < 0.02 &&
              Math.abs(innerWidth / before.width - 1) < 0.02 &&
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
    try {
      await settingsPage?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await context?.close();
      contextClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (contextClosed) {
      try {
        assert.equal(dirname(profilePath), bundleRoot);
        assert(basename(profilePath).startsWith('wmc-native-ui-zoom-'));
        await rm(profilePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        profileRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  const cleanup = { zoomRestored, contextClosed, profileRemoved };
  await writeFile(
    join(output, 'native-ui-zoom.json'),
    `${JSON.stringify(
      {
        status: failure || cleanupErrors.length ? 'failed' : 'passed',
        baseline,
        actual,
        result,
        cleanup,
        error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
        cleanupErrors: cleanupErrors.map((error) =>
          error instanceof Error ? error.message : String(error)
        ),
      },
      null,
      2
    )}\n`
  );
  if (failure || cleanupErrors.length) {
    throw new AggregateError(
      [failure, ...cleanupErrors].filter((error) => error !== undefined),
      `Installed Chrome tooltip zoom or cleanup failed: ${JSON.stringify(cleanup)}`
    );
  }
  assert(result);
  return { ...result, cleanup };
}
