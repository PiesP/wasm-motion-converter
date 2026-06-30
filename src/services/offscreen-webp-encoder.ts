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
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { extractVP8BitstreamFast, StreamingWebpMuxer } from './streaming-webp-encoder';

/**
 * OffscreenCanvas quality parameter (0.0–1.0 float).
 * Maps ConversionQuality to browser WebP encoder quality:
 *   low    → 0.6  (visually transparent, smaller files)
 *   medium → 0.75 (near-identical to source for animated content)
 *   high   → 0.85 (excellent quality, diminishing returns above 0.85)
 */
const OFFSCREEN_QUALITY_MAP: Record<BaseEncoderOptions['quality'], number> = {
  low: 0.6,
  medium: 0.75,
  high: 0.85,
};

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
 */
function extractVP8FromOffscreenBlob(webpBuffer: Uint8Array): Uint8Array {
  if (webpBuffer.length < 24) {
    throw new Error(`WebP too small: ${webpBuffer.length} bytes (minimum 24)`);
  }

  const view = new DataView(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);

  // Verify RIFF header
  if (view.getUint32(0, false) !== StreamingWebpMuxer.RIFF_MAGIC) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }

  // Verify WEBP type
  if (view.getUint32(8, false) !== StreamingWebpMuxer.WEBP_MAGIC) {
    throw new Error(`Invalid WEBP type: 0x${view.getUint32(8, false).toString(16)}`);
  }

  // Determine format: simple VP8 (0x56503820) or extended VP8X (0x56503858)
  const fourCC = view.getUint32(12, false);

  if (fourCC === 0x56503820) {
    // Simple VP8 format — bitstream starts at offset 20
    const frameSize = view.getUint32(16, true);
    if (20 + frameSize > webpBuffer.length) {
      throw new Error(`Frame size ${frameSize} exceeds buffer ${webpBuffer.length}`);
    }
    return webpBuffer.subarray(20, 20 + frameSize);
  }

  if (fourCC === 0x56503858) {
    // VP8X extended format — scan chunks to find VP8
    const vp8xSize = view.getUint32(16, true);
    let offset = 12 + 8 + vp8xSize; // skip past VP8X chunk (header 8 + data)

    while (offset + 8 <= webpBuffer.length) {
      const chunkFourCC = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkFourCC === 0x56503820) {
        // Found VP8 chunk
        if (offset + 8 + chunkSize > webpBuffer.length) {
          throw new Error(`VP8 chunk size ${chunkSize} exceeds buffer ${webpBuffer.length}`);
        }
        return webpBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      }

      // Advance to next chunk (with padding for odd sizes)
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    throw new Error('VP8X container does not contain a VP8 chunk');
  }

  // Unknown format
  const codecStr = String.fromCharCode(
    webpBuffer[12]!,
    webpBuffer[13]!,
    webpBuffer[14]!,
    webpBuffer[15]!
  );
  throw new Error(`Unknown WebP format: "${codecStr}" (0x${fourCC.toString(16)})`);
}

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
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = OFFSCREEN_QUALITY_MAP[opts.quality];
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
  const muxer = new StreamingWebpMuxer(w, h);
  let totalInputFrames = 0;
  let encodeIdx = 0;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController();

  // Accumulate durations from dynamically skipped frames for timing preservation.
  // When decimationController.shouldSkip() drops a frame under memory pressure,
  // its duration is accumulated here and added to the next kept frame's delay.
  // This mirrors the GIF encoder's accumulatedDuration behavior.
  let accumulatedDuration = 0;

  // Decode frames with streaming callback — each frame is encoded immediately
  const { totalInputFrames: totalDecoded, skippedByDecimation: totalSkipped } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      smartFrameSkip: opts.smartFrameSkip,
      onFrameDecoded: (_frameNum, total) => {
        totalInputFrames = total;
        // Report encoding progress during streaming
        if (onProgress && encodeIdx > 0) {
          const encodePct = total > 0 ? Math.round((encodeIdx / total) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: 0,
            currentFrame: encodeIdx,
            totalFrames: total,
          });
        }
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

        const totalDuration = frameDurationMs + accumulatedDuration;
        accumulatedDuration = 0;

        // Create ImageData from RGB data (3 bytes per pixel → 4 bytes RGBA for canvas)
        // OffscreenCanvas putImageData requires RGBA format
        const rgbaData = new Uint8ClampedArray(w * h * 4);
        for (let i = 0, j = 0; i < rgbData.length; i += 3, j += 4) {
          rgbaData[j] = rgbData[i]!;
          rgbaData[j + 1] = rgbData[i + 1]!;
          rgbaData[j + 2] = rgbData[i + 2]!;
          rgbaData[j + 3] = 255; // fully opaque
        }

        const imageData = new ImageData(rgbaData, w, h);

        // Draw to OffscreenCanvas
        ctx.putImageData(imageData, 0, 0);

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

        // Extract VP8 bitstream from the single-frame WebP
        // First frame uses full validation, subsequent frames use fast path
        const bitstream =
          encodeIdx === 0
            ? extractVP8FromOffscreenBlob(webpBuffer)
            : extractVP8BitstreamFast(webpBuffer);

        muxer.addFrame(bitstream, totalDuration);
        encodeIdx++;

        // Release the RGB buffer back to the pool after successful encode
        globalBufferPool.release(rgbData);
      },
    },
    signal
  );

  totalInputFrames = totalDecoded;

  if (muxer.frames === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  // Mux all encoded frames into animated WebP container
  const result = muxer.finish();
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'OffscreenCanvas WebP encoding complete', {
    decodedFrames: totalInputFrames,
    keptFrames: muxer.frames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality,
    skippedByDecimation: totalSkipped,
    dynamicSkipCount: decimationController.getSkipCount(),
  });
  logger.info('encoders', '  │  └─ WebP: OffscreenCanvas encode finished', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation: totalSkipped,
  });

  return result;
}
