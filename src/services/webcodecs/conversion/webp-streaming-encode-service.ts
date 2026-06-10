// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Streaming WebP Encoding Service
 *
 * Encodes ImageData frames directly into animated WebP mux chunks,
 * eliminating the intermediate Uint8Array[] buffer that caused
 * double memory usage in the previous two-stage pipeline.
 *
 * Old pipeline: ImageData[] → encode all → Uint8Array[] → mux all → Blob
 * New pipeline: ImageData → encode → strip container → ANMF chunk → append
 *
 * Memory peak reduction: ~50% (no intermediate encodedFrames array)
 */

import { createWebPFrameEncoder } from '@services/webcodecs/webp/webp-frame-encoder-service';
import type { ConversionOptions } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { cacheWebPChunkSize, getCachedWebPChunkSize } from '@utils/session-cache';
import { createAnmfChunk, stripWebPContainer, webPFrameHasAlphaChunk } from '@utils/webp-muxer';

const resolveChunkSize = (): { chunkSize: number; cached: boolean; cachedChunkSize?: number } => {
  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const cachedChunkSize = getCachedWebPChunkSize();
  const cached = !!(cachedChunkSize && isHardwareCacheValid());

  return {
    cached,
    cachedChunkSize: cachedChunkSize ?? undefined,
    chunkSize:
      cached && cachedChunkSize ? cachedChunkSize : Math.min(20, Math.max(10, hwConcurrency * 2)),
  };
};

export interface StreamingWebPEncodeResult {
  /** ANMF chunk data for each frame, in order */
  anmfChunks: Uint8Array[];
  /** Whether any frame contained an ALPH chunk */
  hasAlpha: boolean;
  /** Chunk size used for encoding batches */
  chunkSizeUsed: number;
}

/**
 * Encode ImageData frames directly into ANMF chunks.
 *
 * Instead of first encoding all frames to WebP and then muxing,
 * this function encodes each frame and immediately strips the WebP
 * container to produce an ANMF-ready payload, appending it to the
 * output array. This avoids holding both the full encoded WebP array
 * and the ANMF chunks in memory simultaneously.
 *
 * @param frames - ImageData frames to encode
 * @param quality - Quality preset
 * @param width - Frame width in pixels
 * @param height - Frame height in pixels
 * @param durations - Frame durations in milliseconds
 * @param codec - Source codec (for logging)
 * @param onProgress - Progress callback (current, total)
 * @param shouldCancel - Cancellation check
 */
export async function encodeWebPFramesStreaming(params: {
  frames: ImageData[];
  quality: ConversionOptions['quality'];
  width: number;
  height: number;
  durations: number[];
  codec?: string;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<StreamingWebPEncodeResult> {
  const { frames, quality, width, height, durations, codec, onProgress, shouldCancel } = params;

  if (frames.length === 0) {
    return { anmfChunks: [], hasAlpha: false, chunkSizeUsed: 0 };
  }

  const webpQualityRatio = QUALITY_PRESETS.webp[quality].quality / 100;
  const encodeFrame = createWebPFrameEncoder(webpQualityRatio);

  const { chunkSize, cached, cachedChunkSize } = resolveChunkSize();

  logger.info('conversion', 'Streaming WebP encode → ANMF chunks', {
    frameCount: frames.length,
    chunkSize,
    cached,
    codec: codec ?? 'unknown',
  });

  const anmfChunks: Uint8Array[] = [];
  let hasAlpha = false;
  const totalFrames = frames.length;

  for (let i = 0; i < totalFrames; i += chunkSize) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const endIdx = Math.min(i + chunkSize, totalFrames);
    const batchPromises: Promise<void>[] = [];

    for (let j = i; j < endIdx; j++) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      const frame = frames[j];
      if (!frame) {
        throw new Error(`Frame at index ${j} is undefined`);
      }

      const duration = durations[j] ?? durations[durations.length - 1] ?? 100;

      // Encode frame to WebP, then immediately strip container and create ANMF chunk
      batchPromises.push(
        (async (): Promise<void> => {
          const encodedWebP = await encodeFrame(frame);

          // Detect alpha from the first few frames only (cheap check)
          if (i === 0 && !hasAlpha) {
            hasAlpha = webPFrameHasAlphaChunk(encodedWebP.buffer as ArrayBuffer);
          }

          // Strip RIFF container → raw VP8/VP8L + optional ALPH
          const framePayload = stripWebPContainer(encodedWebP.buffer as ArrayBuffer);

          // Build ANMF chunk directly from the stripped payload
          const anmfChunk = createAnmfChunk(
            framePayload.buffer as ArrayBuffer,
            duration,
            width,
            height
          );

          anmfChunks[j] = anmfChunk;
        })()
      );
    }

    await Promise.all(batchPromises);
    onProgress?.(endIdx, totalFrames);
  }

  if (!cachedChunkSize && anmfChunks.length > 0) {
    cacheWebPChunkSize(chunkSize);
    logger.info('conversion', 'Cached WebP chunk size for future conversions', {
      chunkSize,
    });
  }

  return { anmfChunks, hasAlpha, chunkSizeUsed: chunkSize };
}
