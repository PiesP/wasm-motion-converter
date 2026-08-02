// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import { extractVideoMetadata } from '@services/video-metadata';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { type EncodedPacket, EncodedPacketSink } from 'mediabunny';

export interface DemuxResult {
  chunks: EncodedVideoChunk[];
  config: VideoDecoderConfig;
  totalFrames: number;
  duration: number;
  /** Total source duration in milliseconds (computed from chunk durations) */
  sourceTotalMs: number;
  /** Average frame rate from pre-computed metadata (or fallback). Used for decimation calculation. */
  framerate: number;
  /** First requested presentation timestamp in microseconds. Preroll packets may precede it. */
  trimStartUs?: number | undefined;
}

type DemuxProgressCallback = (packetsExtracted: number, estimatedTotalFrames: number) => void;

const BYTES_PER_MIB = 1024 * 1024;
const DEMUX_MEMORY_BUDGET_RATIO = 0.25;
const ENCODED_CHUNK_OVERHEAD_BYTES = 1024;

/**
 * Demux a video buffer using MediaBunny, extracting encoded video chunks.
 *
 * When `preComputedMetadata` is provided (from file selection's metadata extraction),
 * the config, duration, and framerate are reused — avoiding a second
 * `extractVideoMetadata()` call and its associated Input creation.
 *
 * @param request - Conversion settings + input buffer
 * @param preComputedMetadata - Optional pre-extracted metadata (from handleFileSelected)
 * @param onProgress - Callback for demux progress reporting
 * @param signal - AbortSignal for cancellation
 */
export async function demuxVideo(
  request: ConversionRequest,
  preComputedMetadata?: VideoMetadata,
  onProgress?: DemuxProgressCallback,
  signal?: AbortSignal
): Promise<DemuxResult> {
  const startTime = performance.now();

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
    // Pass a copy so the original buffer stays intact for demuxing below —
    // mediabunny's BufferSource may detach the buffer on dispose.
    const metadata = await extractVideoMetadata(request.inputBuffer.slice(0));
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
  const inputSource = request.inputBlob ?? request.inputBuffer;
  const input = createMediaBunnyInput(inputSource);
  try {
    const videoTracks = await input.getVideoTracks();
    const videoTrack = videoTracks[0];
    if (!videoTrack) {
      logger.warn('demuxer', 'no-video-track', {
        fileName: request.fileName,
        fileSizeBytes: request.inputBlob?.size ?? request.inputBuffer.byteLength,
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
    const memoryBudgetBytes = Math.max(
      1,
      Math.floor(request.maxMemoryMB * BYTES_PER_MIB * DEMUX_MEMORY_BUDGET_RATIO)
    );

    const chunks: EncodedVideoChunk[] = [];
    let retainedBytes = 0;
    let totalFrames = 0;

    logger.info('demuxer', 'Demuxing started', {
      fileName: request.fileName,
      fileSizeBytes: request.inputBuffer.byteLength,
      codec: config.codec,
      duration: `${duration.toFixed(2)}s`,
      memoryBudgetBytes,
    });

    // Check for cancellation before starting packet iteration
    signal?.throwIfAborted();
    // Iterate all packets from startPacket — no end boundary since
    // MediaBunny's packets() excludes the boundary packet.
    // Manual break when exceeding trimEnd.
    for await (const packet of sink.packets(startPacket)) {
      // Stop if we've passed the trim end boundary
      if (trimEnd !== undefined && packet.timestamp > trimEnd) {
        break;
      }
      signal?.throwIfAborted();
      const chunk = packet.toEncodedVideoChunk();
      retainedBytes += chunk.byteLength + ENCODED_CHUNK_OVERHEAD_BYTES;
      if (retainedBytes > memoryBudgetBytes) {
        throw new Error(
          `Demux memory limit exceeded while retaining encoded packets (${request.maxMemoryMB} MB budget)`
        );
      }
      chunks.push(chunk);
      totalFrames++;
      if (onProgress && totalFrames % 10 === 0) {
        onProgress(totalFrames, estimatedTotalFrames);
      }
      // Yield to browser event loop every 50 packets to prevent UI freezing
      // during demuxing of large files with thousands of packets.
      if (totalFrames % 50 === 0) {
        await yieldToMain();
      }
    }

    const elapsed = performance.now() - startTime;
    logger.info('demuxer', 'Demuxing complete', {
      totalFrames,
      chunkCount: chunks.length,
      retainedBytes,
      elapsedMs: Math.round(elapsed),
      elapsed: `${(elapsed / 1000).toFixed(2)}s`,
    });

    // Compute total source duration from chunk durations (microseconds → milliseconds)
    const sourceTotalMs = chunks.reduce((sum, ch) => sum + Math.max(0, ch.duration ?? 0), 0) / 1000;

    return {
      chunks,
      config,
      totalFrames,
      duration,
      sourceTotalMs,
      framerate,
      trimStartUs: request.trimStart * 1_000_000,
    };
  } finally {
    input.dispose();
  }
}
