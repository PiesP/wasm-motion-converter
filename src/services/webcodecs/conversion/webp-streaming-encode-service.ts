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
import {
  createAnmfChunkFromStripped,
  stripWebPContainer,
  webPFrameHasAlphaChunk,
} from '@utils/webp-muxer';

// ── aHash frame similarity detection ──────────────────────────────────

const HAMMING_SIMILARITY_THRESHOLD = 2;

/**
 * Compute 64-bit average hash (aHash) from ImageData.
 * Downsamples to 8×8 grayscale, computes mean luminance, and builds a
 * BigInt hash where each bit indicates whether the pixel is above the mean.
 */
function computeAverageHash(imageData: ImageData): bigint {
  const { data, width, height } = imageData;
  const pixels = new Array<number>(64);
  const stepX = width / 8;
  const stepY = height / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sx = Math.floor(x * stepX);
      const sy = Math.floor(y * stepY);
      const idx = (sy * width + sx) * 4;
      // Luminance: 0.299R + 0.587G + 0.114B
      pixels[y * 8 + x] = data[idx]! * 0.299 + data[idx + 1]! * 0.587 + data[idx + 2]! * 0.114;
    }
  }
  const mean = pixels.reduce((sum, v) => sum + v, 0) / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (pixels[i]! > mean) {
      hash |= 1n << BigInt(63 - i);
    }
  }
  return hash;
}

/** Popcount on BigInt via XOR → binary string character count. */
function hammingDistance(a: bigint, b: bigint): number {
  const xor = a ^ b;
  return xor.toString(2).replace(/0/g, '').length;
}

// ── Chunk size resolution ─────────────────────────────────────────────

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

  // ── Frame similarity tracking ───────────────────────────────────────
  let lastHash: bigint | undefined;
  let accumulatedDuration = 0;
  let skippedFrameCount = 0;

  logger.performance('Starting WebP streaming encode', {
    totalFrames,
    resolution: `${width}x${height}`,
    codec: codec ?? 'unknown',
  });

  const encodeStartTime = performance.now();

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

    // ── Similarity detection: skip near-duplicate frames ────────────
    const frameHash = computeAverageHash(imageData);
    if (
      lastHash !== undefined &&
      hammingDistance(lastHash, frameHash) <= HAMMING_SIMILARITY_THRESHOLD
    ) {
      accumulatedDuration += durations[i] ?? durations[durations.length - 1] ?? 100;
      skippedFrameCount++;
      // Mark as undefined — filtered out before return
      anmfChunks[i] = undefined as unknown as Uint8Array;
      onProgress?.(i + 1, totalFrames);
      continue;
    }
    lastHash = frameHash;

    // Step 2: Encode ImageData → WebP
    const encodedWebP = await encodeFrame(imageData);
    const webpBuffer = encodedWebP.buffer as ArrayBuffer;

    // Step 3: Detect alpha from first frame only
    if (i === 0 && !hasAlpha) {
      hasAlpha = webPFrameHasAlphaChunk(webpBuffer);
    }

    // Step 4: Strip RIFF container → raw VP8/VP8L + optional ALPH
    const framePayload = stripWebPContainer(webpBuffer);

    // Step 5: Wrap in ANMF chunk (use stripped variant — already stripped at Step 4)
    const duration = durations[i] ?? durations[durations.length - 1] ?? 100;
    anmfChunks[i] = createAnmfChunkFromStripped(framePayload, duration, width, height);

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

    // Emit performance progress every ~10 frames for user-visible feedback
    if (i === 0 || (i + 1) % 10 === 0 || i === totalFrames - 1) {
      const elapsedS = ((performance.now() - encodeStartTime) / 1000).toFixed(1);
      logger.performance(`Encoding WebP... (${i + 1}/${totalFrames}) [${elapsedS}s]`);
    }
  }

  // ── Drain accumulated duration into last valid ANMF ──────────────
  if (accumulatedDuration > 0 && lastHash !== undefined) {
    // Find last valid (non-skipped) ANMF chunk
    let lastValidIdx = -1;
    for (let i = anmfChunks.length - 1; i >= 0; i--) {
      if (anmfChunks[i] !== undefined) {
        lastValidIdx = i;
        break;
      }
    }
    if (lastValidIdx >= 0) {
      const chunk = anmfChunks[lastValidIdx]!;
      const existingDuration =
        (chunk[20] ?? 0) | ((chunk[21] ?? 0) << 8) | ((chunk[22] ?? 0) << 16);
      const newDuration = Math.min(existingDuration + accumulatedDuration, 0xffffff);
      chunk[20] = newDuration & 0xff;
      chunk[21] = (newDuration >> 8) & 0xff;
      chunk[22] = (newDuration >> 16) & 0xff;
    }
  }

  // ── Filter skipped (undefined) entries ────────────────────────────
  const validAnmfChunks = anmfChunks.filter((c): c is Uint8Array => c !== undefined);

  // ── Dedup stats ───────────────────────────────────────────────────
  if (skippedFrameCount > 0) {
    logger.info(
      'conversion',
      `Skipped ${skippedFrameCount} near-duplicate frames (aHash Hamming ≤ ${HAMMING_SIMILARITY_THRESHOLD})`,
      {
        skippedFrames: skippedFrameCount,
        totalFrames,
        dedupRatio: `${((skippedFrameCount / totalFrames) * 100).toFixed(1)}%`,
        accumulatedDuration: `${accumulatedDuration}ms`,
      }
    );
  }

  if (!cachedChunkSize && validAnmfChunks.length > 0) {
    cacheWebPChunkSize(chunkSize);
    logger.info('conversion', 'Cached WebP chunk size for future conversions', {
      chunkSize,
    });
  }

  return { anmfChunks: validAnmfChunks, hasAlpha, chunkSizeUsed: chunkSize };
}
