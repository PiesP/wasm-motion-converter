// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import contractData from '../../validation/windows/output-contract.json' with { type: 'json' };
import {
  type OutputContractCase,
  verifyAnimatedOutput,
} from '../../validation/windows/output-contract.mjs';
import {
  clickConvert,
  dismissWarningDialog,
  downloadResult,
  getErrorMessage,
  injectTestFile,
  isVideoFixtureCodecSupported,
  setFormat,
  setQuality,
  setScale,
  setSmartFrameSkip,
  waitForConversionComplete,
} from './fixtures/test-helpers';

const cases = contractData.cases as OutputContractCase[];
const markers = contractData.markers as Record<string, number[]>;

async function configureContract(page: Parameters<typeof injectTestFile>[0], contract: OutputContractCase) {
  await injectTestFile(page, contract.fixture.replace(/^public\//, ''));
  await setFormat(page, contract.format);
  await setQuality(page, contract.settings.quality);
  await setScale(
    page,
    contract.settings.scale === '1'
      ? '100%'
      : contract.settings.scale === '0.75'
        ? '75%'
        : '50%'
  );
  await setSmartFrameSkip(page, contract.settings.smartFrameSkip);

  if (contract.settings.trimStart > 0 || contract.settings.trimEnd > 0) {
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill(String(contract.settings.trimStart));
    await start.press('Enter');
    await end.fill(String(contract.settings.trimEnd));
    await end.press('Enter');
  }
}

async function runContractConversion(
  page: Parameters<typeof injectTestFile>[0],
  contract: OutputContractCase
) {
  await configureContract(page, contract);
  await clickConvert(page);
  await dismissWarningDialog(page);
  const state = await waitForConversionComplete(page, 120_000);
  expect(await getErrorMessage(page)).toBeNull();
  expect(state).toBe('done');
  return downloadResult(page);
}

test.describe('deterministic output contracts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  for (const contract of cases) {
    test(`${contract.id} preserves geometry, marker order, and timing`, async ({ page }) => {
      test.skip(
        !(await isVideoFixtureCodecSupported(page, contract.fixture.replace(/^public\//, ''))),
        `Browser explicitly rejected the ${contract.id} input codec configuration`
      );
      if (contract.sourceRotationClockwise !== undefined) {
        const rotation = await page.evaluate(async (fixture) => {
          const response = await fetch(`/${fixture.replace(/^public\//, '')}`);
          if (!response.ok) throw new Error(`Unable to load rotation fixture: ${response.status}`);
          const modulePath = '/src/utils/mediabunny-utils.ts';
          const { createMediaBunnyInput } = await import(modulePath);
          const input = createMediaBunnyInput(await response.blob());
          try {
            const [track] = await input.getVideoTracks();
            if (!track) throw new Error('Rotation fixture has no video track');
            return track.getRotation();
          } finally {
            input.dispose();
          }
        }, contract.fixture);
        expect(rotation).toBe(contract.sourceRotationClockwise);
      }
      const output = await runContractConversion(page, contract);
      const observation = await verifyAnimatedOutput(page, output, contract, markers);
      expect(observation.frameCount).toBe(contract.expected.markers.length);
    });
  }
});

test.describe('conversion Worker fallback boundary', () => {
  const contract = cases.find((candidate) => candidate.id === 'cfr-trim-gif');
  if (!contract) throw new Error('Missing cfr-trim-gif output contract');
  const webpContract = cases.find((candidate) => candidate.id === 'vfr-par-webp');
  if (!webpContract) throw new Error('Missing vfr-par-webp output contract');
  const bootstrapCases = [
    { contract, warning: 'worker.fallback' },
    { contract: webpContract, warning: 'worker-create-failed' },
  ];

  for (const bootstrapCase of bootstrapCases) {
    test(`${bootstrapCase.contract.id} falls back when Worker construction fails`, async ({ page }) => {
      const fallbackContract = bootstrapCase.contract;
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, '__wmcWorkerConstructionAttempts', {
          configurable: true,
          value: 0,
          writable: true,
        });
        class UnavailableWorker {
          constructor() {
            globalThis.__wmcWorkerConstructionAttempts++;
            throw new DOMException('Forced Worker bootstrap failure', 'NotSupportedError');
          }
        }
        Object.defineProperty(globalThis, 'Worker', {
          configurable: true,
          value: UnavailableWorker,
          writable: true,
        });
      });
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      await page.goto('/');

      const output = await runContractConversion(page, fallbackContract);
      expect(
        await page.evaluate(() => globalThis.__wmcWorkerConstructionAttempts)
      ).toBeGreaterThan(0);
      expect(warnings.some((message) => message.includes(bootstrapCase.warning))).toBe(true);
      await verifyAnimatedOutput(page, output, fallbackContract, markers);
    });
  }

  test('does not retry on the main thread after Worker initialization', async ({ page }) => {
    await page.addInitScript(() => {
      const NativeWorker = globalThis.Worker;
      class RuntimeFailingWorker {
        readonly inner: Worker;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        private injected = false;

        constructor(url: string | URL, options?: WorkerOptions) {
          this.inner = new NativeWorker(url, options);
          this.inner.onmessage = (event) => {
            this.onmessage?.(event);
            const data = event.data as { type?: string; message?: string } | null;
            if (!this.injected && data?.type === 'log' && data.message === 'Worker initialized') {
              this.injected = true;
              this.inner.terminate();
              queueMicrotask(() =>
                this.onerror?.(
                  new ErrorEvent('error', { message: 'Forced post-start Worker failure' })
                )
              );
            }
          };
          this.inner.onerror = (event) => this.onerror?.(event);
        }

        postMessage(message: unknown, transfer?: Transferable[]): void {
          this.inner.postMessage(message, transfer ?? []);
        }

        terminate(): void {
          this.inner.terminate();
        }
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: RuntimeFailingWorker,
        writable: true,
      });
    });
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.goto('/');
    await configureContract(page, contract);
    await clickConvert(page);
    await dismissWarningDialog(page);

    expect(await waitForConversionComplete(page, 30_000)).toBe('error');
    expect(warnings.some((message) => message.includes('worker.fallback'))).toBe(false);
  });
});

declare global {
  // Test-only probe installed before application startup.
  var __wmcWorkerConstructionAttempts: number;
}
