// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { EncodeTask, EncodeTaskResult } from '@services/worker-pool';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pending: new Map<number, (result: EncodeTaskResult) => void>(),
  tasks: new Map<number, EncodeTask>(),
}));

vi.mock('@services/worker-pool', () => ({
  getWorkerPool: () => ({
    activeWorkers: 2,
    encode: (task: EncodeTask) =>
      new Promise<EncodeTaskResult>((resolve) => {
        mocks.tasks.set(task.id, task);
        mocks.pending.set(task.id, resolve);
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
  });

  it('applies deferred tail duration to the final frame after in-flight work settles', async () => {
    const encoder = createStreamingWebpEncoder(16, 16, 'medium', 2);
    await encoder.submit(new Uint8Array(16), 100);
    await encoder.submit(new Uint8Array(16), 200);

    expect(mocks.tasks.get(0)?.quality).toBe(0.75);

    encoder.padLastFrame(75);
    mocks.pending.get(1)?.({ id: 1, bitstream: new Uint8Array(8) });
    mocks.pending.get(0)?.({ id: 0, bitstream: new Uint8Array(8) });

    const output = await encoder.finish();
    const durations = readFrameDurations(output);

    expect(durations).toEqual([100, 275]);
    expect(durations.reduce((total, duration) => total + duration, 0)).toBe(375);
  });
});
