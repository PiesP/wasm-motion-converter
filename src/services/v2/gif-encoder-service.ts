// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';
import {
  compositeAlphaToRGB,
  copyFrameToRGB,
  getFrameDurationMs,
  resizeFrameToRGBA,
} from './frame-utils';

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

// Bayer ordered dithering strength per quality (0-255 range, lower = subtler)
const QUALITY_DITHER_STRENGTH: Record<GifEncodeOptions['quality'], number> = {
  low: 12, // moderate dither to compensate for 64 colors
  medium: 8, // subtle dither for 128 colors
  high: 4, // very subtle dither for 256 colors (near-truecolor)
};

/**
 * Bayer ordered dithering (8×8 matrix) applied in-place on RGB data.
 *
 * Deterministic — same pattern every frame, no inter-frame swarming.
 * This preserves GIF LZW temporal compression unlike error-diffusion dithering.
 *
 * Memory: O(1) — modifies `rgb` in-place, no allocations.
 */
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
  const scale = strength / 64; // normalize 8×8 matrix values to [-strength/2, +strength/2]
  for (let y = 0; y < height; y++) {
    const by = BAYER_8X8[y & 7]!;
    for (let x = 0; x < width; x++) {
      const threshold = (by[x & 7]! - 32) * scale; // center around 0
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

/**
 * Encode demuxed video frames to GIF using streaming encoding.
 *
 * Memory usage: O(1) per frame — only one frame's RGBA data in memory at a time.
 * The VideoDecoder output callback queues frames, and we process them sequentially
 * through the GIF encoder, which writes each frame immediately without accumulation.
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

  // Frame queue for ordered processing
  const frameQueue: VideoFrame[] = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      frameQueue.push(frame);
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  decoder.configure(demux.config);

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

  console.log(
    `[encodeGif] decoded ${frameQueue.length} frames → encoding at ${w}×${h} (${maxColors} colors)`
  );

  // Process frames sequentially — O(1) memory per frame
  while (frameQueue.length > 0) {
    const frame = frameQueue.shift()!;
    if (signal?.aborted) {
      frame.close();
      for (const f of frameQueue) f.close();
      throw new DOMException('Cancelled', 'AbortError');
    }

    const delayMs = getFrameDurationMs(frame);

    // Convert frame to RGB — one frame at a time
    let rgb: Uint8Array;
    if (needsResize) {
      const rgba = await resizeFrameToRGBA(frame, w, h);
      rgb = compositeAlphaToRGB(rgba);
    } else {
      rgb = await copyFrameToRGB(frame, w, h);
    }
    frame.close();

    // Bayer ordered dithering (pre-processing, in-place on RGB)
    // Skip at 100% scale — too many pixels for synchronous JS loop (blocks main thread)
    if (opts.scale < 1.0) {
      bayerDitherRGB(rgb, w, h, ditherStrength);
    }

    // Quantize and write to GIF encoder immediately
    globalPalette = quantize(rgb, maxColors, { format: 'rgb565' });
    const indexed = applyPalette(rgb, globalPalette, 'rgb565');
    encoder.writeFrame(indexed, w, h, {
      palette: globalPalette,
      repeat: 0,
      delay: delayMs,
    });

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
