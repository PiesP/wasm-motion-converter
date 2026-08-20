// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { FRAME_PIPELINE_MEMORY_BUDGET_BYTES } from '@utils/constants';
import { getPooledBufferSize } from './buffer-pool';

const RGB_BYTES_PER_PIXEL = 3;
const RGBA_AND_CANVAS_BYTES_PER_PIXEL = 8;

/** Estimate the cross-realm memory retained by one active RGB encode task. */
export function estimateActiveFrameBytes(width: number, height: number): number {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) {
    throw new RangeError('Frame dimensions must produce a positive safe pixel count');
  }

  const rgbBytes = pixels * RGB_BYTES_PER_PIXEL;
  const rgbaAndCanvasBytes = pixels * RGBA_AND_CANVAS_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(rgbBytes) || !Number.isSafeInteger(rgbaAndCanvasBytes)) {
    throw new RangeError('Frame allocation exceeds the safe integer range');
  }

  return getPooledBufferSize(rgbBytes) + rgbaAndCanvasBytes;
}

/** Derive bounded concurrency from the shared live-frame memory reservation. */
export function calculateFrameConcurrency(
  width: number,
  height: number,
  requestedMaximum: number
): number {
  const requested = Math.max(1, Math.floor(requestedMaximum));
  const bytesPerFrame = estimateActiveFrameBytes(width, height);
  return Math.max(
    1,
    Math.min(requested, Math.floor(FRAME_PIPELINE_MEMORY_BUDGET_BYTES / bytesPerFrame))
  );
}
