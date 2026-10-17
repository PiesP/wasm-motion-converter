// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { getPooledBufferSize } from '@services/buffer-pool';
import {
  calculateStagedFrameSourceCapacity,
  calculateWebpWorkerCountForBudget,
  estimateActiveFrameBytes,
  estimateDecodedSourceFrameBytes,
  estimateFrameTaskBytes,
  estimateRuntimeDecodedSourceFrameBytes,
  WebpFrameMemoryBudget,
} from '@services/frame-memory';
import {
  CONVERSION_MEMORY_BUDGET_BYTES,
  DEMUX_MEMORY_BUDGET_BYTES,
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  MAX_FRAME_PIXEL_COUNT,
  WEBP_MAX_OUTPUT_BYTES,
} from '@utils/constants';
import { describe, expect, it } from 'vite-plus/test';

describe('frame memory reservations', () => {
  it('reserves the maximum coded and display dimensions for a decoded source frame', () => {
    expect(estimateDecodedSourceFrameBytes(1920, 1080, 2048, 1152)).toBe(2048 * 1152 * 4);
  });

  it('keeps one target working set outside the queued 1080p source-frame capacity', () => {
    const targetWorkingBytes = estimateActiveFrameBytes(960, 540);
    const sourceBytes = estimateDecodedSourceFrameBytes(1920, 1080, 1920, 1080);
    const capacity = calculateStagedFrameSourceCapacity(
      1920,
      1080,
      1920,
      1080,
      960,
      540,
      Number.MAX_SAFE_INTEGER
    );

    expect(capacity).toBe(23);
    expect(targetWorkingBytes + sourceBytes * capacity).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(targetWorkingBytes + sourceBytes * (capacity + 1)).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('calculates source capacity while reserving two target working sets', () => {
    expect(
      calculateStagedFrameSourceCapacity(
        1920,
        1080,
        1920,
        1080,
        960,
        540,
        Number.MAX_SAFE_INTEGER,
        2
      )
    ).toBe(22);
  });

  it('uses a larger runtime allocation for high-bit-depth decoded frames', () => {
    expect(estimateRuntimeDecodedSourceFrameBytes(1920, 1080, 1920, 1080, 24_883_200)).toBe(
      24_883_200
    );
  });

  it('falls back to eight bytes per pixel when runtime layout is uncertain', () => {
    expect(estimateRuntimeDecodedSourceFrameBytes(1920, 1080, 1920, 1080, null)).toBe(
      1920 * 1080 * 8
    );
  });

  it('accounts only the remaining RGBA task transient beside its pooled pixels', () => {
    const pixels = 1920 * 1080;
    expect(estimateFrameTaskBytes(1920, 1080, 'rgb')).toBe(
      getPooledBufferSize(pixels * 3) + pixels * 8
    );
    expect(estimateFrameTaskBytes(1920, 1080, 'rgba')).toBe(
      getPooledBufferSize(pixels * 4) + pixels * 4
    );
    expect(estimateFrameTaskBytes(1920, 1080, 'rgba')).toBeLessThan(
      estimateFrameTaskBytes(1920, 1080, 'rgb')
    );
  });

  it('reserves native 4K source frames separately from a 4K target working set', () => {
    const sourceBytes = estimateDecodedSourceFrameBytes(3840, 2160, 3840, 2160);
    const targetBytes = estimateActiveFrameBytes(3840, 2160);
    const capacity = calculateStagedFrameSourceCapacity(3840, 2160, 3840, 2160, 3840, 2160, 10);

    expect(capacity).toBeGreaterThan(0);
    expect(sourceBytes * capacity + targetBytes).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(sourceBytes * (capacity + 1) + targetBytes).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('includes a 4K native source beside a 360p target and caps requested work', () => {
    const sourceBytes = estimateDecodedSourceFrameBytes(3840, 2160, 3840, 2160);
    const targetBytes = estimateActiveFrameBytes(640, 360);
    const smallSourceCapacity = calculateStagedFrameSourceCapacity(
      640,
      360,
      640,
      360,
      640,
      360,
      10
    );
    const capacity = calculateStagedFrameSourceCapacity(3840, 2160, 3840, 2160, 640, 360, 10);

    expect(smallSourceCapacity).toBe(10);
    expect(capacity).toBe(5);
    expect(sourceBytes * capacity + targetBytes).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(sourceBytes * (capacity + 1) + targetBytes).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('admits near-limit scaled native source frames within the shared byte budget', () => {
    const sourceWidth = 4096;
    const sourceHeight = Math.floor(MAX_FRAME_PIXEL_COUNT / sourceWidth);
    const targetWidth = 4095;
    const targetHeight = Math.floor(MAX_FRAME_PIXEL_COUNT / targetWidth);
    const sourceBytes = estimateDecodedSourceFrameBytes(
      sourceWidth,
      sourceHeight,
      sourceWidth,
      sourceHeight
    );
    const targetBytes = estimateActiveFrameBytes(targetWidth, targetHeight);
    const capacity = calculateStagedFrameSourceCapacity(
      sourceWidth,
      sourceHeight,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      10
    );

    expect(capacity).toBe(1);
    expect(sourceBytes * capacity + targetBytes).toBeLessThanOrEqual(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
    expect(sourceBytes * (capacity + 1) + targetBytes).toBeGreaterThan(
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES
    );
  });

  it('returns zero when one native source exceeds the shared byte budget', () => {
    const oversizedSourceWidth = FRAME_PIPELINE_MEMORY_BUDGET_BYTES / 4;
    const sourceBytes = estimateDecodedSourceFrameBytes(
      oversizedSourceWidth,
      2,
      oversizedSourceWidth,
      2
    );

    expect(sourceBytes).toBeGreaterThan(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(
      calculateStagedFrameSourceCapacity(oversizedSourceWidth, 2, oversizedSourceWidth, 2, 8, 8, 10)
    ).toBe(0);
  });

  it('partitions demux, live frames, and two output copies within one envelope', () => {
    expect(
      DEMUX_MEMORY_BUDGET_BYTES + FRAME_PIPELINE_MEMORY_BUDGET_BYTES + WEBP_MAX_OUTPUT_BYTES * 2
    ).toBe(CONVERSION_MEMORY_BUDGET_BYTES);
  });

  it('allows only one near-limit frame task', () => {
    const width = 4096;
    const height = Math.floor(MAX_FRAME_PIXEL_COUNT / width);

    expect(
      calculateStagedFrameSourceCapacity(width, height, width, height, width, height, 10)
    ).toBe(1);
  });

  it('uses the same power-of-two RGB bucket as the buffer pool', () => {
    expect(getPooledBufferSize(3840 * 2160 * 3)).toBe(32 * 1024 * 1024);
  });

  it('keeps serial progress for a 4K source when nine conservative slots do not fit', async () => {
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 3840,
      codedHeight: 2160,
      displayWidth: 3840,
      displayHeight: 2160,
      targetWidth: 640,
      targetHeight: 360,
      workerCount: 2,
    });
    const source = budget.tryReserveSource(3840 * 2160 * 8);

    expect(source).not.toBeNull();
    expect(budget.sourceHeadroomBytes).toBeGreaterThan(FRAME_PIPELINE_MEMORY_BUDGET_BYTES);
    expect(budget.maxOutstandingTasks).toBe(1);
    const firstTarget = await budget.acquireTarget();
    let secondAcquired = false;
    const secondTarget = budget.acquireTarget().then((reservation) => {
      secondAcquired = true;
      return reservation;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    firstTarget.release();
    (await secondTarget).release();

    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('reserves and releases motion analysis within the same hard frame budget', () => {
    const budget = new WebpFrameMemoryBudget({
      codedWidth: 8,
      codedHeight: 8,
      displayWidth: 8,
      displayHeight: 8,
      targetWidth: 8,
      targetHeight: 8,
      workerCount: 1,
    });
    const analysis = budget.reserveAnalysis(37_376);
    expect(budget.usage.analysisBytes).toBe(37_376);
    const available =
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES - budget.usage.totalBytes - budget.targetTaskBytes;
    const source = budget.tryReserveSource(available);
    expect(source).not.toBeNull();
    expect(budget.tryReserveSource(1)).toBeNull();
    expect(() => budget.reserveAnalysis(1)).toThrow('motion analysis');
    analysis.release();
    expect(budget.usage.analysisBytes).toBe(0);
    source?.release();
    budget.dispose();
    expect(budget.usage.totalBytes).toBe(0);
  });

  it('admits one RGBA Worker for full-resolution 4K within the shared budget', () => {
    const width = 3840;
    const height = 2160;
    expect(
      calculateWebpWorkerCountForBudget({
        codedWidth: width,
        codedHeight: height,
        displayWidth: width,
        displayHeight: height,
        targetWidth: width,
        targetHeight: height,
        requestedWorkers: 2,
      })
    ).toBe(1);
    expect(
      calculateWebpWorkerCountForBudget({
        codedWidth: width,
        codedHeight: height,
        displayWidth: width,
        displayHeight: height,
        targetWidth: 640,
        targetHeight: 360,
        requestedWorkers: 2,
      })
    ).toBe(1);
  });

  it('selects the serial fallback when motion analysis exceeds a full Worker budget', () => {
    const options = {
      codedWidth: 4096,
      codedHeight: 2048,
      displayWidth: 4096,
      displayHeight: 2048,
      targetWidth: 4096,
      targetHeight: 2048,
      requestedWorkers: 1,
    };
    expect(calculateWebpWorkerCountForBudget(options)).toBe(1);
    expect(calculateWebpWorkerCountForBudget({ ...options, analysisBytes: 37_376 })).toBe(0);
  });
});
