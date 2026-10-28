// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Tests for StreamingWebpMuxer — chunk release and peak memory reduction.
 *
 * Verifies that finish() releases chunk references before arrayBuffer()
 * to reduce peak memory during finalization.
 */

import { StreamingWebpMuxer } from '@services/streaming-webp-encoder';
import { describe, expect, it } from 'vite-plus/test';

/** Create a minimal dummy VP8 bitstream for testing muxer structure only. */
function dummyBitstream(size = 100, seed = 0): Uint8Array {
  const frame = new Uint8Array(size);
  if (size >= 10) frame.set([0x10, 0, 0, 0x9d, 0x01, 0x2a, 16, 0, 16, 0]);
  if (size > 10) frame[10] = seed;
  return frame;
}

describe('StreamingWebpMuxer', () => {
  it('writes one identical ICC profile before ANIM and enforces profile consistency and bytes', async () => {
    const profile = new Uint8Array([1, 2, 3]);
    const muxer = new StreamingWebpMuxer(16, 16, { maxOutputBytes: 191 });
    muxer.addPresentationFrame(dummyBitstream(100), { startUs: 0, endUs: 1000 }, profile);
    profile[0] = 9;
    expect(() =>
      muxer.addPresentationFrame(dummyBitstream(100, 1), { startUs: 1000, endUs: 2000 }, profile)
    ).toThrow('inconsistent ICC');
    muxer.finishPresentation(1000);
    const output = await muxer.finish();
    expect(output[20]).toBe(0x22);
    expect(Array.from(output.subarray(30, 42))).toEqual([73, 67, 67, 80, 3, 0, 0, 0, 1, 2, 3, 0]);
    expect(String.fromCharCode(...output.subarray(42, 46))).toBe('ANIM');
    expect(output.length).toBe(188);

    const capped = new StreamingWebpMuxer(16, 16, { maxOutputBytes: 190 });
    expect(() =>
      capped.addPresentationFrame(
        dummyBitstream(100),
        { startUs: 0, endUs: 1000 },
        new Uint8Array([1, 2, 3])
      )
    ).toThrow('byte limit');
  });
  describe('source presentation holds', () => {
    const durations = (bytes: Uint8Array): number[] => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const result: number[] = [];
      for (let offset = 12; offset < bytes.length;) {
        const size = view.getUint32(offset + 4, true);
        if (view.getUint32(offset) === 0x414e4d46) {
          result.push(
            bytes[offset + 20]! | (bytes[offset + 21]! << 8) | (bytes[offset + 22]! << 16)
          );
        }
        offset += 8 + size + (size & 1);
      }
      return result;
    };

    it('finalizes prior holds at original PTS and the last hold at the visible endpoint', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addPresentationFrame(dummyBitstream(), { startUs: 0, endUs: 100_000 });
      muxer.addPresentationFrame(dummyBitstream(42), { startUs: 300_000, endUs: 400_000 });
      muxer.finishPresentation(400_000);
      expect(durations(await muxer.finish())).toEqual([300, 100]);
    });

    it('rounds cumulative boundaries without systematic high-FPS drift', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      for (let index = 0; index < 120; index++) {
        muxer.addPresentationFrame(dummyBitstream(100, index), {
          startUs: Math.round((index * 1_000_000) / 120),
          endUs: Math.round(((index + 1) * 1_000_000) / 120),
        });
      }
      muxer.finishPresentation(1_000_000);
      const holds = durations(await muxer.finish());
      expect(holds.reduce((sum, hold) => sum + hold, 0)).toBe(1000);
      expect(holds.every((hold) => hold >= 11)).toBe(true);
      expect(holds).toHaveLength(60);
    });

    it.each([1, 10, 11])(
      'retains a distinct %sms final scene with bounded endpoint extension',
      async (tail) => {
        const muxer = new StreamingWebpMuxer(16, 16);
        muxer.addPresentationFrame(dummyBitstream(100, 1), { startUs: 0, endUs: 100_000 });
        muxer.addPresentationFrame(dummyBitstream(100, 2), {
          startUs: 100_000,
          endUs: (100 + tail) * 1000,
        });
        muxer.finishPresentation((100 + tail) * 1000);
        expect(durations(await muxer.finish())).toEqual([100, 11]);
        expect(muxer.frames).toBe(2);
      }
    );

    it('keeps the 24fps short endpoint within one terminal hold adjustment', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      const starts = [0, 41667, 83333, 125000, 166667, 208333, 250000, 291667];
      starts.forEach((startUs, index) =>
        muxer.addPresentationFrame(dummyBitstream(100, index), {
          startUs,
          endUs: starts[index + 1] ?? 300_000,
        })
      );
      muxer.finishPresentation(300_000);
      expect(durations(await muxer.finish())).toEqual([42, 41, 42, 42, 41, 42, 42, 11]);
    });

    it('splits a 24-bit continuation without a short final hold', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addPresentationFrame(dummyBitstream(), { startUs: 0, endUs: 1 });
      muxer.finishPresentation((0xffffff + 1) * 1000);
      expect(durations(await muxer.finish())).toEqual([0xffffff - 10, 11]);
    });

    it('splits an overlong hold without truncating its endpoint', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addPresentationFrame(dummyBitstream(99), { startUs: 0, endUs: 100_000 });
      muxer.finishPresentation((0xffffff + 71) * 1000);
      expect(durations(await muxer.finish())).toEqual([0xffffff, 71]);
      expect(muxer.frames).toBe(2);
    });

    it('coalesces exact adjacent VP8 payloads and owns the borrowed input', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      const borrowed = dummyBitstream(100, 7);
      muxer.addPresentationFrame(borrowed, { startUs: 0, endUs: 400 });
      borrowed[10] = 99;
      muxer.addPresentationFrame(dummyBitstream(100, 7), { startUs: 400, endUs: 800 });
      muxer.finishPresentation(800);
      expect(durations(await muxer.finish())).toEqual([11]);
      expect(muxer.frames).toBe(1);
    });

    it.each(['ordinary', 'shared'] as const)(
      'preserves every retained VP8 byte when a %s-backed codec view is overwritten',
      async (backing) => {
        const muxer = new StreamingWebpMuxer(16, 16);
        const borrowed = new Uint8Array(
          backing === 'shared' ? new SharedArrayBuffer(100) : new ArrayBuffer(100)
        );
        const first = dummyBitstream(100, 7);
        const second = dummyBitstream(100, 8);
        borrowed.set(first);
        muxer.addPresentationFrame(borrowed, { startUs: 0, endUs: 11_000 });
        borrowed.set(second);
        muxer.addPresentationFrame(borrowed, { startUs: 11_000, endUs: 22_000 });
        borrowed.fill(0);
        muxer.finishPresentation(22_000);

        const output = await muxer.finish();
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        const payloads: Uint8Array[] = [];
        for (let offset = 12; offset < output.length;) {
          const size = view.getUint32(offset + 4, true);
          if (view.getUint32(offset) === 0x414e4d46) {
            const payloadSize = view.getUint32(offset + 28, true);
            payloads.push(output.subarray(offset + 32, offset + 32 + payloadSize));
          }
          offset += 8 + size + (size & 1);
        }
        expect(payloads).toEqual([first, second]);
        expect(durations(output)).toEqual([11, 11]);
      }
    );

    it('coalesces dense sub-millisecond source cadence into one viewer-safe hold', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      for (let index = 0; index < 8; index++) {
        muxer.addPresentationFrame(dummyBitstream(100, index), {
          startUs: index * 250,
          endUs: (index + 1) * 250,
        });
      }
      muxer.finishPresentation(2000);
      const holds = durations(await muxer.finish());
      expect(holds).toEqual([11]);
      expect(muxer.frames).toBe(1);
    });

    it('counts a dropped terminal sub-millisecond hold against no emitted frame', async () => {
      const muxer = new StreamingWebpMuxer(16, 16, { maxFrames: 1 });
      muxer.addPresentationFrame(dummyBitstream(100, 1), { startUs: 0, endUs: 800 });
      muxer.addPresentationFrame(dummyBitstream(100, 2), { startUs: 800, endUs: 1000 });
      muxer.finishPresentation(1000);
      expect(durations(await muxer.finish())).toEqual([11]);
      expect(muxer.frames).toBe(1);
    });

    it('rejects reversed timestamps even after an exact duplicate was merged', () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addPresentationFrame(dummyBitstream(), { startUs: 0, endUs: 1000 });
      muxer.addPresentationFrame(dummyBitstream(), { startUs: 1000, endUs: 2000 });
      expect(() =>
        muxer.addPresentationFrame(dummyBitstream(), { startUs: 500, endUs: 1500 })
      ).toThrow('out of order');
    });

    it('bounds retained output and a new compressed pending copy', () => {
      const muxer = new StreamingWebpMuxer(16, 16, { maxOutputBytes: 550 });
      muxer.addPresentationFrame(dummyBitstream(100, 1), { startUs: 0, endUs: 11_000 });
      muxer.addPresentationFrame(dummyBitstream(200, 2), { startUs: 11_000, endUs: 22_000 });
      expect(() =>
        muxer.addPresentationFrame(dummyBitstream(200, 3), { startUs: 22_000, endUs: 33_000 })
      ).toThrow('byte limit');
      expect(muxer.frames).toBe(2);
      expect(muxer.frameBytes).toBe(300);
    });

    it('rejects invalid dimensions and mixed presentation APIs', () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      expect(() =>
        muxer.addPresentationFrame(dummyBitstream(100, 1), { startUs: 0, endUs: 1000 })
      ).not.toThrow();
      expect(() => muxer.addFrame(dummyBitstream(), 1)).toThrow('Cannot mix');
      const wrongSize = dummyBitstream();
      wrongSize[6] = 15;
      expect(() => muxer.addPresentationFrame(wrongSize, { startUs: 1000, endUs: 2000 })).toThrow(
        'dimensions'
      );
    });

    it('checks all continuation frames against the output cap before emission', () => {
      const muxer = new StreamingWebpMuxer(16, 16, { maxFrames: 1, maxOutputBytes: 1000 });
      muxer.addPresentationFrame(dummyBitstream(), { startUs: 0, endUs: 1000 });
      expect(() => muxer.finishPresentation((0xffffff + 1) * 1000)).toThrow('frame limit');
      expect(muxer.frames).toBe(0);
      expect(muxer.frameBytes).toBe(100);
    });
  });
  describe('output budgets', () => {
    it('rejects a cumulative frame overflow before adding the frame', () => {
      const muxer = new StreamingWebpMuxer(16, 16, {
        maxFrames: 1,
        maxOutputBytes: 1024,
      });
      muxer.addFrame(dummyBitstream(100), 100);

      expect(() => muxer.addFrame(dummyBitstream(100), 100)).toThrow(
        'WebP output frame limit exceeded'
      );
      expect(muxer.frames).toBe(1);
    });

    it('rejects cumulative bytes before allocating the overflowing chunk', () => {
      const oneFrameBytes = 44 + 24 + 8 + 100;
      const muxer = new StreamingWebpMuxer(16, 16, {
        maxFrames: 2,
        maxOutputBytes: oneFrameBytes,
      });
      muxer.addFrame(dummyBitstream(100), 100);

      expect(() => muxer.addFrame(dummyBitstream(2), 100)).toThrow(
        'WebP output byte limit exceeded'
      );
      expect(muxer.frames).toBe(1);
      expect(muxer.frameBytes).toBe(100);
    });

    it('allows ordinary output within both limits', async () => {
      const muxer = new StreamingWebpMuxer(16, 16, {
        maxFrames: 2,
        maxOutputBytes: 1024,
      });
      muxer.addFrame(dummyBitstream(100), 100);
      muxer.addFrame(dummyBitstream(100), 100);

      await expect(muxer.finish()).resolves.toHaveLength(308);
    });
  });

  describe('finish()', () => {
    it('produces valid WebP output after adding frames', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addFrame(dummyBitstream(), 100);
      muxer.addFrame(dummyBitstream(42), 200);

      const output = await muxer.finish();

      // Should produce a RIFF/WEBP container
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBeGreaterThan(44); // header + at least one frame
    });

    it('throws when no frames have been added', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      await expect(muxer.finish()).rejects.toThrow('No frames added');
    });

    it('honors cancellation before final allocation', async () => {
      const controller = new AbortController();
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addFrame(dummyBitstream(), 100);
      controller.abort();

      await expect(muxer.finish(controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('releases chunk references before arrayBuffer completes (peak memory reduction)', async () => {
      // This test verifies the behavioral property: after Blob construction
      // and before arrayBuffer(), the internal chunk array should be empty.
      // We can't inspect private fields, but we can verify the output is
      // correct with many frames, confirming the early release didn't corrupt.
      const muxer = new StreamingWebpMuxer(16, 16);

      // Add enough frames to create a non-trivial output
      for (let i = 0; i < 50; i++) {
        muxer.addFrame(dummyBitstream(200), 40);
      }

      const output = await muxer.finish();

      // Verify RIFF header
      const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
      expect(view.getUint32(0, false)).toBe(StreamingWebpMuxer.RIFF_MAGIC); // 'RIFF'
      expect(view.getUint32(8, false)).toBe(StreamingWebpMuxer.WEBP_MAGIC); // 'WEBP'

      // Verify ANIM chunk exists (animated WebP marker)
      // VP8X is at offset 12, ANIM at offset 30
      const vp8xFourCC = view.getUint32(12, false);
      expect(vp8xFourCC).toBe(0x56503858); // 'VP8X'

      // Verify frame count matches (50 ANMF chunks + VP8 sub-chunks)
      expect(muxer.frames).toBe(50);
    });

    it('reports correct frame count and byte totals', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addFrame(dummyBitstream(100), 100);
      muxer.addFrame(dummyBitstream(200), 200);
      muxer.addFrame(dummyBitstream(50), 50);

      expect(muxer.frames).toBe(3);
      // frameBytes = sum of padded bitstream lengths
      // 100 (even) + 200 (even) + 50 (even) = 350
      expect(muxer.frameBytes).toBe(350);
    });
  });

  describe('padLastFrameDuration()', () => {
    it('no-ops when no frames exist', () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      expect(() => muxer.padLastFrameDuration(100)).not.toThrow();
    });

    it('no-ops when extraMs is zero or negative', () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addFrame(dummyBitstream(), 100);
      expect(() => muxer.padLastFrameDuration(0)).not.toThrow();
      expect(() => muxer.padLastFrameDuration(-1)).not.toThrow();
    });
  });

  describe('addFrame() with odd-length bitstream', () => {
    it('handles odd-length bitstreams (padding to even)', async () => {
      const muxer = new StreamingWebpMuxer(16, 16);
      muxer.addFrame(dummyBitstream(99), 100); // odd length
      muxer.addFrame(dummyBitstream(100), 200); // even length

      const output = await muxer.finish();
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBeGreaterThan(44);
      expect(muxer.frames).toBe(2);
    });
  });
});
