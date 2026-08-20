// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * OffscreenCanvas-based WebP Encoder Service
 *
 * Uses OffscreenCanvas.convertToBlob({ type: 'image/webp' }) for each frame,
 * then extracts the VP8 bitstream and assembles frames into an animated WebP
 * container using the existing StreamingWebpMuxer RIFF structure.
 *
 * Performance: OffscreenCanvas.convertToBlob is ~3x faster than wasm-webp's
 * encodeRGB for 1080p frames (90ms vs 287ms).
 *
 * Pipeline:
 *   1. decodeFrames streams frames via onFrameAvailable callback
 *   2. Per frame: putImageData → convertToBlob → extract VP8 bitstream
 *   3. Feed to StreamingWebpMuxer for animated container assembly
 */

import type { ProgressCallback } from '@t/conversion-types';
import { getCanvasWebpQuality } from '@utils/constants';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { convertRGBToRGBA } from './frame-utils';
import { withPooledBuffer } from './pooled-buffer';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import { extractAndNormalizeCanvasVp8 } from './webp-bitstream';

/**
 * Check if OffscreenCanvas is available in the current context.
 *
 * OffscreenCanvas may not be available in:
 * - Some Worker threads (depends on browser)
 * - Very old browsers
 * - Node.js (no DOM)
 */
function isOffscreenCanvasAvailable(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/**
 * Extract the VP8 bitstream from a single-frame WebP file produced by
 * OffscreenCanvas.convertToBlob.
 *
 * OffscreenCanvas may produce either:
 * 1. Simple VP8 WebP: RIFF → WEBP → "VP8 " → bitstream
 * 2. Extended VP8X WebP: RIFF → WEBP → "VP8X" → [chunks including "VP8 "]
 *
 * This function handles both formats by scanning for the VP8 chunk.
 *
 * Chromium's convertToBlob (and VideoEncoder) prepend a 3-byte frame
 * size prefix before the VP8 keyframe tag (0x9d 0x01 0x2a). This is
 * stripped to produce a clean VP8 bitstream for the animated WebP muxer.
 */
/**
 * Encode demuxed video frames to animated WebP using OffscreenCanvas.
 *
 * Uses OffscreenCanvas.convertToBlob for per-frame WebP encoding, then
 * extracts VP8 bitstreams and muxes them into an animated WebP container.
 *
 * @param demux - Demuxed video data from demuxer-service
 * @param opts - Encoder options (width, height, quality, scale, etc.)
 * @param onProgress - Progress callback for UI updates
 * @param signal - Abort signal for cancellation
 * @returns Uint8Array containing the complete animated WebP file
 */
export async function encodeWebpOffscreen(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const quality = getCanvasWebpQuality(opts.quality);
  const frameDecimation = opts.frameDecimation ?? 1;

  if (!isOffscreenCanvasAvailable()) {
    throw new Error(
      'OffscreenCanvas is not available in this context. ' +
        'Use the wasm-webp encoder instead, or run in a browser environment.'
    );
  }

  logger.info('encoders', '  │  ├─ WebP: OffscreenCanvas encoder', {
    resolution: `${w}×${h}`,
    quality,
    frameDecimation,
  });

  const startTime = performance.now();

  // Create OffscreenCanvas at target resolution
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get 2D context from OffscreenCanvas');
  }

  // Streaming encode state — use incremental muxer to avoid O(N) memory accumulation
  const muxer = new StreamingWebpMuxer(w, h, opts);
  let encodeIdx = 0;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController();

  // Accumulate durations from dynamically skipped frames for timing preservation.
  // When decimationController.shouldSkip() drops a frame under memory pressure,
  // its duration is accumulated here and added to the next kept frame's delay.
  // This mirrors the GIF encoder's accumulatedDuration behavior.
  let accumulatedDuration = 0;

  // Decode frames with streaming callback — each frame is encoded immediately
  const {
    totalInputFrames: totalDecoded,
    skippedByDecimation: totalSkipped,
    smartSkipped: totalSmartSkipped,
    tailAccumulatedMs,
  } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      smartFrameSkip: opts.smartFrameSkip,
      onFrameDecoded: (_frameNum: number, total: number) => {
        if (!onProgress) return;
        const encCount = encodeIdx;
        if (encCount === 0) return;
        const encodePct = total > 0 ? Math.round((encCount / total) * 40) : 0;
        onProgress({
          phase: 'encoding',
          progress: 50 + Math.min(40, encodePct),
          fps: 0,
          etaSeconds: null,
          memoryMB: 0,
          currentFrame: encCount,
          totalFrames: total,
        });
      },
      // Streaming callback: encode each frame immediately upon decoding
      onFrameAvailable: async (rgbData: Uint8Array, frameDurationMs: number, frameNum: number) => {
        if (signal?.aborted) {
          globalBufferPool.release(rgbData);
          throw new DOMException('Cancelled', 'AbortError');
        }

        // ── Dynamic decimation based on memory pressure ──
        const shouldSkip = decimationController.shouldSkip(frameNum);

        if (shouldSkip) {
          // Accumulate skipped frame duration for timing preservation.
          // Without this, WebP output plays faster than source when dynamic
          // decimation kicks in under memory pressure.
          accumulatedDuration += frameDurationMs;
          globalBufferPool.release(rgbData);
          return;
        }

        return withPooledBuffer(rgbData, async () => {
          const totalDuration = frameDurationMs + accumulatedDuration;
          accumulatedDuration = 0;

          // Create ImageData from RGB data (3 bytes per pixel → 4 bytes RGBA for canvas)
          // OffscreenCanvas putImageData requires RGBA format
          // Use buffer pool to avoid per-frame GC pressure (M-05).
          const rawBuf = convertRGBToRGBA(rgbData, w, h);
          try {
            const rgbaData = new Uint8ClampedArray(
              rawBuf.buffer as ArrayBuffer,
              rawBuf.byteOffset,
              w * h * 4
            ) as unknown as Uint8ClampedArray<ArrayBuffer>;

            const imageData = new ImageData(rgbaData, w, h);

            // Draw to OffscreenCanvas — putImageData copies the data so we can release immediately
            ctx.putImageData(imageData, 0, 0);
          } finally {
            globalBufferPool.release(rawBuf);
          }

          // Encode to WebP via convertToBlob
          const blob = await canvas.convertToBlob({
            type: 'image/webp',
            quality,
          });

          if (!blob || blob.size === 0) {
            throw new Error(
              `convertToBlob returned ${blob ? 'empty' : 'null'} for frame ${encodeIdx}`
            );
          }

          // Read blob as ArrayBuffer
          const webpBuffer = new Uint8Array(await blob.arrayBuffer());

          // Extract VP8 bitstream from the single-frame WebP.
          // Always use the full parser — convertToBlob may produce VP8X
          // format for any frame, not just the first.
          const bitstream = extractAndNormalizeCanvasVp8(webpBuffer);

          muxer.addFrame(bitstream, totalDuration);
          encodeIdx++;
        });
      },
    },
    signal
  );

  if (muxer.frames === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  // Apply tail accumulated duration (decimation + smart-skip leftovers)
  // and dynamic decimation leftovers to the last frame to preserve total play time.
  const totalTailMs = tailAccumulatedMs + accumulatedDuration;
  if (totalTailMs > 0) {
    muxer.padLastFrameDuration(totalTailMs);
  }

  // Mux all encoded frames into animated WebP container
  const result = await muxer.finish(signal);
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'OffscreenCanvas WebP encoding complete', {
    decodedFrames: totalDecoded,
    keptFrames: muxer.frames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality,
    skippedByDecimation: totalSkipped,
    smartSkipped: totalSmartSkipped,
    dynamicSkipCount: decimationController.getSkipCount(),
  });
  logger.info('encoders', '  │  └─ WebP: OffscreenCanvas encode finished', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation: totalSkipped,
    smartSkipped: totalSmartSkipped,
  });

  return result;
}
