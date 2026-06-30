// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Shared MediaBunny Input creation utility.
 *
 * Creates an Input instance from various source types:
 * - ArrayBuffer → BufferSource (in-memory, random access)
 * - Blob/File   → BlobSource   (on-demand read, avoids full memory load)
 *
 * @param source - ArrayBuffer or Blob/File representing the video
 * @returns An Input instance ready for track extraction
 */
import { ALL_FORMATS, BlobSource, BufferSource, Input } from 'mediabunny';

export function createMediaBunnyInput(source: ArrayBuffer | Blob): Input {
  if (source instanceof ArrayBuffer) {
    return new Input({ formats: ALL_FORMATS, source: new BufferSource(source) });
  }
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });
}
