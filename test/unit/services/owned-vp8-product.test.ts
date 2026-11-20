// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { globalBufferPool } from '@services/buffer-pool';
import { encodeWebpOwned } from '@services/webp-encoder-service';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const wasm = readFileSync(new URL('../../../crates/owned-vp8/owned-vp8.wasm', import.meta.url));
const decoder = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    decoder.options = options;
    for (let frame = 0; frame < 2; frame++) {
      const pixels = globalBufferPool.acquire(8 * 8 * 3);
      pixels.fill(frame === 0 ? 30 : 180, 0, 8 * 8 * 3);
      const target = await options.frameMemoryBudget.acquireTarget();
      await options.onFrameAvailable(
        pixels,
        50,
        frame,
        options.frameMemoryBudget.createHandoff(target),
        { startUs: frame * 50_000, endUs: (frame + 1) * 50_000 }
      );
      expect(target.isReleased).toBe(true);
    }
    return {
      totalInputFrames: 2,
      skippedByDecimation: 0,
      smartSkipped: 0,
      consumedChunks: 2,
      selectedFrames: 2,
      presentationEndUs: 100_000,
    };
  }),
}));

function fixture() {
  const demux = {
    chunks: [],
    config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    duration: 0.1,
    framerate: 20,
    sourceTotalMs: 100,
    totalFrames: 2,
    inputBufferBytes: 0,
  };
  const options = {
    width: 8,
    height: 8,
    quality: 'low' as const,
    scale: 1,
    onEncodingComplete: vi.fn(),
    assertOwnedVp8AdditionalMemoryBytes: vi.fn(),
  };
  return { demux, options };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

describe('owned VP8 product software route', () => {
  it('encodes through ABI2, retains presentation timing, and reports exact execution', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from(wasm).buffer, {
        headers: { 'content-type': 'application/wasm' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { demux, options } = fixture();
    const complete = options.onEncodingComplete;
    const first = await encodeWebpOwned(demux, options);
    const second = await encodeWebpOwned(demux, options);
    expect(first).toEqual(second);
    expect(Array.from(first.subarray(0, 4))).toEqual([82, 73, 70, 70]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decoder.options).toEqual(
      expect.objectContaining({ pixelFormat: 'rgb', stagedCopyLookahead: false })
    );
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        consumedChunks: 2,
        encodedFrames: 2,
        emittedFrames: 2,
        ownedVp8Frames: 2,
        ownedVp8Steps: expect.any(Number),
        ownedVp8PeakActualLinearCapacityBytes: expect.any(Number),
      })
    );
    expect(complete.mock.lastCall?.[0].ownedVp8Steps).toBeGreaterThan(0);
    expect(options.assertOwnedVp8AdditionalMemoryBytes).toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'retains the final copy charge until late %s after Stop',
    async (outcome) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(Uint8Array.from(wasm).buffer, {
              headers: { 'content-type': 'application/wasm' },
            })
          )
        )
      );
      const { demux, options } = fixture();
      const copy = Promise.withResolvers<ArrayBuffer>();
      const entered = Promise.withResolvers<void>();
      vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementationOnce(() => {
        entered.resolve();
        return copy.promise;
      });
      const cancel = new AbortController();
      const pending = encodeWebpOwned(demux, options, undefined, cancel.signal);
      await entered.promise;
      cancel.abort();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(options.onEncodingComplete).not.toHaveBeenCalled();
      // Another broker cannot take the pool while the Blob still owns the bytes.
      await expect(encodeWebpOwned(demux, options)).rejects.toThrow(
        'growth guard already installed'
      );
      if (outcome === 'resolve') {
        copy.resolve(new ArrayBuffer(1));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      } else {
        const error = new Error('late output copy failure');
        copy.reject(error);
        await expect(pending).rejects.toBe(error);
      }
      expect(options.onEncodingComplete).not.toHaveBeenCalled();
      await expect(encodeWebpOwned(demux, options)).resolves.toBeInstanceOf(Uint8Array);
      expect(options.onEncodingComplete).toHaveBeenCalledOnce();
    }
  );
});
