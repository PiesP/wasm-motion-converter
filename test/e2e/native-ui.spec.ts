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

