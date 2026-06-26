// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Shared MediaBunny Input creation utility.
 *
 * Extracts the repeated `new BufferSource(buffer)` → `new Input({ formats, source })`
 * pattern into a single function to avoid duplication and ensure consistent
 * configuration across video-metadata and demuxer-service.
 *
 * @param buffer - The video file's ArrayBuffer
 * @returns An Input instance ready for track extraction
 */
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

export function createMediaBunnyInput(buffer: ArrayBuffer): Input {
  const source = new BufferSource(buffer);
  return new Input({ formats: ALL_FORMATS, source });
}
