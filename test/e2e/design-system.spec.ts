// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function readAppTransitionDurationMs(page: Page): Promise<number> {
  return page.locator('[data-testid="app"]').evaluate((element) => {
    const durations = getComputedStyle(element).transitionDuration.split(',');
    return Math.max(
      ...durations.map((duration) => {
        const value = Number.parseFloat(duration);
        return duration.trim().endsWith('ms') ? value : value * 1_000;
      })
    );
  });
}

async function readPulseAnimationName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'animate-pulse';
    document.body.append(probe);
    const animationName = getComputedStyle(probe).animationName;
    probe.remove();
    return animationName;
  });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

interface RenderedTextMetrics {
  ancestorOpacities: number[];
  background: string;
  color: string;
  contrastRatio: number;
  fontSizePx: number;
}

async function readRenderedTextMetrics(locator: Locator): Promise<RenderedTextMetrics> {
  return locator.evaluate((element) => {
    interface Rgba {
      alpha: number;
      blue: number;
      green: number;
      red: number;
    }

    const parseColor = (value: string): Rgba => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!context) throw new Error('2D canvas is unavailable');
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const parts = context.getImageData(0, 0, 1, 1).data;
      return {
        red: parts[0]!,
        green: parts[1]!,
        blue: parts[2]!,
        alpha: parts[3]! / 255,
      };
    };
    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
      if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
      return {
        red:
          (foreground.red * foreground.alpha +
            background.red * background.alpha * (1 - foreground.alpha)) /
          alpha,
        green:
          (foreground.green * foreground.alpha +
            background.green * background.alpha * (1 - foreground.alpha)) /
          alpha,
        blue:
          (foreground.blue * foreground.alpha +
            background.blue * background.alpha * (1 - foreground.alpha)) /
          alpha,
        alpha,
      };
    };
    const luminance = (color: Rgba): number => {
      const channels = [color.red, color.green, color.blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };

    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      ancestors.push(current);
    }
    const ancestorOpacities = ancestors.map((ancestor) =>
      Number.parseFloat(getComputedStyle(ancestor).opacity)
    );
    let background: Rgba = { red: 255, green: 255, blue: 255, alpha: 1 };
    for (const ancestor of ancestors.reverse()) {
      background = composite(parseColor(getComputedStyle(ancestor).backgroundColor), background);
    }
    const style = getComputedStyle(element);
    const foreground = composite(parseColor(style.color), background);
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    const contrastRatio =
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);

    return {
      ancestorOpacities,
      background: `rgba(${background.red}, ${background.green}, ${background.blue}, ${background.alpha})`,
      color: style.color,
      contrastRatio,
      fontSizePx: Number.parseFloat(style.fontSize),
    };
  });
}

async function mountCompactProgressHarness(page: Page, locale: 'ar' | 'en'): Promise<void> {
  await page.evaluate(async (initialLocale) => {
    const harnessPath = '/test/unit/components/rendered-design-harness.tsx';
    const harness = await import(harnessPath);
    harness.mountCompactProgressHarness(initialLocale);
  }, locale);
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

  test('applies the reduced-motion contract to rendered controls and animation utilities', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const normalTransitionMs = await readAppTransitionDurationMs(page);
    expect(normalTransitionMs).toBeGreaterThan(1);
    expect(await readPulseAnimationName(page)).not.toBe('none');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedTransitionMs = await readAppTransitionDurationMs(page);
    expect(reducedTransitionMs).toBeLessThanOrEqual(0.01);
    expect(reducedTransitionMs).toBeLessThan(normalTransitionMs);
    expect(await readPulseAnimationName(page)).toBe('none');
  });

  test('keeps optional video and performance details keyboard-operable at narrow width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(async () => {
      const modulePath = './src/test-helpers';
      const { attachTestHelpers } = await import(modulePath);
      attachTestHelpers();
      await window.__TEST_HELPERS__?.injectFile(
        new File(['synthetic'], 'state-clarity.mp4', { type: 'video/mp4' }),
        {
          width: 1920,
          height: 1080,
          duration: 12,
          codec: 'unknown',
          framerate: 30,
          bitrate: 0,
        }
      );
    });

    const metadata = page.locator('[data-testid="video-metadata"]');
    const metadataSummary = metadata.locator('summary');
    await expect(page.locator('[data-testid="dropzone"]')).toContainText('9 B');
    await expect(metadata).toBeVisible();
    await expect(metadata).not.toHaveAttribute('open');
    expect(await metadataSummary.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await metadataSummary.focus();
    await page.keyboard.press('Enter');
    await expect(metadata).toHaveAttribute('open', '');
    await expect(metadata).toContainText('state-clarity.mp4');
    await expect(metadata.getByText('Unavailable')).toHaveCount(2);
    await expect(metadataSummary).toBeFocused();
    await page.keyboard.press('Space');
    await expect(metadata).not.toHaveAttribute('open');

    const advanced = page.locator('[data-testid="advanced-settings"]');
    const advancedSummary = advanced.locator('summary');
    await expect(advanced).not.toHaveAttribute('open');
    expect(await advancedSummary.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await expect(advancedSummary).toContainText('Off');
    await advancedSummary.focus();
    await page.keyboard.press('Enter');
    await expect(advanced).toHaveAttribute('open', '');

    const off = advanced.locator('input[name="smart-frame-skip"][value="off"]');
    const low = advanced.locator('input[name="smart-frame-skip"][value="low"]');
    await off.focus();
    await page.keyboard.press('ArrowRight');
    await expect(low).toBeChecked();
    await expect(advancedSummary).toContainText('Low');

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps compact ETA and memory text readable in ${colorScheme} mode`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page);
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await mountCompactProgressHarness(page, 'en');

      const harness = page.locator('[data-testid="compact-progress-harness"]');
      const eta = harness.getByText(/^ETA /);
      const memory = harness.getByText(/64 MB \/ 512 MB/);
      await expect(eta).toBeVisible();
      await expect(memory).toBeVisible();

      const [etaMetrics, memoryMetrics] = await Promise.all([
        readRenderedTextMetrics(eta),
        readRenderedTextMetrics(memory),
      ]);
      console.log(
        `compact-progress-${colorScheme} ${JSON.stringify({ eta: etaMetrics, memory: memoryMetrics })}`
      );
      await page.screenshot({
        path: `${process.env.DESIGN_EVIDENCE_DIR ?? 'test-results'}/compact-progress-${colorScheme}.png`,
        fullPage: true,
      });

      for (const metrics of [etaMetrics, memoryMetrics]) {
        expect(metrics.ancestorOpacities.every((opacity) => opacity === 1)).toBe(true);
        expect(metrics.fontSizePx).toBeGreaterThanOrEqual(12);
        expect(metrics.contrastRatio).toBeGreaterThanOrEqual(4.5);
      }
      expect(browserErrors).toEqual([]);
    });
  }

  test('keeps narrow RTL progress usable with reduced motion and forced colors', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({
      colorScheme: 'dark',
      forcedColors: 'active',
      reducedMotion: 'reduce',
    });
    await page.goto('/');
    await mountCompactProgressHarness(page, 'ar');

    const harness = page.locator('[data-testid="compact-progress-harness"]');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(harness.getByText(/الوقت المتبقي/)).toBeVisible();
    await expect(harness.getByText(/64 MB \/ 512 MB/)).toBeVisible();
    await expect(harness.locator('[role="progressbar"]')).toHaveCount(1);
    await expect(harness.getByRole('button')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    const progressTransitionMs = await harness
      .locator('[role="progressbar"] > div')
      .evaluate((element) => {
        const duration = getComputedStyle(element).transitionDuration;
        const value = Number.parseFloat(duration);
        return duration.endsWith('ms') ? value : value * 1_000;
      });
    expect(progressTransitionMs).toBeLessThanOrEqual(0.01);
    await page.screenshot({
      path: `${process.env.DESIGN_EVIDENCE_DIR ?? 'test-results'}/progress-rtl-forced-colors.png`,
      fullPage: true,
    });
  });

  test('keeps progress and status singular while preserving cancellation at each app layout', async ({
    page,
  }) => {
    const browserErrors = collectBrowserErrors(page);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
      await page.goto('/');
      await page.evaluate(async () => {
        const helperPath = './src/test-helpers';
        const storePath = '/src/stores/conversion-store.ts';
        const [{ attachTestHelpers }, store] = await Promise.all([
          import(helperPath),
          import(storePath),
        ]);
        attachTestHelpers();
        await window.__TEST_HELPERS__?.injectFile(
          new File(['synthetic'], 'active-conversion.mp4', { type: 'video/mp4' }),
          {
            width: 1920,
            height: 1080,
            duration: 12,
            codec: 'unknown',
            framerate: 30,
            bitrate: 0,
          }
        );
        store.setConversionProgress(42);
        store.setConversionStatusMessage('Encoding frames');
        store.setAppState('converting');
      });

      const dropzone = page.locator('[data-testid="dropzone"]');
      await expect(dropzone.getByText('Converting...', { exact: true })).toHaveCount(1);
      await expect(dropzone.getByText('42%', { exact: true })).toHaveCount(1);
      await expect(dropzone.locator('[role="progressbar"]')).toHaveCount(1);
      const cancel = page.locator('[data-testid="dropzone-cancel-button"]');
      await expect(cancel).toBeEnabled();
      await expect(cancel).toHaveAttribute('aria-label', 'Cancel conversion');

      await page.evaluate(async () => {
        const storePath = '/src/stores/conversion-store.ts';
        const store = await import(storePath);
        store.setAppState('cancelling');
      });
      await expect(dropzone.getByText('Cancelling...', { exact: true })).toHaveCount(1);
      await expect(cancel).toBeDisabled();
      await expect(cancel).toHaveAttribute('aria-label', 'Cancelling...');
      await page.screenshot({
        path: `${process.env.DESIGN_EVIDENCE_DIR ?? 'test-results'}/progress-${width}-cancelling.png`,
        fullPage: true,
      });
    }
    expect(browserErrors).toEqual([]);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`uses the Panel surface and radius for the result container in ${colorScheme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      const metrics = await page.evaluate(async () => {
        const harnessPath = '/test/unit/components/rendered-design-harness.tsx';
        const harness = await import(harnessPath);
        harness.mountResultPreviewHarness();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const host = document.querySelector('[data-testid="result-preview-harness"]');
        if (!(host instanceof HTMLElement)) throw new Error('Result harness did not render');
        const panel = host.firstElementChild;
        if (!(panel instanceof HTMLElement)) throw new Error('Result Panel did not render');
        const style = getComputedStyle(panel);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          panelRadius: getComputedStyle(document.documentElement)
            .getPropertyValue('--pp-component-panel-radius')
            .trim(),
        };
      });
      console.log(`result-panel-${colorScheme} ${JSON.stringify(metrics)}`);
      await page.screenshot({
        path: `${process.env.DESIGN_EVIDENCE_DIR ?? 'test-results'}/result-panel-${colorScheme}.png`,
        fullPage: true,
      });
      expect(metrics.borderRadius).toBe(metrics.panelRadius);
      expect(metrics.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(metrics.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    });
  }
});
