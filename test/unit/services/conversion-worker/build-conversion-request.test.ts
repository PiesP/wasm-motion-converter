// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { buildConversionRequest } from '@services/conversion-worker/build-conversion-request';
import { calcAutoDecimation } from '@services/encoder-common';
import { WEBP_TARGET_FPS } from '@utils/constants';
import type { SerializedConversionOptions } from '@services/conversion-worker/types';

function createOptions(
  overrides: Partial<SerializedConversionOptions> = {}
): SerializedConversionOptions {
  return {
    format: 'webp',
    quality: 'high',
    fps: 60,
    scale: 1,
    trimStart: 0,
    trimEnd: 0,
    maxFrames: 0,
    ...overrides,
  };
}

describe('buildConversionRequest', () => {
  it('preserves an omitted force decimation for automatic WebP FPS control', () => {
    const request = buildConversionRequest(new ArrayBuffer(8), createOptions());

    expect(request.forceDecimation).toBeUndefined();
    expect(calcAutoDecimation(60, WEBP_TARGET_FPS.high, request.forceDecimation)).toBe(2);
  });

  it('preserves an explicit memory-pressure override', () => {
    const request = buildConversionRequest(
      new ArrayBuffer(8),
      createOptions({ forceDecimation: 4 })
    );

    expect(request.forceDecimation).toBe(4);
  });
});
