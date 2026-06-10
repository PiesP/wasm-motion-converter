// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Streaming WebP Encoding Service
 *
 * Encodes frames directly into animated WebP mux chunks in a single pass,
 * eliminating the intermediate Uint8Array[] and ImageData[] buffers that
 * caused double memory usage in the previous two-stage pipeline.
 *
 * Pipeline: EncoderFrame[] → per-frame: frameToImageData → encode → strip → ANMF
 *                → assemble RIFF → Blob
 *
 * Each frame is converted, encoded, and packaged before the next frame begins,
 * so only one frame's worth of data exists in memory at any time.
 */

import type { ConversionOptions, EncoderFrame } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { cacheWebPChunkSize, getCachedWebPChunkSize } from '@utils/session-cache';
import { createAnmfChunk, stripWebPContainer, webPFrameHasAlphaChunk } from '@utils/webp-muxer';

const resolveChunkSize = (): {
  chunkSize: number;
  cached: boolean;
  cachedChunkSize?: number;
} => {
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
 * Encode EncoderFrame[] directly into ANMF chunks, one frame at a time.
 *
 * Each frame is converted to ImageData, encoded to WebP, stripped to its
 * VP8/VP8L payload, and wrapped in an ANMF chunk — all before moving to
 * the next frame. This ensures only one ImageData and one encoded WebP
 * buffer exist in memory at any time.
 *
 * GPU resources (ImageBitmap, VideoFrame) are closed immediately after
 * conversion to minimize GPU memory pressure.
 *
 * @param frames - EncoderFrame[], ImageData[], or mixed
 * @param quality - Quality preset
 * @param width - Frame width in pixels
 * @param height - Frame height in pixels
 * @param durations - Frame durations in milliseconds
 * @param codec - Source codec (for logging)
 * @param onProgress - Progress callback (current, total)
 * @param shouldCancel - Cancellation check
 */
export async function encodeFramesToANMFChunks(params: {
  frames: EncoderFrame[];
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
  const { chunkSize, cached, cachedChunkSize } = resolveChunkSize();

  logger.info('conversion', 'Streaming per-frame WebP encode → ANMF chunks', {
    frameCount: frames.length,
    chunkSize,
    cached,
    codec: codec ?? 'unknown',
  });

  const anmfChunks: Uint8Array[] = new Array(frames.length);
  let hasAlpha = false;
  const totalFrames = frames.length;

  // Reusable canvas for frame conversion (avoids per-frame allocation)
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for WebP frame encoding');
  }

  // Reusable WebP encoder
  const { createWebPFrameEncoder } = await import(
    '@services/webcodecs/webp/webp-frame-encoder-service'
  );
  const encodeFrame = createWebPFrameEncoder(webpQualityRatio);

  for (let i = 0; i < totalFrames; i++) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const frame = frames[i];
    if (!frame) {
      throw new Error(`Frame at index ${i} is undefined`);
    }

    // Step 1: Convert to ImageData (reuses canvas)
    let imageData: ImageData;
    if (frame instanceof ImageData) {
      imageData = frame;
    } else {
      // EncoderFrame (VideoFrame, ImageBitmap, etc.) → ImageData
      const src = frame as CanvasImageSource & { width: number; height: number };
      const fw = 'displayWidth' in src ? src.displayWidth : src.width;
      const fh = 'displayHeight' in src ? src.displayHeight : src.height;
      if (canvas.width !== fw || canvas.height !== fh) {
        canvas.width = fw;
        canvas.height = fh;
      }
      ctx.drawImage(src, 0, 0, fw, fh);
      imageData = ctx.getImageData(0, 0, fw, fh);
    }

    // Step 2: Encode ImageData → WebP
    const encodedWebP = await encodeFrame(imageData);
    const webpBuffer = encodedWebP.buffer as ArrayBuffer;

    // Step 3: Detect alpha from first frame only
    if (i === 0 && !hasAlpha) {
      hasAlpha = webPFrameHasAlphaChunk(webpBuffer);
    }

    // Step 4: Strip RIFF container → raw VP8/VP8L + optional ALPH
    const framePayload = stripWebPContainer(webpBuffer);

    // Step 5: Wrap in ANMF chunk
    const duration = durations[i] ?? durations[durations.length - 1] ?? 100;
    anmfChunks[i] = createAnmfChunk(framePayload.buffer as ArrayBuffer, duration, width, height);

    // Step 6: Release GPU resources immediately
    if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
      try {
        frame.close();
      } catch {
        /* ignore */
      }
    } else if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
      try {
        frame.close();
      } catch {
        /* ignore */
      }
    }

    onProgress?.(i + 1, totalFrames);
  }

  if (!cachedChunkSize && anmfChunks.length > 0) {
    cacheWebPChunkSize(chunkSize);
    logger.info('conversion', 'Cached WebP chunk size for future conversions', {
      chunkSize,
    });
  }

  return { anmfChunks, hasAlpha, chunkSizeUsed: chunkSize };
}
