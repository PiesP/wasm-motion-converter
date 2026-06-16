// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service
 *
 * Encodes decoded video frames into animated GIF using gifenc.
 * Uses direct VideoFrame.copyTo() for zero-copy pixel extraction.
 * Single global palette from first frame for speed.
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

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video frames to GIF.
 * Uses direct VideoFrame pixel copy — no ImageBitmap intermediate.
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

  const encoder = GIFEncoder({ auto: true });
  let frameIdx = 0;
  const startTime = performance.now();
  let globalPalette: number[][] | null = null;

  for await (const frame of decodeStreaming(demux, undefined, signal)) {
    // Zero-copy: VideoFrame → RGBA directly (with optional resize)
    const rgba = needsResize
      ? await resizeFrameToRGBA(frame, w, h)
      : await copyFrameToRGBA(frame, w, h);
    frame.close();

    const delayMs = getFrameDurationMs(frame);

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
