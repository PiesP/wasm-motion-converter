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
