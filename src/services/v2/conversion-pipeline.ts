// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Pipeline (Worker-side)
 *
 * Streaming pipeline: demux → decode → encode
 * Frames are processed one at a time to minimize memory usage.
 * No intermediate frame storage — each frame is decoded, encoded, and closed immediately.
 */

import type { ConversionProgress, ConversionRequest } from '@/types/v2-conversion-types';
import { demuxVideo } from './demuxer-service';
import { encodeGif } from './gif-encoder-service';
import { encodeWebp } from './webp-encoder-service';

export type PipelineProgressCallback = (progress: ConversionProgress) => void;

export async function runConversionPipeline(
  request: ConversionRequest,
  onProgress: PipelineProgressCallback,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  // Phase 1: Demux (0~10%)
  onProgress({ phase: 'decoding', progress: 0, fps: 0, etaSeconds: null, memoryMB: 0 });
  const demuxResult = await demuxVideo(request);
  onProgress({ phase: 'decoding', progress: 10, fps: 0, etaSeconds: null, memoryMB: 0 });

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Phase 2: Decode + Encode streaming (10~90%)
  // Frames are decoded and encoded one at a time — no intermediate storage
  const codedWidth = demuxResult.config.codedWidth!;
  const codedHeight = demuxResult.config.codedHeight!;

  let output: ArrayBuffer;
  if (request.format === 'gif') {
    output = (
      await encodeGif(
        demuxResult,
        {
          width: codedWidth,
          height: codedHeight,
          quality: request.quality,
          scale: request.scale,
        },
        (p) => {
          const mappedProgress = 10 + Math.round(p.progress * 0.8);
          onProgress({ ...p, progress: Math.min(90, mappedProgress) });
        },
        signal
      )
    ).buffer as ArrayBuffer;
  } else {
    const encoded = await encodeWebp(
      demuxResult,
      {
        width: codedWidth,
        height: codedHeight,
        quality: request.quality,
        scale: request.scale,
      },
      (p) => {
        const mappedProgress = 10 + Math.round(p.progress * 0.8);
        onProgress({ ...p, progress: Math.min(90, mappedProgress) });
      },
      signal
    );
    output = encoded.buffer as ArrayBuffer;
  }

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Phase 3: Assembly (90~100%)
  onProgress({ phase: 'assembling', progress: 95, fps: 0, etaSeconds: 0, memoryMB: 0 });
  onProgress({ phase: 'assembling', progress: 100, fps: 0, etaSeconds: 0, memoryMB: 0 });

  return output;
}
