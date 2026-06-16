// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Decoder Service
 *
 * Video decoder using WebCodecs VideoDecoder.
 * Uses a completion Promise to guarantee all frames are collected before yielding.
 */

import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';

export type DecodeProgressCallback = (progress: ConversionProgress) => void;

/**
 * Decode video chunks and yield frames one at a time.
 *
 * Creates a completion Promise that resolves only after:
 * 1. All chunks are fed to the decoder
 * 2. decoder.flush() is called and awaited
 * 3. The flush promise resolves (all output callbacks have fired)
 */
export async function* decodeStreaming(
  demux: DemuxResult,
  onProgress?: DecodeProgressCallback,
  signal?: AbortSignal
): AsyncGenerator<VideoFrame, void, void> {
  const startTime = performance.now();
  const frames: VideoFrame[] = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      frames.push(frame);
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  decoder.configure(demux.config);

  // Feed all chunks
  let chunkIdx = 0;
  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
    chunkIdx++;
  }

  // Flush and wait for all output callbacks
  try {
    const flushPromise = decoder.flush();
    // Handle both Promise and undefined return
    if (flushPromise) {
      await flushPromise;
    }
    // Additional delay ensures output callbacks have fired
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } catch (e) {
    if (!decodeError) {
      decodeError = e instanceof Error ? e : new Error(String(e));
    }
  }

  decoder.close();

  if (decodeError) throw decodeError;

  // Yield frames
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) {
      for (let j = i; j < frames.length; j++) {
        frames[j]?.close();
      }
      throw new DOMException('Cancelled', 'AbortError');
    }

    if (onProgress && (i + 1) % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'decoding',
        progress: Math.round(((i + 1) / demux.totalFrames) * 100),
        fps: Math.round((i + 1) / elapsed),
        etaSeconds: i > 0 ? Math.round((demux.totalFrames - i - 1) / ((i + 1) / elapsed)) : null,
        memoryMB: 0,
      });
    }

    yield frames[i]!;
  }

  if (onProgress) {
    onProgress({
      phase: 'decoding',
      progress: 100,
      fps: 0,
      etaSeconds: 0,
      memoryMB: 0,
    });
  }
}

/**
 * Legacy batch decoder — same as decodeStreaming.
 */
export async function* decodeStream(
  demux: DemuxResult,
  _poolSize: number,
  onProgress?: DecodeProgressCallback
): AsyncGenerator<VideoFrame, void, void> {
  yield* decodeStreaming(demux, onProgress);
}
