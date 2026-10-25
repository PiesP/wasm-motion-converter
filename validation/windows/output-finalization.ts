// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { Browser, Page } from '@playwright/test';

const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;

export const OUTPUT_FINALIZATION_SCENARIO = 'output-finalization';
export const OUTPUT_FINALIZATION_V2_SCENARIO = 'output-finalization-v2';
export const OUTPUT_FINALIZATION_FIXTURE =
  'validation/windows/inputs/output-finalization-motion.mp4';
export const OUTPUT_FINALIZATION_V2_FIXTURE =
  'validation/windows/inputs/output-finalization-noisy-1024x576.mp4';

type Workload = {
  id: 'small' | 'large';
  path: string;
  inputSha256: string;
  quality: 'low' | 'high';
  scale: '0.5' | '1';
  outputWidth?: number;
  outputHeight?: number;
};
type BlobEvent = {
  kind: 'construct' | 'read' | 'url';
  size: number;
  startMs: number;
  endMs: number;
};
type Observer = {
  clickMs: number | null;
  events: BlobEvent[];
  reset: () => void;
};

type WebpRoute = 'webp-parallel-canvas' | 'webp-serial-canvas' | 'webp-wasm';

export function classifyWebpRoute(line: string): WebpRoute | null {
  if (line.includes('Branch: WebP encoder (parallel Worker pool + OffscreenCanvas)'))
    return 'webp-parallel-canvas';
  if (line.includes('Branch: WebP encoder (OffscreenCanvas convertToBlob + mux)'))
    return 'webp-serial-canvas';
  if (line.includes('Branch: WebP encoder (streaming encodeRGB + mux)')) return 'webp-wasm';
  return null;
}

function observeProductLogs(page: Page) {
  const observation = {
    routes: [] as WebpRoute[],
    criticalSkipWarnings: 0,
    reset() {
      this.routes = [];
      this.criticalSkipWarnings = 0;
    },
  };
  page.on('console', (message) => {
    const line = message.text();
    const route = classifyWebpRoute(line);
    if (route) observation.routes.push(route);
    if (
      message.type() === 'warning' &&
      line.includes('Critical memory pressure, dynamic frame skip')
    )
      observation.criticalSkipWarnings++;
  });
  return observation;
}

/** Installed before the built app; exported so the native File boundary can be tested directly. */
export function installOutputFinalizationObserver() {
  const observer: Observer = {
    clickMs: null,
    events: [],
    reset() {
      this.clickMs = null;
      this.events = [];
    },
  };
  Reflect.set(globalThis, '__wmcOutputFinalizationObserver', observer);
  const NativeBlob = Blob;
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, parts, newTarget) {
      const startMs = performance.now();
      const blob = Reflect.construct(target, parts, newTarget) as Blob;
      if (blob.type === 'image/webp')
        observer.events.push({
          kind: 'construct',
          size: blob.size,
          startMs,
          endMs: performance.now(),
        });
      return blob;
    },
  });
  const nativeArrayBuffer = NativeBlob.prototype.arrayBuffer;
  NativeBlob.prototype.arrayBuffer = function () {
    if (this.type !== 'image/webp') return nativeArrayBuffer.call(this);
    const startMs = performance.now();
    const promise = nativeArrayBuffer.call(this);
    // Return the native promise unchanged so consumers retain its timing and identity.
    void promise.then(
      () =>
        observer.events.push({
          kind: 'read',
          size: this.size,
          startMs,
          endMs: performance.now(),
        }),
      () =>
        observer.events.push({ kind: 'read', size: this.size, startMs, endMs: performance.now() })
    );
    return promise;
  };
  const nativeCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource) {
    const startMs = performance.now();
    const url = nativeCreateObjectURL.call(URL, object);
    if (object instanceof NativeBlob && object.type === 'image/webp')
      observer.events.push({ kind: 'url', size: object.size, startMs, endMs: performance.now() });
    return url;
  };
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="convert-button"]'))
        observer.clickMs = performance.now();
    },
    true
  );
  return observer;
}

async function installObserver(page: Page) {
  await page.addInitScript(installOutputFinalizationObserver);
}

async function choose(page: Page, group: string, value: string) {
  const option = page.locator(`[data-testid="option-${group}-${value}"]`);
  if (!(await option.isVisible()))
    await page.locator('[data-testid="advanced-settings"] summary').click();
  await option.click();
  assert.equal(await option.locator('input').isChecked(), true);
}

async function heapPoint(page: Page) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      return await session.send('Runtime.getHeapUsage');
    } finally {
      await session.detach();
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

async function downloadIdentity(page: Page) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const stream = await (await pending).createReadStream();
  assert(stream, 'Download stream unavailable');
  const hash = createHash('sha256');
  let bytes = 0;
  let header = Buffer.alloc(0);
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    assert(bytes <= MAX_OUTPUT_BYTES, 'Output exceeds the unchanged 96 MiB limit');
    hash.update(part);
    if (header.length < 12) header = Buffer.concat([header, part.subarray(0, 12 - header.length)]);
  }
  assert(bytes > 12 && header.toString('ascii', 0, 4) === 'RIFF');
  assert.equal(header.toString('ascii', 8, 12), 'WEBP');
  assert.equal(header.readUInt32LE(4) + 8, bytes);
  return { bytes, sha256: hash.digest('hex'), mime: 'image/webp' };
}

async function inspectOutput(page: Page, href: string, workload: Workload) {
  return page.evaluate(
    async ({ url, id, expectedWidth, expectedHeight }) => {
      if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder unavailable');
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error('Retained Blob stream unavailable');
      if (response.headers.get('content-type') !== 'image/webp')
        throw new Error('Retained output has the wrong MIME type');
      const decoder = new ImageDecoder({
        data: response.body,
        type: 'image/webp',
        preferAnimation: true,
      });
      try {
        await decoder.completed;
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1 || track.frameCount > 240)
          throw new Error('Output exceeds the 240-frame decoder bound');
        const frameHashes: string[] = [];
        const durationsUs: number[] = [];
        let dimensions: { width: number; height: number } | undefined;
        let totalPixels = 0;
        let firstFrameOpaque = false;
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
          const image = decoded.image;
          try {
            if (
              !decoded.complete ||
              image.displayWidth !== expectedWidth ||
              image.displayHeight !== expectedHeight
            )
              throw new Error(`Invalid output frame ${frameIndex}`);
            dimensions ??= { width: image.displayWidth, height: image.displayHeight };
            if (
              image.displayWidth !== dimensions.width ||
              image.displayHeight !== dimensions.height
            )
              throw new Error('Large output frame dimensions changed');
            totalPixels += image.displayWidth * image.displayHeight;
            if (totalPixels > 240 * 1280 * 720) throw new Error('Decoded pixel budget exceeded');
            const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('No 2D decode context');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            if (frameIndex === 0) {
              firstFrameOpaque = true;
              for (let offset = 3; offset < pixels.length; offset += 4) {
                if (pixels[offset] !== 255) {
                  firstFrameOpaque = false;
                  break;
                }
              }
              if (!firstFrameOpaque) throw new Error('Loop start is not fully opaque');
            }
            const digest = await crypto.subtle.digest('SHA-256', pixels);
            frameHashes.push(
              Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
                ''
              )
            );
            durationsUs.push(image.duration ?? 0);
          } finally {
            image.close();
          }
        }
        const totalDurationUs = durationsUs.reduce((sum, duration) => sum + duration, 0);
        const expectedDurationUs = id === 'large' ? 12_000_000 : 1_000_000;
        if (Math.abs(totalDurationUs - expectedDurationUs) > (id === 'large' ? 500_000 : 150_000))
          throw new Error(`Unexpected output duration ${totalDurationUs}`);
        return {
          mime: response.headers.get('content-type'),
          dimensions,
          frameCount: track.frameCount,
          repetitionCount: Number.isFinite(track.repetitionCount)
            ? track.repetitionCount
            : 'infinite',
          firstFrameOpaque,
          totalDurationUs,
          durationsUs,
          frameHashes,
        };
      } finally {
        decoder.close();
      }
    },
    {
      url: href,
      id: workload.id,
      expectedWidth: workload.outputWidth ?? (workload.id === 'large' ? 1280 : 80),
      expectedHeight: workload.outputHeight ?? (workload.id === 'large' ? 720 : 45),
    }
  );
}

async function measure(
  page: Page,
  productLogs: ReturnType<typeof observeProductLogs>,
  workload: Workload,
  condition: 'cold' | 'warm',
  index: number
) {
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__wmcOutputFinalizationObserver') as Observer).reset()
  );
  productLogs.reset();
  const heapBefore = await heapPoint(page);
  const started = Date.now();
  await page.locator('[data-testid="convert-button"]').click();
  const prompt = page.locator('[data-testid="modal-confirm-button"]');
  if (await prompt.isVisible()) await prompt.click();
  await page.waitForFunction(
    () => {
      const probe = Reflect.get(globalThis, '__wmcOutputFinalizationObserver') as Observer;
      return (
        probe.events.some((event) => event.kind === 'url') &&
        document.querySelector('[data-testid="result-section"]')?.getClientRects().length
      );
    },
    undefined,
    { timeout: CONVERSION_TIMEOUT_MS }
  );
  assert.equal(await page.locator('[data-testid="error-display"]').isVisible(), false);
  const observations = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__wmcOutputFinalizationObserver') as Observer;
    return {
      clickMs: probe.clickMs,
      events: [...probe.events],
      timeOrigin: performance.timeOrigin,
    };
  });
  const heapAfter = await heapPoint(page);
  const output = await downloadIdentity(page);
  const href = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
  if (!href?.startsWith('blob:')) throw new Error('WebP result has no retained Blob URL');
  const outputEvents = observations.events.filter((event) => event.size === output.bytes);
  const created = outputEvents.find((event) => event.kind === 'construct');
  const published = outputEvents.findLast((event) => event.kind === 'url');
  assert(created && published && observations.clickMs !== null, 'Missing output observer boundary');
  const fullReads = outputEvents.filter((event) => event.kind === 'read');
  const decoded = await inspectOutput(page, href, workload);
  const result = {
    workload: workload.id,
    condition,
    index,
    started,
    timeOrigin: observations.timeOrigin,
    inputSha256: workload.inputSha256,
    settings: {
      format: 'webp',
      quality: workload.quality,
      scale: workload.scale,
      smartFrameSkip: 'off',
    },
    output,
    clickToBlobUrlMs: published.endMs - observations.clickMs,
    blobConstructToUrlMs: published.endMs - created.startMs,
    fullReadCount: fullReads.length,
    fullReadBytes: fullReads.reduce((sum, event) => sum + event.size, 0),
    fullReadElapsedMs: fullReads.map((event) => event.endMs - event.startMs),
    events: observations.events,
    productRoute: productLogs.routes.length === 1 ? productLogs.routes[0] : null,
    productRouteObservations: [...productLogs.routes],
    criticalPressureSkipWarnings: productLogs.criticalSkipWarnings,
    terminalFrameCounter: null,
    terminalCounterObserved: false,
    terminalFrameCounterReason: 'compact-progress-does-not-render-frame-count',
    sourceFrameGap: null,
    skipObservationLimitation: 'sustained-info-suppressed-in-production',
    rendererHeapBefore: heapBefore,
    rendererHeapAfter: heapAfter,
    workerMemory: null,
    nativeGpuMemory: null,
    decoded,
  };
  if (workload.id === 'small') assert(output.bytes < 1024 * 1024, 'Small output exceeded 1 MiB');
  return result;
}

export async function exerciseOutputFinalization(
  browser: Browser,
  url: string,
  workloads: [Workload, Workload],
  onSample: (sample: Awaited<ReturnType<typeof measure>>) => Promise<void>
) {
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  const retained = new Map<
    string,
    {
      page: Page;
      logs: ReturnType<typeof observeProductLogs>;
      close: () => Promise<void>;
      timeOrigin: number;
    }
  >();
  try {
    for (let index = 0; index < 3; index++) {
      const ordered = index === 1 ? [...workloads].reverse() : workloads;
      for (const workload of ordered) {
        const context = await browser.newContext({
          acceptDownloads: true,
          locale: 'en-US',
          serviceWorkers: 'block',
        });
        const page = await context.newPage();
        const logs = observeProductLogs(page);
        try {
          await installObserver(page);
          const response = await page.goto(url);
          assert(response?.ok(), 'Production application failed to load');
          assert(
            await page.evaluate(() => crossOriginIsolated),
            'Production document is not isolated'
          );
          await page.locator('[data-testid="file-input"]').setInputFiles(workload.path);
          await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
          await choose(page, 'format', 'webp');
          await choose(page, 'quality', workload.quality);
          await choose(page, 'scale', workload.scale);
          await choose(page, 'smart-frame-skip', 'off');
          const sample = await measure(page, logs, workload, 'cold', index);
          samples.push(sample);
          await onSample(sample);
          if (index === 2)
            retained.set(workload.id, {
              page,
              logs,
              close: () => context.close(),
              timeOrigin: await page.evaluate(() => performance.timeOrigin),
            });
          else await context.close();
        } catch (error) {
          await context.close();
          throw error;
        }
      }
    }
    for (let index = 0; index < 3; index++) {
      const ordered = index === 1 ? [...workloads].reverse() : workloads;
      for (const workload of ordered) {
        const previous = retained.get(workload.id);
        assert(previous);
        const sample = await measure(previous.page, previous.logs, workload, 'warm', index);
        samples.push(sample);
        await onSample(sample);
        assert.equal(
          await previous.page.evaluate(() => performance.timeOrigin),
          previous.timeOrigin
        );
      }
    }
    const largeSamples = samples.filter((sample) => sample.workload === 'large');
    const qualification = {
      largeOutputAtLeast8MiB: largeSamples.every(
        (sample) => sample.output.bytes >= 8 * 1024 * 1024
      ),
      routeObserved: samples.every((sample) => sample.productRoute !== null),
    };
    return {
      scenario: OUTPUT_FINALIZATION_SCENARIO,
      status: Object.values(qualification).every(Boolean) ? 'passed' : 'incomplete',
      browserVersion: browser.version(),
      qualification,
      samples,
    };
  } finally {
    for (const entry of retained.values()) await entry.close();
  }
}
