// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * V2 Conversion Service
 *
 * Runs the full pipeline on the main thread: demux → decode → encode.
 * WebCodecs VideoDecoder requires main thread access in most browsers.
 */

import { runConversionPipeline } from '@/services/v2/conversion-pipeline';
import type { ConversionProgress } from '@/types/v2-conversion-types';

export interface V2ConversionOptions {
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;
  trimStart: number;
  trimEnd: number;
}

export type V2ProgressCallback = (progress: ConversionProgress) => void;

export class ConversionCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

export async function performConversionV2(
  inputFile: File,
  options: V2ConversionOptions,
  onProgress: V2ProgressCallback,
  signal?: AbortSignal
): Promise<{ blob: Blob; format: 'gif' | 'webp' }> {
  const buffer = await inputFile.arrayBuffer();

  if (signal?.aborted) throw new ConversionCancelledError();

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
    },
    onProgress,
    signal
  );

  const mimeType = options.format === 'gif' ? 'image/gif' : 'image/webp';
  return { blob: new Blob([output], { type: mimeType }), format: options.format };
}
