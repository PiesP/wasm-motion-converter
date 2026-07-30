// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Page } from '@playwright/test';

const LIGHT_THEME = {
  accent: 'rgb(95, 81, 199)',
  canvas: 'rgb(247, 248, 250)',
  onAccent: 'rgb(255, 255, 255)',
  text: 'rgb(21, 24, 29)',
} as const;

const DARK_THEME = {
  accent: 'rgb(174, 162, 255)',
  canvas: 'rgb(11, 14, 19)',
  onAccent: 'rgb(20, 16, 37)',
  text: 'rgb(243, 246, 249)',
} as const;

async function readAccentPair(page: Page): Promise<{ background: string; foreground: string }> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--pp-color-accent)';
    probe.style.color = 'var(--pp-color-on-accent)';
    document.body.append(probe);

    const style = getComputedStyle(probe);
    const pair = {
      background: style.backgroundColor,
      foreground: style.color,
    };
    probe.remove();
    return pair;
  });
}

test.describe('Quiet Instruments adapter', () => {
  test('binds the WMC product scope and preserves system light behavior', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    const root = page.locator('html');
    await expect(root).toHaveClass(/\bpp-design\b/);
    await expect(root).toHaveAttribute('data-pp-product', 'wmc');
    await expect(root).toHaveAttribute('data-pp-theme', 'auto');
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_THEME.canvas);
    await expect(page.locator('body')).toHaveCSS('color', LIGHT_THEME.text);
    await expect.poll(() => readAccentPair(page)).toEqual({
      background: LIGHT_THEME.accent,
      foreground: LIGHT_THEME.onAccent,
    });

    const targetMinimum = await root.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--pp-component-target-minimum').trim()
    );
    expect(targetMinimum).toBe('44px');

    await page.locator('[data-testid="language-selector"]').selectOption('ko');
    await expect(root).toHaveAttribute('lang', 'ko');
  });

  test('follows system dark colors and applies shared icon metrics', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');

    await expect(page.locator('body')).toHaveCSS('background-color', DARK_THEME.canvas);
    await expect(page.locator('body')).toHaveCSS('color', DARK_THEME.text);
    await expect.poll(() => readAccentPair(page)).toEqual({
      background: DARK_THEME.accent,
      foreground: DARK_THEME.onAccent,
    });

    const sharedIcon = page.locator('svg[stroke-width="1.75"]').first();
    await expect(sharedIcon).toBeAttached();
    await expect(sharedIcon).toHaveAttribute('viewBox', '0 0 24 24');
    await expect(sharedIcon).toHaveAttribute('stroke-linecap', 'round');
    await expect(sharedIcon).toHaveAttribute('stroke-linejoin', 'round');

    await page.keyboard.press('Tab');
    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toHaveCSS('background-color', DARK_THEME.accent);
    await expect(skipLink).toHaveCSS('color', DARK_THEME.onAccent);
    await expect(skipLink).toHaveCSS('outline-color', 'rgb(143, 134, 255)');
    await expect(skipLink).toHaveCSS('outline-width', '2px');
  });
});
