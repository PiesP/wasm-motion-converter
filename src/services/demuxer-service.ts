// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { yieldToMain } from '@services/frame-utils';
import { extractVideoMetadata } from '@services/video-metadata';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { EncodedPacket, EncodedPacketSink } from 'mediabunny';

export interface DemuxResult {
  chunks: EncodedVideoChunk[];
  config: VideoDecoderConfig;
  totalFrames: number;
  duration: number;
  /** Total source duration in milliseconds (computed from chunk durations) */
  sourceTotalMs: number;
  /** Average frame rate from pre-computed metadata (or fallback). Used for decimation calculation. */
  framerate: number;
}

type DemuxProgressCallback = (packetsExtracted: number, estimatedTotalFrames: number) => void;

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

  const videoTracks = await input.getVideoTracks();
  const videoTrack = videoTracks[0];
  if (!videoTrack) {
    input.dispose();
    logger.warn('demuxer', 'no-video-track', {
      fileName: request.fileName,
      fileSizeBytes: request.inputBlob?.size ?? request.inputBuffer.byteLength,
    });
    throw new Error('No video track found in input');
  }
  const sink = new EncodedPacketSink(videoTrack);

  // Seek to trimStart if specified, otherwise start from first packet.
  // Use getNextKeyPacket() instead of getPacket() to validate that mediabunny
  // has correctly classified the packet as a keyframe. In rare cases mediabunny's
  // determinePacketType() may reclassify a keyframe as delta, causing DataError
  // on the first decode call. getNextKeyPacket() walks forward until it finds a
  // verified keyframe.
  let startPacket: EncodedPacket | null;
  if (request.trimStart > 0) {
    const nearPacket = await sink.getPacket(request.trimStart);
    if (nearPacket) {
      // Verify keyframe classification — walk forward if misclassified
      const verified = await sink.getNextKeyPacket(nearPacket);
      startPacket = verified ?? nearPacket;
    } else {
      startPacket = null;
    }
  } else {
    startPacket = await sink.getFirstPacket();
  }
  if (!startPacket) {
    input.dispose();
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

  const chunks: EncodedVideoChunk[] = [];
  let totalFrames = 0;

  logger.info('demuxer', 'Demuxing started', {
    fileName: request.fileName,
    fileSizeBytes: request.inputBuffer.byteLength,
    codec: config.codec,
    duration: `${duration.toFixed(2)}s`,
  });

  try {
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
      chunks.push(packet.toEncodedVideoChunk());
      totalFrames++;
      if (onProgress && totalFrames % 10 === 0) {
        onProgress(totalFrames, estimatedTotalFrames);
      }
      // Yield to browser event loop every 50 packets to prevent UI freezing
      // during demuxing of large files with thousands of packets.
      if (totalFrames % 50 === 0) {
        if (signal?.aborted) {
          throw new DOMException('Cancelled', 'AbortError');
        }
        await yieldToMain();
      }
    }
  } finally {
    input.dispose();
  }

  const elapsed = performance.now() - startTime;
  logger.info('demuxer', 'Demuxing complete', {
    totalFrames,
    chunkCount: chunks.length,
    elapsedMs: Math.round(elapsed),
    elapsed: `${(elapsed / 1000).toFixed(2)}s`,
  });

  // Compute total source duration from chunk durations (microseconds → milliseconds)
  const sourceTotalMs = chunks.reduce((sum, ch) => sum + Math.max(0, ch.duration ?? 0), 0) / 1000;

  return { chunks, config, totalFrames, duration, sourceTotalMs, framerate };
}
