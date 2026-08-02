// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { buildEncodingProgress } from '@services/conversion-progress';
import { describe, expect, it } from 'vitest';

describe('conversion encoding progress policy', () => {
  it('maps an encoder frame into the weighted encoding phase', () => {
    expect(
      buildEncodingProgress({
        progressFrame: 10,
        currentFrame: 10,
        etaFrame: 10,
        totalFrames: 20,
        fps: 5,
        memoryMB: 128,
        elapsedMs: 2500,
      })
    ).toEqual({
      phase: 'encoding',
      progress: 83,
      fps: 5,
      etaSeconds: 2,
      memoryMB: 128,
      currentFrame: 10,
      totalFrames: 20,
      elapsedMs: 2500,
    });
  });

  it('caps progress at the encoding phase maximum', () => {
    expect(
      buildEncodingProgress({
        progressFrame: 30,
        currentFrame: 30,
        etaFrame: 30,
        totalFrames: 20,
        fps: 5,
        memoryMB: 0,
        elapsedMs: 0,
      }).progress
    ).toBe(93);
  });

  it('preserves separate progress and displayed frame fallbacks', () => {
    expect(
      buildEncodingProgress({
        progressFrame: 5,
        currentFrame: 0,
        etaFrame: null,
        totalFrames: 20,
        fps: 5,
        memoryMB: 64,
        elapsedMs: 1000,
      })
    ).toMatchObject({ progress: 78, currentFrame: 0, etaSeconds: null });
  });
});
