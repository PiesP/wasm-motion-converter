// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Dogfood QA: Production Site Health Check
//
// This file documents the systematic QA inspection performed via MCP Playwright
// against the production deployment at https://wasm-motion-converter.pages.dev/.
//
// Run with: pnpm exec playwright test test/e2e/dogfood-qa.spec.ts --reporter=list
//
// Last inspection: 2026-07-29

import { test, expect, type Page } from '@playwright/test';
import { isCloudflareInsightsResource } from './fixtures/url-utils';

const SITE_URL = 'https://wasm-motion-converter.pages.dev';
const DEPLOY_URL = process.env.DEPLOY_URL || SITE_URL;

// Skip all dogfood-qa tests when running against dev server (SKIP_WEB_SERVER=1).
// These tests inspect the production deployment and require a built+deployed site.
test.beforeEach(() => {
  test.skip(process.env.SKIP_WEB_SERVER === '1', 'Dogfood QA requires the production deployment');
});

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
    await page.goto(DEPLOY_URL);
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
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    // static.cloudflareinsights.com may fail in some networks — non-critical
    const criticalFailed = failed.filter(
      (f) => !isCloudflareInsightsResource(f),
    );
    expect(criticalFailed).toEqual([]);
  });

  test('DOMContentLoaded within 3s', async ({ page }) => {
    const start = Date.now();
    await page.goto(DEPLOY_URL);
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
    await page.goto(DEPLOY_URL);

    const metaChecks = [
      { selector: 'meta[name="description"]', attr: 'content', minLen: 20 },
      { selector: 'meta[name="robots"]', attr: 'content', expected: 'index, follow' },
      { selector: 'meta[name="viewport"]', attr: 'content', expected: 'width=device-width, initial-scale=1.0' },
      { selector: 'link[rel="canonical"]', attr: 'href', expected: `${SITE_URL}/` },
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
    await page.goto(DEPLOY_URL);

    const ogTags = ['og:title', 'og:description', 'og:type', 'og:url'];
    for (const tag of ogTags) {
      const el = page.locator(`meta[property="${tag}"]`).first();
      await expect(el).toBeAttached();
      const content = await el.getAttribute('content');
      expect(content).toBeTruthy();
      expect(content!.length).toBeGreaterThan(0);
    }
  });

  test('has Twitter Card tags', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    const twitterTags = ['twitter:card', 'twitter:title', 'twitter:description'];
    for (const tag of twitterTags) {
      const el = page.locator(`meta[name="${tag}"]`).first();
      await expect(el).toBeAttached();
      const content = await el.getAttribute('content');
      expect(content).toBeTruthy();
    }
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary');
  });

  test('has theme-color meta tags', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    const lightTheme = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]');
    const darkTheme = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]');
    await expect(lightTheme).toHaveAttribute('content', '#f7f8fa');
    await expect(darkTheme).toHaveAttribute('content', '#0b0e13');
  });

  test('does not preconnect to external code CDNs', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    const preconnects = await page.locator('link[rel="preconnect"]').all();
    const hrefs = await Promise.all(preconnects.map((el) => el.getAttribute('href')));
    expect(hrefs).not.toContain('https://cdn.jsdelivr.net');
    expect(hrefs).not.toContain('https://esm.sh');
  });
});

// ---------------------------------------------------------------------------
// 3. Accessibility
// ---------------------------------------------------------------------------

test.describe('Accessibility', () => {
  test('has skip to main content link', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toBeAttached();
    await expect(skipLink).toHaveText(/skip to main content/i);
  });

  test('has lang attribute on html', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang).toBe('en');
  });

  test('has exactly one h1', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    const h1s = await page.locator('h1').all();
    expect(h1s.length).toBe(1);
  });

  test('radio inputs have associated labels via id/for', async ({ page }) => {
    await page.goto(DEPLOY_URL);

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
    await page.goto(DEPLOY_URL);

    const convertBtn = page.locator('[data-testid="convert-button"]');
    await expect(convertBtn).toBeDisabled();
    await expect(convertBtn).toHaveText(/select a video to start/i);
  });

  test('app state indicator shows current state', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    await expect(page.locator('#app-state')).toHaveText('Select a video to start conversion');
  });

  test('tooltip info buttons have aria-label', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    const infoBtns = page.locator('button[aria-label^="Information about"]');
    await expect(infoBtns).toHaveCount(4);
    const labels = await infoBtns.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label'))
    );
    expect(labels).toEqual([
      'Information about Output Format',
      'Information about Quality Preset',
      'Information about Smart Frame Skip',
      'Information about Output Scale',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. System Theme
// ---------------------------------------------------------------------------

test.describe('System Theme', () => {
  test('follows light and dark system preferences', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(DEPLOY_URL);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 248, 250)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(21, 24, 29)');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 14, 19)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(243, 246, 249)');
  });
});

// ---------------------------------------------------------------------------
// 5. Performance
// ---------------------------------------------------------------------------

test.describe('Performance', () => {
  test('JS bundle count is reasonable (< 6 chunks)', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    const jsChunks = await page.locator('script[src*="assets/"]').all();
    // Main bundle + runtime + services + components + ui + worker
    expect(jsChunks.length).toBeLessThanOrEqual(6);
  });

  test('modulepreload hints stay on the deployment origin', async ({ page }) => {
    // Production-only: modulepreload hints are generated by Vite build, not dev server.
    test.skip(process.env.SKIP_WEB_SERVER === '1', 'modulepreload only in production build');
    await page.goto(DEPLOY_URL);

    const modulePreloads = await page.locator('link[rel="modulepreload"]').all();
    expect(modulePreloads.length).toBeGreaterThan(0);
    const deploymentOrigin = new URL(DEPLOY_URL).origin;

    for (const preload of modulePreloads) {
      const href = await preload.getAttribute('href');
      expect(href).not.toBeNull();
      expect(new URL(href!, DEPLOY_URL).origin).toBe(deploymentOrigin);
    }
  });

  test('total JS transfer size under 150KB', async ({ page }) => {
    await page.goto(DEPLOY_URL);
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
    await page.goto(DEPLOY_URL);

    const footer = page.getByRole('contentinfo');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText('mediabunny');
  });

  test('external links have rel=noopener noreferrer', async ({ page }) => {
    await page.goto(DEPLOY_URL);

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
  return isCloudflareInsightsResource(error) || error.includes('ERR_CONNECTION_REFUSED');
}
