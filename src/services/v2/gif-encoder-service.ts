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

  // Process frames sequentially — O(1) memory per frame
  while (frameQueue.length > 0) {
    const frame = frameQueue.shift()!;
    if (signal?.aborted) {
      frame.close();
      for (const f of frameQueue) f.close();
      throw new DOMException('Cancelled', 'AbortError');
    }

    const delayMs = getFrameDurationMs(frame);

    // Convert frame to RGBA — one frame at a time
    let rgba: Uint8Array;
    if (needsResize) {
      rgba = await resizeFrameToRGBA(frame, w, h);
    } else {
      rgba = await copyFrameToRGBA(frame, w, h);
    }
    frame.close();

    // Quantize and write to GIF encoder immediately
    globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
    const indexed = applyPalette(rgba, globalPalette, 'rgb565');
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
