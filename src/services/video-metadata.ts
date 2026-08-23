// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { withTimeout } from '@piesp/browser-core/async';
import { throwIfAborted } from '@piesp/browser-core/error';
import { copyBoundedCodecDescription } from '@services/codec-description';
import type { MediabunnyVideoDecoderConfig, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS, MAX_TOTAL_PIXEL_COUNT } from '@utils/constants';
import { logger } from '@utils/logger';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';

/** Timeout for computePacketStats to prevent mediabunny internal hangs. */
const COMPUTE_PACKET_STATS_TIMEOUT_MS = 2_000;

/**
 * Extract video metadata from an ArrayBuffer or Blob using MediaBunny.
 *
 * Shared utility to avoid duplicating the BufferSource → Input → getVideoTracks()
 * → getDecoderConfig() pipeline across demuxer-service and file-selected handler.
 *
 * FPS and bitrate are computed via `track.computePacketStats(50)` which scans the
 * first ~50 packets (metadata-only, no actual data reads). For CFR (constant frame
 * rate) videos this returns the exact frame rate; for VFR it returns a close
 * approximation. See <https://mediabunny.dev/guide/reading-media-files#packet-statistics>.
 *
 * @param source - The video file source. Blob avoids materializing the whole file.
 * @param defaultFps - Fallback frame rate if not derivable from config (default: DEFAULT_FPS)
 * @returns VideoMetadata including the VideoDecoderConfig for WebCodecs
 * @throws Error if no video track found or decoder config unavailable
 */
export async function extractVideoMetadata(
  source: ArrayBuffer | Blob,
  defaultFps: number = DEFAULT_FPS,
  signal?: AbortSignal
): Promise<VideoMetadata> {
  const input = createMediaBunnyInput(source);
  let disposed = false;
  const disposeInput = (): void => {
    if (disposed) return;
    disposed = true;
    input.dispose();
  };
  const abortHandler = (): void => disposeInput();
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    throwIfAborted(signal);
    const videoTracks = await awaitWithAbort(input.getVideoTracks(), signal);
    const track = videoTracks[0];
    if (!track) {
      throw new Error('No video track found in input buffer');
    }

    const config = await awaitWithAbort(track.getDecoderConfig(), signal);
    if (!config) {
      throw new Error('Unable to obtain VideoDecoderConfig from video track');
    }
    const boundedDescription = copyBoundedCodecDescription(config.description);
    const boundedConfig: VideoDecoderConfig = {
      ...config,
      ...(boundedDescription !== undefined ? { description: boundedDescription } : {}),
    };

    const duration = await awaitWithAbort(track.computeDuration(), signal);

    // ── FPS & Bitrate: compute from first ~50 packets ──────────────────
    // computePacketStats scans packets metadata-only (no actual data reads)
    // and returns { packetCount, averagePacketRate, averageBitrate }.
    // For CFR videos averagePacketRate == exact frame rate.
    // Cost: ~10-30ms (independent of file size).
    let computedFps: number | null = null;
    let computedBitrate: number | null = null;

    try {
      const packetStats = await withTimeout(
        track.computePacketStats(50),
        COMPUTE_PACKET_STATS_TIMEOUT_MS,
        `Timeout: computePacketStats exceeded ${COMPUTE_PACKET_STATS_TIMEOUT_MS}ms`,
        undefined,
        signal
      );
      if (Number.isFinite(packetStats.averagePacketRate) && packetStats.averagePacketRate > 0) {
        computedFps = Math.round(packetStats.averagePacketRate * 100) / 100;
      }
      if (Number.isFinite(packetStats.averageBitrate) && packetStats.averageBitrate > 0) {
        computedBitrate = Math.round(packetStats.averageBitrate);
      }
    } catch {
      throwIfAborted(signal);
      // computePacketStats may fail for very short files, exotic containers,
      // or hang due to mediabunny internal state issues (timeout fallback).
      // Fall through to metadata-based or default values below.
    }

    // Fallback chain for FPS:
    //   1. computePacketStats (most accurate for CFR, reasonable for VFR)
    //   2. defaultFps (caller-provided constant)
    const framerate = computedFps ?? defaultFps;

    // Fallback chain for bitrate:
    //   1. computePacketStats (computed from actual packet bytes — most accurate)
    //   2. track.getAverageBitrate() (container metadata, available for MP4/WebM)
    //   3. track.getBitrate() (peak bitrate from metadata — least reliable)
    //
    // If computePacketStats timed out, subsequent mediabunny calls are likely
    // to hang as well (same internal state corruption).  Skip them to avoid
    // compounding the delay.
    let bitrate = computedBitrate;
    const packetStatsTimedOut = computedBitrate == null && computedFps == null;
    if (!packetStatsTimedOut && (bitrate == null || bitrate <= 0)) {
      try {
        const avgBitrate = await withTimeout(
          track.getAverageBitrate(),
          COMPUTE_PACKET_STATS_TIMEOUT_MS,
          `Timeout: getAverageBitrate exceeded ${COMPUTE_PACKET_STATS_TIMEOUT_MS}ms`,
          undefined,
          signal
        );
        if (avgBitrate != null && Number.isFinite(avgBitrate) && avgBitrate > 0) {
          bitrate = avgBitrate;
        }
      } catch {
        throwIfAborted(signal);
        // getAverageBitrate not supported by all formats
      }
    }
    if (!packetStatsTimedOut && (bitrate == null || bitrate <= 0)) {
      try {
        const peakBitrate = await withTimeout(
          track.getBitrate(),
          COMPUTE_PACKET_STATS_TIMEOUT_MS,
          `Timeout: getBitrate exceeded ${COMPUTE_PACKET_STATS_TIMEOUT_MS}ms`,
          undefined,
          signal
        );
        if (peakBitrate != null && Number.isFinite(peakBitrate) && peakBitrate > 0) {
          bitrate = peakBitrate;
        }
      } catch {
        throwIfAborted(signal);
        // getBitrate not supported by all formats
      }
    }

    if (bitrate != null && Number.isFinite(bitrate) && bitrate > 0) {
      logger.info('general', 'Extracted video metadata', {
        codec: config.codec?.split('.')[0] ?? 'unknown',
        duration: `${duration.toFixed(2)}s`,
        framerate,
        bitrateMbps: (bitrate / 1_000_000).toFixed(2),
      });
    }

    // displayAspectWidth/Height: present when pixel aspect ratio is non-square (mediabunny v1.40.0+).
    // These represent the display dimensions directly.
    const cfg = boundedConfig as MediabunnyVideoDecoderConfig;
    const codedWidth = boundedConfig.codedWidth ?? 0;
    const codedHeight = boundedConfig.codedHeight ?? 0;
    const displayWidth = cfg.displayAspectWidth ?? cfg.displayWidth;
    const displayHeight = cfg.displayAspectHeight ?? cfg.displayHeight;
    const hasSafeDisplayDimensions =
      Number.isSafeInteger(displayWidth) &&
      Number.isSafeInteger(displayHeight) &&
      displayWidth! > 0 &&
      displayHeight! > 0 &&
      displayWidth! <= MAX_TOTAL_PIXEL_COUNT / displayHeight!;
    const width = hasSafeDisplayDimensions ? displayWidth! : codedWidth;
    const height = hasSafeDisplayDimensions ? displayHeight! : codedHeight;

    // Extract codec string (e.g. "avc1.42E01E" → "avc1")
    const codec = boundedConfig.codec?.split('.')[0] ?? 'unknown';

    return {
      width,
      height,
      duration,
      codec,
      framerate,
      bitrate: bitrate ?? 0,
      config: boundedConfig,
    };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    disposeInput();
  }
}

function awaitWithAbort<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const source = Promise.resolve(operation);
  if (!signal) return source;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('The metadata analysis was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void source.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );

    if (signal.aborted) onAbort();
  });
}
