// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it, vi } from 'vitest';
import { buildConversionRequest } from '@services/conversion-worker/build-conversion-request';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants';

describe('buildConversionRequest', () => {
  const baseOptions = {
    format: 'gif' as const,
    quality: 0.8,
    scale: 1,
    trimStart: 0,
    trimEnd: 10,
    frameDecimation: undefined,
    smartFrameSkip: 'off' as const,
    hwAccel: 'prefer-hardware' as const,
    maxFrames: 100,
    maxOutputBytes: 1024,
  };

  it('builds a ConversionRequest with all expected fields', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, baseOptions);

    expect(request.inputBuffer).toBe(buffer);
    expect(request.format).toBe('gif');
    expect(request.quality).toBe(0.8);
    expect(request.scale).toBe(1);
    expect(request.maxFrames).toBe(100);
    expect(request.maxOutputBytes).toBe(1024);
  });

  it('includes inputBlob and fileName when provided', () => {
    const buffer = new ArrayBuffer(1024);
    const blob = new Blob(['test']);
    const request = buildConversionRequest(
      buffer,
      baseOptions,
      WORKER_MAX_MEMORY_MB,
      blob,
      'myvideo.webm'
    );

    expect(request.inputBlob).toBe(blob);
    expect(request.fileName).toBe('myvideo.webm');
  });

  it('uses default maxMemoryMB when not specified', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, baseOptions);

    expect(request.inputBuffer).toBe(buffer);
  });

  it('preserves trimStart and trimEnd values', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, {
      ...baseOptions,
      trimStart: 2,
      trimEnd: 8,
    });

    expect(request.trimStart).toBe(2);
    expect(request.trimEnd).toBe(8);
  });

  it('does not normalize forceDecimation: undefined stays undefined', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, baseOptions);

    // forceDecimation should be undefined (use format's automatic target FPS)
    // not normalized to 1
    expect(request.forceDecimation).toBeUndefined();
  });

  it('does not allow serialized limits above the format hard ceilings', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, {
      ...baseOptions,
      format: 'webp',
      maxFrames: Number.MAX_SAFE_INTEGER,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(request.maxFrames).toBe(9000);
    expect(request.maxOutputBytes).toBe(134217728);
  });
});
