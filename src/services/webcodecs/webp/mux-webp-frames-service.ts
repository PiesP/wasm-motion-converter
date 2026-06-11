// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebP frame muxing helper.
 *
 * Combines pre-encoded WebP image frames into a single animated WebP.
 *
 * Two paths:
 * 1. Legacy (two-stage): encodedFrames[] → build ANMF chunks → assemble RIFF
 * 2. Streaming (single-pass): EncoderFrame[] → per-frame encode → ANMF → assemble RIFF
 *
 * The streaming path is preferred as it reduces peak memory by ~75%.
 */

import type { VideoMetadata } from '@t/conversion-types';
import { MIN_WEBP_FRAME_DURATION_MS, WEBP_BACKGROUND_COLOR } from '@utils/constants';
import { logger } from '@utils/logger';
import {
  createAnmfChunkFromStripped,
  muxAnimatedWebPFromChunks,
  stripWebPContainer,
} from '@utils/webp-muxer';

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
  const { encodedFrames, timestamps, width, height, durationSeconds, onProgress, shouldCancel } =
    params;

  if (!encodedFrames.length) {
    return null;
  }

  // Build durations from timestamps
  const { buildWebPFrameDurations } = await import('@services/webcodecs/webp/webp-timing-service');
  const durations = buildWebPFrameDurations({
    timestamps,
    fps: params.fps,
    frameCount: encodedFrames.length,
    sourceFPS: params.metadata?.framerate,
    codec: params.metadata?.codec,
    durationSeconds,
  });

  if (encodedFrames.length === 1) {
    onProgress?.(1, 1);
    const frame = encodedFrames[0];
    if (!frame) return null;
    const buffer = (frame.buffer as ArrayBuffer).slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength
    );
    return new Blob([buffer], { type: 'image/webp' });
  }

  // Legacy path: build ANMF chunks from pre-encoded WebP frames
  logger.warn('conversion', 'muxWebPFrames: using legacy two-stage path', {
    frameCount: encodedFrames.length,
  });

  const anmfChunks: Uint8Array[] = [];
  let hasAlpha = false;

  for (let i = 0; i < encodedFrames.length; i++) {
    if (shouldCancel?.()) throw new Error('Conversion cancelled by user');
    onProgress?.(i + 1, encodedFrames.length);

    const frame = encodedFrames[i];
    if (!frame) throw new Error(`Missing encoded frame at index ${i}`);

    if (i === 0) {
      const { webPFrameHasAlphaChunk } = await import('@utils/webp-muxer');
      hasAlpha = webPFrameHasAlphaChunk(frame.buffer as ArrayBuffer);
    }

    const payload = stripWebPContainer(frame.buffer as ArrayBuffer);
    const duration = durations[i] ?? durations[durations.length - 1] ?? MIN_WEBP_FRAME_DURATION_MS;
    anmfChunks.push(createAnmfChunkFromStripped(payload, duration, width, height));
  }

  const muxed = muxAnimatedWebPFromChunks(anmfChunks, hasAlpha, {
    width,
    height,
    loopCount: 0,
    backgroundColor: WEBP_BACKGROUND_COLOR,
  });

  onProgress?.(encodedFrames.length, encodedFrames.length);
  return new Blob([muxed], { type: 'image/webp' });
}

/**
 * Stream-encode EncoderFrame[] directly into an animated WebP Blob.
 *
 * Each frame is converted to ImageData, encoded to WebP, stripped to its
 * VP8/VP8L payload, and wrapped in an ANMF chunk — all before moving to
 * the next frame. GPU resources are closed immediately after conversion.
 *
 * Peak memory: O(1) per frame instead of O(N) for full frame array.
 */
export interface MuxWebPStreamingResult {
  blob: Blob | null;
  /** aHash dedup stats: frames skipped */
  skippedFrames: number;
  /** aHash dedup stats: total frames evaluated */
  totalFrames: number;
}

export async function muxWebPFramesStreaming(params: {
  frames: import('@t/conversion-types').EncoderFrame[];
  timestamps: number[];
  width: number;
  height: number;
  fps: number;
  quality: 'low' | 'medium' | 'high';
  metadata?: VideoMetadata;
  durationSeconds?: number;
  codec?: string;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<MuxWebPStreamingResult> {
  const {
    frames,
    timestamps,
    width,
    height,
    fps,
    quality,
    metadata,
    durationSeconds,
    codec,
    onProgress,
    shouldCancel,
  } = params;

  if (!frames.length) return { blob: null, skippedFrames: 0, totalFrames: 0 };

  // Calculate frame durations upfront (lightweight)
  const { buildWebPFrameDurations } = await import('@services/webcodecs/webp/webp-timing-service');
  const durations = buildWebPFrameDurations({
    timestamps,
    fps,
    frameCount: frames.length,
    sourceFPS: metadata?.framerate,
    codec: metadata?.codec,
    durationSeconds,
  });

  // Single-pass per-frame encoding
  const { encodeFramesToANMFChunks } = await import(
    '@services/webcodecs/conversion/webp-streaming-encode-service'
  );

  const { anmfChunks, hasAlpha, skippedFrames, totalFrames } = await encodeFramesToANMFChunks({
    frames,
    quality,
    width,
    height,
    durations,
    codec,
    onProgress,
    shouldCancel,
  });

  if (anmfChunks.length === 0) return { blob: null, skippedFrames, totalFrames };

  if (anmfChunks.length === 1) {
    const frame = anmfChunks[0];
    if (!frame) return { blob: null, skippedFrames, totalFrames };
    return {
      blob: new Blob([frame.buffer as ArrayBuffer], { type: 'image/webp' }),
      skippedFrames,
      totalFrames,
    };
  }

  // Assemble final RIFF container from ANMF chunks
  const muxed = muxAnimatedWebPFromChunks(anmfChunks, hasAlpha, {
    width,
    height,
    loopCount: 0,
    backgroundColor: WEBP_BACKGROUND_COLOR,
  });

  return { blob: new Blob([muxed], { type: 'image/webp' }), skippedFrames, totalFrames };
}
