// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
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

const PALETTE_RECALC_INTERVAL: Record<GifEncodeOptions['quality'], number | null> = {
  low: null,
  medium: 30,
  high: 15,
};

export type GifProgressCallback = (progress: ConversionProgress) => void;

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

  // Decode all frames
  const decodedFrames: VideoFrame[] = [];
  let decodeError: Error | null = null;

  // Check codec support before creating decoder
  const support = await VideoDecoder.isConfigSupported(demux.config);
  if (!support.supported) {
    throw new Error(`Codec not supported: ${demux.config.codec}`);
  }

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      decodedFrames.push(frame);
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  decoder.configure(demux.config);

  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      if (decoder.state !== 'closed') decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
  }

  try {
    if (decoder.state !== 'closed') await decoder.flush();
  } catch (e) {
    if (!decodeError) {
      decodeError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (decoder.state !== 'closed') decoder.close();

  if (decodeError) throw decodeError;

  // Encode to GIF
  const encoder = GIFEncoder({ auto: true });
  let frameIdx = 0;
  const startTime = performance.now();
  let globalPalette: number[][] | null = null;
  let prevFrameRGBA: Uint8Array | null = null;

  for (let i = 0; i < decodedFrames.length; i++) {
    const frame = decodedFrames[i]!;
    if (signal?.aborted) {
      for (let j = i; j < decodedFrames.length; j++) decodedFrames[j]?.close();
      throw new DOMException('Cancelled', 'AbortError');
    }

    const delayMs = getFrameDurationMs(frame);
    const rgba = needsResize
      ? await resizeFrameToRGBA(frame, w, h)
      : await copyFrameToRGBA(frame, w, h);
    frame.close();

    const shouldRecalc =
      recalcInterval !== null &&
      frameIdx > 0 &&
      frameIdx % recalcInterval === 0 &&
      prevFrameRGBA !== null &&
      computeColorDiff(rgba, prevFrameRGBA) > 30;

    if (!globalPalette || shouldRecalc) {
      globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
      const indexed = applyPalette(rgba, globalPalette, 'rgb565');
      encoder.writeFrame(indexed, w, h, { palette: globalPalette, repeat: 0, delay: delayMs });
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

  if (frameIdx === 0) {
    throw new Error('No frames decoded for GIF encoding');
  }

  encoder.finish();
  return encoder.bytes();
}
