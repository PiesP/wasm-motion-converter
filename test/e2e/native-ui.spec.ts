// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';

test('native confirmation keeps keyboard, backdrop, focus, and callbacks in one lifecycle', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const opener = document.createElement('button');
    opener.id = 'confirmation-test-opener';
    opener.textContent = 'Open confirmation';
    document.body.append(opener);
    opener.focus();

    const modulePath = '/src/stores/confirmation-store.ts';
    const { showConfirmation } = await import(modulePath);
    const warning = {
      severity: 'warning' as const,
      message: 'Check file',
      requiresConfirmation: true,
    };
    const show = () =>
      showConfirmation(
        [warning],
        () => {
          document.body.dataset.confirmCount = String(
            Number(document.body.dataset.confirmCount ?? 0) + 1
          );
        },
        () => {
          document.body.dataset.cancelCount = String(
            Number(document.body.dataset.cancelCount ?? 0) + 1
          );
        }
      );
    opener.addEventListener('click', show);
    show();
  });

  const dialog = page.getByRole('dialog');
  const cancel = page.getByTestId('modal-cancel-button');
  const confirm = page.getByTestId('modal-confirm-button');
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-cancel-count', '1');
  await expect(page.locator('#confirmation-test-opener')).toBeFocused();

  await page.locator('#confirmation-test-opener').click();
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  await page.mouse.move(dialogBounds!.x + dialogBounds!.width / 2, dialogBounds!.y + 24);
  await page.mouse.down();
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-cancel-count', '1');
  await page.mouse.click(1, 1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-cancel-count', '2');
  await expect(page.locator('body')).not.toHaveAttribute('data-confirm-count', /.+/);
});

test('anchored tooltip follows focus and stays within a changed viewport', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Information about Output Format' });
  const tooltip = page.getByRole('tooltip');
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  const tooltipId = await tooltip.getAttribute('id');
  await expect(trigger).toHaveAttribute('aria-describedby', tooltipId!);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);

  await trigger.blur();
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  const hoverBounds = await tooltip.boundingBox();
  expect(hoverBounds).not.toBeNull();
  await page.mouse.move(
    hoverBounds!.x + hoverBounds!.width / 2,
    hoverBounds!.y + hoverBounds!.height / 2
  );
  await page.waitForTimeout(130);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 480 });
  const languageSelector = page.getByTestId('language-selector');
  await languageSelector.focus();
  await languageSelector.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const localizedTrigger = page.locator('fieldset legend button').first();
  await page.evaluate(() => {
    document.body.style.minHeight = '1600px';
  });
  await localizedTrigger.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -24));
  await localizedTrigger.focus();
  await expect(tooltip).toBeVisible();
  await tooltip.evaluate((element) => {
    element.textContent = 'Long localized explanation. '.repeat(16);
  });
  const bounds = await tooltip.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480);

  const expectUnoccluded = async () => {
    const hits = await tooltip.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return [0.2, 0.5, 0.8].map((fraction) => {
        const hit = document.elementFromPoint(
          rect.left + rect.width * fraction,
          rect.top + rect.height * fraction
        );
        return hit === element || element.contains(hit);
      });
    });
    expect(hits).toEqual([true, true, true]);
  };
  await expectUnoccluded();

  await page.evaluate(() => window.scrollBy(0, 12));
  const triggerBounds = await localizedTrigger.boundingBox();
  expect(triggerBounds).not.toBeNull();
  expect(triggerBounds!.y).toBeGreaterThanOrEqual(0);
  expect(triggerBounds!.y).toBeLessThan(60);
  const scrolledBounds = await tooltip.boundingBox();
  expect(scrolledBounds).not.toBeNull();
  expect(scrolledBounds!.y).toBeGreaterThanOrEqual(0);
  expect(scrolledBounds!.y + scrolledBounds!.height).toBeLessThanOrEqual(480);
  await expectUnoccluded();
});

test('localized tooltip reopens only after focus changes following Escape', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Information about Output Format' });
  const tooltip = page.getByRole('tooltip');
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);

  const languageSelector = page.getByTestId('language-selector');
  await languageSelector.focus();
  await languageSelector.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const localizedTrigger = page.locator('fieldset legend button').first();
  await localizedTrigger.focus();
  await expect(tooltip).toBeVisible();
  const tooltipId = await tooltip.getAttribute('id');
  expect(tooltipId).toBeTruthy();
  await expect(localizedTrigger).toHaveAttribute('aria-describedby', tooltipId!);
});

test('captured trim handle owns outside movement, pointer identity, and release', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const modulePath = './src/test-helpers';
    const { attachTestHelpers } = await import(modulePath);
    attachTestHelpers();
    await window.__TEST_HELPERS__?.injectFile(
      new File(['synthetic'], 'trim-pointer.mp4', { type: 'video/mp4' }),
      {
        width: 640,
        height: 360,
        duration: 10,
        codec: 'avc1.42E01E',
        framerate: 15,
        bitrate: 500000,
      }
    );
  });

  const start = page.getByTestId('trim-start-handle');
  const track = page.getByTestId('trim-timeline');
  await expect(start).toBeVisible();
  await start.scrollIntoViewIfNeeded();
  const startBounds = await start.boundingBox();
  const trackBounds = await track.boundingBox();
  expect(startBounds).not.toBeNull();
  expect(trackBounds).not.toBeNull();
  await page.mouse.move(
    startBounds!.x + startBounds!.width / 2,
    startBounds!.y + startBounds!.height / 2
  );
  await page.mouse.down();
  await expect(page.locator('body')).toHaveCSS('cursor', 'ew-resize');
  await start.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 999, clientX: 9999 })
    );
  });
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  await page.mouse.move(trackBounds!.x + trackBounds!.width + 100, trackBounds!.y + 20);
  await expect(start).toHaveAttribute('aria-valuenow', '9.9');
  await expect(page.locator('#trim-start-input')).toHaveValue('0:09.9');
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveCSS('cursor', 'ew-resize');

  const end = page.getByTestId('trim-end-handle');
  const endBounds = await end.boundingBox();
  expect(endBounds).not.toBeNull();
  await end.evaluate((element) => {
    element.addEventListener('gotpointercapture', () => {
      (element as HTMLElement).dataset.gotCapture = 'true';
    });
    element.addEventListener('lostpointercapture', () => {
      (element as HTMLElement).dataset.lostCapture = 'true';
    });
    element.addEventListener(
      'pointerdown',
      (event) => {
        (element as HTMLElement).dataset.activePointerId = String(
          (event as PointerEvent).pointerId
        );
      },
      { once: true }
    );
  });
  await page.mouse.move(endBounds!.x + endBounds!.width / 2, endBounds!.y + endBounds!.height / 2);
  await page.mouse.down();
  await expect(page.locator('body')).toHaveCSS('cursor', 'ew-resize');
  await page.mouse.move(
    endBounds!.x + endBounds!.width / 2 - 1,
    endBounds!.y + endBounds!.height / 2
  );
  await expect(end).toHaveAttribute('data-got-capture', 'true');
  await end.evaluate((element) => {
    const pointerId = Number((element as HTMLElement).dataset.activePointerId);
    (element as HTMLButtonElement).releasePointerCapture(pointerId);
  });
  await page.mouse.move(endBounds!.x - 50, endBounds!.y + endBounds!.height / 2);
  await expect(end).toHaveAttribute('data-lost-capture', 'true');
  await expect(page.locator('body')).not.toHaveCSS('cursor', 'ew-resize');
  await page.mouse.up();
});
