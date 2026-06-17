// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';
import { copyFrameToRGB, getFrameDurationMs, isDuplicateFrame } from './frame-utils';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all, 2 = keep 50%, etc.) */
  frameDecimation?: number;
  /** Enable frame deduplication (dHash-based) */
  deduplicate?: boolean;
  /** dHash threshold for deduplication (0-64, lower = stricter) */
  dedupThreshold?: number;
}

const QUALITY_COLORS: Record<GifEncodeOptions['quality'], number> = {
  low: 64,
  medium: 128,
  high: 256,
};

// Bayer ordered dithering strength per quality (0-255 range, lower = subtler)
const QUALITY_DITHER_STRENGTH: Record<GifEncodeOptions['quality'], number> = {
  low: 12,
  medium: 8,
  high: 4,
};

const BAYER_8X8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function bayerDitherRGB(rgb: Uint8Array, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  const scale = strength / 64;
  for (let y = 0; y < height; y++) {
    const by = BAYER_8X8[y & 7]!;
    for (let x = 0; x < width; x++) {
      const threshold = (by[x & 7]! - 32) * scale;
      const idx = (y * width + x) * 3;
      const r = rgb[idx]!;
      const g = rgb[idx + 1]!;
      const b = rgb[idx + 2]!;
      rgb[idx] = r + threshold < 0 ? 0 : r + threshold > 255 ? 255 : (r + threshold) | 0;
      rgb[idx + 1] = g + threshold < 0 ? 0 : g + threshold > 255 ? 255 : (g + threshold) | 0;
      rgb[idx + 2] = b + threshold < 0 ? 0 : b + threshold > 255 ? 255 : (b + threshold) | 0;
    }
  }
}

export type GifProgressCallback = (progress: ConversionProgress) => void;

// Throttle: report every N ms to avoid flooding the main thread
const PROGRESS_THROTTLE_MS = 150;

/**
 * Encode demuxed video frames to GIF using streaming encoding + gifsicle post-processing.
 *
 * Pipeline:
 *   1. VideoDecoder (hardware-accelerated) → frame queue
 *   2. Per-frame: copyTo RGB → dither → quantize → writeFrame
 *   3. Post-process: gifsicle -O1 --lossy for 30-50% size reduction
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: GifEncodeOptions,
  onProgress?: GifProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const maxColors = QUALITY_COLORS[opts.quality];
  const ditherStrength = QUALITY_DITHER_STRENGTH[opts.quality];
  const needsResize = w !== srcW || h !== srcH;
  const frameDecimation = opts.frameDecimation ?? 1;
  const doDedup = opts.deduplicate ?? true;
  const dedupThreshold = opts.dedupThreshold ?? 8;

  // Check codec support
  const support = await VideoDecoder.isConfigSupported(demux.config);
  if (!support.supported) {
    throw new Error(`Codec not supported: ${demux.config.codec}`);
  }

  // Streaming GIF encoder — writes frames one at a time
  const encoder = GIFEncoder({ auto: true });
  let frameIdx = 0;
  const startTime = performance.now();
  let globalPalette: number[][] | null = null;
  let lastProgressReport = 0;

  // Frame queue for ordered processing
  const frameQueue: VideoFrame[] = [];
  let decodeError: Error | null = null;

  // H2: Hardware-accelerated decoding (with fallback)
  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      frameQueue.push(frame);
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  // Try hardware acceleration first, fall back to software
  const hwConfig = { ...demux.config, hardwareAcceleration: 'prefer-hardware' as const };
  const swConfig = { ...demux.config, hardwareAcceleration: 'prefer-software' as const };
  const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
  decoder.configure(hwSupport.supported ? hwConfig : swConfig);

  // Feed all chunks
  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      if (decoder.state !== 'closed') decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
  }

  // Flush decoder
  try {
    if (decoder.state !== 'closed') await decoder.flush();
  } catch (e) {
    if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
  }
  if (decoder.state !== 'closed') decoder.close();

  if (decodeError) throw decodeError;

  logger.info('encoders', 'GIF encoding started', {
    frameCount: frameQueue.length,
    resolution: `${w}×${h}`,
    maxColors,
    quality: opts.quality,
    scale: opts.scale,
    hardwareAcceleration: 'prefer-hardware',
  });

  // T3: Track total output duration to verify timing matches source
  let outputTotalDelay = 0;
  const sourceTotalDelay = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000; // ms

  // Process frames sequentially — O(1) memory per frame
  // With deduplication and decimation for size optimization
  let prevRGB: Uint8Array | null = null;
  let accumulatedDelay = 0;
  let skippedByDecimation = 0;
  let skippedByDedup = 0;
  let splitFrames = 0;

  // T2: Maximum delay per frame — prevents a single frame from displaying too long
  // GIF spec max is 65535ms, but >200ms causes visible stuttering
  const MAX_FRAME_DELAY = 200;

  /**
   * Write a frame to the GIF encoder with delay capping.
   * If accumulated delay exceeds MAX_FRAME_DELAY, insert intermediate frames
   * to maintain smooth playback.
   */
  function writeFrameWithDelay(rgbData: Uint8Array, delayMs: number): void {
    let remaining = delayMs;

    if (remaining <= MAX_FRAME_DELAY) {
      const pal = globalPalette;
      if (!pal) return;
      const indexed = applyPalette(rgbData, pal, 'rgb565');
      encoder.writeFrame(indexed, w, h, { palette: pal, repeat: 0, delay: remaining });
      outputTotalDelay += remaining;
      return;
    }

    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_FRAME_DELAY);
      const pal = globalPalette;
      if (!pal) return;
      const indexed = applyPalette(rgbData, pal, 'rgb565');
      encoder.writeFrame(indexed, w, h, { palette: pal, repeat: 0, delay: chunk });
      outputTotalDelay += chunk;
      remaining -= chunk;
      if (remaining > 0) splitFrames++;
    }
  }

  while (frameQueue.length > 0) {
    const frame = frameQueue.shift()!;
    if (signal?.aborted) {
      frame.close();
      for (const f of frameQueue) f.close();
      throw new DOMException('Cancelled', 'AbortError');
    }

    const frameDelay = getFrameDurationMs(frame);

    // F2: Frame decimation — skip every Nth frame
    if (frameDecimation > 1 && frameIdx % frameDecimation !== 0) {
      accumulatedDelay += frameDelay;
      frame.close();
      frameIdx++;
      skippedByDecimation++;
      continue;
    }

    // H3: Direct RGB copy (no createImageBitmap fallback)
    const rgb = await copyFrameToRGB(frame, w, h, needsResize);
    frame.close();

    // F1: Frame deduplication — skip similar frames
    if (doDedup && prevRGB !== null && isDuplicateFrame(prevRGB, rgb, w, h, dedupThreshold)) {
      accumulatedDelay += frameDelay;
      frameIdx++;
      skippedByDedup++;
      // Don't update prevRGB — keep the original for comparison
      continue;
    }

    // Add accumulated delay from skipped frames
    const totalDelay = frameDelay + accumulatedDelay;
    accumulatedDelay = 0;

    // Bayer ordered dithering (pre-processing, in-place on RGB)
    if (ditherStrength > 0) {
      bayerDitherRGB(rgb, w, h, ditherStrength);
    }

    // Quantize and write to GIF encoder with delay optimization
    globalPalette = quantize(rgb, maxColors, { format: 'rgb565' });
    writeFrameWithDelay(rgb, totalDelay);

    prevRGB = rgb;
    frameIdx++;
    const now = performance.now();
    if (
      onProgress &&
      (now - lastProgressReport >= PROGRESS_THROTTLE_MS || frameIdx === demux.totalFrames)
    ) {
      lastProgressReport = now;
      const elapsedSec = (now - startTime) / 1000;
      onProgress({
        phase: 'encoding',
        progress: Math.round((frameIdx / demux.totalFrames) * 100),
        fps: Math.round(frameIdx / elapsedSec),
        etaSeconds: null,
        memoryMB: 0,
        currentFrame: frameIdx,
        totalFrames: demux.totalFrames,
        elapsedMs: Math.round(now - startTime),
      });
    }
  }

  if (frameIdx === 0) {
    throw new Error('No frames decoded for GIF encoding');
  }

  encoder.finish();
  const rawBytes = encoder.bytes();
  const encodeElapsed = (performance.now() - startTime) / 1000;

  // NOTE: gifsicle WASM post-processing disabled — browser virtual filesystem issues
  // TODO: Re-enable after fixing gifsicle.run() output in browser context
  const finalBytes = rawBytes;
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'GIF encoding complete', {
    framesEncoded: frameIdx,
    totalFrames: demux.totalFrames,
    outputBytes: finalBytes.length,
    encodeFps: Math.round(frameIdx / encodeElapsed),
    totalDuration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    maxColors,
    skippedByDecimation,
    skippedByDedup,
    splitFrames,
    dedupEnabled: doDedup,
    frameDecimation,
    sourceDurationMs: Math.round(sourceTotalDelay),
    outputDurationMs: Math.round(outputTotalDelay),
    timingErrorMs: Math.round(outputTotalDelay - sourceTotalDelay),
  });

  return finalBytes;
}
