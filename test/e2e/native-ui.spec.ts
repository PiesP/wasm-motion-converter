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
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Information about Output Format"]'
    );
    if (!button?.parentElement) throw new Error('Tooltip anchor is missing');
    Object.assign(button.parentElement.style, { position: 'fixed', top: '2px', right: '2px' });
  });
  await trigger.blur();
  await trigger.focus();
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

  await page.evaluate(() => {
    document.body.style.minHeight = '1600px';
    window.scrollTo(0, 300);
  });
  const scrolledBounds = await tooltip.boundingBox();
  expect(scrolledBounds).not.toBeNull();
  expect(scrolledBounds!.y).toBeGreaterThanOrEqual(0);
  expect(scrolledBounds!.y + scrolledBounds!.height).toBeLessThanOrEqual(480);
});
