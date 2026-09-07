// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pixelFormat: null as string | null,
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    mocks.pixelFormat = options.pixelFormat;
    const backing = new Uint8Array([10, 20, 30, 255, 0x7f, 0x7f, 0x7f, 0x7f]);
    await options.onFrameAvailable(backing, 100, 0);
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 100,
      tailAccumulatedMs: 0,
      totalInputFrames: 1,
    };
  }),
}));

vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));

import { globalBufferPool } from '@services/buffer-pool';
import { encodeWebpOffscreen } from '@services/offscreen-webp-encoder';

afterEach(() => {
  globalBufferPool.clear();
  vi.unstubAllGlobals();
});

describe('OffscreenCanvas WebP RGBA ownership', () => {
  it('passes an exact RGBA view to ImageData without allocating a converted frame', async () => {
    const bitstream = new Uint8Array([0x06, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0]);
    const webp = new Uint8Array(20 + bitstream.length);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x20], 12);
    new DataView(webp.buffer).setUint32(16, bitstream.length, true);
    webp.set(bitstream, 20);
    const imageDataInputs: Uint8ClampedArray[] = [];
    const putImageData = vi.fn();
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(data: Uint8ClampedArray) {
          imageDataInputs.push(data);
        }
      }
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): { putImageData: typeof putImageData } {
          return { putImageData };
        }

        async convertToBlob(): Promise<Blob> {
          return new Blob([webp], { type: 'image/webp' });
        }
      }
    );

    await expect(
      encodeWebpOffscreen(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
          duration: 0.1,
          framerate: 10,
          sourceTotalMs: 100,
          totalFrames: 1,
        },
        { height: 1, quality: 'medium', scale: 1, width: 1 }
      )
    ).resolves.toBeInstanceOf(Uint8Array);

    expect(mocks.pixelFormat).toBe('rgba');
    expect(imageDataInputs).toHaveLength(1);
    expect(imageDataInputs[0]).toEqual(new Uint8ClampedArray([10, 20, 30, 255]));
    expect(imageDataInputs[0]?.byteLength).toBe(4);
    expect(imageDataInputs[0]?.buffer.byteLength).toBe(8);
    expect(putImageData).toHaveBeenCalledOnce();
  });
});
