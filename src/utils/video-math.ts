// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Shared video math utilities used by both WebCodecs and FFmpeg conversion paths.
 */

/**
 * Compute the effective trim duration from optional trim settings and metadata.
 * Returns undefined when trim is not active.
 */
export function computeTrimDuration(
  trimStart?: number,
  trimEnd?: number,
  fullDuration?: number
): number | undefined {
  if (!fullDuration) {
    // Without metadata duration, only use explicit trim range
    return trimEnd && trimEnd > 0 ? Math.max(0.1, trimEnd - (trimStart ?? 0)) : undefined;
  }

  const effectiveStart = trimStart ?? 0;
  const effectiveEnd = trimEnd && trimEnd > 0 ? trimEnd : fullDuration;
  return Math.max(0.1, effectiveEnd - effectiveStart);
}
