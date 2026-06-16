// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * V2 Conversion Service
 *
 * Orchestrates video conversion via Web Worker.
 * The worker runs the full pipeline: demux → decode → encode.
 */

import type { ConversionProgress, ConversionRequest } from '@/types/v2-conversion-types';

const MAX_MEMORY_MB = 1500;

export interface V2ConversionOptions {
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;
  trimStart: number;
  trimEnd: number;
}

export type V2ProgressCallback = (progress: ConversionProgress) => void;

/**
 * Create a conversion worker and return a promise-based interface.
 */
function createConversionWorker(): Worker {
  return new Worker(new URL('../../workers/conversion.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export async function performConversionV2(
  inputFile: File,
  options: V2ConversionOptions,
  onProgress: V2ProgressCallback
): Promise<{ blob: Blob; format: 'gif' | 'webp' }> {
  const buffer = await inputFile.arrayBuffer();

  const worker = createConversionWorker();

  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case 'progress':
          onProgress(msg.progress);
          break;
        case 'complete': {
          const mimeType = msg.format === 'gif' ? 'image/gif' : 'image/webp';
          const blob = new Blob([msg.output], { type: mimeType });
          resolve({ blob, format: msg.format });
          worker.terminate();
          break;
        }
        case 'error': {
          reject(new Error(msg.message));
          worker.terminate();
          break;
        }
      }
    };

    worker.onerror = (err) => {
      reject(new Error(err.message));
      worker.terminate();
    };

    const request: ConversionRequest = {
      inputBuffer: buffer,
      fileName: inputFile.name,
      format: options.format,
      quality: options.quality,
      scale: options.scale,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      maxMemoryMB: MAX_MEMORY_MB,
    };

    // Transfer ArrayBuffer ownership to worker (zero-copy)
    worker.postMessage({ type: 'convert', request }, [buffer]);
  });
}
