// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

type AppWorkerObservation = {
  url: string;
  starts: {
    requestId: string;
    format: unknown;
    quality: unknown;
    scale: unknown;
    smartFrameSkip: unknown;
  }[];
  completes: { requestId: string; outputBytes: number; sha256: string | null }[];
  errors: { requestId: unknown; code: unknown }[];
};

export async function installAppWorkerObserver(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    const observations: AppWorkerObservation[] = [];
    Reflect.set(globalThis, '__wmcAppWorkerObservations', observations);
    globalThis.Worker = class ObservedWorker extends NativeWorker {
      private readonly record: AppWorkerObservation | undefined;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const url = new URL(String(scriptURL), location.href);
        if (!/^\/assets\/worker-[\w-]+\.js$/.test(url.pathname)) return;
        this.record = { url: url.href, starts: [], completes: [], errors: [] };
        observations.push(this.record);
        this.addEventListener('message', ({ data }) => {
          if (data === null || typeof data !== 'object') return;
          if (data.type === 'complete' && data.outputBuffer instanceof ArrayBuffer) {
            const complete = {
              requestId: data.requestId,
              outputBytes: data.outputBuffer.byteLength,
              sha256: null as string | null,
            };
            this.record?.completes.push(complete);
            void crypto.subtle.digest('SHA-256', data.outputBuffer).then(
              (digest) => {
                complete.sha256 = Array.from(new Uint8Array(digest), (byte) =>
                  byte.toString(16).padStart(2, '0')
                ).join('');
              },
              () => {
                complete.sha256 = 'digest-failed';
              }
            );
          } else if (data.type === 'error') {
            this.record?.errors.push({ requestId: data.requestId, code: data.code });
          }
        });
      }

      override postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        if (
          this.record &&
          message !== null &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'start' &&
          'options' in message &&
          message.options !== null &&
          typeof message.options === 'object'
        ) {
          const values = message.options as Record<string, unknown>;
          this.record.starts.push({
            requestId: 'requestId' in message ? String(message.requestId) : '',
            format: values.format,
            quality: values.quality,
            scale: values.scale,
            smartFrameSkip: values.smartFrameSkip,
          });
        }
        if (Array.isArray(options)) return super.postMessage(message, options);
        return super.postMessage(message, options);
      }
    };
  });
}

export async function readAppWorkerObservation(page: Page): Promise<AppWorkerObservation> {
  await page.waitForFunction(
    () => {
      const observations = Reflect.get(globalThis, '__wmcAppWorkerObservations') as
        | AppWorkerObservation[]
        | undefined;
      return typeof observations?.[0]?.completes[0]?.sha256 === 'string';
    },
    undefined,
    { timeout: 5_000 }
  );
  const observations = await page.evaluate(
    () => Reflect.get(globalThis, '__wmcAppWorkerObservations') as AppWorkerObservation[]
  );
  assert.equal(
    observations.length,
    1,
    'GIF conversion did not construct one built conversion Worker'
  );
  const observation = observations[0]!;
  assert.equal(
    observation.starts.length,
    1,
    'Built conversion Worker did not receive one app start'
  );
  assert.deepEqual(observation.starts[0], {
    requestId: observation.starts[0]?.requestId,
    format: 'gif',
    quality: 'low',
    scale: 0.5,
    smartFrameSkip: 'off',
  });
  assert(observation.starts[0]?.requestId, 'Built conversion Worker start omitted request ID');
  assert.deepEqual(observation.errors, [], 'App Worker returned an error');
  assert.deepEqual(observation.completes, [
    {
      requestId: observation.starts[0].requestId,
      outputBytes: observation.completes[0]?.outputBytes,
      sha256: observation.completes[0]?.sha256,
    },
  ]);
  assert((observation.completes[0]?.outputBytes ?? 0) > 100, 'Worker completion has no output');
  assert.match(observation.completes[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  return observation;
}

export async function installUnavailableWorkerObserver(page: Page) {
  await page.addInitScript(() => {
    const nativeConvert = OffscreenCanvas.prototype.convertToBlob;
    const counts = {
      workerConstructionAttempts: 0,
      nativeWebpAvailable: typeof nativeConvert === 'function',
      nativeWebpCalls: 0,
    };
    Reflect.set(globalThis, '__wmcMainThreadWebpCounts', counts);
    if (counts.nativeWebpAvailable) {
      OffscreenCanvas.prototype.convertToBlob = function (options?: ImageEncodeOptions) {
        if (options?.type === 'image/webp') counts.nativeWebpCalls++;
        return nativeConvert.call(this, options);
      };
    }
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: class UnavailableWorker {
        constructor() {
          counts.workerConstructionAttempts++;
          throw new DOMException('Forced Worker construction failure', 'NotSupportedError');
        }
      },
    });
  });
}

export async function readUnavailableWorkerObservation(page: Page) {
  const counts = await page.evaluate(
    () =>
      Reflect.get(globalThis, '__wmcMainThreadWebpCounts') as {
        workerConstructionAttempts: number;
        nativeWebpAvailable: boolean;
        nativeWebpCalls: number;
      }
  );
  assert(counts.workerConstructionAttempts > 0, 'No Worker construction failure was observed');
  return counts;
}

export async function readMainThreadWebpObservation(page: Page) {
  const counts = await readUnavailableWorkerObservation(page);
  assert.equal(counts.nativeWebpAvailable, true, 'Native Canvas WebP capability is unavailable');
  assert(
    counts.nativeWebpCalls > 1,
    'WebP conversion did not use native Canvas encoding beyond the capability probe'
  );
  return counts;
}

/** Exercise the built conversion module captured from a successful app conversion. */
export async function exerciseInvalidWorkerOptions(page: Page, workerUrl: string) {
  const result = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: 'module' });
    const receive = (requestId: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Worker response timed out for ${requestId}`));
        }, 5_000);
        const onError = (event: ErrorEvent) => {
          cleanup();
          reject(new Error(`Worker module failed: ${event.message}`));
        };
        const onMessage = (event: MessageEvent<unknown>) => {
          const value = event.data;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
          const response = value as Record<string, unknown>;
          if (response.requestId !== requestId) return;
          cleanup();
          resolve(response);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          worker.removeEventListener('error', onError);
          worker.removeEventListener('message', onMessage);
        };
        worker.addEventListener('error', onError);
        worker.addEventListener('message', onMessage);
      });
    try {
      const ready = await receive('');
      if (ready.type !== 'log' || ready.message !== 'Worker initialized') {
        throw new Error('Built conversion Worker did not initialize');
      }
      const observations: {
        field: string;
        value: unknown;
        response: Record<string, unknown>;
        ms: number;
      }[] = [];
      for (const [field, value] of [
        ['format', 'avif'],
        ['quality', 'ultra'],
        ['smartFrameSkip', 'turbo'],
        ['smartFrameSkip', 123],
        ['maxMemoryMB', 0],
      ] as const) {
        const requestId = `invalid-option-${observations.length}`;
        const responsePromise = receive(requestId);
        const started = performance.now();
        worker.postMessage({
          type: 'start',
          requestId,
          inputBuffer: new ArrayBuffer(0),
          config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
          options: {
            format: 'gif',
            quality: 'medium',
            fps: 30,
            scale: 1,
            trimStart: 0,
            trimEnd: 0,
            maxFrames: 1,
            maxOutputBytes: 1024,
            [field]: value,
          },
        });
        const response = await responsePromise;
        observations.push({ field, value, response, ms: performance.now() - started });
      }
      return observations;
    } finally {
      worker.terminate();
    }
  }, workerUrl);
  for (let index = 0; index < result.length; index++) {
    const row = result[index];
    assert(row, `Missing invalid Worker option observation ${index}`);
    assert.deepEqual(row.response, {
      type: 'error',
      requestId: `invalid-option-${index}`,
      message: 'Invalid conversion worker request',
      code: 'INVALID_REQUEST',
    });
    assert(row.ms < 5_000, `Invalid Worker request ${index} did not settle promptly`);
  }
  assert.equal(result.length, 5);
  return {
    id: 'built-worker-invalid-options',
    status: 'passed',
    workerUrl: new URL(workerUrl).pathname,
    observations: result,
  };
}
