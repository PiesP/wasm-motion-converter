// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { getPooledBufferSize } from '@services/buffer-pool';
import {
  calculateFrameConcurrency,
  estimateActiveFrameBytes,
} from '@services/frame-memory';
import {
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  MAX_FRAME_PIXEL_COUNT,
} from '@utils/constants';

describe('frame memory reservations', () => {
  it('keeps the existing small-frame parallelism', () => {
    expect(calculateFrameConcurrency(8, 8, 10)).toBe(10);
  });

  it('reduces 4K live-frame concurrency to the shared byte budget', () => {
    const bytesPerFrame = estimateActiveFrameBytes(3840, 2160);
    const concurrency = calculateFrameConcurrency(3840, 2160, 10);

    expect(concurrency).toBe(2);
    expect(bytesPerFrame * concurrency).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(bytesPerFrame * (concurrency + 1)).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('allows only one near-limit frame task', () => {
    const width = 4096;
    const height = Math.floor(MAX_FRAME_PIXEL_COUNT / width);

    expect(calculateFrameConcurrency(width, height, 10)).toBe(1);
  });

  it('uses the same power-of-two RGB bucket as the buffer pool', () => {
    expect(getPooledBufferSize(3840 * 2160 * 3)).toBe(32 * 1024 * 1024);
  });
});
