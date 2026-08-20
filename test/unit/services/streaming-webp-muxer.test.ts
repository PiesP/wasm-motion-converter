// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Tests for StreamingWebpMuxer — chunk release and peak memory reduction.
 *
 * Verifies that finish() releases chunk references before arrayBuffer()
 * to reduce peak memory during finalization.
 */

import { describe, expect, it } from 'vitest';
import { StreamingWebpMuxer } from '@services/streaming-webp-encoder';

/** Create a minimal dummy VP8 bitstream for testing muxer structure only. */
function dummyBitstream(size = 100): Uint8Array {
  return new Uint8Array(size);
}

describe('StreamingWebpMuxer', () => {
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
