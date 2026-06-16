// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service
 *
 * Encodes decoded video frames into animated GIF using gifenc.
 * Uses a single global palette from the first frame for speed.
 * Frames are processed one at a time to minimize memory usage.
 */

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeStreaming } from './decoder-service';
import type { DemuxResult } from './demuxer-service';

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

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video chunks directly to GIF.
 * Decodes and encodes frames one at a time — no intermediate frame storage.
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: GifEncodeOptions,
  onProgress?: GifProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);
  const maxColors = QUALITY_COLORS[opts.quality];

  const encoder = GIFEncoder({ auto: true });
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  let frameIdx = 0;
  const startTime = performance.now();
  let globalPalette: number[][] | null = null;

  for await (const frame of decodeStreaming(demux, undefined, signal)) {
    // Convert VideoFrame → ImageBitmap → Canvas → ImageData
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: w,
      resizeHeight: h,
    });
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    frame.close();

    const imageData = ctx.getImageData(0, 0, w, h);
    const rgba = new Uint8Array(imageData.data);
    const delayMs = Math.max(10, Math.round((frame.duration ?? 33_333) / 1000));

    if (!globalPalette) {
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
