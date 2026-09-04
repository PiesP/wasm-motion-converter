// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversionProfiler } from '@services/conversion-profiler';

describe('ConversionProfiler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no dominant stage when no work was recorded', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10);

    const report = new ConversionProfiler().finish();

    expect(report).toMatchObject({
      schemaVersion: 2,
      stages: [],
      stageWallTimePct: { demuxing: 0, transcoding: 0, finalizing: 0 },
      dominantStage: null,
    });
  });

  it('reports non-overlapping wall-clock stages and a truthful dominant stage', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(35)
      .mockReturnValueOnce(35);

    const profiler = new ConversionProfiler();
    profiler.begin('demuxing').end({ frames: 30 });
    profiler
      .begin('transcoding')
      .end({ decodedFrames: 30, encodedFrames: 20, outputBytes: 1024 * 1024 });
    profiler.begin('finalizing').end();

    const report = profiler.finish();
    expect(report.stageWallTimePct).toEqual({
      demuxing: 28.6,
      transcoding: 57.1,
      finalizing: 14.3,
    });
    expect(report.dominantStage).toBe('transcoding');
    expect(report.summary).toContain('streaming decode+encode; attribution unavailable');

    const transcode = report.stages.find((stage) => stage.stage === 'transcoding');
    expect(transcode).toMatchObject({
      mode: 'streaming-decode-encode',
      attribution: 'combined',
      decodedFrames: 30,
      encodedFrames: 20,
      decodeFps: 1500,
      encodeFps: 1000,
      outputBytes: 1024 * 1024,
      throughputMBps: 50,
    });
  });

  it('returns an idempotent immutable snapshot', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(5);

    const profiler = new ConversionProfiler();
    profiler.begin('demuxing').end({ frames: 1 });

    const first = profiler.finish();
    const second = profiler.finish();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.stages)).toBe(true);
  });
});
