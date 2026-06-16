// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service
 *
 * Encodes decoded video frames into animated GIF using gifenc.
 * Uses direct VideoFrame.copyTo() for zero-copy pixel extraction.
 *
 * Adaptive palette: for high quality, recalculates palette every N frames
 * to handle scenes with significant color changes.
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeStreaming } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { copyFrameToRGBA, getFrameDurationMs, resizeFrameToRGBA } from './frame-utils';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

const QUALITY_COLORS: Record<GifEncodeOptions['quality'], number> = {
  low: 64,
  medium: 128,
  high: 256,
};

/** How often to recalculate the palette (in frames). Only for high quality. */
const PALETTE_RECALC_INTERVAL: Record<GifEncodeOptions['quality'], number | null> = {
  low: null, // Never recalculate — speed priority
  medium: 30, // Every 30 frames (~1s at 30fps)
  high: 15, // Every 15 frames (~0.5s at 30fps)
};

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Compute color difference between two RGBA buffers.
 * Returns average per-pixel color distance (0-255).
 * Used to decide when to recalculate the palette.
 */
function computeColorDiff(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let totalDiff = 0;
  const pixelCount = len / 4;
  for (let i = 0; i < len; i += 4) {
    totalDiff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    totalDiff += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
    totalDiff += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
  }
  return totalDiff / (pixelCount * 3);
}

/**
 * Encode demuxed video frames to GIF.
 * Uses direct VideoFrame pixel copy — no ImageBitmap intermediate.
 * Adaptive palette recalculation for medium/high quality.
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
  const needsResize = w !== srcW || h !== srcH;
  const recalcInterval = PALETTE_RECALC_INTERVAL[opts.quality];

  const encoder = GIFEncoder({ auto: true });
  let frameIdx = 0;
  const startTime = performance.now();
  let globalPalette: number[][] | null = null;
  let prevFrameRGBA: Uint8Array | null = null;

  for await (const frame of decodeStreaming(demux, undefined, signal)) {
    // Capture duration before close() invalidates the frame
    const delayMs = getFrameDurationMs(frame);

    // Zero-copy: VideoFrame → RGBA directly (with optional resize)
    const rgba = needsResize
      ? await resizeFrameToRGBA(frame, w, h)
      : await copyFrameToRGBA(frame, w, h);
    frame.close();

    // Adaptive palette: recalculate if color changed significantly
    const shouldRecalc =
      recalcInterval !== null &&
      frameIdx > 0 &&
      frameIdx % recalcInterval === 0 &&
      prevFrameRGBA !== null &&
      computeColorDiff(rgba, prevFrameRGBA) > 30;

    if (!globalPalette || shouldRecalc) {
      globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
      const indexed = applyPalette(rgba, globalPalette, 'rgb565');
      encoder.writeFrame(indexed, w, h, {
        palette: globalPalette,
        repeat: 0,
        delay: delayMs,
      });
    } else {
      const indexed = applyPalette(rgba, globalPalette, 'rgb565');
      encoder.writeFrame(indexed, w, h, { delay: delayMs });
    }

    prevFrameRGBA = rgba;
    frameIdx++;

    if (onProgress && frameIdx % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'encoding',
        progress: Math.round((frameIdx / demux.totalFrames) * 100),
        fps: Math.round(frameIdx / elapsed),
        etaSeconds: null,
        memoryMB: 0,
      });
    }
  }

  encoder.finish();
  return encoder.bytes();
}
