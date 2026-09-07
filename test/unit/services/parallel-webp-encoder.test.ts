// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { globalBufferPool } from '@services/buffer-pool';
import { WebpFrameMemoryBudget } from '@services/frame-memory';
import type { EncodeTask, EncodeTaskResult, WebpWorkerPool } from '@services/worker-pool';
import { FRAME_PIPELINE_MEMORY_BUDGET_BYTES } from '@utils/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pending: new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: EncodeTaskResult) => void }
  >(),
  tasks: new Map<number, EncodeTask>(),
}));

function createWorkerPool(): WebpWorkerPool {
  return {
    activeWorkers: 2,
    encode: (task: EncodeTask) =>
      new Promise<EncodeTaskResult>((resolve, reject) => {
        mocks.tasks.set(task.id, task);
        mocks.pending.set(task.id, { reject, resolve });
      }),
    stats: { active: 0, idle: 2, poolSize: 2, queued: 0 },
  } as unknown as WebpWorkerPool;
}

import { createStreamingWebpEncoder } from '@services/parallel-webp-encoder';

function readFrameDurations(output: Uint8Array): number[] {
  const durations: number[] = [];
  for (let offset = 0; offset + 24 <= output.length; offset++) {
    if (
      output[offset] === 0x41 &&
      output[offset + 1] === 0x4e &&
      output[offset + 2] === 0x4d &&
      output[offset + 3] === 0x46
    ) {
      durations.push(
        output[offset + 20]! |
          (output[offset + 21]! << 8) |
          (output[offset + 22]! << 16)
      );
    }
  }
  return durations;
}

describe('createStreamingWebpEncoder tail timing', () => {
  beforeEach(() => {
    mocks.pending.clear();
    mocks.tasks.clear();
    globalBufferPool.clear();
  });

  it('applies deferred tail duration to the final frame after in-flight work settles', async () => {
    const encoder = createStreamingWebpEncoder(createWorkerPool(), 16, 16, 'medium', 2);
    await encoder.submit(new Uint8Array(16), 100);
    await encoder.submit(new Uint8Array(16), 200);
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(2));

    expect(mocks.tasks.get(0)?.quality).toBe(0.75);

    encoder.padLastFrame(75);
    mocks.pending.get(1)?.resolve({ id: 1, bitstream: new Uint8Array(8) });
    mocks.pending.get(0)?.resolve({ id: 0, bitstream: new Uint8Array(8) });
    const output = await encoder.finish();
    const durations = readFrameDurations(output);

    expect(durations).toEqual([100, 275]);
    expect(durations.reduce((total, duration) => total + duration, 0)).toBe(375);
  });

  it('preserves the first worker error and refuses submissions after failure', async () => {
    const encoder = createStreamingWebpEncoder(createWorkerPool(), 16, 16, 'medium', 5);
    const rejectedBuffer = new Uint8Array(16);
    const firstError = new Error('first worker failure');

    const submissions = Array.from({ length: 4 }, () =>
      encoder.submit(new Uint8Array(16), 100)
    );
    const blockedSubmission = encoder.submit(rejectedBuffer, 100);
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(4));

    mocks.pending.get(0)?.reject(firstError);

    await expect(blockedSubmission).rejects.toBe(firstError);
    expect(mocks.tasks.size).toBe(4);
    expect(encoder.failureSignal.aborted).toBe(true);
    expect(encoder.failureSignal.reason).toBe(firstError);
    expect(globalBufferPool.totalPooledMemory).toBe(rejectedBuffer.byteLength);

    for (let index = 1; index < 4; index++) {
      mocks.pending.get(index)?.resolve({ id: index, bitstream: new Uint8Array(8) });
    }
    await Promise.allSettled(submissions);

    await expect(encoder.finish()).rejects.toBe(firstError);
  });

  it('applies output limits to out-of-order worker results', async () => {
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      2,
      undefined,
      { maxFrames: 1, maxOutputBytes: 1024 }
    );
    const firstSubmission = encoder.submit(new Uint8Array(16), 100);
    const secondSubmission = encoder.submit(new Uint8Array(16), 100);
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(2));

    mocks.pending.get(1)?.resolve({ id: 1, bitstream: new Uint8Array(8) });
    mocks.pending.get(0)?.resolve({ id: 0, bitstream: new Uint8Array(8) });
    await Promise.all([firstSubmission, secondSubmission]);

    await expect(encoder.finish()).rejects.toThrow('WebP output frame limit exceeded');
  });

  it('waits for a near-budget Worker frame before accepting the next one', async () => {
    const encoder = createStreamingWebpEncoder(createWorkerPool(), 3000, 2000, 'medium', 2);
    const firstSubmission = encoder.submit(new Uint8Array(16), 100);
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(1));

    const secondSubmission = encoder.submit(new Uint8Array(16), 100);
    expect(mocks.tasks.size).toBe(1);

    mocks.pending.get(0)?.resolve({ id: 0, bitstream: new Uint8Array(8) });
    await firstSubmission;
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(2));
    mocks.pending.get(1)?.resolve({ id: 1, bitstream: new Uint8Array(8) });
    await secondSubmission;

    await expect(encoder.finish()).resolves.toBeInstanceOf(Uint8Array);
  });

  it('bounds sequentially awaited submissions and retained out-of-order result backing', async () => {
    const pool = createWorkerPool();
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 16,
      codedHeight: 16,
      displayWidth: 16,
      displayHeight: 16,
      targetWidth: 16,
      targetHeight: 16,
      workerCount: 2,
    });
    const encoder = createStreamingWebpEncoder(
      pool,
      16,
      16,
      'medium',
      5,
      undefined,
      undefined,
      undefined,
      budget
    );

    for (let index = 0; index < 4; index++) {
      await encoder.submit(new Uint8Array(16), 100);
    }
    expect(mocks.tasks.size).toBe(4);

    let fifthAccepted = false;
    const fifthSubmission = encoder.submit(new Uint8Array(16), 100).then(() => {
      fifthAccepted = true;
    });

    for (let index = 1; index < 4; index++) {
      const backing = new Uint8Array(1024);
      mocks.pending.get(index)?.resolve({ id: index, bitstream: backing.subarray(0, 8) });
    }
    await vi.waitFor(() => expect(budget.usage.resultBytes).toBe(3 * 1024));
    expect(fifthAccepted).toBe(false);
    expect(mocks.tasks.size).toBe(4);

    mocks.pending.get(0)?.resolve({ id: 0, bitstream: new Uint8Array(8) });
    await fifthSubmission;
    expect(mocks.tasks.size).toBe(5);
    expect(budget.usage.resultBytes).toBe(0);

    mocks.pending.get(4)?.resolve({ id: 4, bitstream: new Uint8Array(8) });
    await expect(encoder.finish()).resolves.toBeInstanceOf(Uint8Array);
    encoder.dispose();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('serializes simultaneous no-handoff admission at the outstanding task cap', async () => {
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 16,
      codedHeight: 16,
      displayWidth: 16,
      displayHeight: 16,
      targetWidth: 16,
      targetHeight: 16,
      workerCount: 2,
    });
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      8,
      undefined,
      undefined,
      undefined,
      budget
    );

    const submissions = Array.from({ length: 8 }, () =>
      encoder.submit(new Uint8Array(16), 100)
    );
    await vi.waitFor(() => expect(mocks.tasks.size).toBe(budget.maxOutstandingTasks));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.tasks.size).toBe(budget.maxOutstandingTasks);

    for (let index = 0; index < submissions.length; index++) {
      await vi.waitFor(() => expect(mocks.pending.has(index)).toBe(true));
      mocks.pending.get(index)?.resolve({ id: index, bitstream: new Uint8Array(8) });
    }
    await Promise.all(submissions);
    await expect(encoder.finish()).resolves.toBeInstanceOf(Uint8Array);

    encoder.dispose();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('cancels a blocked admission without waiting for hung worker tasks', async () => {
    const controller = new AbortController();
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 16,
      codedHeight: 16,
      displayWidth: 16,
      displayHeight: 16,
      targetWidth: 16,
      targetHeight: 16,
      workerCount: 2,
    });
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      5,
      undefined,
      undefined,
      controller.signal,
      budget
    );

    for (let index = 0; index < 4; index++) {
      await encoder.submit(new Uint8Array(16), 100);
    }
    const blockedBuffers = Array.from({ length: 3 }, () => globalBufferPool.acquire(16));
    const blocked = blockedBuffers.map((buffer) => encoder.submit(buffer, 100));
    controller.abort(new DOMException('Cancelled', 'AbortError'));

    const outcomes = await Promise.allSettled(blocked);
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AbortError' },
      });
    }
    expect(mocks.tasks.size).toBe(4);
    expect(globalBufferPool.totalActiveMemory).toBe(0);

    encoder.dispose();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('releases a pooled frame when submission starts with an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      1,
      undefined,
      undefined,
      controller.signal
    );
    const frame = globalBufferPool.acquire(16);

    await expect(encoder.submit(frame, 100)).rejects.toMatchObject({ name: 'AbortError' });
    expect(globalBufferPool.totalActiveMemory).toBe(0);

    encoder.dispose();
  });

  it('cancels finish without waiting for a hung worker task', async () => {
    const controller = new AbortController();
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 16,
      codedHeight: 16,
      displayWidth: 16,
      displayHeight: 16,
      targetWidth: 16,
      targetHeight: 16,
      workerCount: 2,
    });
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      1,
      undefined,
      undefined,
      controller.signal,
      budget
    );
    await encoder.submit(new Uint8Array(16), 100);
    const finishing = encoder.finish();

    controller.abort(new DOMException('Cancelled', 'AbortError'));

    await expect(finishing).rejects.toMatchObject({ name: 'AbortError' });
    encoder.dispose();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('rejects a completed result before retaining its backing beyond the shared budget', async () => {
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 16,
      codedHeight: 16,
      displayWidth: 16,
      displayHeight: 16,
      targetWidth: 16,
      targetHeight: 16,
      workerCount: 2,
    });
    const source = budget.tryReserveSource(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES -
        budget.usage.canvasBytes -
        budget.targetTaskBytes -
        4
    );
    expect(source).not.toBeNull();
    const encoder = createStreamingWebpEncoder(
      createWorkerPool(),
      16,
      16,
      'medium',
      1,
      undefined,
      undefined,
      undefined,
      budget
    );
    await encoder.submit(new Uint8Array(16), 100);

    mocks.pending.get(0)?.resolve({ id: 0, bitstream: new Uint8Array(8) });

    await expect(encoder.finish()).rejects.toThrow(
      'WebP frame memory limit exceeded by encoded results'
    );
    expect(encoder.failureSignal.reason).toMatchObject({
      message: 'WebP frame memory limit exceeded by encoded results',
    });
    expect(budget.usage.resultBytes).toBe(0);

    source?.release();
    encoder.dispose();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });
});
