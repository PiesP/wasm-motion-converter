// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('landing page has no automated WCAG A/AA violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="app"]')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(results.violations).toEqual([]);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
});

test('loaded trim editor has no automated WCAG A/AA violations', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { attachTestHelpers } = await import('./src/test-helpers');
    attachTestHelpers();
    await window.__TEST_HELPERS__?.injectFile(
      new File(['synthetic'], 'trim-a11y.mp4', { type: 'video/mp4' }),
      {
        width: 1920,
        height: 1080,
        duration: 9.8,
        codec: 'avc1.42E01E',
        framerate: 15,
        bitrate: 4_000_000,
      }
    );
  });
  await expect(page.locator('[data-testid="input-range-editor"]')).toBeVisible();
  // The selected-file card fades in over 300ms; audit its stable visual state.
  await page.waitForTimeout(400);

  const results = await new AxeBuilder({ page })
    .include('[data-testid="input-range-editor"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});
