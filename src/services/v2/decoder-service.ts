// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common VideoDecoder pipeline for both GIF and WebP encoders.
 *
 * Extracts RGB frames from demuxed video chunks using VideoDecoder,
 * with hardware acceleration support, frame decimation, and abort handling.
 *
 * Supports two modes:
 * 1. Batch mode (WebP): collects all frames into an array (existing behavior)
 * 2. Streaming mode (GIF): calls onFrameAvailable per frame for immediate encoding
 *
 * Both encoders share the same demux output and frame extraction logic;
 * only the encoding step (gifenc vs wasm-webp) differs.
 */

import { logger } from '@utils/logger';
import type { DemuxResult } from './demuxer-service';
import { copyFrameToRGB, getFrameDurationMs } from './frame-utils';

export interface DecodeOptions {
  width: number;
  height: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Hardware acceleration policy */
  hwAccel?: 'prefer-hardware' | 'prefer-software';
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
  /**
   * Streaming callback: fired for each decoded frame with RGB data.
   * When provided, frames are NOT accumulated into an array — instead they
   * are passed to this callback for immediate processing (e.g. encoding).
   * The callback receives ownership of the RGB buffer (must release to pool).
   */
  onFrameAvailable?: (
    rgbData: Uint8Array,
    durationMs: number,
    frameNum: number
  ) => Promise<void> | void;
}

export interface DecodedFrame {
  /** RGB pixel data, length = width * height * 3 */
  data: Uint8Array;
  /** Frame display duration in milliseconds */
  duration: number;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  totalInputFrames: number;
  skippedByDecimation: number;
  /** Total source duration in milliseconds (from demux chunk durations) */
  sourceTotalMs: number;
  /** Total output duration in milliseconds (sum of all frame durations) */
  outputTotalMs: number;
}

/**
 * Decode demuxed video chunks to RGB frames.
 *
 * Pipeline:
 *   1. Configure VideoDecoder (hwAccel with software fallback)
 *   2. Feed all chunks from DemuxResult
 *   3. Per-frame: copyTo RGB → optional filter → accumulate skipped durations
 *   4a. Batch mode: collect into frames array
 *   4b. Stream mode: call onFrameAvailable callback per frame
 */
export async function decodeFrames(
  demux: DemuxResult,
  opts: DecodeOptions,
  signal?: AbortSignal
): Promise<DecodeResult> {
  const {
    width,
    height,
    frameDecimation = 1,
    hwAccel = 'prefer-software',
    onFrameDecoded,
    onFrameAvailable,
  } = opts;

  const streaming = typeof onFrameAvailable === 'function';
  const rgbFrames: DecodedFrame[] = streaming ? [] : []; // Only used in batch mode
  const pendingConversions: Promise<void>[] = [];
  let decodeError: Error | null = null;
  let inputFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;

  // Check codec support
  const support = await VideoDecoder.isConfigSupported(demux.config);
  if (!support.supported) {
    throw new Error(
      `Unsupported configuration. Check isConfigSupported() prior to calling configure(). Codec: ${demux.config.codec}`
    );
  }

  // Build hw/sw configs
  const buildConfig = (hw: 'prefer-hardware' | 'prefer-software') => ({
    ...demux.config,
    hardwareAcceleration: hw,
  });

  // Try hardware first if requested
  let activeConfig = buildConfig(hwAccel);
  if (hwAccel === 'prefer-hardware') {
    const hwSupport = await VideoDecoder.isConfigSupported(buildConfig('prefer-hardware'));
    if (!hwSupport.supported) {
      logger.info('encoders', 'Hardware decoding not available, falling back to software', {
        codec: demux.config.codec,
      });
      activeConfig = buildConfig('prefer-software');
    }
  }

  logger.info('encoders', 'VideoDecoder configured', {
    codec: demux.config.codec,
    hwAccel: activeConfig.hardwareAcceleration,
    resolution: `${width}×${height}`,
    totalFrames: demux.totalFrames,
    frameDecimation,
    streaming,
  });

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      const frameDuration = getFrameDurationMs(frame);
      const frameNum = inputFrameCount++;

      // Frame decimation: skip every Nth frame
      if (frameDecimation > 1 && frameNum % frameDecimation !== 0) {
        accumulatedDuration += frameDuration;
        frame.close();
        skippedByDecimation++;
        return;
      }

      const totalDuration = frameDuration + accumulatedDuration;
      accumulatedDuration = 0;

      const conversion = (async () => {
        try {
          const rgbData = await copyFrameToRGB(frame, width, height);

          if (streaming) {
            // Streaming mode: pass frame to callback for immediate processing
            await onFrameAvailable(rgbData, totalDuration, frameNum);
            // Note: onFrameAvailable is responsible for releasing rgbData
          } else {
            // Batch mode: collect into array (existing behavior for WebP)
            rgbFrames.push({ data: rgbData, duration: totalDuration });
          }

          // Report decoding progress — throttle to every 10 frames
          if (
            onFrameDecoded &&
            (streaming
              ? inputFrameCount % 10 === 0
              : rgbFrames.length % 10 === 0 || rgbFrames.length === 1)
          ) {
            onFrameDecoded(streaming ? inputFrameCount : rgbFrames.length, demux.totalFrames);
          }
        } finally {
          frame.close();
        }
      })();
      pendingConversions.push(conversion);
    },
    error(e: Error) {
      logger.error('encoders', 'VideoDecoder error', {
        codec: demux.config.codec,
        error: e.message,
      });
      decodeError = e;
    },
  });

  decoder.configure(activeConfig);

  // Feed all chunks
  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      if (decoder.state !== 'closed') decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    if (decoder.state === 'closed') break;
    decoder.decode(chunk);
  }

  // Flush decoder
  try {
    if (decoder.state !== 'closed') await decoder.flush();
  } catch (e) {
    if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
  }
  // Guard against double-close: flush() may have already closed the decoder
  if (decoder.state !== 'closed') decoder.close();

  // Always await pending conversions before throwing to avoid VideoFrame leak
  await Promise.all(pendingConversions);

  if (decodeError) throw decodeError;

  // Add any remaining accumulated duration to the last frame (batch mode only)
  if (!streaming && accumulatedDuration > 0 && rgbFrames.length > 0) {
    const last = rgbFrames[rgbFrames.length - 1];
    if (last) last.duration += accumulatedDuration;
  }

  // Compute timing summary
  const sourceTotalMs = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;
  const outputTotalMs = streaming
    ? 0 // Not tracked in streaming mode (encoder handles timing)
    : rgbFrames.reduce((sum, f) => sum + f.duration, 0);

  logger.info('encoders', 'Decoding complete', {
    totalInputFrames: inputFrameCount,
    outputFrames: streaming ? inputFrameCount - skippedByDecimation : rgbFrames.length,
    skippedByDecimation,
    resolution: `${width}×${height}`,
    streaming,
  });

  return {
    frames: rgbFrames,
    totalInputFrames: inputFrameCount,
    skippedByDecimation,
    sourceTotalMs,
    outputTotalMs,
  };
}
