// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { assessEnvironmentCapabilities } from '@utils/environment-capabilities';
import { describe, expect, it } from 'vitest';

describe('assessEnvironmentCapabilities', () => {
  const requiredCapabilities = {
    VideoDecoder: class {},
    VideoFrame: class {},
    WebAssembly: {},
  };

  it('accepts the conversion environment without cross-origin isolation', () => {
    expect(
      assessEnvironmentCapabilities({
        ...requiredCapabilities,
        SharedArrayBuffer: undefined,
        crossOriginIsolated: false,
      })
    ).toMatchObject({
      isSupported: true,
      hasWebCodecs: true,
      hasWebAssembly: true,
      hasSharedArrayBuffer: false,
      isCrossOriginIsolated: false,
    });
  });

  it.each([
    ['VideoDecoder', { VideoDecoder: undefined }],
    ['VideoFrame', { VideoFrame: undefined }],
    ['WebAssembly', { WebAssembly: undefined }],
  ] as const)('rejects an environment without %s', (_name, missingCapability) => {
    expect(
      assessEnvironmentCapabilities({
        ...requiredCapabilities,
        SharedArrayBuffer: class {},
        crossOriginIsolated: true,
        ...missingCapability,
      }).isSupported
    ).toBe(false);
  });

  it('reports cross-origin isolation as an optional capability', () => {
    expect(
      assessEnvironmentCapabilities({
        ...requiredCapabilities,
        SharedArrayBuffer: class {},
        crossOriginIsolated: true,
      })
    ).toMatchObject({
      isSupported: true,
      hasSharedArrayBuffer: true,
      isCrossOriginIsolated: true,
    });
  });
});
