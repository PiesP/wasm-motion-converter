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
  const format = request.format;
  const logCtx = {
    format,
    quality: request.quality,
    scale: request.scale,
    fileName: request.fileName,
    trimStart: request.trimStart,
    trimEnd: request.trimEnd,
    inputBytes: request.inputBuffer.byteLength,
  };

  logger.performance('Pipeline started', logCtx);
  logger.info('conversion', `▶ Pipeline route: V2_MAINTHREAD_${format.toUpperCase()}`, logCtx);

  // Demux (0~10%)
  let demuxResult: Awaited<ReturnType<typeof demuxVideo>>;
  try {
    demuxResult = await demuxVideo(request, (packetsExtracted) => {
      const memMB = getMemoryUsageMB() ?? 0;
      const elapsedMs = Math.round(performance.now() - pipelineStart);
      onProgress({
        phase: 'demuxing',
        progress: 0,
        fps: 0,
        etaSeconds: null,
        memoryMB: memMB,
        currentFrame: packetsExtracted,
        totalFrames: 0,
        elapsedMs,
      });
    });
  } catch (err) {
    logger.error('conversion', 'Demux failed', {
      fileName: request.fileName,
      format: request.format,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (signal?.aborted) {
    logger.info('conversion', 'Conversion aborted after demux');
    throw new DOMException('Cancelled', 'AbortError');
  }

  const cfg = demuxResult.config as unknown as Record<string, number>;
  const codedWidth = cfg.displayWidth ?? demuxResult.config.codedWidth!;
  const codedHeight = cfg.displayHeight ?? demuxResult.config.codedHeight!;

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
    logger.info('conversion', '  ├─ Branch: GIF encoder (gifenc + VideoDecoder)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
    });
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
    logger.info('conversion', '  ├─ Branch: WebP encoder (wasm-webp + VideoDecoder)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
    });
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
  logger.info('conversion', `◀ Pipeline complete: V2_MAINTHREAD_${request.format.toUpperCase()}`, {
    format: request.format,
    quality: request.quality,
    scale: request.scale,
    totalFrames: demuxResult.totalFrames,
    outputBytes: output.byteLength,
    duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
    peakMemoryMB: memMB,
  });
  logger.performance('Pipeline complete', {
    format: request.format,
    outputBytes: output.byteLength,
    durationMs: totalElapsedMs,
    peakMemoryMB: memMB,
  });

  return output;
}
