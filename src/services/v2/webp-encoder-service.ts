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

/** Max frames per encodeAnimation call to keep WASM memory under ~2GB */
const MAX_FRAMES = 300;

/**
 * Encode demuxed video frames to WebP.
 * Skips frames if needed to keep WASM memory under the 2GB limit.
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

  // Calculate frame skip if too many frames
  const frameStep = demux.totalFrames > MAX_FRAMES ? Math.ceil(demux.totalFrames / MAX_FRAMES) : 1;
  if (frameStep > 1) {
    console.warn(
      `[encodeWebp] ${demux.totalFrames} frames → ~${Math.ceil(demux.totalFrames / frameStep)} frames (step=${frameStep})`
    );
  }

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

  // Convert frames and encode
  const frames: { data: Uint8Array; duration: number; config: WebPConfig }[] = [];
  const startTime = performance.now();
  let encodedFrames = 0;

  for (let i = 0; i < decodedFrames.length; i += frameStep) {
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
    encodedFrames++;

    if (onProgress && encodedFrames % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'encoding',
        progress: Math.round((encodedFrames / Math.ceil(demux.totalFrames / frameStep)) * 100),
        fps: Math.round(encodedFrames / elapsed),
        etaSeconds: null,
        memoryMB: 0,
      });
    }

    // Close remaining frames we skipped
    if (frameStep > 1) {
      for (let j = i + 1; j < Math.min(i + frameStep, decodedFrames.length); j++) {
        decodedFrames[j]?.close();
      }
    }
  }

  if (frames.length === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  const result = await encodeAnimation(w, h, false, frames);
  if (!result || result.length === 0) {
    throw new Error(
      `wasm-webp encodeAnimation returned ${result ? `empty (${result.length} bytes)` : 'null'} (frames: ${frames.length}, w: ${w}, h: ${h})`
    );
  }

  return result;
}
