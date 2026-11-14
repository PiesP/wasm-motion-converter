// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { ownedDecoderConfig, ownedTimestampUs } from '@services/owned-demux-config';
import {
  classifyOwnedDemuxError,
  computeOwnedPacketStats,
  createOwnedDemuxSession,
} from '@services/owned-demux-core';
import {
  activeOwnedInputGeneration,
  MAX_OWNED_INDEX_DESCRIPTION_BYTES,
  publishOwnedInputIndex,
} from '@services/owned-input-index-cache';
import type { VideoMetadata, VideoRotation } from '@t/conversion-types';
import { DEFAULT_FPS } from '@utils/constants';
import { logger } from '@utils/logger';

import { resolveVideoDimensions } from './frame-utils';
import { fingerprintOwnedDemuxSource } from './owned-demux-index-snapshot';

/** Extract the first supported video track through bounded, local range reads. */
export async function extractVideoMetadata(
  source: ArrayBuffer | Blob,
  defaultFps: number = DEFAULT_FPS,
  signal?: AbortSignal
): Promise<VideoMetadata> {
  const session = await createOwnedDemuxSession(source, signal);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    session.release();
  };
  signal?.addEventListener('abort', release, { once: true });
  try {
    signal?.throwIfAborted();
    const track = await session.analyze(signal);
    const config = ownedDecoderConfig(track);
    // Check the WebCodecs numeric boundary before converting the track's timebase.
    ownedTimestampUs(track.durationTicks, track.timescale);
    const rawDuration = Number(track.durationTicks) / track.timescale;
    const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 0;
    const stats = await computeOwnedPacketStats(session, track, signal);
    const framerate =
      stats && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0
        ? Math.round(stats.averagePacketRate * 100) / 100
        : defaultFps;
    const bitrate =
      stats && Number.isFinite(stats.averageBitrate) && stats.averageBitrate > 0
        ? Math.round(stats.averageBitrate)
        : 0;
    const selectedGeneration = source instanceof Blob ? activeOwnedInputGeneration(source) : null;
    if (
      source instanceof Blob &&
      selectedGeneration !== null &&
      track.description.byteLength <= MAX_OWNED_INDEX_DESCRIPTION_BYTES
    ) {
      const snapshot = await session.exportIndex(signal);
      if (snapshot) {
        const fingerprint = await fingerprintOwnedDemuxSource(source, signal);
        signal?.throwIfAborted();
        publishOwnedInputIndex(source, selectedGeneration, snapshot, fingerprint, signal, {
          packetCount: track.packetCount,
          maxPacketBytes: track.maxPacketBytes,
          descriptionBytes: track.description.byteLength,
        });
      }
    }
    const rotation: VideoRotation =
      track.rotation === 90 || track.rotation === 180 || track.rotation === 270
        ? track.rotation
        : 0;
    const dimensions = resolveVideoDimensions({
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      displayAspectWidth: config.displayAspectWidth,
      displayAspectHeight: config.displayAspectHeight,
      rotation,
    });
    if (bitrate > 0)
      logger.info('general', 'Extracted video metadata', {
        codec: config.codec.split('.')[0] ?? 'unknown',
        duration: `${duration.toFixed(2)}s`,
        framerate,
        bitrateMbps: (bitrate / 1_000_000).toFixed(2),
      });
    return {
      width: dimensions?.width ?? config.codedWidth ?? 0,
      height: dimensions?.height ?? config.codedHeight ?? 0,
      duration,
      codec: config.codec.split('.')[0] ?? 'unknown',
      framerate,
      bitrate,
      config,
      rotation,
    };
  } catch (error) {
    throw classifyOwnedDemuxError(error, signal);
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
}
