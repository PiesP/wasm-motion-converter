// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  frameCount: 2,
  writeFrame: vi.fn(),
}));

vi.mock('@services/gif-scalar-wasm', () => ({
  createGifScalarQuantizer: async () => {
    let prepared: Uint8Array = new Uint8Array();
    return Object.assign((rgba: Uint8Array) => [[rgba[0]!, rgba[0]!, rgba[0]!]], {
      prepare: (rgba: Uint8Array) => {
        prepared = rgba;
      },
      quantizePrepared: () => [[prepared[0]!, prepared[0]!, prepared[0]!]],
      mapPalette: () => Uint8Array.of(0),
      compress: () => Uint8Array.of(2, 2, 0),
    });
  },
}));
vi.mock('@services/gif-owned-writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/gif-owned-writer')>();
  return {
    OwnedGifWriter: class extends actual.OwnedGifWriter {
      override writeFrame(
        ...args: Parameters<InstanceType<typeof actual.OwnedGifWriter>['writeFrame']>
      ): void {
        mocks.writeFrame(...args);
        super.writeFrame(...args);
      }
    },
  };
});
vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    for (let frame = 0; frame < mocks.frameCount; frame++) {
      await options.onFrameAvailable(
        new Uint8Array([frame, frame, frame, 255]),
        100,
        frame,
        undefined,
        { startUs: frame * 100_000, endUs: (frame + 1) * 100_000 }
      );
    }
    return {
      totalInputFrames: mocks.frameCount,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: mocks.frameCount * 100,
      presentationEndUs: mocks.frameCount * 100_000,
      consumedChunks: mocks.frameCount,
      decodedFrames: mocks.frameCount,
      selectedFrames: mocks.frameCount,
    };
  }),
}));
vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({ getSkipCount: () => 0, shouldSkip: () => false }),
}));

import { encodeGif } from '@services/gif-encoder-service';
import { OwnedGifWriter } from '@services/gif-owned-writer';

const demux = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
  duration: 0.2,
  framerate: 30,
  sourceTotalMs: 200,
  totalFrames: 2,
};
const frameOptions = { palette: [[0, 0, 0]], colorDepth: 2, repeat: 0, delay: 20 };

beforeEach(() => {
  mocks.frameCount = 2;
  mocks.writeFrame.mockClear();
});

describe('owned GIF output admission', () => {
  it('rejects the second output frame before writing it', async () => {
    await expect(
      encodeGif(demux, {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        maxFrames: 1,
        maxOutputBytes: 32_768,
      })
    ).rejects.toThrow('GIF output frame limit exceeded');
    expect(mocks.writeFrame).toHaveBeenCalledOnce();
  });

  it('rejects cumulative output beyond the byte ceiling', () => {
    const writer = new OwnedGifWriter(
      64,
      70,
      () => {},
      () => new Uint8Array(300)
    );
    expect(() => writer.writeFrame(Uint8Array.of(0), 1, 1, frameOptions)).toThrow(
      'GIF output byte limit exceeded'
    );
    expect(writer.stream.buffer.byteLength).toBe(64);
  });

  it('charges old and new stream capacities before geometric growth', () => {
    const admissions: number[] = [];
    const writer = new OwnedGifWriter(
      4096,
      10_000,
      (bytes: number) => admissions.push(bytes),
      () => new Uint8Array(5000)
    );
    expect(() => writer.writeFrame(Uint8Array.of(0), 1, 1, frameOptions)).toThrow(
      'GIF output byte limit exceeded'
    );
    expect(writer.stream.buffer.byteLength).toBe(4096);
    expect(admissions.every((bytes) => bytes === 4096)).toBe(true);
  });

  it('allows a bounded frame and charges the final output copy', async () => {
    mocks.frameCount = 1;
    const admissions: number[] = [];
    const output = await encodeGif(demux, {
      width: 1,
      height: 1,
      quality: 'low',
      scale: 1,
      maxFrames: 1,
      maxOutputBytes: 8192,
      assertAdditionalMemoryBytes: (bytes: number) => admissions.push(bytes),
    });
    expect(output.subarray(0, 6)).toEqual(new TextEncoder().encode('GIF89a'));
    expect(output.at(-1)).toBe(0x3b);
    expect(admissions.some((bytes) => bytes >= 4096 + output.byteLength)).toBe(true);
  });

  it('rejects aggregate stream growth before allocation', () => {
    const writer = new OwnedGifWriter(
      4096,
      20_000,
      (bytes: number) => {
        if (bytes > 10_000) throw new Error('aggregate memory limit exceeded');
      },
      () => new Uint8Array(5000)
    );
    expect(() => writer.writeFrame(Uint8Array.of(0), 1, 1, frameOptions)).toThrow(
      'aggregate memory limit exceeded'
    );
    expect(writer.stream.buffer.byteLength).toBe(4096);
  });
});
