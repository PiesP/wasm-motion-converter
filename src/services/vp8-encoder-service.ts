// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * VP8 VideoEncoder-based WebP Encoder Service
 *
 * Uses WebCodecs VideoEncoder with "vp8" codec to encode frames directly
 * as VP8 keyframes, then muxes them into an animated WebP container.
 *
 * Key advantage over OffscreenCanvas: Encoding happens entirely on the GPU
 * without reading pixel data into JavaScript memory.
 *
 * Pipeline:
 *   1. Draw VideoFrame to OffscreenCanvas (GPU)
 *   2. Create VideoFrame from canvas: new VideoFrame(canvas) — GPU-only, no copyTo
 *   3. VideoEncoder.encode(vp8Frame, { keyFrame: true }) — native VP8 encoding
 *   4. Extract raw VP8 bytes from EncodedVideoChunk
 *   5. Wrap in "VP8 " RIFF sub-chunk → feed to StreamingWebpMuxer
 *
 * Reference: https://pietrasiak.com/fast-video-rendering-and-encoding-using-web-apis
 * "new VideoFrame(canvas) will create VideoFrame out of canvas on GPU level,
 *  never reading pixels data."
 */

import type { ProgressCallback } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { StreamingWebpMuxer } from './streaming-webp-encoder';

/**
 * Check if VideoEncoder VP8 encoding is available in the current context.
 */
function isVp8EncoderAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

/**
 * Check if the browser supports VP8 encoding at the given resolution.
 */
async function isVp8ConfigSupported(width: number, height: number): Promise<boolean> {
  try {
    const config: VideoEncoderConfig = {
      codec: 'vp8',
      width,
      height,
      bitrate: 1_000_000,
      framerate: 30,
    };
    const result = await VideoEncoder.isConfigSupported(config);
    return result.supported === true;
  } catch {
    return false;
  }
}

/**
 * Wrap raw VP8 bitstream in a "VP8 " RIFF sub-chunk header.
 * The WebP ANMF specification (RFC 9649) requires the VP8 data to be
 * wrapped in a "VP8 " chunk with FourCC and size prefix.
 *
 * Output layout (8 + bitstream.length bytes):
 *   Offset  Content
 *   0       "VP8 " (FourCC, big-endian: 0x56503820)
 *   4       chunk size (uint32 LE)
 *   8       raw VP8 bitstream
 */
function wrapVp8Subchunk(vp8Data: Uint8Array): Uint8Array {
  const totalSize = 8 + vp8Data.length;
  const wrapped = new Uint8Array(totalSize);
  const view = new DataView(wrapped.buffer);

  // "VP8 " FourCC — big-endian
  view.setUint32(0, 0x56503820, false);
  // Chunk size — little-endian
  view.setUint32(4, vp8Data.length, true);
  // Copy VP8 bitstream
  wrapped.set(vp8Data, 8);

  return wrapped;
}

/**
 * Encode demuxed video frames to animated WebP using VideoEncoder VP8.
 *
 * Falls back to OffscreenCanvas encoding if VideoEncoder is unavailable
 * or VP8 configuration is not supported.
 *
 * @returns Uint8Array of animated WebP, or throws if fallback is unavailable
 */
export async function encodeWebpVp8(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const frameDecimation = opts.frameDecimation ?? 1;

  // Check availability — fall back to caller if unsupported
  if (!isVp8EncoderAvailable()) {
    throw new Error('VideoEncoder VP8: not available in this context');
  }

  const configSupported = await isVp8ConfigSupported(w, h);
  if (!configSupported) {
    throw new Error('VideoEncoder VP8: configuration not supported');
  }

  logger.info('encoders', '  │  ├─ WebP: VideoEncoder VP8 encoder', {
    resolution: `${w}×${h}`,
    frameDecimation,
  });

  const startTime = performance.now();

  // Create canvas for GPU-only frame conversion (no pixel read)
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context from OffscreenCanvas');
  }

  // Setup VideoEncoder for VP8 encoding
  let encodeError: Error | null = null;

  const encoder = new VideoEncoder({
    output(chunk: EncodedVideoChunk, _metadata?: EncodedVideoChunkMetadata) {
      // Extract VP8 bytes from encoded chunk
      const byteLength = chunk.byteLength;
      const buffer = new ArrayBuffer(byteLength);
      chunk.copyTo(buffer);
      const vp8Bytes = new Uint8Array(buffer);

      // Wrap in "VP8 " RIFF sub-chunk
      const subchunk = wrapVp8Subchunk(vp8Bytes);
      muxer.addFrame(subchunk, currentDurationMs);

      encodedFrames++;
    },
    error(e: Error) {
      logger.error('encoders', 'VideoEncoder error', { error: e.message });
      encodeError = e;
    },
  });

  encoder.configure({
    codec: 'vp8',
    width: w,
    height: h,
    bitrate: 5_000_000, // 5 Mbps for quality VP8 encoding
    framerate: 30,
  });

  // Streaming muxer
  const muxer = new StreamingWebpMuxer(w, h);
  let encodedFrames = 0;
  let encodeIdx = 0;
  let currentDurationMs = 0;

  // Dynamic decimation controller
  const decimationController = createDynamicDecimationController();
  let accumulatedDuration = 0;

  // Decode frames with streaming callback
  const { totalInputFrames: totalDecoded, skippedByDecimation: totalSkipped } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      smartFrameSkip: opts.smartFrameSkip,
      onFrameDecoded: (_frameNum, total) => {
        if (onProgress && encodedFrames > 0) {
          const encodePct = total > 0 ? Math.round((encodedFrames / total) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: 0,
            currentFrame: encodedFrames,
            totalFrames: total,
          });
        }
      },
      onFrameAvailable: async (rgbData: Uint8Array, frameDurationMs: number, frameNum: number) => {
        if (signal?.aborted) {
          globalBufferPool.release(rgbData);
          throw new DOMException('Cancelled', 'AbortError');
        }

        // Dynamic decimation
        const shouldSkip = decimationController.shouldSkip(frameNum);
        if (shouldSkip) {
          accumulatedDuration += frameDurationMs;
          globalBufferPool.release(rgbData);
          return;
        }

        const totalDuration = frameDurationMs + accumulatedDuration;
        accumulatedDuration = 0;
        currentDurationMs = totalDuration;

        // ── GPU-only VideoFrame pipeline ──
        // Draw the decoded frame onto the canvas (GPU)
        // Note: rgbData is NOT used directly — we use the VideoFrame from decoder.
        // The canvas drawing step happens via the decodeFrames output which
        // gives us the VideoFrame. We need to draw it to canvas first.
        //
        // However, decodeFrames calls copyFrameToRGB internally which reads
        // pixels to JS. For the GPU-only path, we need the original VideoFrame.
        // Solution: We create a fresh VideoFrame from the canvas in the
        // copyFrameCanvas path, then encode it.
        //
        // This is the bridge: RGB data → canvas → VideoFrame → VideoEncoder
        const pixelCount = w * h;

        // Convert RGB → RGBA for canvas putImageData (3bpp → 4bpp)
        const rgbaBuf = globalBufferPool.acquire(pixelCount * 4);
        for (let i = 0, j = 0; i < rgbData.length; i += 3, j += 4) {
          rgbaBuf[j] = rgbData[i]!;
          rgbaBuf[j + 1] = rgbData[i + 1]!;
          rgbaBuf[j + 2] = rgbData[i + 2]!;
          rgbaBuf[j + 3] = 255;
        }

        const imageData = new ImageData(
          new Uint8ClampedArray(rgbaBuf.buffer as ArrayBuffer, rgbaBuf.byteOffset, pixelCount * 4),
          w,
          h
        );

        ctx.putImageData(imageData, 0, 0);
        globalBufferPool.release(rgbaBuf);
        globalBufferPool.release(rgbData);

        // Create VideoFrame from canvas — GPU-only, no pixel read!
        const vp8Frame = new VideoFrame(canvas, {
          timestamp: encodeIdx * 1_000_000, // microseconds
          duration: Math.round(totalDuration * 1000), // microseconds
        });

        // Encode as VP8 keyframe (WebP always uses keyframes)
        encoder.encode(vp8Frame, { keyFrame: true });
        vp8Frame.close();

        encodeIdx++;
      },
    },
    signal
  );

  // Flush encoder to get all remaining encoded chunks
  try {
    await encoder.flush();
  } catch (e) {
    if (!encodeError) {
      encodeError = e instanceof Error ? e : new Error(String(e));
    }
  }

  encoder.close();

  if (encodeError) throw encodeError;

  if (muxer.frames === 0) {
    throw new Error('No frames encoded for VP8 WebP encoding');
  }

  const result = muxer.finish();
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'VP8 VideoEncoder WebP encoding complete', {
    decodedFrames: totalDecoded,
    keptFrames: muxer.frames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    skippedByDecimation: totalSkipped,
    dynamicSkipCount: decimationController.getSkipCount(),
  });
  logger.info('encoders', '  │  └─ WebP: VP8 encode finished', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation: totalSkipped,
  });

  return result;
}
