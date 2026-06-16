// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { MemoryGuard } from '@services/v2/memory-guard';
import { createConversionWorker } from '@services/v2/worker-utils';
import type { ConversionProgress, ConversionRequest } from '@t/v2-conversion-types';

const MAX_MEMORY_MB = 1500;

export interface V2ConversionOptions {
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;
  trimStart: number;
  trimEnd: number;
}

export type V2ProgressCallback = (progress: ConversionProgress) => void;

export async function performConversionV2(
  inputFile: File,
  options: V2ConversionOptions,
  onProgress: V2ProgressCallback
): Promise<{ blob: Blob; format: 'gif' | 'webp' }> {
  const guard = new MemoryGuard(MAX_MEMORY_MB);
  const suggestedScale = guard.suggestScale(1920, 1080, 300);
  const finalScale = Math.min(options.scale, suggestedScale);

  const buffer = await inputFile.arrayBuffer();

  const canvas = document.createElement('canvas');
  const { worker } = createConversionWorker(canvas);

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
          canvas.remove();
          break;
        }
        case 'error': {
          reject(new Error(msg.message));
          worker.terminate();
          canvas.remove();
          break;
        }
      }
    };

    worker.onerror = (err) => {
      reject(new Error(err.message));
      worker.terminate();
      canvas.remove();
    };

    const request: ConversionRequest = {
      inputBuffer: buffer,
      fileName: inputFile.name,
      format: options.format,
      quality: options.quality,
      scale: finalScale,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      maxMemoryMB: MAX_MEMORY_MB,
    };

    worker.postMessage({ type: 'convert', request }, [buffer]);
  });
}
