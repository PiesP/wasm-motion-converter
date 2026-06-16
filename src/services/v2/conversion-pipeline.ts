// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Pipeline (Main Thread)
 *
 * demux → decode → encode, all on main thread.
 * Each encoder handles its own VideoDecoder.
 */

import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
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
  const pipelineStart = performance.now();

  // Demux (0~10%) — "Preparing video data..."
  const demuxResult = await demuxVideo(request, (packetsExtracted) => {
    const memMB = getMemoryUsageMB() ?? 0;
    const elapsedMs = Math.round(performance.now() - pipelineStart);
    onProgress({
      phase: 'demuxing',
      progress: 0, // demux has no total yet; caller maps to 0~10%
      fps: 0,
      etaSeconds: null,
      memoryMB: memMB,
      currentFrame: packetsExtracted,
      totalFrames: 0, // unknown during demux
      elapsedMs,
    });
  });

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  const codedWidth = demuxResult.config.codedWidth!;
  const codedHeight = demuxResult.config.codedHeight!;

  const demuxElapsedMs = performance.now() - pipelineStart;
  const demuxMemMB = getMemoryUsageMB() ?? 0;
  onProgress({
    phase: 'demuxing',
    progress: 10,
    fps: 0,
    etaSeconds: null,
    memoryMB: demuxMemMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: Math.round(demuxElapsedMs),
  });

  // Decode + Encode (10~90%)
  let output: ArrayBuffer;
  if (request.format === 'gif') {
    output = (
      await encodeGif(
        demuxResult,
        { width: codedWidth, height: codedHeight, quality: request.quality, scale: request.scale },
        (p) => {
          const mappedProgress = 10 + Math.round(p.progress * 0.8);
          onProgress({
            ...p,
            phase: 'encoding',
            progress: Math.min(90, mappedProgress),
            memoryMB: getMemoryUsageMB() ?? 0,
            currentFrame: p.currentFrame,
            totalFrames: demuxResult.totalFrames,
            elapsedMs: Math.round(performance.now() - pipelineStart),
          });
        },
        signal
      )
    ).buffer as ArrayBuffer;
  } else {
    const encoded = await encodeWebp(
      demuxResult,
      { width: codedWidth, height: codedHeight, quality: request.quality, scale: request.scale },
      (p) => {
        const mappedProgress = 10 + Math.round(p.progress * 0.8);
        onProgress({
          ...p,
          phase: 'encoding',
          progress: Math.min(90, mappedProgress),
          memoryMB: getMemoryUsageMB() ?? 0,
          currentFrame: p.currentFrame,
          totalFrames: demuxResult.totalFrames,
          elapsedMs: Math.round(performance.now() - pipelineStart),
        });
      },
      signal
    );
    output = encoded.buffer as ArrayBuffer;
  }

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Assembly (90~100%)
  const memMB = getMemoryUsageMB() ?? 0;
  const totalElapsedMs = Math.round(performance.now() - pipelineStart);
  onProgress({
    phase: 'assembling',
    progress: 95,
    fps: 0,
    etaSeconds: 0,
    memoryMB: memMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: totalElapsedMs,
  });
  onProgress({
    phase: 'assembling',
    progress: 100,
    fps: 0,
    etaSeconds: 0,
    memoryMB: memMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: totalElapsedMs,
  });

  // Completion summary
  logger.info('conversion', 'Pipeline complete', {
    format: request.format,
    quality: request.quality,
    scale: request.scale,
    totalFrames: demuxResult.totalFrames,
    outputBytes: output.byteLength,
    duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
    peakMemoryMB: memMB,
  });

  return output;
}
