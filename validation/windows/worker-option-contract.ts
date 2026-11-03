// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

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
