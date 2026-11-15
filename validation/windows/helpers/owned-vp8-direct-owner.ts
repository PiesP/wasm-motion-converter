// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import type { Page } from '@playwright/test';

import type { CapacityRecord } from './owned-vp8-owner-retention.ts';

const WORKER_ASSET = /^assets\/worker-[\w-]+\.js$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const MAX_SMALL_OUTPUT_BYTES = 8 * 1024 * 1024;

export type DirectOwnerSnapshot = {
  requestId: string | null;
  createdCount: number;
  records: CapacityRecord[];
};

export type DirectOwnerRequest = {
  workerPath: string;
  inputBase64: string;
  requestId: string;
  config: object;
  options: object;
};

/** Fail closed on missing or unrelated ABI activity, including an unretired completion. */
export function assertDirectOwnerSnapshot(
  snapshot: DirectOwnerSnapshot | null,
  requestId: string,
  completed: boolean
): asserts snapshot is DirectOwnerSnapshot {
  assert(snapshot, 'Direct Worker owned ABI snapshot unavailable');
  assert.equal(snapshot.requestId, requestId, 'Direct Worker ABI request identity mismatch');
  assert(Number.isSafeInteger(snapshot.createdCount) && snapshot.createdCount > 0);
  assert.equal(
    snapshot.records.length,
    snapshot.createdCount,
    'Direct Worker ABI inventory incomplete'
  );
  assert.equal(new Set(snapshot.records.map((record) => record.id)).size, snapshot.createdCount);
  for (const [index, record] of snapshot.records.entries()) {
    assert.equal(record.id, index + 1, 'Direct Worker ABI instance identity mismatch');
    assert(record.successfulBeginCalls > 0, 'Direct Worker owned begin was not observed');
    assert(record.stepCalls > 0, 'Direct Worker owned step was not observed');
    assert(
      Number.isSafeInteger(record.peakCapacityBytes) &&
        record.peakCapacityBytes > 0 &&
        record.peakCapacityBytes <= 192 * 1024 * 1024,
      'Direct Worker owned linear capacity exceeded 192 MiB'
    );
    if (completed) {
      assert(record.retireCalls > 0 && record.retireStatus === 0);
      assert(
        record.retirementTimeCapacityBytes !== null &&
          record.retirementTimeCapacityBytes > 0 &&
          record.retirementTimeCapacityBytes <= 192 * 1024 * 1024,
        'Direct Worker retirement capacity unavailable or exceeded 192 MiB'
      );
    } else {
      assert(
        record.retireCalls === 0 &&
          record.retireStatus === null &&
          record.retirementTimeCapacityBytes === null,
        'Direct Worker retired before active termination'
      );
    }
  }
}

function validateRequest(request: DirectOwnerRequest) {
  assert(WORKER_ASSET.test(request.workerPath), 'Direct Worker asset path is invalid');
  assert(request.requestId.length > 0, 'Direct Worker request ID is empty');
  const inputBytes = Buffer.from(request.inputBase64, 'base64');
  assert(
    inputBytes.length > 0 && inputBytes.length <= MAX_INPUT_BYTES,
    'Direct Worker input outside bound'
  );
  assert.equal(
    inputBytes.toString('base64'),
    request.inputBase64,
    'Direct Worker input encoding invalid'
  );
}

/** One actual bundled conversion Worker and one transferred input per completed request. */
export async function runDirectOwnerCompletion(page: Page, request: DirectOwnerRequest) {
  validateRequest(request);
  const { workerPath, inputBase64, requestId, config, options } = request;
  const result = await page.evaluate(
    async ({ workerPath, inputBase64, requestId, config, options }) => {
      const input = Uint8Array.from(atob(inputBase64), (character) => character.charCodeAt(0));
      return new Promise<{
        requestId: string;
        output: number[];
        outputBytes: number;
        durationMs: number;
        progressCount: number;
        ownedProgressCount: number;
      }>((resolve, reject) => {
        const worker = new Worker(`/${workerPath}`, { type: 'module' });
        let started = false;
        let settled = false;
        let progressCount = 0;
        let ownedProgressCount = 0;
        const timer = setTimeout(
          () => finish(new Error('Direct Worker completion timed out')),
          180_000
        );
        function finish(error?: Error, value?: Parameters<typeof resolve>[0]) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new Error('Direct Worker completed without a result'));
        }
        worker.addEventListener('error', (event) => {
          event.preventDefault();
          finish(new Error(`Direct Worker script error: ${event.message}`));
        });
        worker.addEventListener('messageerror', () =>
          finish(new Error('Direct Worker message error'))
        );
        worker.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
          if (!data || typeof data !== 'object') return;
          const message = data as Record<string, unknown>;
          if (message.type === 'ready' && message.requestId === '' && !started) {
            started = true;
            try {
              worker.postMessage(
                {
                  type: 'start',
                  requestId,
                  inputBuffer: input.buffer,
                  config,
                  options,
                  duration: 4,
                  framerate: 4,
                },
                [input.buffer]
              );
            } catch (error) {
              finish(new Error(`Direct Worker start failed: ${String(error)}`));
            }
            return;
          }
          if (message.requestId !== requestId) return;
          if (message.type === 'progress') {
            progressCount++;
            if (typeof message.ownedVp8Steps === 'number' && message.ownedVp8Steps > 0)
              ownedProgressCount++;
          } else if (message.type === 'error') {
            finish(new Error(`Direct Worker ${String(message.code)}: ${String(message.message)}`));
          } else if (message.type === 'complete') {
            if (!(message.outputBuffer instanceof ArrayBuffer)) {
              finish(new Error('Direct Worker returned no ArrayBuffer'));
              return;
            }
            const outputBytes = message.outputBuffer.byteLength;
            if (outputBytes === 0 || outputBytes > 8 * 1024 * 1024) {
              finish(new Error('Direct Worker small output outside transfer bound'));
              return;
            }
            finish(undefined, {
              requestId,
              output: Array.from(new Uint8Array(message.outputBuffer)),
              outputBytes,
              durationMs: Number(message.durationMs),
              progressCount,
              ownedProgressCount,
            });
          }
        });
      });
    },
    { workerPath, inputBase64, requestId, config, options }
  );
  assert(result.outputBytes > 0 && result.outputBytes <= MAX_OUTPUT_BYTES);
  assert(result.outputBytes <= MAX_SMALL_OUTPUT_BYTES);
  assert.equal(result.output.length, result.outputBytes);
  assert(Number.isFinite(result.durationMs) && result.durationMs > 0);
  assert(result.progressCount > 0 && result.ownedProgressCount > 0);
  return result;
}

/** Observe an actual live ABI step, then abort and terminate that exact Worker. */
export async function runDirectOwnerActiveTermination(page: Page, request: DirectOwnerRequest) {
  validateRequest(request);
  const { workerPath, inputBase64, requestId, config, options } = request;
  const browserWorkerPromise = page.waitForEvent('worker', {
    predicate: (worker) => new URL(worker.url()).pathname === `/${workerPath}`,
    timeout: 30_000,
  });
  const startedPromise = page.evaluate(
    async ({ workerPath, inputBase64, requestId, config, options }) => {
      const input = Uint8Array.from(atob(inputBase64), (character) => character.charCodeAt(0));
      return new Promise<string>((resolve, reject) => {
        const worker = new Worker(`/${workerPath}`, { type: 'module' });
        const active = { worker, requestId, progressCount: 0, terminalType: null as string | null };
        Reflect.set(globalThis, '__wmcVp8DirectOwnerActiveWorker', active);
        let sent = false;
        let settled = false;
        const timer = setTimeout(() => fail(new Error('Direct Worker ready timed out')), 30_000);
        function fail(error: Error) {
          active.terminalType = error.message;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        worker.addEventListener('error', (event) => {
          event.preventDefault();
          fail(new Error(`Direct Worker script error: ${event.message}`));
        });
        worker.addEventListener('messageerror', () =>
          fail(new Error('Direct Worker message error'))
        );
        worker.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
          if (!data || typeof data !== 'object') return;
          const message = data as Record<string, unknown>;
          if (message.type === 'ready' && message.requestId === '' && !sent) {
            sent = true;
            try {
              worker.postMessage(
                {
                  type: 'start',
                  requestId,
                  inputBuffer: input.buffer,
                  config,
                  options,
                  duration: 4,
                  framerate: 4,
                },
                [input.buffer]
              );
              settled = true;
              clearTimeout(timer);
              resolve(requestId);
            } catch (error) {
              fail(new Error(`Direct Worker start failed: ${String(error)}`));
            }
          } else if (message.requestId === requestId && message.type === 'progress') {
            active.progressCount++;
          } else if (
            message.requestId === requestId &&
            (message.type === 'complete' || message.type === 'error')
          ) {
            active.terminalType = message.type;
            if (!settled) fail(new Error(`Direct Worker reached ${message.type} before start`));
          }
        });
      });
    },
    { workerPath, inputBase64, requestId, config, options }
  );
  try {
    // Promise.all observes both pending operations on every rejection path.
    const [browserWorker, startedRequestId] = await Promise.all([
      browserWorkerPromise,
      startedPromise,
    ]);
    assert.equal(startedRequestId, requestId);
    const deadline = Date.now() + 30_000;
    const readLifecycle = () =>
      page.evaluate((id) => {
        const active = Reflect.get(globalThis, '__wmcVp8DirectOwnerActiveWorker') as
          | { requestId: string; terminalType: string | null }
          | undefined;
        const lifecycle = Reflect.get(globalThis, '__wmcVp8WorkerLifecycle') as {
          snapshot: () => Array<{ requestId: string | null; terminalType: string | null }>;
        };
        const record = lifecycle.snapshot().at(-1);
        if (active?.requestId !== id || record?.requestId !== id)
          throw new Error('Direct Worker active identity mismatch');
        return active.terminalType ?? record.terminalType;
      }, requestId);
    const readLiveSnapshot = async (): Promise<DirectOwnerSnapshot | null> => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('Direct Worker live ABI step timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          browserWorker.evaluate(() => {
            const probe = Reflect.get(globalThis, '__wmcVp8RetainedWorkerProbe') as
              | { snapshot: () => DirectOwnerSnapshot }
              | undefined;
            return probe?.snapshot() ?? null;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Direct Worker live ABI snapshot timed out')),
              remainingMs
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let snapshot: DirectOwnerSnapshot | null = null;
    while (Date.now() < deadline) {
      const terminal = await readLifecycle();
      if (terminal !== null)
        throw new Error(`Direct Worker reached ${terminal} before termination`);
      snapshot = await readLiveSnapshot();
      if (snapshot && snapshot.requestId !== null && snapshot.requestId !== requestId)
        throw new Error('Direct Worker live ABI request identity mismatch');
      if (snapshot?.records.some((record) => record.retireCalls > 0))
        throw new Error('Direct Worker retired before active termination');
      if (snapshot?.records.some((record) => record.stepCalls > 0)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    assertDirectOwnerSnapshot(snapshot, requestId, false);
    // Retirement can occur without a terminal response between observations.
    const latest = await readLiveSnapshot();
    assertDirectOwnerSnapshot(latest, requestId, false);
    const progressCount = await page.evaluate((id) => {
      const active = Reflect.get(globalThis, '__wmcVp8DirectOwnerActiveWorker') as
        | { worker: Worker; requestId: string; progressCount: number; terminalType: string | null }
        | undefined;
      if (active?.requestId !== id) throw new Error('Direct Worker active handle missing');
      const lifecycle = Reflect.get(globalThis, '__wmcVp8WorkerLifecycle') as {
        snapshot: () => Array<{ requestId: string | null; terminalType: string | null }>;
      };
      const record = lifecycle.snapshot().at(-1);
      if (record?.requestId !== id || record.terminalType !== null || active.terminalType !== null)
        throw new Error('Direct Worker was no longer active before termination');
      active.worker.postMessage({ type: 'abort', requestId: id });
      active.worker.terminate();
      Reflect.deleteProperty(globalThis, '__wmcVp8DirectOwnerActiveWorker');
      return active.progressCount;
    }, requestId);
    return {
      requestId,
      progressCount,
      observedStepCalls: latest!.records.reduce((sum, record) => sum + record.stepCalls, 0),
      snapshot: latest!,
    };
  } finally {
    await page
      .evaluate((id) => {
        const active = Reflect.get(globalThis, '__wmcVp8DirectOwnerActiveWorker') as
          | { worker: Worker; requestId: string }
          | undefined;
        if (active?.requestId !== id) return;
        active.worker.terminate();
        Reflect.deleteProperty(globalThis, '__wmcVp8DirectOwnerActiveWorker');
      }, requestId)
      .catch(() => undefined);
  }
}
