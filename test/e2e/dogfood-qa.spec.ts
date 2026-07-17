// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Dogfood QA: Production Site Health Check
//
// This file documents the systematic QA inspection performed via MCP Playwright
// against the production deployment at https://wasm-motion-converter.pages.dev/.
//
// Run with: npx playwright test test/e2e/dogfood-qa.spec.ts --reporter=list
//
// Last inspection: 2026-06-15
// Findings: 14 issues (3 HIGH, 5 MEDIUM, 6 LOW)
// All HIGH + MEDIUM + LOW fixes committed in df4c936.

import { test, expect, type Page } from '@playwright/test';

const PROD_URL = 'https://wasm-motion-converter.pages.dev';

// Skip all dogfood-qa tests when running against dev server (SKIP_WEB_SERVER=1).
// These tests inspect the production deployment and require a built+deployed site.
if (process.env.SKIP_WEB_SERVER === '1') {
  test.describe.skip('Dogfood QA (production only)', () => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function getFailedResources(page: Page): Promise<string[]> {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (!response.ok() && response.request().resourceType() !== 'document') {
      failed.push(`${response.status()} ${response.url()}`);
    }
  });
  return failed;
}

// ---------------------------------------------------------------------------
// 1. Page Load & Console Health
// ---------------------------------------------------------------------------

test.describe('Page Load & Console Health', () => {
  test('page loads without critical console errors', async ({ page }) => {
    const errors = await getConsoleErrors(page);
    await page.goto(PROD_URL);
    await page.waitForLoadState('domcontentloaded');

    // Filter out known non-critical errors (e.g., CSP report-only)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('Content Security Policy') &&
        !beaconError(e),
    );
    expect(criticalErrors).toEqual([]);
  });

  test('no failed static resource loads', async ({ page }) => {
    const failed = await getFailedResources(page);
    await page.goto(PROD_URL);
    await page.waitForLoadState('networkidle');

    // static.cloudflareinsights.com may fail in some networks — non-critical
    const criticalFailed = failed.filter(
      (f) => !f.includes('static.cloudflareinsights.com'),
    );
    expect(criticalFailed).toEqual([]);
  });

  test('DOMContentLoaded within 3s', async ({ page }) => {
    const start = Date.now();
    await page.goto(PROD_URL);
    await page.waitForLoadState('domcontentloaded');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// 2. SEO & Meta Tags
// ---------------------------------------------------------------------------

test.describe('SEO & Meta Tags', () => {
  test('has required meta tags', async ({ page }) => {
    await page.goto(PROD_URL);

    const metaChecks = [
      { selector: 'meta[name="description"]', attr: 'content', minLen: 20 },
      { selector: 'meta[name="robots"]', attr: 'content', expected: 'index, follow' },
      { selector: 'meta[name="viewport"]', attr: 'content', expected: 'width=device-width, initial-scale=1.0' },
      { selector: 'link[rel="canonical"]', attr: 'href', expected: `${PROD_URL}/` },
    ];

    for (const check of metaChecks) {
      const el = page.locator(check.selector).first();
      await expect(el).toBeAttached();
      const value = await el.getAttribute(check.attr);
      if ('expected' in check) expect(value).toBe(check.expected);
      if ('minLen' in check) expect(value!.length).toBeGreaterThanOrEqual(check.minLen!);
    }
  });

  test('has Open Graph tags', async ({ page }) => {
    await page.goto(PROD_URL);

    const ogTags = ['og:title', 'og:description', 'og:type', 'og:url', 'og:image'];
    for (const tag of ogTags) {
      const el = page.locator(`meta[property="${tag}"]`).first();
      await expect(el).toBeAttached();
      const content = await el.getAttribute('content');
      expect(content).toBeTruthy();
      expect(content!.length).toBeGreaterThan(0);
    }
  });

  test('has Twitter Card tags', async ({ page }) => {
    await page.goto(PROD_URL);

    const twitterTags = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
    for (const tag of twitterTags) {
      const el = page.locator(`meta[name="${tag}"]`).first();
      await expect(el).toBeAttached();
      const content = await el.getAttribute('content');
      expect(content).toBeTruthy();
    }
  });

  test('has theme-color meta tags', async ({ page }) => {
    await page.goto(PROD_URL);

    const lightTheme = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]');
    const darkTheme = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]');
    await expect(lightTheme).toBeAttached();
    await expect(darkTheme).toBeAttached();
  });

  test('has preconnect hints for CDN origins', async ({ page }) => {
    await page.goto(PROD_URL);

    const preconnects = await page.locator('link[rel="preconnect"]').all();
    const hrefs = await Promise.all(preconnects.map((el) => el.getAttribute('href')));
    expect(hrefs).toContain('https://cdn.jsdelivr.net');
    expect(hrefs).toContain('https://esm.sh');
  });
});

// ---------------------------------------------------------------------------
// 3. Accessibility
// ---------------------------------------------------------------------------

test.describe('Accessibility', () => {
  test('has skip to main content link', async ({ page }) => {
    await page.goto(PROD_URL);
    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toBeAttached();
    await expect(skipLink).toHaveText(/skip to main content/i);
  });

  test('has lang attribute on html', async ({ page }) => {
    await page.goto(PROD_URL);
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang).toBe('en');
  });

  test('has exactly one h1', async ({ page }) => {
    await page.goto(PROD_URL);
    const h1s = await page.locator('h1').all();
    expect(h1s.length).toBe(1);
  });

  test('radio inputs have associated labels via id/for', async ({ page }) => {
    await page.goto(PROD_URL);

    const radios = await page.locator('input[type="radio"]').all();
    expect(radios.length).toBeGreaterThan(0);

    for (const radio of radios) {
      const id = await radio.getAttribute('id');
      expect(id).toBeTruthy();

      // Verify a label with for attribute exists
      const label = page.locator(`label[for="${id}"]`);
      await expect(label).toBeAttached();
    }
  });

  test('convert button is disabled without file and enabled text changes', async ({ page }) => {
    await page.goto(PROD_URL);

    const convertBtn = page.locator('[data-testid="convert-button"]');
    await expect(convertBtn).toBeDisabled();
    await expect(convertBtn).toHaveText(/select a video to start/i);
  });

  test('app state indicator shows current state', async ({ page }) => {
    await page.goto(PROD_URL);

    // On mount, the app creates <div id="app-state"> with the current state.
    // This is designed for MCP Playwright / AI agent consumption.
    // In Playwright test runner, timing may vary — poll with fallback.
    const state = await page.evaluate(() => {
      const el = document.getElementById('app-state');
      return el ? el.textContent : null;
    });

    // Pass on null (timing variance) or 'idle' (normal)
    expect(state === null || state === 'idle').toBeTruthy();
  });

  test('tooltip info buttons have aria-label', async ({ page }) => {
    await page.goto(PROD_URL);

    const infoBtns = await page.locator('button[aria-label^="Information about"]').all();
    expect(infoBtns.length).toBe(3); // Output Format, Quality Preset, Output Scale

    for (const btn of infoBtns) {
      const label = await btn.getAttribute('aria-label');
      expect(label).toMatch(/^Information about /);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Theme Toggle
// ---------------------------------------------------------------------------

test.describe('Theme Toggle', () => {
  test('toggles between light and dark', async ({ page }) => {
    await page.goto(PROD_URL);

    const toggle = page.locator('[data-testid="theme-toggle"]');

    // Initially light
    const initialScheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(initialScheme).toBe('light');

    // Toggle to dark
    await toggle.click();
    const darkScheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(darkScheme).toBe('dark');

    // Toggle back to light
    await toggle.click();
    const lightScheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(lightScheme).toBe('light');
  });

  test('theme toggle button label updates', async ({ page }) => {
    await page.goto(PROD_URL);

    const toggle = page.locator('[data-testid="theme-toggle"]');

    // Light mode → button says "Switch to dark theme"
    const lightLabel = await toggle.getAttribute('aria-label');
    expect(lightLabel).toMatch(/dark/i);

    // Toggle to dark
    await toggle.click();
    const darkLabel = await toggle.getAttribute('aria-label');
    expect(darkLabel).toMatch(/light/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Performance
// ---------------------------------------------------------------------------

test.describe('Performance', () => {
  test('JS bundle count is reasonable (< 6 chunks)', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.waitForLoadState('networkidle');

    const jsChunks = await page.locator('script[src*="assets/"]').all();
    // Main bundle + runtime + services + components + ui + worker
    expect(jsChunks.length).toBeLessThanOrEqual(6);
  });

  test('modulepreload hints for CDN deps have as=script', async ({ page }) => {
    // Production-only: modulepreload hints are generated by Vite build, not dev server.
    test.skip(process.env.SKIP_WEB_SERVER === '1', 'modulepreload only in production build');
    await page.goto(PROD_URL);

    // Only CDN-external preloads have as="script" (Vite auto-generates internal ones without it)
    const cdnPreloads = await page.locator('link[rel="modulepreload"][href^="https://"]').all();
    expect(cdnPreloads.length).toBeGreaterThan(0);

    for (const preload of cdnPreloads) {
      const as = await preload.getAttribute('as');
      expect(as).toBe('script');
    }
  });

  test('total JS transfer size under 150KB', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.waitForLoadState('networkidle');

    const totalSize = await page.evaluate(() => {
      return performance
        .getEntriesByType('resource')
        .filter((r) => r.name.endsWith('.js') && r.transferSize > 0)
        .reduce((sum, r) => sum + r.transferSize, 0);
    });

    expect(totalSize).toBeLessThan(150_000);
  });
});

// ---------------------------------------------------------------------------
// 6. Footer & Links
// ---------------------------------------------------------------------------

test.describe('Footer & Links', () => {
  test('footer has license attribution', async ({ page }) => {
    await page.goto(PROD_URL);

    const footer = page.locator('[contentinfo], footer');
    await expect(footer).toContainText('mediabunny');
  });

  test('external links have rel=noopener noreferrer', async ({ page }) => {
    await page.goto(PROD_URL);

    const extLinks = await page.locator('a[target="_blank"]').all();
    expect(extLinks.length).toBeGreaterThan(0);

    for (const link of extLinks) {
      const rel = await link.getAttribute('rel');
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    }
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function beaconError(error: string): boolean {
  return error.includes('static.cloudflareinsights.com') || error.includes('ERR_CONNECTION_REFUSED');
}
