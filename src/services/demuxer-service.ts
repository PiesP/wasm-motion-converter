// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import { extractVideoMetadata } from '@services/video-metadata';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS, DEMUX_MEMORY_BUDGET_BYTES } from '@utils/constants';
import { logger } from '@utils/logger';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { type EncodedPacket, EncodedPacketSink } from 'mediabunny';

export interface DemuxResult {
  /** One-shot packet stream. The producer advances only when the decoder requests a chunk. */
  chunks: Iterable<EncodedVideoChunk> | AsyncIterable<EncodedVideoChunk>;
  config: VideoDecoderConfig;
  /** Maximum encoded bytes that the decoder may retain before emitting matching output. */
  encodedChunkBudgetBytes?: number | undefined;
  /** Estimated frame count until the stream finishes, then the exact packet count. */
  totalFrames: number;
  duration: number;
  /** Exact streamed source duration in milliseconds once chunks are consumed. */
  sourceTotalMs: number;
  /** Average frame rate from pre-computed metadata (or fallback). Used for decimation calculation. */
  framerate: number;
  /** First requested presentation timestamp in microseconds. Preroll packets may precede it. */
  trimStartUs?: number | undefined;
  /** Idempotently release the MediaBunny input if the stream is not consumed. */
  dispose?: (() => void) | undefined;
}

type DemuxPreparedCallback = (estimatedTotalFrames: number) => void;

const ENCODED_CHUNK_OVERHEAD_BYTES = 1024;

export function getEncodedChunkRetainedBytes(chunk: EncodedVideoChunk): number {
  return chunk.byteLength + ENCODED_CHUNK_OVERHEAD_BYTES;
}

function resolveInputSource(request: ConversionRequest): Blob | ArrayBuffer {
  const source = request.inputBlob ?? request.inputBuffer;
  if (!source) {
    throw new Error('No video input source provided');
  }
  return source;
}

function getInputSizeBytes(source: Blob | ArrayBuffer): number {
  return source instanceof Blob ? source.size : source.byteLength;
}

/**
 * Prepare a lazy MediaBunny packet stream for the decoder.
 *
 * When `preComputedMetadata` is provided (from file selection's metadata extraction),
 * the config, duration, and framerate are reused — avoiding a second
 * `extractVideoMetadata()` call and its associated Input creation.
 *
 * @param request - Conversion settings + input buffer
 * @param preComputedMetadata - Optional pre-extracted metadata (from handleFileSelected)
 * @param onPrepared - Callback after metadata, track, and trim start are ready
 * @param signal - AbortSignal for cancellation
 */
export async function demuxVideo(
  request: ConversionRequest,
  preComputedMetadata?: VideoMetadata,
  onPrepared?: DemuxPreparedCallback,
  signal?: AbortSignal
): Promise<DemuxResult> {
  const startTime = performance.now();
  const inputSource = resolveInputSource(request);
  const inputSizeBytes = getInputSizeBytes(inputSource);

  // Reuse pre-computed metadata when available (avoids second extractVideoMetadata call).
  // Keep the extractVideoMetadata fallback for callers that don't pass metadata
  // (e.g. tests, programmatic API usage).
  let config: VideoDecoderConfig;
  let duration: number;
  let framerate: number;

  if (preComputedMetadata?.config) {
    config = preComputedMetadata.config;
    duration = preComputedMetadata.duration;
    framerate = preComputedMetadata.framerate;
  } else {
    // Extract metadata (also validates the video track exists and config is obtainable).
    const metadata = await extractVideoMetadata(inputSource);
    if (!metadata.config) {
      throw new Error('Unable to obtain VideoDecoderConfig from video track');
    }
    config = metadata.config;
    duration = metadata.duration;
    framerate = metadata.framerate;
  }

  // Estimate total frames from duration and frame rate for progress reporting.
  // This is an estimate — actual packet count may differ due to variable frame rate
  // or container-level vs stream-level duration mismatch.
  const safeFramerate = Number.isFinite(framerate) && framerate > 0 ? framerate : DEFAULT_FPS;
  const estimatedTotalFrames = Math.max(1, Math.round(duration * safeFramerate));

  // Set up source/input for demuxing.
  // Prefer inputBlob (on-demand read via BlobSource) over inputBuffer
  // (full in-memory BufferSource) to reduce memory usage for large files.
  const input = createMediaBunnyInput(inputSource);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    input.dispose();
  };

  try {
    const videoTracks = await input.getVideoTracks();
    const videoTrack = videoTracks[0];
    if (!videoTrack) {
      logger.warn('demuxer', 'no-video-track', {
        fileName: request.fileName,
        fileSizeBytes: inputSizeBytes,
      });
      throw new Error('No video track found in input');
    }
    const sink = new EncodedPacketSink(videoTrack);

    // Decode from the key packet at or before trimStart. Frames before the requested
    // presentation timestamp are preroll needed to decode the first visible frame;
    // decoder-service filters those frames from encoder output.
    let startPacket: EncodedPacket | null;
    if (request.trimStart > 0) {
      startPacket = await sink.getKeyPacket(request.trimStart, { verifyKeyPackets: true });
    } else {
      startPacket = await sink.getFirstPacket();
    }
    if (!startPacket) {
      logger.warn('demuxer', 'no-decodable-packets', {
        fileName: request.fileName,
        codec: config.codec,
        duration: `${duration.toFixed(2)}s`,
        trimStart: request.trimStart,
      });
      throw new Error('No decodable packets found in input buffer');
    }

    // trimEnd == 0 means "until the end" — iterate all packets without a boundary.
    // MediaBunny's packets(start, end) excludes `end` from iteration, so using
    // an endPacket causes the last frame to be lost. Instead, iterate unbounded
    // and break manually when exceeding trimEnd.
    const trimEnd = request.trimEnd > 0 ? request.trimEnd : undefined;
    const memoryBudgetBytes = DEMUX_MEMORY_BUDGET_BYTES;

    logger.info('demuxer', 'Demux stream prepared', {
      fileName: request.fileName,
      fileSizeBytes: inputSizeBytes,
      codec: config.codec,
      duration: `${duration.toFixed(2)}s`,
      memoryBudgetBytes,
    });

    // Check for cancellation before handing ownership of Input to the stream.
    signal?.throwIfAborted();
    onPrepared?.(estimatedTotalFrames);

    let result!: DemuxResult;
    const chunks = (async function* streamChunks(): AsyncGenerator<EncodedVideoChunk> {
      let totalFrames = 0;
      let sourceDurationUs = 0;
      let peakChunkBytes = 0;
      let completed = false;

      try {
        // Iterate all packets from startPacket — no end boundary since
        // MediaBunny's packets() excludes the boundary packet. The consumer's
        // next() calls provide backpressure, so only one encoded chunk is held
        // between this generator and VideoDecoder.
        for await (const packet of sink.packets(startPacket)) {
          if (trimEnd !== undefined && packet.timestamp > trimEnd) break;
          signal?.throwIfAborted();

          const chunk = packet.toEncodedVideoChunk();
          const retainedBytes = getEncodedChunkRetainedBytes(chunk);
          if (retainedBytes > memoryBudgetBytes) {
            throw new Error(
              `Demux memory limit exceeded by one encoded packet (${memoryBudgetBytes} byte budget)`
            );
          }

          peakChunkBytes = Math.max(peakChunkBytes, retainedBytes);
          totalFrames++;
          sourceDurationUs += Math.max(0, chunk.duration ?? 0);
          yield chunk;

          // Yield periodically even when the decoder accepts packets quickly.
          if (totalFrames % 50 === 0) await yieldToMain();
        }
        completed = true;
      } finally {
        result.totalFrames = totalFrames;
        result.sourceTotalMs = sourceDurationUs / 1000;
        dispose();

        const elapsed = performance.now() - startTime;
        logger.info('demuxer', completed ? 'Demux stream complete' : 'Demux stream closed', {
          totalFrames,
          sourceTotalMs: result.sourceTotalMs,
          peakChunkBytes,
          elapsedMs: Math.round(elapsed),
          elapsed: `${(elapsed / 1000).toFixed(2)}s`,
        });
      }
    })();

    result = {
      chunks,
      config,
      encodedChunkBudgetBytes: memoryBudgetBytes,
      totalFrames: estimatedTotalFrames,
      duration,
      sourceTotalMs: 0,
      framerate,
      trimStartUs: request.trimStart * 1_000_000,
      dispose,
    };
    return result;
  } catch (error) {
    dispose();
    throw error;
  }
}
