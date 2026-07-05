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
import { VP8_DEFAULT_BITRATE } from '@utils/constants';
import { logger } from '@utils/logger';
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
 * Prepare VP8 EncodedVideoChunk data for WebP ANMF muxing.
 *
 * Two transformations are applied:
 * 1. Strip Chromium's 3-byte frame size prefix before the VP8 keyframe tag.
 * 2. Patch show_frame bit from 0→1. Chromium's VP8 encoder produces invisible
 *    keyframes (show_frame=0) which are alternate reference frames, not
 *    displayable. WebP ANMF frames must be visible.
 *
 * The prefix varies per frame, so we locate the frame tag dynamically.
 */
function prepareVp8Frame(vp8Bytes: Uint8Array): Uint8Array {
  let frameStart = 0;

  for (let i = 0; i < Math.min(vp8Bytes.length - 2, 16); i++) {
    if (vp8Bytes[i] === 0x9d && vp8Bytes[i + 1] === 0x01 && vp8Bytes[i + 2] === 0x2a) {
      frameStart = i;
      break;
    }
  }

  // Strip prefix and create a mutable copy for show_frame + version patching.
  // Chromium's VP8 encoder produces keyframes with:
  //   - show_frame=0 (invisible) at bit 3 — must be 1 for WebP ANMF
  //   - version=2 at bits 6-4 — must be 0 per RFC 6386
  // Patch bit 3 → 1 and bits 6-4 → 0 (e.g. 0xa0 → 0x88).
  const raw = vp8Bytes.subarray(frameStart);
  const frame = new Uint8Array(raw);
  const byte = frame[3];
  if (byte !== undefined) {
    frame[3] = (byte & 0x8f) | 0x08; // clear version bits 6-4, set show_frame bit 3
  }

  return frame;
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

      // Strip Chromium's frame prefix and patch show_frame for display.
      // The muxer will wrap it in the correct "VP8 " RIFF sub-chunk.
      const rawVp8 = prepareVp8Frame(vp8Bytes);
      muxer.addFrame(rawVp8, currentDurationMs);

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
    bitrate: VP8_DEFAULT_BITRATE, // 5 Mbps for quality VP8 encoding
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

  // Decode frames with GPU-only streaming callback (no pixel read).
  // Uses onVideoFrameAvailable to receive raw VideoFrames directly,
  // skipping copyFrameToRGB entirely. Smart frame skip and adaptive
  // mode are disabled for this path (require dHash / RGB data).
  const { totalInputFrames: totalDecoded, skippedByDecimation: totalSkipped } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
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
      onVideoFrameAvailable: async (
        frame: VideoFrame,
        frameDurationMs: number,
        frameNum: number
      ) => {
        if (signal?.aborted) {
          frame.close();
          throw new DOMException('Cancelled', 'AbortError');
        }

        // Dynamic decimation
        const shouldSkip = decimationController.shouldSkip(frameNum);
        if (shouldSkip) {
          accumulatedDuration += frameDurationMs;
          frame.close();
          return;
        }

        const totalDuration = frameDurationMs + accumulatedDuration;
        accumulatedDuration = 0;
        currentDurationMs = totalDuration;

        // ── GPU-only pipeline: VideoFrame → canvas → VideoFrame → VideoEncoder ──
        // All operations stay on GPU — no pixel data read into JS memory.
        // ctx.drawImage(frame) transfers frame pixels GPU→GPU (zero-copy).
        ctx.drawImage(frame, 0, 0, w, h);
        frame.close();

        const vp8Frame = new VideoFrame(canvas, {
          timestamp: encodeIdx * 1_000_000,
          duration: Math.round(totalDuration * 1000),
        });

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
