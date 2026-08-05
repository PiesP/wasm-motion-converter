// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { globalBufferPool } from '@services/buffer-pool';
import type { EncodeTask, EncodeTaskResult } from '@services/worker-pool';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pending: new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: EncodeTaskResult) => void }
  >(),
  tasks: new Map<number, EncodeTask>(),
}));

vi.mock('@services/worker-pool', () => ({
  getWorkerPool: () => ({
    activeWorkers: 2,
    encode: (task: EncodeTask) =>
      new Promise<EncodeTaskResult>((resolve, reject) => {
        mocks.tasks.set(task.id, task);
        mocks.pending.set(task.id, { reject, resolve });
      }),
    stats: { active: 0, idle: 2, poolSize: 2, queued: 0 },
  }),
  WebpWorkerPool: { getOptimalWorkerCount: () => 2 },
}));

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
    const encoder = createStreamingWebpEncoder(16, 16, 'medium', 2);
    await encoder.submit(new Uint8Array(16), 100);
    await encoder.submit(new Uint8Array(16), 200);

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
    const encoder = createStreamingWebpEncoder(16, 16, 'medium', 5);
    const rejectedBuffer = new Uint8Array(16);
    const firstError = new Error('first worker failure');

    for (let index = 0; index < 4; index++) {
      await encoder.submit(new Uint8Array(16), 100);
    }
    const blockedSubmission = encoder.submit(rejectedBuffer, 100);

    mocks.pending.get(0)?.reject(firstError);

    await expect(blockedSubmission).rejects.toBe(firstError);
    expect(mocks.tasks.size).toBe(4);
    expect(encoder.failureSignal.aborted).toBe(true);
    expect(encoder.failureSignal.reason).toBe(firstError);
    expect(globalBufferPool.totalPooledMemory).toBe(rejectedBuffer.byteLength);

    for (let index = 1; index < 4; index++) {
      mocks.pending.get(index)?.resolve({ id: index, bitstream: new Uint8Array(8) });
    }

    await expect(encoder.finish()).rejects.toBe(firstError);
  });
});
