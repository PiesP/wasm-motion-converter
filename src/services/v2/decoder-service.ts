// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Decoder Service
 *
 * Streaming video decoder using WebCodecs VideoDecoder.
 * Frames are yielded one at a time to minimize memory usage.
 */

import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';

export type DecodeProgressCallback = (progress: ConversionProgress) => void;

/**
 * Decode video chunks and yield frames one at a time.
 *
 * Uses a streaming approach: chunks are fed to the decoder sequentially,
 * and frames are yielded via an async generator as they become available.
 * This avoids storing all decoded frames in memory simultaneously.
 *
 * @param demux - Demuxed video data (chunks + config)
 * @param onProgress - Progress callback
 * @param signal - AbortSignal for cancellation
 */
export async function* decodeStreaming(
  demux: DemuxResult,
  onProgress?: DecodeProgressCallback,
  signal?: AbortSignal
): AsyncGenerator<VideoFrame, void, void> {
  const startTime = performance.now();
  let frameCount = 0;
  let decodeError: Error | null = null;

  // Queue for frames ready to be yielded
  const frameQueue: VideoFrame[] = [];
  let resolveNext: (() => void) | null = null;

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      frameQueue.push(frame);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    },
    error(e: Error) {
      decodeError = e;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    },
  });

  decoder.configure(demux.config);

  // Feed chunks sequentially
  let chunkIdx = 0;
  const feedNextChunk = (): void => {
    if (chunkIdx >= demux.chunks.length || decodeError) {
      if (chunkIdx >= demux.chunks.length) {
        decoder.flush();
      }
      return;
    }
    const chunk = demux.chunks[chunkIdx];
    if (chunk) {
      decoder.decode(chunk);
    }
    chunkIdx++;
  };

  // Start feeding chunks
  feedNextChunk();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Cancelled', 'AbortError');
      }

      // Wait for frames or completion
      while (frameQueue.length === 0 && !decodeError && chunkIdx < demux.chunks.length) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
          // Also resolve when next chunk is fed
          if (chunkIdx < demux.chunks.length) {
            feedNextChunk();
          }
        });
      }

      // Yield available frames
      while (frameQueue.length > 0) {
        const frame = frameQueue.shift()!;
        frameCount++;

        if (onProgress && frameCount % 5 === 0) {
          const elapsed = (performance.now() - startTime) / 1000;
          onProgress({
            phase: 'decoding',
            progress: Math.round((frameCount / demux.totalFrames) * 100),
            fps: Math.round(frameCount / elapsed),
            etaSeconds:
              frameCount > 0
                ? Math.round((demux.totalFrames - frameCount) / (frameCount / elapsed))
                : null,
            memoryMB: 0,
          });
        }

        yield frame;
      }

      // Check if we're done
      if (chunkIdx >= demux.chunks.length && frameQueue.length === 0) {
        break;
      }

      if (decodeError) throw decodeError;
    }
  } finally {
    decoder.close();
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
 * Legacy batch decoder — decodes all chunks then yields frames.
 * Kept for backward compatibility but decodeStreaming is preferred.
 */
export async function* decodeStream(
  demux: DemuxResult,
  _poolSize: number,
  onProgress?: DecodeProgressCallback
): AsyncGenerator<VideoFrame, void, void> {
  yield* decodeStreaming(demux, onProgress);
}
