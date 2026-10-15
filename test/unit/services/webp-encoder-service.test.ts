// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decodeOptions: null as Record<string, unknown> | null,
  encodeRGBReuse: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  finishPresentation: vi.fn(),
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    mocks.decodeOptions = options;
    options.onFrameDecoded?.(1, 1);
    await options.onFrameAvailable(new Uint8Array(3), 100, 0, undefined, {
      startUs: 0,
      endUs: 100_000,
    });
    return {
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 175,
      tailAccumulatedMs: 0,
      presentationEndUs: 175_000,
      totalInputFrames: 1,
      consumedChunks: 3,
      selectedFrames: 1,
    };
  }),
}));
vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));
vi.mock('@services/streaming-webp-encoder', () => ({
  extractVP8Bitstream: (value: Uint8Array) => value,
  StreamingWebpMuxer: class {
    frames = 0;
    addPresentationFrame(): void {
      this.frames++;
    }
    finishPresentation = mocks.finishPresentation;
    async finish(): Promise<Uint8Array> {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));
vi.mock('@services/wasm-webp-singleton', () => ({
  encodeRGBReuse: mocks.encodeRGBReuse,
}));

import { encodeWebp } from '@services/webp-encoder-service';

describe('encodeWebp timing', () => {
  it('finalizes the last hold at the visible source endpoint', async () => {
    const onFrameDecoded = vi.fn();
    const onFrameEncoded = vi.fn();
    const onEncodingComplete = vi.fn();
    await encodeWebp(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.175,
        framerate: 30,
        sourceTotalMs: 175,
        totalFrames: 1,
      },
      {
        width: 1,
        height: 1,
        quality: 'medium',
        scale: 1,
        frameDecimation: 1.05,
        minimumSourceFrameGap: 2,
        pressureCadenceRatio: 1.4,
        onFrameDecoded,
        onFrameEncoded,
        onEncodingComplete,
      }
    );

    expect(mocks.finishPresentation).toHaveBeenCalledWith(175_000);
    expect(mocks.encodeRGBReuse).toHaveBeenCalledWith(expect.any(Uint8Array), 1, 1, 75);
    expect(mocks.decodeOptions).not.toHaveProperty('maxInputChunks');
    expect(mocks.decodeOptions).toEqual(
      expect.objectContaining({
        frameDecimation: 1.05,
        minimumSourceFrameGap: 2,
        pressureCadenceRatio: 1.4,
      })
    );
    expect(onFrameDecoded).toHaveBeenCalledWith(1, 1);
    expect(onFrameEncoded).toHaveBeenCalledWith(1, 1);
    expect(onEncodingComplete).toHaveBeenCalledWith({
      consumedChunks: 3,
      decodedFrames: 1,
      selectedFrames: 1,
      encodedFrames: 1,
      emittedFrames: 1,
    });
  });
});
