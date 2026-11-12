// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

export const MOTION_SIGNATURE_SCENARIO = 'motion-signature';
export const MOTION_SIGNATURE_OVERHEAD_SCENARIO = 'motion-signature-overhead';
export const MOTION_PRIMARY_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
export const MOTION_SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';

const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;

type Workload = {
  id: 'primary-enabled' | 'small-enabled' | 'primary-off';
  fixture: string;
  inputSha256: string;
  width: number;
  height: number;
  smartFrameSkip: 'low' | 'off';
};

type WorkerEvent = {
  url: string;
  starts: { requestId: string; options: Record<string, unknown> }[];
  completes: { requestId: string; outputBytes: number }[];
  errors: { requestId: string; code: string }[];
};

type MotionObserver = {
  clickMs: number | null;
  outputUrls: { size: number; type: string; atMs: number }[];
  workers: WorkerEvent[];
  reset: () => void;
};

/** Installed before the application; keeps all measurement events in one page clock. */
function installMotionObserver() {
  const observed: MotionObserver = {
    clickMs: null,
    outputUrls: [],
    workers: [],
    reset() {
      this.clickMs = null;
      this.outputUrls = [];
    },
  };
  Reflect.set(globalThis, '__wmcMotionObserver', observed);

  const NativeWorker = Worker;
  globalThis.Worker = class ObservedWorker extends NativeWorker {
    private readonly entry: WorkerEvent | null;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);
      const url = new URL(String(scriptURL), location.href);
      this.entry = /^\/assets\/worker-[\w-]+\.js$/.test(url.pathname)
        ? { url: url.href, starts: [], completes: [], errors: [] }
        : null;
      if (this.entry) observed.workers.push(this.entry);
      this.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
        if (!this.entry || !data || typeof data !== 'object' || !('type' in data)) return;
        if (
          data.type === 'complete' &&
          'outputBuffer' in data &&
          data.outputBuffer instanceof ArrayBuffer
        ) {
          this.entry.completes.push({
            requestId: 'requestId' in data ? String(data.requestId) : '',
            outputBytes: data.outputBuffer.byteLength,
          });
        } else if (data.type === 'error') {
          this.entry.errors.push({
            requestId: 'requestId' in data ? String(data.requestId) : '',
            code: 'code' in data ? String(data.code) : '',
          });
        }
      });
    }

    override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if (
        this.entry &&
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'start' &&
        'options' in message &&
        message.options &&
        typeof message.options === 'object'
      ) {
        this.entry.starts.push({
          requestId: 'requestId' in message ? String(message.requestId) : '',
          options: { ...message.options },
        });
      }
      if (Array.isArray(options)) return super.postMessage(message, options);
      return super.postMessage(message, options);
    }
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource) {
    const url = createObjectURL.call(URL, object);
    if (object instanceof Blob && object.type === 'image/gif') {
      observed.outputUrls.push({ size: object.size, type: object.type, atMs: performance.now() });
    }
    return url;
  };
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="convert-button"]')
      ) {
        observed.clickMs = performance.now();
      }
    },
    true
  );
}

async function choose(page: Page, group: string, value: string) {
  const option = page.locator(`[data-testid="option-${group}-${value}"]`);
  if (!(await option.isVisible()))
    await page.locator('[data-testid="advanced-settings"] summary').click();
  await option.click();
  assert.equal(await option.locator('input').isChecked(), true);
}

async function downloadIdentity(page: Page) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const stream = await (await pending).createReadStream();
  assert(stream, 'Saved GIF stream is unavailable');
  let bytes = 0;
  let header = Buffer.alloc(0);
  const hash = createHash('sha256');
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    assert(bytes <= MAX_OUTPUT_BYTES, 'Saved GIF exceeded the unchanged 96 MiB limit');
    hash.update(part);
    parts.push(part);
    if (header.length < 6) header = Buffer.concat([header, part.subarray(0, 6 - header.length)]);
  }
  assert(bytes > 13 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii')));
  return { bytes, sha256: hash.digest('hex'), data: Buffer.concat(parts) };
}

/** Independent browser decode, after the latency interval has ended. */
async function inspectGif(page: Page, data: Buffer, workload: Workload) {
  return page.evaluate(
    async ({ encoded, width, height }) => {
      if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder unavailable');
      const decoder = new ImageDecoder({
        data: new Uint8Array(encoded),
        type: 'image/gif',
        preferAnimation: true,
      });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1 || track.frameCount > 400)
          throw new Error('Unexpected GIF frame count');
        const frames: { durationUs: number; pixelSha256: string }[] = [];
        for (let index = 0; index < track.frameCount; index++) {
          const frame = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
          const image = frame.image;
          try {
            if (!frame.complete || image.displayWidth !== width || image.displayHeight !== height)
              throw new Error(`GIF frame ${index} was incomplete or had wrong dimensions`);
            const pixels = new Uint8Array(width * height * 4);
            await image.copyTo(pixels, { format: 'RGBA' });
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
            frames.push({
              durationUs: image.duration ?? 0,
              pixelSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
                ''
              ),
            });
          } finally {
            image.close();
          }
        }
        const durationUs = frames.reduce((total, frame) => total + frame.durationUs, 0);
        if (Math.abs(durationUs - (width === 320 ? 3_000_000 : 1_000_000)) > 250_000)
          throw new Error(`Unexpected GIF duration ${durationUs}`);
        return {
          frameCount: track.frameCount,
          repetitionCount: track.repetitionCount,
          durationUs,
          frames,
        };
      } finally {
        decoder.close();
      }
    },
    { encoded: [...data], width: workload.width, height: workload.height }
  );
}

async function measure(
  page: Page,
  workload: Workload,
  condition: 'cold-first-use' | 'fresh-context' | 'warm',
  index: number,
  instrumentation: 'enabled' | 'disabled'
) {
  const before = await page.evaluate(() => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    observer.reset();
    return { workerCount: observer.workers.length, timeOrigin: performance.timeOrigin };
  });
  const wallStart = new Date().toISOString();
  await page.locator('[data-testid="convert-button"]').click();
  const prompt = page.locator('[data-testid="modal-confirm-button"]');
  if (await prompt.isVisible()) await prompt.click();
  await page.waitForFunction(
    () => {
      const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
      return (
        observer.outputUrls.length > 0 &&
        document.querySelector('[data-testid="result-section"]')?.getClientRects().length
      );
    },
    undefined,
    { timeout: CONVERSION_TIMEOUT_MS }
  );
  assert.equal(await page.locator('[data-testid="error-display"]').isVisible(), false);
  const observation = await page.evaluate((workerCount) => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    return {
      clickMs: observer.clickMs,
      outputUrls: [...observer.outputUrls],
      workers: observer.workers.slice(workerCount),
      timeOrigin: performance.timeOrigin,
      profile: Reflect.get(globalThis, '__wmcMotionProfile') as Record<string, unknown> | undefined,
      dimensions: Reflect.get(globalThis, '__wmcMotionDimensions') as
        | { width: number; height: number; stride: number }[]
        | undefined,
    };
  }, before.workerCount);
  assert.equal(observation.timeOrigin, before.timeOrigin, 'Document changed during conversion');
  assert(observation.clickMs !== null, 'Request click was not observed');
  assert.equal(observation.workers.length, 1, 'A new conversion Worker was not created');
  const worker = observation.workers[0]!;
  assert.equal(worker.starts.length, 1, 'Worker did not receive exactly one start');
  assert.equal(worker.completes.length, 1, 'Worker did not complete exactly once');
  assert.deepEqual(worker.errors, [], 'Worker reported a failure');
  assert.deepEqual(
    {
      format: worker.starts[0]?.options.format,
      quality: worker.starts[0]?.options.quality,
      scale: worker.starts[0]?.options.scale,
      smartFrameSkip: worker.starts[0]?.options.smartFrameSkip,
    },
    { format: 'gif', quality: 'high', scale: 1, smartFrameSkip: workload.smartFrameSkip }
  );
  if (instrumentation === 'enabled') {
    assert(observation.profile, 'Measured production build omitted the motion profile');
    assert(observation.dimensions, 'Measured production build omitted motion dimensions');
  } else {
    assert.equal(
      observation.profile,
      undefined,
      'Overhead control unexpectedly enabled motion profiling'
    );
    assert.equal(
      observation.dimensions,
      undefined,
      'Overhead control unexpectedly recorded dimensions'
    );
  }
  const operations = observation.profile?.operationTotals as
    | Record<string, { wallMs: number; samples: number }>
    | undefined;
  if (instrumentation === 'enabled') {
    assert(operations, 'Motion operation totals missing');
    const signature = operations.motionSignature;
    const comparison = operations.motionComparison;
    assert(signature && comparison, 'Separated signature/comparison timings missing');
    assert.equal(
      signature.samples,
      observation.dimensions?.length,
      'Signature call count mismatch'
    );
    assert(
      observation.dimensions?.every(
        (entry) =>
          entry.width === workload.width &&
          entry.height === workload.height &&
          (entry.stride === 3 || entry.stride === 4)
      ),
      'Unexpected motion signature dimensions or stride'
    );
    if (workload.smartFrameSkip === 'off') assert.equal(signature.samples, 0);
    else assert(signature.samples > 0, 'Enabled skip did not call the signature kernel');
  }

  const href = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
  assert(href?.startsWith('blob:'), 'GIF result has no Blob URL');
  const { data, ...saved } = await downloadIdentity(page);
  const ready = observation.outputUrls.findLast((event) => event.size === saved.bytes);
  assert(ready, 'Saved GIF had no matching Blob publication event');
  assert.equal(
    worker.completes[0]?.outputBytes,
    saved.bytes,
    'Worker output size differs from saved file'
  );
  const decoded = await inspectGif(page, data, workload);
  const elapsedMs = ready.atMs - observation.clickMs;
  assert(elapsedMs > 0, 'Invalid request-to-download-ready interval');
  return {
    workload: workload.id,
    condition,
    index,
    wallStart,
    timeOrigin: observation.timeOrigin,
    inputSha256: workload.inputSha256,
    settings: { format: 'gif', quality: 'high', scale: 1, smartFrameSkip: workload.smartFrameSkip },
    instrumentation,
    outputRoute: observation.profile?.encoderRoute ?? 'unobserved',
    requestToDownloadReadyMs: elapsedMs,
    operationTotals: operations,
    dimensions: observation.dimensions,
    frames: observation.profile?.stages ?? null,
    worker: { url: worker.url, starts: worker.starts, completes: worker.completes },
    saved,
    decoded,
  };
}

export async function exerciseMotionSignature(
  browser: Browser,
  url: string,
  workloads: readonly Workload[],
  onSample: (sample: Awaited<ReturnType<typeof measure>>) => Promise<void>,
  instrumentation: 'enabled' | 'disabled',
  output: string
) {
  assert.equal(workloads.length, 3);
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  const primary = workloads[0]!;
  const small = workloads[1]!;
  const off = workloads[2]!;
  const orderedWorkloads = [primary, small, off];
  const artifacts: { file: string; bytes: number; sha256: string }[] = [];
  const retained = new Map<
    string,
    { page: Page; close: () => Promise<void>; timeOrigin: number }
  >();
  try {
    for (const workload of orderedWorkloads) {
      const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
      const page = await context.newPage();
      try {
        await page.addInitScript(installMotionObserver);
        const response = await page.goto(url);
        assert(response?.ok(), 'Production app failed to load');
        assert(await page.evaluate(() => crossOriginIsolated), 'Production page is not isolated');
        await page.locator('[data-testid="file-input"]').setInputFiles(workload.fixture);
        await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
        await choose(page, 'format', 'gif');
        await choose(page, 'quality', 'high');
        await choose(page, 'scale', '1');
        await choose(page, 'smart-frame-skip', workload.smartFrameSkip);
        const condition = workload.id === 'primary-enabled' ? 'cold-first-use' : 'fresh-context';
        const sample = await measure(page, workload, condition, 0, instrumentation);
        samples.push(sample);
        await onSample(sample);
        retained.set(workload.id, {
          page,
          close: () => context.close(),
          timeOrigin: await page.evaluate(() => performance.timeOrigin),
        });
      } catch (error) {
        await context.close();
        throw error;
      }
    }
    for (const workload of orderedWorkloads) {
      const entry = retained.get(workload.id);
      assert(entry, 'No retained same-document page for warm comparison');
      const sample = await measure(entry.page, workload, 'warm', 0, instrumentation);
      samples.push(sample);
      await onSample(sample);
      if (workload.id === 'primary-enabled') {
        const file = 'motion-signature-result.png';
        const bytes = await entry.page.screenshot({ path: join(output, file), fullPage: true });
        artifacts.push({
          file,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      assert.equal(await entry.page.evaluate(() => performance.timeOrigin), entry.timeOrigin);
    }
    return {
      scenario:
        instrumentation === 'enabled'
          ? MOTION_SIGNATURE_SCENARIO
          : MOTION_SIGNATURE_OVERHEAD_SCENARIO,
      status: 'passed' as const,
      browserVersion: browser.version(),
      samplingPlan:
        'one primary cold first-use and one same-document warm attempt per controller invocation; run five fresh controller invocations per variant',
      artifacts,
      samples,
    };
  } finally {
    await Promise.all([...retained.values()].map((entry) => entry.close()));
  }
}
