// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Frame filename formatting for WebCodecs frame capture.
 */

export function formatFrameName(
  framePrefix: string,
  frameDigits: number,
  frameIndex: number,
  frameStartNumber: number,
  extension: string
): string {
  const frameNumber = frameStartNumber + frameIndex;
  const paddedNumber = frameNumber.toString().padStart(frameDigits, '0');
  return `${framePrefix}${paddedNumber}.${extension}`;
}
