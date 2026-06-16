// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
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
 * Collect decoded frames into an array, then encode to WebP.
 * This avoids async generator issues in the Worker context.
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

  // Phase 1: Decode all frames
  const frames: { data: Uint8Array; duration: number; config: WebPConfig }[] = [];
  const decodedFrames: VideoFrame[] = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      decodedFrames.push(frame);
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  decoder.configure(demux.config);

  console.log('[webp-encoder] chunks:', demux.chunks.length, 'codec:', demux.config.codec);

  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
  }

  try {
    await decoder.flush();
  } catch (e) {
    if (!decodeError) {
      decodeError = e instanceof Error ? e : new Error(String(e));
    }
  }
  decoder.close();

  if (decodeError) throw decodeError;

  // Phase 2: Convert each VideoFrame to RGB
  const startTime = performance.now();
  for (let i = 0; i < decodedFrames.length; i++) {
    const frame = decodedFrames[i]!;
    if (signal?.aborted) {
      for (let j = i; j < decodedFrames.length; j++) decodedFrames[j]?.close();
      throw new DOMException('Cancelled', 'AbortError');
    }

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

    if (onProgress && (i + 1) % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'encoding',
        progress: Math.round(((i + 1) / demux.totalFrames) * 100),
        fps: Math.round((i + 1) / elapsed),
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
