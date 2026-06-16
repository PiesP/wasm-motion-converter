// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service
 *
 * Encodes decoded video frames into animated WebP using wasm-webp.
 * Uses direct VideoFrame.copyTo() for zero-copy pixel extraction.
 * Alpha compositing: blends RGBA over black to avoid dark artifacts.
 */

import type { WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeStreaming } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import {
  compositeAlphaToRGB,
  copyFrameToRGB,
  getFrameDurationMs,
  resizeFrameToRGBA,
} from './frame-utils';

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
 * Encode demuxed video frames to WebP.
 * Uses direct VideoFrame pixel copy + alpha compositing.
 */
export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  onProgress?: WebpProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const webpConfig: WebPConfig = { lossless: 0, quality };
  const needsResize = w !== srcW || h !== srcH;

  const frames: { data: Uint8Array; duration: number; config: WebPConfig }[] = [];
  let frameIdx = 0;
  const startTime = performance.now();

  for await (const frame of decodeStreaming(demux, undefined, signal)) {
    // Capture duration before close() invalidates the frame
    const durationMs = getFrameDurationMs(frame);

    // Zero-copy: VideoFrame → RGB with alpha compositing
    let rgbData: Uint8Array;
    if (needsResize) {
      // Resize path: RGBA with alpha composite
      const rgba = await resizeFrameToRGBA(frame, w, h);
      rgbData = compositeAlphaToRGB(rgba);
    } else {
      // Direct path: VideoFrame → RGB
      rgbData = await copyFrameToRGB(frame, w, h);
    }
    frame.close();

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
