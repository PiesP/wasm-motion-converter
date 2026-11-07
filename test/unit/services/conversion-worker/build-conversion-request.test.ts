// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { buildConversionRequest } from '@services/conversion-worker/build-conversion-request';
import type { SerializedConversionOptions } from '@services/conversion-worker/types';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants';
import { describe, expect, it } from 'vite-plus/test';

describe('buildConversionRequest', () => {
  const baseOptions: SerializedConversionOptions = {
    format: 'gif',
    quality: 'medium',
    fps: 30,
    scale: 1,
    trimStart: 0,
    trimEnd: 10,
    smartFrameSkip: 'off',
    maxFrames: 100,
    maxOutputBytes: 1024,
  };

  it('builds a ConversionRequest with all expected fields', () => {
    const buffer = new ArrayBuffer(1024);
    const request = buildConversionRequest(buffer, baseOptions);

    expect(request.inputBuffer).toBe(buffer);
    expect(request.format).toBe('gif');
    expect(request.quality).toBe('medium');
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

  it('reuses the admitted decoder fields without normalizing false, zero, or absent fields', () => {
    const description = new Uint8Array([1, 2, 3]).buffer;
    const request = buildConversionRequest(
      undefined,
      baseOptions,
      WORKER_MAX_MEMORY_MB,
      new Blob(),
      'clip.mp4',
      {
        codec: 'avc1.640028',
        codedWidth: 16,
        codedHeight: 9,
        colorSpace: { fullRange: false },
        description,
        displayAspectWidth: 4,
        displayAspectHeight: 3,
        hardwareAcceleration: 'prefer-hardware',
        rotation: 0,
      },
      0,
      0
    );

    expect(request.preComputedMetadata).toEqual({
      config: {
        codec: 'avc1.640028',
        codedWidth: 16,
        codedHeight: 9,
        colorSpace: { fullRange: false },
        description,
        displayAspectWidth: 4,
        displayAspectHeight: 3,
        hardwareAcceleration: 'prefer-hardware',
      },
      duration: 0,
      framerate: 0,
      rotation: 0,
    });
    expect(request.preComputedMetadata?.config?.description).toBe(description);
    expect(buildConversionRequest(undefined, baseOptions)).not.toHaveProperty(
      'preComputedMetadata'
    );
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

  it('preserves fractional memory cadence separately from an explicit frame gap', () => {
    const request = buildConversionRequest(new ArrayBuffer(0), {
      ...baseOptions,
      forceDecimation: 2,
      memoryPressureCadenceRatio: 1.4,
    });
    expect(request.forceDecimation).toBe(2);
    expect(request.memoryPressureCadenceRatio).toBe(1.4);
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
    expect(request.maxOutputBytes).toBe(100663296);
  });
});
