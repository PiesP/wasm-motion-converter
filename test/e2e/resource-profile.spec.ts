// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import {
  clickConvert,
  dismissWarningDialog,
  getAppState,
  injectTestFile,
  runConversion,
  setFormat,
  setQuality,
  setScale,
  setSmartFrameSkip,
} from './fixtures/test-helpers';

const STRESS_FIXTURE = 'test-video-ci-high-motion-120fps.mp4';
const MEASURED_CYCLES = 5;

interface ChromiumProcessInfo {
  type: string;
  id: number;
  cpuTime: number;
}

interface ResourceSample {
  timestampMs: number;
  jsHeapMB: number | null;
  pssMB: number;
  rssMB: number;
  cpuTimeSeconds: number;
  processCount: number;
  byType: Record<string, { count: number; pssMB: number; rssMB: number }>;
}

interface ConversionMeasurement {
  elapsedMs: number;
  cpuSeconds: number;
  outputBytes: number;
  peakJsDeltaMB: number | null;
  peakPssDeltaMB: number;
  peakRssDeltaMB: number;
  postGc: ResourceSample;
  postGcUaMemoryMB: number | null;
}

function readKilobytes(text: string, field: string): number {
  const match = text.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm'));
  return match ? Number(match[1]) : 0;
}

async function readProcessMemory(pid: number): Promise<{ pssMB: number; rssMB: number }> {
  try {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    return {
      pssMB: readKilobytes(rollup, 'Pss') / 1024,
      rssMB: readKilobytes(rollup, 'Rss') / 1024,
    };
  } catch {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const rssMB = readKilobytes(status, 'VmRSS') / 1024;
      return { pssMB: rssMB, rssMB };
    } catch {
      return { pssMB: 0, rssMB: 0 };
    }
  }
}

async function sampleResources(page: Page, browserCdp: CDPSession): Promise<ResourceSample> {
  const { processInfo } = (await browserCdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: ChromiumProcessInfo[];
  };
  const processes = await Promise.all(
    processInfo.map(async (process) => ({
      ...process,
      ...(await readProcessMemory(process.id)),
    })),
  );
  const jsHeapMB = await page.evaluate(() => {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }).memory;
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / 1024 / 1024 : null;
  });

  const byType: ResourceSample['byType'] = {};
  for (const process of processes) {
    const current = byType[process.type] ?? { count: 0, pssMB: 0, rssMB: 0 };
    current.count++;
    current.pssMB += process.pssMB;
    current.rssMB += process.rssMB;
    byType[process.type] = current;
  }

  return {
    timestampMs: Date.now(),
    jsHeapMB,
    pssMB: processes.reduce((total, process) => total + process.pssMB, 0),
    rssMB: processes.reduce((total, process) => total + process.rssMB, 0),
    cpuTimeSeconds: processes.reduce((total, process) => total + process.cpuTime, 0),
    processCount: processes.length,
    byType,
  };
}

async function measureUaMemoryMB(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const measure = (
      performance as Performance & {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      }
    ).measureUserAgentSpecificMemory;
    if (!crossOriginIsolated || typeof measure !== 'function') return null;

    try {
      const result = await Promise.race([
        measure.call(performance),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      return result ? result.bytes / 1024 / 1024 : null;
    } catch {
      return null;
    }
  });
}

function peakDelta(
  samples: ResourceSample[],
  field: 'pssMB' | 'rssMB' | 'jsHeapMB',
): number | null {
  const values = samples
    .map((sample) => sample[field])
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return null;
  return Math.max(...values) - values[0]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function theilSenSlope(values: number[]): number {
  const slopes: number[] = [];
  for (let start = 0; start < values.length; start++) {
    for (let end = start + 1; end < values.length; end++) {
      slopes.push((values[end]! - values[start]!) / (end - start));
    }
  }
  return median(slopes);
}

async function runMeasuredConversion(
  page: Page,
  browserCdp: CDPSession,
  format: 'gif' | 'webp',
): Promise<ConversionMeasurement> {
  await injectTestFile(page, STRESS_FIXTURE);
  await setFormat(page, format);
  await setQuality(page, 'high');
  await setScale(page, '100%');
  await setSmartFrameSkip(page, 'adaptive');

  const samples = [await sampleResources(page, browserCdp)];
  const startedAt = performance.now();
  await clickConvert(page);
  await dismissWarningDialog(page);

  let state = await getAppState(page);
  while (state !== 'done' && state !== 'error' && performance.now() - startedAt < 60_000) {
    await page.waitForTimeout(150);
    samples.push(await sampleResources(page, browserCdp));
    state = await getAppState(page);
  }
  samples.push(await sampleResources(page, browserCdp));
  expect(state).toBe('done');
  const elapsedMs = performance.now() - startedAt;

  const output = await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null);
  expect(output?.type).toBe(`image/${format}`);

  await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
  await page.requestGC();
  await page.waitForTimeout(500);
  const postGc = await sampleResources(page, browserCdp);
  const postGcUaMemoryMB = await measureUaMemoryMB(page);

  return {
    elapsedMs,
    cpuSeconds: samples.at(-1)!.cpuTimeSeconds - samples[0]!.cpuTimeSeconds,
    outputBytes: output!.size,
    peakJsDeltaMB: peakDelta(samples, 'jsHeapMB'),
    peakPssDeltaMB: peakDelta(samples, 'pssMB')!,
    peakRssDeltaMB: peakDelta(samples, 'rssMB')!,
    postGc,
    postGcUaMemoryMB,
  };
}

test.describe('opt-in Chromium resource profile', () => {
  test.skip(process.platform !== 'linux', 'Chromium process PSS/RSS sampling requires Linux /proc');

  for (const format of ['gif', 'webp'] as const) {
    test(`${format.toUpperCase()} reaches a post-warm-up resource plateau`, async ({
      browser,
      page,
    }) => {
      test.slow();
      await page.goto('/');
      const browserCdp = await browser.newBrowserCDPSession();
      try {
        const system = (await browserCdp.send('SystemInfo.getInfo')) as {
          gpu?: { devices?: Array<{ deviceString?: string; driverVersion?: string }> };
          modelName?: string;
          commandLine?: string;
        };
        console.info(
          '[resource-environment]',
          JSON.stringify({
            modelName: system.modelName,
            gpuDevices: system.gpu?.devices,
            commandLine: system.commandLine,
          }),
        );

        // Exclude one-time worker, Canvas, and WASM initialization from leak slopes.
        await runMeasuredConversion(page, browserCdp, format);

        const measurements: ConversionMeasurement[] = [];
        for (let cycle = 0; cycle < MEASURED_CYCLES; cycle++) {
          measurements.push(await runMeasuredConversion(page, browserCdp, format));
        }

        for (const measurement of measurements) {
          expect(measurement.elapsedMs).toBeLessThan(30_000);
          expect(measurement.peakPssDeltaMB).toBeLessThan(384);
          expect(measurement.peakRssDeltaMB).toBeLessThan(768);
          if (measurement.peakJsDeltaMB !== null) {
            expect(measurement.peakJsDeltaMB).toBeLessThan(128);
          }
          expect(measurement.postGc.pssMB).toBeGreaterThan(0);
          expect(measurement.postGc.processCount).toBeGreaterThan(0);
        }

        const postGcPssSlope = theilSenSlope(
          measurements.map((measurement) => measurement.postGc.pssMB),
        );
        const postGcJsValues = measurements
          .map((measurement) => measurement.postGc.jsHeapMB)
          .filter((value): value is number => value !== null);
        const postGcJsSlope =
          postGcJsValues.length === MEASURED_CYCLES ? theilSenSlope(postGcJsValues) : null;
        const uaValues = measurements
          .map((measurement) => measurement.postGcUaMemoryMB)
          .filter((value): value is number => value !== null);
        const postGcUaSlope =
          uaValues.length === MEASURED_CYCLES ? theilSenSlope(uaValues) : null;

        console.info(
          '[resource-profile]',
          JSON.stringify({ format, measurements, postGcPssSlope, postGcJsSlope, postGcUaSlope }),
        );

        expect(postGcPssSlope).toBeLessThan(16);
        if (postGcJsSlope !== null) expect(postGcJsSlope).toBeLessThan(8);
        if (postGcUaSlope !== null) expect(postGcUaSlope).toBeLessThan(8);
      } finally {
        await browserCdp.detach();
      }
    });
  }

  test('cancellation becomes idle, quiesces, and permits a new conversion', async ({
    browser,
    page,
  }) => {
    await page.goto('/');
    const browserCdp = await browser.newBrowserCDPSession();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await injectTestFile(page, STRESS_FIXTURE);
      await setFormat(page, 'gif');
      await setQuality(page, 'high');
      await setScale(page, '100%');
      await setSmartFrameSkip(page, 'adaptive');
      await clickConvert(page);
      await dismissWarningDialog(page);

      const stopButton = page.locator('[data-testid="stop-conversion-button"]');
      await expect(stopButton).toBeVisible();
      const cancelledAt = performance.now();
      await stopButton.click();
      await expect
        .poll(() => getAppState(page), { timeout: 5_000, intervals: [25] })
        .toBe('idle');
      const idleLatencyMs = performance.now() - cancelledAt;
      expect(idleLatencyMs).toBeLessThanOrEqual(500);
      expect(await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null)).toBeNull();

      let previous = await sampleResources(page, browserCdp);
      let quietSamples = 0;
      const quietStartedAt = performance.now();
      while (quietSamples < 2 && performance.now() - quietStartedAt < 5_000) {
        await page.waitForTimeout(250);
        const current = await sampleResources(page, browserCdp);
        const cpuDelta = current.cpuTimeSeconds - previous.cpuTimeSeconds;
        const pssDelta = Math.abs(current.pssMB - previous.pssMB);
        quietSamples = cpuDelta <= 0.05 && pssDelta <= 8 ? quietSamples + 1 : 0;
        previous = current;
      }
      const quietLatencyMs = performance.now() - quietStartedAt;
      expect(quietSamples).toBe(2);
      expect(quietLatencyMs).toBeLessThan(5_000);

      await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
      const recovery = await runConversion(page, {
        file: 'test-video-ci-h264.mp4',
        format: 'webp',
        quality: 'low',
        scale: '50%',
        timeoutMs: 60_000,
      });
      expect(recovery).toMatchObject({ state: 'done', error: null });
      expect(pageErrors).toEqual([]);

      console.info('[cancellation-profile]', JSON.stringify({ idleLatencyMs, quietLatencyMs }));
    } finally {
      await browserCdp.detach();
    }
  });
});
