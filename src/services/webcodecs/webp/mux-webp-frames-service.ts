/**
 * WebP frame muxing helper.
 *
 * Combines pre-encoded WebP image frames into a single animated WebP.
 *
 * This module is intentionally UI-agnostic and can be shared by both:
 * - The complex codec direct WebCodecs path (RGBA → WebP → mux)
 * - The standard WebCodecs capture path (RGBA → WebP → mux)
 */

import {
  MIN_WEBP_FRAME_DURATION_MS,
  WEBP_BACKGROUND_COLOR,
} from '@services/webcodecs/webp-constants-service';
import {
  buildWebPFrameDurations,
  resolveAnimationDurationSeconds,
} from '@services/webcodecs/webp-timing-service';
import type { VideoMetadata } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { muxAnimatedWebP } from '@utils/webp-muxer';

export async function muxWebPFrames(params: {
  encodedFrames: Uint8Array[];
  timestamps: number[];
  width: number;
  height: number;
  fps: number;
  metadata?: VideoMetadata;
  durationSeconds?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<Blob | null> {
  const {
    encodedFrames,
    timestamps,
    width,
    height,
    fps,
    metadata,
    durationSeconds,
    onProgress,
    shouldCancel,
  } = params;

  if (!encodedFrames.length) {
    return null;
  }

  const animationDurationSeconds = resolveAnimationDurationSeconds(
    encodedFrames.length,
    fps,
    metadata,
    durationSeconds
  );

  const durations = buildWebPFrameDurations({
    timestamps,
    fps,
    frameCount: encodedFrames.length,
    sourceFPS: metadata?.framerate,
    codec: metadata?.codec,
    durationSeconds: animationDurationSeconds,
  });

  // Log duration statistics for debugging
  if (durations.length > 0) {
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const variance = maxDuration - minDuration;

    logger.info('conversion', 'WebP frame duration statistics', {
      frameCount: durations.length,
      avgDuration: `${avgDuration.toFixed(2)}ms`,
      minDuration: `${minDuration}ms`,
      maxDuration: `${maxDuration}ms`,
      variance: `${variance}ms`,
      isUniform: variance === 0,
    });
  }

  if (encodedFrames.length === 1) {
    onProgress?.(1, 1);
    const frame = encodedFrames[0];
    if (!frame) {
      return null;
    }

    const buffer = frame.slice().buffer;
    return new Blob([buffer], { type: 'image/webp' });
  }

  const framesForMux = encodedFrames.map((frame, index) => {
    if (!frame) {
      throw new Error('Missing encoded frame for WebP muxing.');
    }

    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    onProgress?.(index + 1, encodedFrames.length);

    const buffer = frame.slice().buffer as ArrayBuffer;
    const duration =
      durations[index] ?? durations[durations.length - 1] ?? MIN_WEBP_FRAME_DURATION_MS;

    return { data: buffer, duration };
  });

  const muxed = await muxAnimatedWebP(framesForMux, {
    width,
    height,
    loopCount: 0,
    backgroundColor: WEBP_BACKGROUND_COLOR,
  });

  onProgress?.(encodedFrames.length, encodedFrames.length);

  return new Blob([muxed], { type: 'image/webp' });
}
