// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebP Encoding Service
 *
 * Encodes ImageData frames to WebP format using canvas encoding.
 */

import { createWebPFrameEncoder } from '@services/webcodecs/webp/webp-frame-encoder-service';
import type { ConversionOptions } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { cacheWebPChunkSize, getCachedWebPChunkSize } from '@utils/session-cache';

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

export async function encodeWebPFramesInChunks(params: {
  frames: ImageData[];
  quality: ConversionOptions['quality'];
  codec?: string;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<{ encodedFrames: Uint8Array[]; chunkSizeUsed: number }> {
  const { frames, quality, codec, onProgress, shouldCancel } = params;

  if (frames.length === 0) {
    return { encodedFrames: [], chunkSizeUsed: 0 };
  }

  const webpQualityRatio = QUALITY_PRESETS.webp[quality].quality / 100;
  const encodeFrame = createWebPFrameEncoder(webpQualityRatio);

  const { chunkSize, cached, cachedChunkSize } = resolveChunkSize();

  logger.info('conversion', 'Encoding WebP frames with canvas encoder', {
    frameCount: frames.length,
    chunkSize,
    cached,
    codec: codec ?? 'unknown',
  });

  const encodedFrames: Uint8Array[] = [];
  const totalFrames = frames.length;

  for (let i = 0; i < totalFrames; i += chunkSize) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const chunk = frames.slice(i, Math.min(i + chunkSize, totalFrames));
    const encodedChunk = await Promise.all(chunk.map((frame) => encodeFrame(frame)));
    encodedFrames.push(...encodedChunk);

    onProgress?.(encodedFrames.length, totalFrames);
  }

  if (!cachedChunkSize && encodedFrames.length > 0) {
    cacheWebPChunkSize(chunkSize);
    logger.info('conversion', 'Cached WebP chunk size for future conversions', {
      chunkSize,
    });
  }

  return { encodedFrames, chunkSizeUsed: chunkSize };
}
