// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { MediabunnyVideoDecoderConfig, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';

/** Timeout for computePacketStats to prevent mediabunny internal hangs. */
const COMPUTE_PACKET_STATS_TIMEOUT_MS = 2_000;

/**
 * Race a promise against a timeout.  If the promise does not settle within
 * `ms` milliseconds the returned promise rejects with a descriptive error.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Extract video metadata from an ArrayBuffer using MediaBunny.
 *
 * Shared utility to avoid duplicating the BufferSource → Input → getVideoTracks()
 * → getDecoderConfig() pipeline across demuxer-service and file-selected handler.
 *
 * FPS and bitrate are computed via `track.computePacketStats(50)` which scans the
 * first ~50 packets (metadata-only, no actual data reads). For CFR (constant frame
 * rate) videos this returns the exact frame rate; for VFR it returns a close
 * approximation. See <https://mediabunny.dev/guide/reading-media-files#packet-statistics>.
 *
 * @param buffer - The video file's ArrayBuffer
 * @param defaultFps - Fallback frame rate if not derivable from config (default: DEFAULT_FPS)
 * @returns VideoMetadata including the VideoDecoderConfig for WebCodecs
 * @throws Error if no video track found or decoder config unavailable
 */
export async function extractVideoMetadata(
  buffer: ArrayBuffer,
  defaultFps: number = DEFAULT_FPS
): Promise<VideoMetadata> {
  const input = createMediaBunnyInput(buffer);

  try {
    const videoTracks = await input.getVideoTracks();
    const track = videoTracks[0];
    if (!track) {
      throw new Error('No video track found in input buffer');
    }

    const config = await track.getDecoderConfig();
    if (!config) {
      throw new Error('Unable to obtain VideoDecoderConfig from video track');
    }

    const duration = await track.computeDuration();

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
        'computePacketStats'
      );
      if (packetStats.averagePacketRate > 0) {
        computedFps = Math.round(packetStats.averagePacketRate * 100) / 100;
      }
      if (packetStats.averageBitrate > 0) {
        computedBitrate = Math.round(packetStats.averageBitrate);
      }
    } catch {
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
    let bitrate = computedBitrate;
    if (bitrate == null || bitrate <= 0) {
      try {
        const avgBitrate = await track.getAverageBitrate();
        if (avgBitrate != null && avgBitrate > 0) bitrate = avgBitrate;
      } catch {
        // getAverageBitrate not supported by all formats
      }
    }
    if (bitrate == null || bitrate <= 0) {
      try {
        const peakBitrate = await track.getBitrate();
        if (peakBitrate != null && peakBitrate > 0) bitrate = peakBitrate;
      } catch {
        // getBitrate not supported by all formats
      }
    }

    if (bitrate != null && bitrate > 0) {
      logger.info('general', 'Extracted video metadata', {
        codec: config.codec?.split('.')[0] ?? 'unknown',
        duration: `${duration.toFixed(2)}s`,
        framerate,
        bitrateMbps: (bitrate / 1_000_000).toFixed(2),
      });
    }

    // displayAspectWidth/Height: present when pixel aspect ratio is non-square (mediabunny v1.40.0+).
    // These represent the display dimensions directly.
    const cfg = config as MediabunnyVideoDecoderConfig;
    const width = cfg.displayAspectWidth ?? cfg.displayWidth ?? config.codedWidth ?? 0;
    const height = cfg.displayAspectHeight ?? cfg.displayHeight ?? config.codedHeight ?? 0;

    // Extract codec string (e.g. "avc1.42E01E" → "avc1")
    const codec = config.codec?.split('.')[0] ?? 'unknown';

    return {
      width,
      height,
      duration,
      codec,
      framerate,
      bitrate: bitrate ?? 0,
      config,
    };
  } finally {
    input.dispose();
  }
}
