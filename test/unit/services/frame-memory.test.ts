// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { getPooledBufferSize } from '@services/buffer-pool';
import {
  calculateFrameConcurrency,
  calculateFrameOutputConcurrency,
  estimateActiveFrameBytes,
  estimateFrameOutputBytes,
} from '@services/frame-memory';
import {
  CONVERSION_MEMORY_BUDGET_BYTES,
  DEMUX_MEMORY_BUDGET_BYTES,
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  MAX_FRAME_PIXEL_COUNT,
  WEBP_MAX_OUTPUT_BYTES,
} from '@utils/constants';

describe('frame memory reservations', () => {
  it('keeps the existing small-frame parallelism', () => {
    expect(calculateFrameConcurrency(8, 8, 10)).toBe(10);
  });

  it('reduces 4K live-frame concurrency to the shared byte budget', () => {
    const bytesPerFrame = estimateActiveFrameBytes(3840, 2160);
    const concurrency = calculateFrameConcurrency(3840, 2160, 10);

    expect(concurrency).toBe(1);
    expect(bytesPerFrame * concurrency).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(bytesPerFrame * (concurrency + 1)).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('includes a 4K source frame when calculating 360p output concurrency', () => {
    const bytesPerOutput = estimateFrameOutputBytes(3840, 2160, 640, 360);

    expect(calculateFrameConcurrency(640, 360, 10)).toBe(10);
    expect(calculateFrameOutputConcurrency(3840, 2160, 640, 360, 10)).toBe(5);
    expect(bytesPerOutput).toBe(
      3840 * 2160 * 4 + estimateActiveFrameBytes(640, 360)
    );
    expect(bytesPerOutput).toBeLessThanOrEqual(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(bytesPerOutput * 5).toBeLessThanOrEqual(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(bytesPerOutput * 6).toBeGreaterThan(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
  });

  it('does not double count equal source and target dimensions', () => {
    expect(estimateFrameOutputBytes(3840, 2160, 3840, 2160)).toBe(
      estimateActiveFrameBytes(3840, 2160)
    );
  });

  it('admits one near-limit scaled frame within the shared byte budget', () => {
    const sourceWidth = 4096;
    const sourceHeight = Math.floor(MAX_FRAME_PIXEL_COUNT / sourceWidth);
    const targetWidth = 4095;
    const targetHeight = Math.floor(MAX_FRAME_PIXEL_COUNT / targetWidth);
    const bytesPerOutput = estimateFrameOutputBytes(
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight
    );

    expect(bytesPerOutput).toBeLessThanOrEqual(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(
      calculateFrameOutputConcurrency(
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
        10
      )
    ).toBe(1);
  });

  it('returns zero when one scaled frame exceeds the shared byte budget', () => {
    const oversizedSourceWidth = FRAME_PIPELINE_MEMORY_BUDGET_BYTES / 4;
    const bytesPerOutput = estimateFrameOutputBytes(oversizedSourceWidth, 2, 8, 8);

    expect(bytesPerOutput).toBeGreaterThan(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(calculateFrameOutputConcurrency(oversizedSourceWidth, 2, 8, 8, 10)).toBe(0);
  });

  it('partitions demux, live frames, and two output copies within one envelope', () => {
    expect(
      DEMUX_MEMORY_BUDGET_BYTES +
        FRAME_PIPELINE_MEMORY_BUDGET_BYTES +
        WEBP_MAX_OUTPUT_BYTES * 2
    ).toBe(CONVERSION_MEMORY_BUDGET_BYTES);
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
