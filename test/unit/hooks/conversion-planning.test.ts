// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  buildConversionMemoryPlan,
  resolveMemoryPressureDecimation,
  serializeConversionInputs,
} from '@hooks/conversion-handlers/conversion-planning';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { describe, expect, it } from 'vitest';

const defaultSettings: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 1,
  smartFrameSkip: 'off',
  trimEnd: 0,
  trimStart: 0,
};

const defaultMetadata: VideoMetadata = {
  bitrate: 1_000_000,
  codec: 'vp9',
  config: { codec: 'vp09.00.10.08', codedHeight: 1080, codedWidth: 1920 },
  duration: 2,
  framerate: 60,
  height: 1080,
  width: 1920,
};

describe('buildConversionMemoryPlan', () => {
  it.each([
    ['missing metadata', null, { ...defaultSettings, quality: 'high' as const }],
    ['non-high quality', defaultMetadata, defaultSettings],
    ['reduced scale', defaultMetadata, { ...defaultSettings, quality: 'high' as const, scale: 0.75 as const }],
  ])('skips memory probing for %s', (_name, metadata, settings) => {
    expect(buildConversionMemoryPlan(metadata, settings)).toBeNull();
  });

  it.each([
    ['gif', 20, 40],
    ['webp', 30, 60],
  ] as const)('plans decimated frame count and target FPS for %s', (format, targetFps, frames) => {
    const plan = buildConversionMemoryPlan(defaultMetadata, {
      ...defaultSettings,
      format,
      quality: 'high',
    });

    expect(plan).toEqual({
      estimatedFrames: frames,
      format,
      height: 1080,
      sourceFps: 60,
      targetFps,
      width: 1920,
    });
  });

  it.each([
    ['gif', 20, 200],
    ['webp', 30, 300],
  ] as const)('uses the selected trim range when estimating %s memory', (format, targetFps, frames) => {
    const plan = buildConversionMemoryPlan(
      { ...defaultMetadata, duration: 120 },
      {
        ...defaultSettings,
        format,
        quality: 'high',
        trimEnd: 20,
        trimStart: 10,
      }
    );

    expect(plan?.estimatedFrames).toBe(frames);
    expect(plan?.targetFps).toBe(targetFps);
  });

  it('uses full duration for the full-duration trim sentinel and clamps trim values', () => {
    const fullDuration = buildConversionMemoryPlan(
      { ...defaultMetadata, duration: 2 },
      { ...defaultSettings, quality: 'high', trimEnd: 0, trimStart: 0 }
    );
    const clamped = buildConversionMemoryPlan(
      { ...defaultMetadata, duration: 2 },
      { ...defaultSettings, quality: 'high', trimEnd: 20, trimStart: -10 }
    );

    expect(fullDuration?.estimatedFrames).toBe(40);
    expect(clamped?.estimatedFrames).toBe(40);
  });

  it('uses a bounded fallback frame estimate when duration is unavailable', () => {
    const plan = buildConversionMemoryPlan(
      { ...defaultMetadata, duration: 0 },
      { ...defaultSettings, quality: 'high' }
    );

    expect(plan?.estimatedFrames).toBe(300);
  });
});

describe('resolveMemoryPressureDecimation', () => {
  const plan = {
    estimatedFrames: 120,
    format: 'gif' as const,
    height: 1080,
    sourceFps: 60,
    targetFps: 20,
    width: 1920,
  };

  it.each(['ok', 'warning'] as const)('preserves configured sampling for %s memory', (level) => {
    expect(resolveMemoryPressureDecimation(plan, level)).toBeUndefined();
  });

  it('derives decimation only for critical memory pressure', () => {
    expect(resolveMemoryPressureDecimation(plan, 'critical')).toBe(4);
  });
});

describe('serializeConversionInputs', () => {
  it('serializes decoder metadata and normalized settings without reading a store', () => {
    const description = new Uint8Array([0x01, 0xab, 0xff]).buffer;
    const metadata: VideoMetadata = {
      ...defaultMetadata,
      rotation: 270,
      config: {
        codec: 'avc1.640028',
        codedHeight: 1080,
        codedWidth: 1920,
        description,
        displayAspectHeight: 9,
        displayAspectWidth: 16,
        hardwareAcceleration: 'prefer-hardware',
      },
    };

    expect(
      serializeConversionInputs(metadata, 4, {
        ...defaultSettings,
        smartFrameSkip: 'medium',
        trimEnd: 1.5,
        trimStart: -1,
      })
    ).toEqual({
      serializedConfig: {
        codec: 'avc1.640028',
        codedHeight: 1080,
        codedWidth: 1920,
        description,
        displayAspectHeight: 9,
        displayAspectWidth: 16,
        hardwareAcceleration: 'prefer-hardware',
        rotation: 270,
      },
      serializedOptions: {
        forceDecimation: 4,
        format: 'gif',
        fps: 60,
        maxFrames: 9000,
        maxOutputBytes: 268435456,
        quality: 'medium',
        scale: 1,
        smartFrameSkip: 'medium',
        trimEnd: 1.5,
        trimStart: 0,
      },
    });
  });

  it('does not clone an unused decoder description for WebP conversion', () => {
    const description = new Uint8Array([0x01, 0xab, 0xff]).buffer;
    const metadata: VideoMetadata = {
      ...defaultMetadata,
      config: {
        codec: 'avc1.640028',
        codedHeight: 1080,
        codedWidth: 1920,
        description,
      },
    };

    const result = serializeConversionInputs(metadata, undefined, {
      ...defaultSettings,
      format: 'webp',
    });

    expect(result.serializedConfig).not.toHaveProperty('description');
  });

  it('uses protocol defaults when metadata and decoder config are unavailable', () => {
    expect(serializeConversionInputs(null, undefined, defaultSettings)).toEqual({
      serializedConfig: null,
      serializedOptions: expect.objectContaining({
        forceDecimation: undefined,
        fps: 30,
        trimEnd: 0,
        trimStart: 0,
      }),
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'replaces an invalid metadata frame rate (%s) with the protocol default',
    (framerate) => {
      const result = serializeConversionInputs(
        { ...defaultMetadata, framerate },
        undefined,
        defaultSettings
      );

      expect(result.serializedOptions.fps).toBe(30);
    }
  );

  it('preserves malformed display aspect fields so the worker allocation boundary can reject them', () => {
    const metadata: VideoMetadata = {
      ...defaultMetadata,
      config: {
        codec: 'avc1.640028',
        codedHeight: 1080,
        codedWidth: 1920,
        displayAspectHeight: 1080,
        displayAspectWidth: 0,
      },
    };

    expect(serializeConversionInputs(metadata, undefined, defaultSettings).serializedConfig).toEqual(
      expect.objectContaining({
        displayAspectHeight: 1080,
        displayAspectWidth: 0,
      })
    );
  });
});
