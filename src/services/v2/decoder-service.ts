// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common VideoDecoder pipeline for both GIF and WebP encoders.
 *
 * Extracts RGB frames from demuxed video chunks using VideoDecoder,
 * with hardware acceleration support, frame decimation, and abort handling.
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
  /**
   * Optional per-frame filter called after RGB extraction.
   * Return true to keep the frame, false to discard it.
   * Discarded frame's duration is accumulated into the next kept frame.
   */
  filterFrame?: (rgb: Uint8Array, width: number, height: number) => boolean;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
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
  skippedByFilter: number;
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
 *   4. Return RGB frames + timing info
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
    filterFrame,
    onFrameDecoded,
  } = opts;

  const rgbFrames: DecodedFrame[] = [];
  const pendingConversions: Promise<void>[] = [];
  let decodeError: Error | null = null;
  let inputFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;
  let skippedByFilter = 0;

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

          // Apply optional frame filter (e.g. deduplication)
          if (filterFrame && !filterFrame(rgbData, width, height)) {
            accumulatedDuration += totalDuration;
            skippedByFilter++;
            return;
          }

          rgbFrames.push({ data: rgbData, duration: totalDuration });
          // Report decoding progress (fire-and-forget)
          if (onFrameDecoded) {
            onFrameDecoded(rgbFrames.length, demux.totalFrames);
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

  if (decodeError) throw decodeError;

  // Wait for all RGB conversions
  await Promise.all(pendingConversions);

  // Add any remaining accumulated duration to the last frame
  if (accumulatedDuration > 0 && rgbFrames.length > 0) {
    const last = rgbFrames[rgbFrames.length - 1];
    if (last) last.duration += accumulatedDuration;
  }

  // Compute timing summary
  const sourceTotalMs = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;
  const outputTotalMs = rgbFrames.reduce((sum, f) => sum + f.duration, 0);

  logger.info('encoders', 'Decoding complete', {
    totalInputFrames: inputFrameCount,
    outputFrames: rgbFrames.length,
    skippedByDecimation,
    skippedByFilter,
    resolution: `${width}×${height}`,
  });

  return {
    frames: rgbFrames,
    totalInputFrames: inputFrameCount,
    skippedByDecimation,
    skippedByFilter,
    sourceTotalMs,
    outputTotalMs,
  };
}
