// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import type { ConversionProfileReport } from '@services/conversion-profiler';
import { parseGifDelaysCs } from '../../validation/windows/gif-playback.mjs';
import contractData from '../../validation/windows/output-contract.json' with { type: 'json' };
import {
  compareAnimatedOutputExact,
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

async function configureContract(
  page: Parameters<typeof injectTestFile>[0],
  contract: OutputContractCase
) {
  await injectTestFile(page, contract.fixture.replace(/^public\//, ''));
  await setFormat(page, contract.format);
  await setQuality(page, contract.settings.quality);
  await setScale(
    page,
    contract.settings.scale === '1' ? '100%' : contract.settings.scale === '0.75' ? '75%' : '50%'
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
  if (contract.id.startsWith('integer-vfr-')) {
    expect(await page.evaluate(() => window.__TEST_HELPERS__?.getMetadata()?.framerate)).toBe(60);
  }
  await clickConvert(page);
  await dismissWarningDialog(page);
  const state = await waitForConversionComplete(page, 120_000);
  expect(await getErrorMessage(page)).toBeNull();
  expect(state).toBe('done');
  const output = await downloadResult(page);
  if (contract.format === 'gif') {
    expect(parseGifDelaysCs(output).every((delay) => delay >= 2 && delay <= 200)).toBe(true);
  }
  await test.info().attach(`${contract.id}.${contract.format}`, {
    body: output,
    contentType: contract.format === 'gif' ? 'image/gif' : 'image/webp',
  });
  return output;
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
      if (contract.id === 'cfr-trim-gif') {
        const exact = await compareAnimatedOutputExact(page, output, output, contract.format);
        expect(exact.durationUs).toBeGreaterThan(0);
        expect(exact.loopTransitionChecked).toBe(true);
      }
    });
  }
});

test.describe('fractional pressure cadence through UI routing', () => {
  for (const route of [
    'gif-worker',
    'gif-main',
    'webp-parallel',
    'webp-serial',
    'webp-wasm',
  ] as const) {
    test(`${route} admits fifteen of twenty-one decoded frames under critical pressure`, async ({
      page,
    }) => {
      await page.addInitScript((backend) => {
        if (backend === 'gif-main' || backend === 'webp-serial') {
          Object.defineProperty(globalThis, 'Worker', {
            configurable: true,
            value: class UnavailableWorker {
              constructor() {
                throw new DOMException(
                  'Force the selected main-thread contract',
                  'NotSupportedError'
                );
              }
            },
          });
        }
        if (backend === 'webp-wasm') {
          Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
            configurable: true,
            value: undefined,
          });
        }
      }, route);
      await page.goto('/');
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const format = route.startsWith('gif') ? 'gif' : 'webp';
      const contract = cases.find((entry) => entry.id === `pressure-21fps-${format}`)!;
      const observations = [];
      for (const critical of [false, true]) {
        await page.evaluate((isCritical) => {
          window.__TEST_HELPERS__?.resetApp();
          Object.defineProperty(performance, 'memory', {
            configurable: true,
            value: {
              usedJSHeapSize: 8 * 1024 * 1024,
              totalJSHeapSize: 16 * 1024 * 1024,
              jsHeapSizeLimit: (isCritical ? 16 : 1024) * 1024 * 1024,
            },
          });
        }, critical);
        const activeContract = critical
          ? {
              ...contract,
              expected: {
                ...contract.expected,
                ...contractData.pressureExpectations[format],
              },
            }
          : contract;
        const output = await runContractConversion(page, activeContract);
        await verifyAnimatedOutput(page, output, activeContract, markers);
        const profile = await page.evaluate(() => {
          const helper = window.__TEST_HELPERS__ as unknown as {
            getConversionProfile: () => ConversionProfileReport | null;
          };
          return helper.getConversionProfile();
        });
        const stage = profile?.stages.find((entry) => entry.stage === 'transcoding');
        if (!stage || stage.stage !== 'transcoding') throw new Error('Missing native counts');
        expect(stage.decodedFrames).toBe(21);
        expect(stage.selectedFrames).toBe(critical ? 15 : format === 'gif' ? 20 : 21);
        expect(profile?.encoderRoute).toBe(
          route === 'webp-parallel'
            ? 'webp-parallel-canvas'
            : route === 'webp-serial'
              ? 'webp-serial-canvas'
              : route
        );
        observations.push({ critical, profile });
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      }
      await page.evaluate(() => {
        window.__TEST_HELPERS__?.resetApp();
        Object.defineProperty(performance, 'memory', {
          configurable: true,
          value: {
            usedJSHeapSize: 8 * 1024 * 1024,
            totalJSHeapSize: 16 * 1024 * 1024,
            jsHeapSizeLimit: 1024 * 1024 * 1024,
          },
        });
      });
      const integerVfr = cases.find((entry) => entry.id === `integer-vfr-${format}`)!;
      const vfrOutput = await runContractConversion(page, integerVfr);
      await verifyAnimatedOutput(page, vfrOutput, integerVfr, markers);
      const vfrProfile = await page.evaluate(() => {
        const helper = window.__TEST_HELPERS__ as unknown as {
          getConversionProfile: () => ConversionProfileReport | null;
        };
        return helper.getConversionProfile();
      });
      const vfrStage = vfrProfile?.stages.find((entry) => entry.stage === 'transcoding');
      if (!vfrStage || vfrStage.stage !== 'transcoding')
        throw new Error('Missing VFR admission counts');
      expect(vfrStage.decodedFrames).toBe(3);
      expect(vfrStage.selectedFrames).toBe(3);
      await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
      await injectTestFile(page, 'test-video-ci-high-motion-120fps.mp4');
      await setFormat(page, format);
      await setQuality(page, 'high');
      await setScale(page, '100%');
      await setSmartFrameSkip(page, 'off');
      await page.evaluate(() => {
        const samples: Array<{
          atMs: number;
          percent: number;
          current: number;
          total: number;
          phase: string;
          fps: number | null;
        }> = [];
        const capture = () => {
          const diagnostics = document.querySelector('[data-testid="progress-diagnostics"]');
          const text = diagnostics?.textContent ?? '';
          const count = /Frame (\d+)\/(\d+)/.exec(text);
          const rate = /@ ([\d.]+) fps/.exec(text);
          const phase = /— (\w+)/.exec(text)?.[1] ?? 'unknown';
          const percent = Number(
            document.querySelector('[role="progressbar"]')?.getAttribute('data-progress')
          );
          if (!count || !Number.isFinite(percent)) return;
          const current = Number(count[1]);
          if (samples.at(-1)?.current === current && samples.at(-1)?.phase === phase) return;
          if (samples.length >= 128) throw new Error('Progress observer overflow');
          samples.push({
            atMs: performance.now(),
            percent,
            current,
            total: Number(count[2]),
            phase,
            fps: rate ? Number(rate[1]) : null,
          });
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.body, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        (globalThis as unknown as { __wmcProgressObservation: unknown }).__wmcProgressObservation =
          { samples, observer };
      });
      await clickConvert(page);
      await dismissWarningDialog(page);
      expect(await waitForConversionComplete(page, 120_000)).toBe('done');
      const progressObservation = await page.evaluate(() => {
        const inspector = (
          globalThis as unknown as {
            __wmcProgressObservation: {
              samples: Array<{
                atMs: number;
                percent: number;
                current: number;
                total: number;
                phase: string;
                fps: number | null;
              }>;
              observer: MutationObserver;
            };
          }
        ).__wmcProgressObservation;
        inspector.observer.disconnect();
        return inspector.samples;
      });
      const longProfile = await page.evaluate(() =>
        (
          window.__TEST_HELPERS__ as unknown as {
            getConversionProfile: () => ConversionProfileReport | null;
          }
        ).getConversionProfile()
      );
      const longStage = longProfile?.stages.find((entry) => entry.stage === 'transcoding');
      if (!longStage || longStage.stage !== 'transcoding')
        throw new Error('Missing native long-stream counts');
      expect(longStage.decodedFrames).toBe(360);
      const intermediate = progressObservation.filter(
        (sample) => sample.current > 1 && sample.current < 360 && sample.percent < 100
      );
      expect(intermediate.length).toBeGreaterThan(0);
      expect(
        intermediate.some(
          (sample) => sample.fps !== null && Number.isFinite(sample.fps) && sample.fps > 0
        )
      ).toBe(true);
      expect(
        progressObservation.every(
          (sample, index) =>
            index === 0 ||
            (sample.percent >= progressObservation[index - 1]!.percent &&
              (sample.phase !== progressObservation[index - 1]!.phase ||
                sample.current >= progressObservation[index - 1]!.current))
        )
      ).toBe(true);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      await test.info().attach(`${route}-admission.json`, {
        body: JSON.stringify(
          { timeOrigin, observations, vfrProfile, longProfile, progressObservation },
          null,
          2
        ),
        contentType: 'application/json',
      });
    });
  }
});

test.describe('Canvas pixel-copy fallback', () => {
  test('uses direct VideoFrame drawing for identity-sized frames and preserves output', async ({
    page,
  }) => {
    const contract = cases.find((candidate) => candidate.id === 'cfr-trim-gif');
    if (!contract) throw new Error('Missing cfr-trim-gif output contract');
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, '__wmcWorkerConstructionAttempts', {
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(globalThis, '__wmcIdentitySizedVideoFrameDraws', {
        configurable: true,
        value: 0,
        writable: true,
      });
      class UnavailableWorker {
        constructor() {
          globalThis.__wmcWorkerConstructionAttempts++;
          throw new DOMException('Force main-thread conversion', 'NotSupportedError');
        }
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: UnavailableWorker,
        writable: true,
      });

      Object.defineProperty(VideoFrame.prototype, 'copyTo', {
        configurable: true,
        value: function () {
          return Promise.reject(
            new DOMException('Force Canvas pixel copying', 'NotSupportedError')
          );
        },
      });

      const contextPrototype = OffscreenCanvasRenderingContext2D.prototype;
      const originalDrawImage = contextPrototype.drawImage;
      Object.defineProperty(contextPrototype, 'drawImage', {
        configurable: true,
        value: function (this: OffscreenCanvasRenderingContext2D, ...args: unknown[]) {
          const [source, ...coordinates] = args;
          if (
            source instanceof VideoFrame &&
            coordinates.length === 2 &&
            coordinates[0] === 0 &&
            coordinates[1] === 0 &&
            source.displayWidth === this.canvas.width &&
            source.displayHeight === this.canvas.height
          ) {
            globalThis.__wmcIdentitySizedVideoFrameDraws++;
          }
          return Reflect.apply(originalDrawImage, this, args);
        },
      });
    });
    await page.goto('/');
    test.skip(
      !(await isVideoFixtureCodecSupported(page, contract.fixture.replace(/^public\//, ''))),
      `Browser explicitly rejected the ${contract.id} input codec configuration`
    );

    const output = await runContractConversion(page, contract);
    const pathProbe = await page.evaluate(() => {
      const helpers = window.__TEST_HELPERS__ as unknown as {
        getConversionProfile: () => {
          copyPathCounts: Record<string, number>;
        } | null;
      };
      const profile = helpers.getConversionProfile();
      return {
        workerConstructionAttempts: globalThis.__wmcWorkerConstructionAttempts,
        identitySizedVideoFrameDraws: globalThis.__wmcIdentitySizedVideoFrameDraws,
        canvasCopyFrames: profile?.copyPathCounts.canvas ?? 0,
      };
    });
    const observation = await verifyAnimatedOutput(page, output, contract, markers);

    expect(observation.frameCount).toBe(contract.expected.markers.length);
    expect(pathProbe.workerConstructionAttempts).toBeGreaterThan(0);
    expect(pathProbe.identitySizedVideoFrameDraws).toBeGreaterThan(0);
    expect(pathProbe.identitySizedVideoFrameDraws).toBe(pathProbe.canvasCopyFrames);
  });
});

test.describe('conversion Worker fallback boundary', () => {
  const contract = cases.find((candidate) => candidate.id === 'cfr-trim-gif');
  if (!contract) throw new Error('Missing cfr-trim-gif output contract');
  const webpContract = cases.find((candidate) => candidate.id === 'vfr-par-webp');
  if (!webpContract) throw new Error('Missing vfr-par-webp output contract');
  const bootstrapCases = [
    {
      contract,
      warning: 'worker.fallback',
      encoder: 'GIF',
      route: 'gif-main',
      disableNativeWebp: false,
    },
    {
      contract: webpContract,
      warning: 'worker-create-failed',
      encoder: 'serial Canvas WebP',
      route: 'webp-serial-canvas',
      disableNativeWebp: false,
    },
    {
      contract: webpContract,
      warning: null,
      encoder: 'WASM WebP',
      route: 'webp-wasm',
      disableNativeWebp: true,
    },
  ];

  for (const bootstrapCase of bootstrapCases) {
    test(`${bootstrapCase.contract.id} preserves output with ${bootstrapCase.encoder} fallback`, async ({
      page,
    }) => {
      const fallbackContract = bootstrapCase.contract;
      await page.addInitScript((disableNativeWebp) => {
        // Keep Canvas pixel-copy support while forcing the existing WASM encoder branch.
        if (disableNativeWebp) {
          Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
            configurable: true,
            value: undefined,
          });
        }
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
      }, bootstrapCase.disableNativeWebp);
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      await page.goto('/');

      const output = await runContractConversion(page, fallbackContract);
      const attempts = await page.evaluate(() => globalThis.__wmcWorkerConstructionAttempts);
      if (bootstrapCase.disableNativeWebp) {
        // A rejected native capability probe selects WASM before creating a pool.
        expect(attempts).toBe(0);
      } else {
        expect(attempts).toBeGreaterThan(0);
      }
      if (bootstrapCase.warning) {
        expect(warnings.some((message) => message.includes(bootstrapCase.warning!))).toBe(true);
      }
      const route = await page.evaluate(() => {
        const helpers = window.__TEST_HELPERS__ as unknown as
          | {
              getConversionProfile: () => ConversionProfileReport | null;
            }
          | undefined;
        return helpers?.getConversionProfile()?.encoderRoute ?? null;
      });
      expect(route).toBe(bootstrapCase.route);
      if (bootstrapCase.disableNativeWebp) {
        expect(await page.evaluate(() => typeof OffscreenCanvas.prototype.convertToBlob)).toBe(
          'undefined'
        );
      }
      await verifyAnimatedOutput(page, output, fallbackContract, markers);
    });
  }

  for (const failure of ['runtime', 'decoder'] as const) {
    test(`recovers with a new conversion after a post-start ${failure} failure`, async ({
      page,
    }) => {
      await page.addInitScript((failureKind) => {
        const NativeWorker = globalThis.Worker;
        let injectedFailure = false;
        class RuntimeFailingWorker {
          readonly inner: Worker;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: ErrorEvent) => void) | null = null;
          private injected = false;
          private requestId = '';

          constructor(url: string | URL, options?: WorkerOptions) {
            this.inner = new NativeWorker(url, options);
            this.inner.onmessage = (event) => {
              this.onmessage?.(event);
              const data = event.data as { type?: string; message?: string } | null;
              if (
                !injectedFailure &&
                !this.injected &&
                data?.type === 'log' &&
                data.message === 'Worker initialized'
              ) {
                this.injected = true;
                injectedFailure = true;
                this.inner.terminate();
                queueMicrotask(() => {
                  if (failureKind === 'decoder') {
                    this.onmessage?.(
                      new MessageEvent('message', {
                        data: {
                          type: 'error',
                          requestId: this.requestId,
                          message: 'Forced decoder failure',
                          code: 'DECODER_ERROR',
                        },
                      })
                    );
                  } else {
                    this.onerror?.(
                      new ErrorEvent('error', { message: 'Forced post-start Worker failure' })
                    );
                  }
                });
              }
            };
            this.inner.onerror = (event) => this.onerror?.(event);
          }

          postMessage(message: unknown, transfer?: Transferable[]): void {
            const request = message as { requestId?: string };
            if (request.requestId) this.requestId = request.requestId;
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
      }, failure);
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      await page.goto('/');
      const documentIdentity = await page.evaluate(() => performance.timeOrigin);
      await configureContract(page, contract);
      await clickConvert(page);
      await dismissWarningDialog(page);

      expect(await waitForConversionComplete(page, 30_000)).toBe('error');
      expect(warnings.some((message) => message.includes('worker.fallback'))).toBe(false);
      expect(
        await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null)
      ).toBeNull();
      await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
      const recoveredOutput = await runContractConversion(page, contract);
      await verifyAnimatedOutput(page, recoveredOutput, contract, markers);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentIdentity);
      expect(
        await page.evaluate(() => {
          const helpers = window.__TEST_HELPERS__ as unknown as
            | {
                getConversionProfile: () => ConversionProfileReport | null;
              }
            | undefined;
          return helpers?.getConversionProfile()?.encoderRoute ?? null;
        })
      ).toBe('gif-worker');
      expect(warnings.some((message) => message.includes('worker.fallback'))).toBe(false);
    });
  }
});

declare global {
  // Test-only probe installed before application startup.
  var __wmcWorkerConstructionAttempts: number;
  var __wmcIdentitySizedVideoFrameDraws: number;
}
