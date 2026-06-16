// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

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

export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  onProgress?: WebpProgressCallback,
  _signal?: AbortSignal
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

  for await (const frame of decodeStreaming(demux, undefined, undefined)) {
    const durationMs = getFrameDurationMs(frame);

    let rgbData: Uint8Array;
    if (needsResize) {
      const rgba = await resizeFrameToRGBA(frame, w, h);
      rgbData = compositeAlphaToRGB(rgba);
    } else {
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
  if (!result || result.length === 0) {
    throw new Error(
      `wasm-webp encodeAnimation returned ${result ? `empty (${result.length} bytes)` : 'null'} (frames: ${frames.length}, w: ${w}, h: ${h}, totalInputBytes: ${frames.reduce((s, f) => s + f.data.length, 0)})`
    );
  }

  return result;
}
