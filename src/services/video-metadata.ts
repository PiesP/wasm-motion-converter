// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { VideoMetadata } from '@t/conversion-types';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

interface MediabunnyVideoDecoderConfig extends VideoDecoderConfig {
  displayAspectWidth?: number;
  displayAspectHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}

/**
 * Extract video metadata from an ArrayBuffer using MediaBunny.
 *
 * Shared utility to avoid duplicating the BufferSource → Input → getVideoTracks()
 * → getDecoderConfig() pipeline across demuxer-service and file-selected handler.
 *
 * @param buffer - The video file's ArrayBuffer
 * @param defaultFps - Fallback frame rate if not derivable from config (default: 30)
 * @returns VideoMetadata including the VideoDecoderConfig for WebCodecs
 * @throws Error if no video track found or decoder config unavailable
 */
export async function extractVideoMetadata(
  buffer: ArrayBuffer,
  defaultFps = 30
): Promise<VideoMetadata> {
  const source = new BufferSource(buffer);
  const input = new Input({ formats: ALL_FORMATS, source });

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
      framerate: defaultFps,
      bitrate: 0,
      config,
    };
  } finally {
    input.dispose();
  }
}
