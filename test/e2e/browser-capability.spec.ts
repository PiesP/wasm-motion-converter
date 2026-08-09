// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { expect, test } from '@playwright/test';

test.describe('Browser capability contract', () => {
  test('loads the core UI and reports required API support accurately', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'dropconvert' })).toBeVisible();
    await expect(page.getByTestId('dropzone')).toBeVisible();

    const capabilities = await page.evaluate(() => ({
      hasWebCodecs:
        typeof globalThis.VideoDecoder === 'function' &&
        typeof globalThis.VideoFrame === 'function',
      hasWebAssembly: typeof globalThis.WebAssembly === 'object',
    }));
    const isSupported = capabilities.hasWebCodecs && capabilities.hasWebAssembly;
    const warning = page.getByTestId('environment-warning');

    if (isSupported) {
      await expect(warning).toHaveCount(0);
    } else {
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('Environment Not Supported');
      await expect(warning).toContainText(
        `WebCodecs ${capabilities.hasWebCodecs ? 'Available' : 'Unavailable'}`
      );
      await expect(warning).toContainText(
        `WebAssembly ${capabilities.hasWebAssembly ? 'Available' : 'Unavailable'}`
      );
    }
  });
});
