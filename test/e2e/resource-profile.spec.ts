// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { MAX_FRAME_PIXEL_COUNT } from '@utils/constants';
import type {
  ConversionProfileReport,
  ProfileOperationTotals,
} from '@services/conversion-profiler';
import contractData from '../../validation/windows/output-contract.json' with { type: 'json' };
import {
  assertAnimatedOutput,
  inspectAnimatedOutput,
  type OutputContractCase,
} from '../../validation/windows/output-contract.mjs';

import {
  readLinuxProcessMemory,
  summarizeProcessMemory,
  type ProcessMemorySummary,
} from './fixtures/process-memory';
import { captureSamplesDuringOperation } from './fixtures/resource-sampling';
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
const HOSTILE_PAR_FIXTURE = 'test-video-resource-hostile-par.webm';
const MEASURED_CYCLES = 5;
const FAST_SAMPLE_INTERVAL_MS = 20;
const CONVERSION_SAMPLE_INTERVAL_MS = 150;
const profileContract = (contractData.cases as OutputContractCase[]).find(
  (contract) => contract.id === 'motion-cadence-gif',
);
if (!profileContract) throw new Error('Missing motion-cadence-gif output contract');

interface ConversionWorkload {
  id: string;
  fixture: string;
  format: 'gif' | 'webp';
  settings: OutputContractCase['settings'];
  contract?: OutputContractCase;
}

const workloads: ConversionWorkload[] = [
  ...(['gif', 'webp'] as const).map((format) => ({
    id: `high-motion-${format}`,
    fixture: STRESS_FIXTURE,
    format,
    settings: {
      quality: 'high' as const,
      scale: '1' as const,
      trimStart: 0,
      trimEnd: 0,
      smartFrameSkip: 'adaptive' as const,
    },
  })),
  {
    id: profileContract.id,
    fixture: profileContract.fixture.replace(/^public\//, ''),
    format: profileContract.format,
    settings: profileContract.settings,
    contract: profileContract,
  },
];

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
  cpuProcesses: ChromiumProcessInfo[];
  processCount: number;
  pssProcessCount: number;
  rssProcessCount: number;
  samplingAttempts: number;
  memorySources: ProcessMemorySummary['sources'];
  byType: ProcessMemorySummary['byType'];
}

interface ConversionMeasurement {
  elapsedMs: number;
  transcodingWallMs: number | null;
  profileOperationTotals: ProfileOperationTotals | null;
  profileCopyPathCounts: Record<string, number> | null;
  cpuSeconds: number | null;
  cpuProcessSetStable: boolean;
  samples: ResourceSample[];
  outputBytes: number;
  outputSha256: string;
  peakJsDeltaMB: number | null;
  peakPssDeltaMB: number;
  peakRssDeltaMB: number;
  postGc: ResourceSample;
  postGcUaMemoryMB: number | null;
}

interface RejectedInputMeasurement {
  elapsedMs: number;
  error: string;
  peakPssDeltaMB: number;
  peakRssDeltaMB: number;
  sampleCount: number;
  postGc: ResourceSample;
}

async function readChromiumProcesses(browserCdp: CDPSession) {
  const { processInfo } = (await browserCdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: ChromiumProcessInfo[];
  };

  return Promise.all(
    processInfo.map(async (process) => ({
      ...process,
      memory: await readLinuxProcessMemory(process.id),
    })),
  );
}

function samplingEvidence(summary: ProcessMemorySummary) {
  return {
    processCount: summary.processCount,
    pssProcessCount: summary.pssProcessCount,
    rssProcessCount: summary.rssProcessCount,
    sources: summary.sources,
    byType: summary.byType,
    missing: summary.missing,
  };
}

async function sampleResources(page: Page, browserCdp: CDPSession): Promise<ResourceSample> {
  let processes = await readChromiumProcesses(browserCdp);
  const initialSummary = summarizeProcessMemory(processes);
  let summary = initialSummary;
  let samplingAttempts = 1;

  if (summary.pssMB === null || summary.rssMB === null) {
    // A process can exit between the CDP snapshot and /proc reads. Replace the
    // entire snapshot once so an exited PID is not mixed into a partial aggregate.
    processes = await readChromiumProcesses(browserCdp);
    summary = summarizeProcessMemory(processes);
    samplingAttempts++;
  }

  if (summary.pssMB === null || summary.rssMB === null) {
    const evidence = {
      reason: summary.processCount === 0 ? 'no Chromium processes' : 'incomplete PSS/RSS',
      samplingAttempts,
      initial: samplingEvidence(initialSummary),
      final: samplingEvidence(summary),
    };
    console.error('[resource-sampling-failure]', JSON.stringify(evidence));
    throw new Error(`Chromium process-memory sample unavailable: ${JSON.stringify(evidence)}`);
  }

  const jsHeapMB = await page.evaluate(() => {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }).memory;
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / 1024 / 1024 : null;
  });

  return {
    timestampMs: Date.now(),
    jsHeapMB,
    pssMB: summary.pssMB,
    rssMB: summary.rssMB,
    cpuTimeSeconds: processes.reduce((total, process) => total + process.cpuTime, 0),
    cpuProcesses: processes.map(({ id, type, cpuTime }) => ({ id, type, cpuTime })),
    processCount: summary.processCount,
    pssProcessCount: summary.pssProcessCount,
    rssProcessCount: summary.rssProcessCount,
    samplingAttempts,
    memorySources: summary.sources,
    byType: summary.byType,
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

async function captureFastResourceSamples<T>(
  page: Page,
  browserCdp: CDPSession,
  operation: () => Promise<T>,
): Promise<{ result: T; samples: ResourceSample[] }> {
  return captureSamplesDuringOperation({
    sample: () => sampleResources(page, browserCdp),
    waitForInterval: () => page.waitForTimeout(FAST_SAMPLE_INTERVAL_MS),
    operation,
  });
}

async function runMeasuredConversion(
  page: Page,
  browserCdp: CDPSession,
  workload: ConversionWorkload,
): Promise<{ measurement: ConversionMeasurement; encodedOutput: Buffer }> {
  await injectTestFile(page, workload.fixture);
  await setFormat(page, workload.format);
  await setQuality(page, workload.settings.quality);
  await setScale(page, '100%');
  await setSmartFrameSkip(page, workload.settings.smartFrameSkip);
  if (workload.settings.trimStart > 0 || workload.settings.trimEnd > 0) {
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill(String(workload.settings.trimStart));
    await start.press('Enter');
    await end.fill(String(workload.settings.trimEnd));
    await end.press('Enter');
  }
  expect(await page.evaluate(() => window.__TEST_HELPERS__?.getSettings())).toMatchObject({
    format: workload.format,
    ...workload.settings,
    scale: Number(workload.settings.scale),
  });

  const samples = [await sampleResources(page, browserCdp)];
  const startedAt = performance.now();
  await clickConvert(page);
  await dismissWarningDialog(page);

  let state = await getAppState(page);
  while (state !== 'done' && state !== 'error' && performance.now() - startedAt < 60_000) {
    await page.waitForTimeout(CONVERSION_SAMPLE_INTERVAL_MS);
    samples.push(await sampleResources(page, browserCdp));
    state = await getAppState(page);
  }
  samples.push(await sampleResources(page, browserCdp));
  expect(state).toBe('done');
  const elapsedMs = performance.now() - startedAt;
  const profile = (await page.evaluate(
    () => (window as any).__TEST_HELPERS__?.getConversionProfile() ?? null,
  )) as ConversionProfileReport | null;
  expect(profile).not.toBeNull();
  expect(
    Object.values(profile!.copyPathCounts).reduce((sum, count) => sum + count, 0),
  ).toBe(profile!.operationTotals.pixelCopy.samples);
  const transcodingWallMs =
    profile?.stages.find((stage) => stage.stage === 'transcoding')?.durationMs ?? null;

  const output = await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null);
  expect(output?.type).toBe(`image/${workload.format}`);

  // Retain the exact measured output outside the conversion interval. Decode only
  // after every cycle so the correctness observer cannot warm later conversions.
  const encodedOutput = Buffer.from(
    await page.getByTestId('result-image').evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error('Output image is unavailable');
      return [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())];
    }),
  );
  expect(encodedOutput.byteLength).toBe(output!.size);
  const outputSha256 = createHash('sha256').update(encodedOutput).digest('hex');
  const initialProcessIds = samples[0]!.cpuProcesses.map(({ id }) => id).sort().join(',');
  const cpuProcessSetStable = samples.every(
    (sample) => sample.cpuProcesses.map(({ id }) => id).sort().join(',') === initialProcessIds,
  );

  await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
  await page.requestGC();
  await page.waitForTimeout(500);
  const postGc = await sampleResources(page, browserCdp);
  const postGcUaMemoryMB = await measureUaMemoryMB(page);

  return {
    encodedOutput,
    measurement: {
      elapsedMs,
      transcodingWallMs,
      profileOperationTotals: profile?.operationTotals ?? null,
      profileCopyPathCounts: profile?.copyPathCounts ?? null,
      cpuSeconds: cpuProcessSetStable
        ? samples.at(-1)!.cpuTimeSeconds - samples[0]!.cpuTimeSeconds
        : null,
      cpuProcessSetStable,
      samples,
      outputBytes: output!.size,
      outputSha256,
      peakJsDeltaMB: peakDelta(samples, 'jsHeapMB'),
      peakPssDeltaMB: peakDelta(samples, 'pssMB')!,
      peakRssDeltaMB: peakDelta(samples, 'rssMB')!,
      postGc,
      postGcUaMemoryMB,
    },
  };
}

async function runMeasuredHostileParRejection(
  page: Page,
  browserCdp: CDPSession,
): Promise<RejectedInputMeasurement> {
  await injectTestFile(page, HOSTILE_PAR_FIXTURE);
  await setFormat(page, 'gif');
  await setQuality(page, 'high');
  await setScale(page, '100%');

  const metadata = await page.evaluate(() => window.__TEST_HELPERS__?.getMetadata() ?? null);
  expect(metadata?.config).toMatchObject({
    codedWidth: 520,
    codedHeight: 520,
    displayAspectWidth: 52_000,
    displayAspectHeight: 520,
  });
  expect(
    (metadata?.config?.displayAspectWidth ?? 0) *
      (metadata?.config?.displayAspectHeight ?? 0),
  ).toBeGreaterThan(MAX_FRAME_PIXEL_COUNT);

  const startedAt = performance.now();
  const { result: error, samples } = await captureFastResourceSamples(
    page,
    browserCdp,
    async () => {
      await clickConvert(page);
      await dismissWarningDialog(page);
      await expect
        .poll(() => getAppState(page), { timeout: 5_000, intervals: [10, 25, 50] })
        .toBe('error');
      return page.evaluate(() => window.__TEST_HELPERS__?.getError() ?? '');
    },
  );
  const elapsedMs = performance.now() - startedAt;

  expect(error).toBe('Unable to determine video dimensions');
  expect(await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null)).toBeNull();

  await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
  await page.requestGC();
  await page.waitForTimeout(500);
  const postGc = await sampleResources(page, browserCdp);

  return {
    elapsedMs,
    error,
    peakPssDeltaMB: peakDelta(samples, 'pssMB')!,
    peakRssDeltaMB: peakDelta(samples, 'rssMB')!,
    sampleCount: samples.length,
    postGc,
  };
}

test.describe('opt-in Chromium resource profile', () => {
  test.skip(process.platform !== 'linux', 'Chromium process PSS/RSS sampling requires Linux /proc');

  for (const workload of workloads) {
    test(`${workload.id} reaches a post-warm-up resource plateau`, async ({
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
        await runMeasuredConversion(page, browserCdp, workload);

        const measurements: ConversionMeasurement[] = [];
        const outputs: Buffer[] = [];
        for (let cycle = 0; cycle < MEASURED_CYCLES; cycle++) {
          const { measurement, encodedOutput } = await runMeasuredConversion(page, browserCdp, workload);
          measurements.push(measurement);
          outputs.push(encodedOutput);
          await test.info().attach(`${workload.id}-cycle-${cycle + 1}.${workload.format}`, {
            body: encodedOutput,
            contentType: `image/${workload.format}`,
          });
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

        const observations = [];
        const correctnessFailures: string[] = [];
        for (const [cycle, output] of outputs.entries()) {
          const observation = await inspectAnimatedOutput(
            page, output, workload.format, contractData.markers,
          );
          observations.push(observation);
          if (workload.contract) {
            try {
              assertAnimatedOutput(observation, workload.contract);
            } catch (error) {
              correctnessFailures.push(`cycle ${cycle + 1}: ${String(error)}`);
            }
          }
        }
        const evidence = {
          id: workload.id,
          format: workload.format,
          fixture: workload.fixture,
          inputSha256: createHash('sha256')
            .update(readFileSync(resolve('public', workload.fixture))).digest('hex'),
          settings: workload.settings,
          measurementScope: {
            elapsed: 'UI conversion request through observed done, including resource sampling',
            cpu: 'Chromium process CPU delta; unavailable when a sampled process set changes',
            memory: 'Observed sampled peak delta, not an absolute peak',
            sampleIntervalMs: CONVERSION_SAMPLE_INTERVAL_MS,
            correctness: 'Encoded outputs decoded after all measured cycles and post-GC samples',
          },
          measurements, postGcPssSlope, postGcJsSlope, postGcUaSlope,
          observations,
          correctness: {
            status: workload.contract
              ? correctnessFailures.length === 0 ? 'passed' : 'failed'
              : 'observed-without-frame-oracle',
            contract: workload.contract ?? null,
            failures: correctnessFailures,
          },
        };
        await test.info().attach(`${workload.id}-evidence.json`, {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json',
        });
        console.info(
          '[resource-profile]',
          JSON.stringify(evidence),
        );

        for (const measurement of measurements) {
          expect(measurement.elapsedMs).toBeLessThan(30_000);
          expect(Number.isFinite(measurement.cpuSeconds)).toBe(true);
          expect(measurement.cpuSeconds).toBeGreaterThanOrEqual(0);
          expect(measurement.peakPssDeltaMB).toBeLessThan(384);
          expect(measurement.peakRssDeltaMB).toBeLessThan(768);
          if (measurement.peakJsDeltaMB !== null) {
            expect(measurement.peakJsDeltaMB).toBeLessThan(128);
          }
          expect(measurement.postGc.pssMB).toBeGreaterThan(0);
          expect(measurement.postGc.processCount).toBeGreaterThan(0);
        }
        expect(new Set(measurements.map((measurement) => measurement.outputSha256)).size).toBe(1);


        expect(correctnessFailures).toEqual([]);
        expect(measurements.every((measurement) => measurement.cpuProcessSetStable)).toBe(true);
        expect(postGcPssSlope).toBeLessThan(16);
        if (postGcJsSlope !== null) expect(postGcJsSlope).toBeLessThan(8);
        if (postGcUaSlope !== null) expect(postGcUaSlope).toBeLessThan(8);
      } finally {
        await browserCdp.detach();
      }
    });
  }

  test('hostile pixel-aspect metadata is rejected without a large native allocation', async ({
    browser,
    page,
  }) => {
    test.slow();
    await page.goto('/');
    const browserCdp = await browser.newBrowserCDPSession();
    const workerFallbackLogs: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('worker.fallback')) workerFallbackLogs.push(message.text());
    });

    try {
      // Exclude one-time application and MediaBunny initialization from leak slopes.
      await runMeasuredHostileParRejection(page, browserCdp);

      const measurements: RejectedInputMeasurement[] = [];
      for (let cycle = 0; cycle < MEASURED_CYCLES; cycle++) {
        measurements.push(await runMeasuredHostileParRejection(page, browserCdp));
      }

      for (const measurement of measurements) {
        expect(measurement.elapsedMs).toBeLessThan(5_000);
        expect(measurement.peakPssDeltaMB).toBeLessThan(128);
        expect(measurement.peakRssDeltaMB).toBeLessThan(256);
        expect(measurement.sampleCount).toBeGreaterThanOrEqual(2);
        expect(measurement.postGc.pssMB).toBeGreaterThan(0);
        expect(measurement.postGc.processCount).toBeGreaterThan(0);
      }

      const postGcPssSlope = theilSenSlope(
        measurements.map((measurement) => measurement.postGc.pssMB),
      );
      const postGcRssSlope = theilSenSlope(
        measurements.map((measurement) => measurement.postGc.rssMB),
      );

      console.info(
        '[hostile-par-profile]',
        JSON.stringify({
          fixture: HOSTILE_PAR_FIXTURE,
          maxFramePixels: MAX_FRAME_PIXEL_COUNT,
          measurements,
          postGcPssSlope,
          postGcRssSlope,
        }),
      );

      expect(postGcPssSlope).toBeLessThan(16);
      expect(postGcRssSlope).toBeLessThan(16);
      expect(workerFallbackLogs).toEqual([]);
    } finally {
      await browserCdp.detach();
    }
  });

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
