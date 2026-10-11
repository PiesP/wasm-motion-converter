// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCanvasWebpCapability } from '@services/webp-capability';

function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array([0x10, 0, 0, 0x9d, 0x01, 0x2a, width, 0, height, 0]);
  const bytes = new Uint8Array(20 + frame.length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, frame.length, true);
  bytes.set(frame, 20);
  return bytes;
}

function iccWebp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const simple = webp(width, height);
  const bytes = new Uint8Array(12 + 18 + 10 + simple.length - 12);
  const view = new DataView(bytes.buffer);
  bytes.set(simple.subarray(0, 12), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  bytes[20] = 0x20;
  bytes[24] = width - 1;
  bytes[27] = height - 1;
  bytes.set([0x49, 0x43, 0x43, 0x50], 30);
  view.setUint32(34, 1, true);
  bytes[38] = 7;
  bytes.set(simple.subarray(12), 40);
  return bytes;
}

afterEach(() => vi.unstubAllGlobals());

describe('Canvas WebP capability', () => {
  it('accepts a Chromium-style ICCP chunk before opaque VP8', async () => {
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): object { return { fillRect() {}, fillStyle: '' }; }
      async convertToBlob(): Promise<Blob> { return new Blob([iccWebp(2, 2)], { type: 'image/webp' }); }
    });
    expect(await probeCanvasWebpCapability()).toBe(true);
  });
  it('accepts only a 2x2 opaque VP8 result', async () => {
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): object { return { fillRect() {}, fillStyle: '' }; }
      async convertToBlob(): Promise<Blob> { return new Blob([webp(2, 2)], { type: 'image/webp' }); }
    });
    expect(await probeCanvasWebpCapability()).toBe(true);
  });

  it('rejects a silent PNG fallback or wrong coded dimensions', async () => {
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): object { return { fillRect() {}, fillStyle: '' }; }
      async convertToBlob(): Promise<Blob> { return new Blob([webp(1, 1)], { type: 'image/webp' }); }
    });
    expect(await probeCanvasWebpCapability()).toBe(false);
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): object { return { fillRect() {}, fillStyle: '' }; }
      async convertToBlob(): Promise<Blob> { return new Blob([webp(2, 2)], { type: 'image/png' }); }
    });
    expect(await probeCanvasWebpCapability()).toBe(false);
  });
});
