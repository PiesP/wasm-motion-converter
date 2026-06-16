// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service
 *
 * Encodes decoded video frames into animated WebP using wasm-webp.
 * Processes frames one at a time to minimize memory usage.
 */

import type { WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeStreaming } from './decoder-service';
import type { DemuxResult } from './demuxer-service';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 50,
  medium: 75,
  high: 95,
};

export type WebpProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video chunks directly to WebP.
 * Decodes and encodes frames in a streaming pipeline.
 *
 * Note: WebP encoder accumulates all frames before final encode,
 * but frames are decoded one at a time to minimize decode-side memory.
 */
export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  onProgress?: WebpProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const webpConfig: WebPConfig = { lossless: 0, quality };

  const frames: { data: Uint8Array; duration: number; config: WebPConfig }[] = [];
  let frameIdx = 0;
  const startTime = performance.now();

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  for await (const frame of decodeStreaming(demux, undefined, signal)) {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: w,
      resizeHeight: h,
    });
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    frame.close();

    const imageData = ctx.getImageData(0, 0, w, h);

    // Strip alpha: RGBA → RGB
    const pixelCount = w * h;
    const rgbData = new Uint8Array(pixelCount * 3);
    const src = imageData.data;
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * 4;
      const dstIdx = i * 3;
      rgbData[dstIdx] = src[srcIdx]!;
      rgbData[dstIdx + 1] = src[srcIdx + 1]!;
      rgbData[dstIdx + 2] = src[srcIdx + 2]!;
    }

    const rawDuration = frame.duration as number | null;
    const durationMs =
      rawDuration != null && rawDuration > 0 ? Math.max(1, Math.round(rawDuration / 1000)) : 100;

    frames.push({ data: rgbData, duration: durationMs, config: webpConfig });

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

  const result = await encodeAnimation(w, h, false, frames);
  if (!result) {
    throw new Error('wasm-webp encodeAnimation returned null');
  }

  return result;
}
