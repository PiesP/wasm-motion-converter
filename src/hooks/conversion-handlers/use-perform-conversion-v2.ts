// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * V2 Conversion Service
 *
 * Runs the full pipeline on the main thread: demux → decode → encode.
 * WebCodecs VideoDecoder requires main thread access in most browsers.
 */

import type { ConversionFormat, ConversionQuality, SmartFrameSkipMode } from '@t/conversion-types';
import type { ProgressCallback } from '@t/v2-conversion-types';
import { logger } from '@utils/logger';
import { runConversionPipeline } from '@/services/v2/conversion-pipeline';

export interface V2ConversionOptions {
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: number;
  trimStart: number;
  trimEnd: number;
  /** Force frame decimation (overrides auto-decimation) */
  forceDecimation?: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

class ConversionCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

export async function performConversionV2(
  inputFile: File,
  options: V2ConversionOptions,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  existingBuffer?: ArrayBuffer
): Promise<{ blob: Blob; format: 'gif' | 'webp' }> {
  let buffer: ArrayBuffer;
  try {
    buffer = existingBuffer ?? (await inputFile.arrayBuffer());
  } catch (err) {
    logger.error('conversion', 'Failed to read input file buffer', {
      fileName: inputFile.name,
      fileSizeBytes: inputFile.size,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (signal?.aborted) {
    logger.info('conversion', 'Conversion cancelled before pipeline start', {
      fileName: inputFile.name,
      format: options.format,
    });
    throw new ConversionCancelledError();
  }

  const output = await runConversionPipeline(
    {
      inputBuffer: buffer,
      fileName: inputFile.name,
      format: options.format,
      quality: options.quality,
      scale: options.scale,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      maxMemoryMB: 1500,
      forceDecimation: options.forceDecimation,
      smartFrameSkip: options.smartFrameSkip,
    },
    onProgress,
    signal
  );

  logger.info('conversion', `  └─ Generated: ${options.format.toUpperCase()} blob`, {
    outputBytes: output.byteLength,
    format: options.format,
    fileName: inputFile.name,
  });

  const mimeType = options.format === 'gif' ? 'image/gif' : 'image/webp';
  return { blob: new Blob([output], { type: mimeType }), format: options.format };
}
