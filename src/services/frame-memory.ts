// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { FRAME_PIPELINE_MEMORY_BUDGET_BYTES } from '@utils/constants';
import { getPooledBufferSize } from './buffer-pool';

const RGB_BYTES_PER_PIXEL = 3;
const DECODED_RGBA_BYTES_PER_PIXEL = 4;
const DECODED_RGBA_AND_CANVAS_BYTES_PER_PIXEL = 12;

/** Conservatively estimate a retained VideoFrame from its maximum visible extent. */
export function estimateDecodedSourceFrameBytes(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number
): number {
  const width = Math.max(codedWidth, displayWidth);
  const height = Math.max(codedHeight, displayHeight);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) {
    throw new RangeError('Source frame dimensions must produce a positive safe pixel count');
  }

  const bytes = pixels * DECODED_RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError('Source frame allocation exceeds the safe integer range');
  }
  return bytes;
}

/** Estimate the cross-realm memory retained by one active RGB encode task. */
export function estimateActiveFrameBytes(width: number, height: number): number {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) {
    throw new RangeError('Frame dimensions must produce a positive safe pixel count');
  }

  const rgbBytes = pixels * RGB_BYTES_PER_PIXEL;
  const decodedRgbaAndCanvasBytes = pixels * DECODED_RGBA_AND_CANVAS_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(rgbBytes) || !Number.isSafeInteger(decodedRgbaAndCanvasBytes)) {
    throw new RangeError('Frame allocation exceeds the safe integer range');
  }

  return getPooledBufferSize(rgbBytes) + decodedRgbaAndCanvasBytes;
}

/** Estimate source-frame ownership plus target conversion working memory. */
export function estimateFrameOutputBytes(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): number {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return estimateActiveFrameBytes(sourceWidth, sourceHeight);
  }

  const sourcePixels = sourceWidth * sourceHeight;
  if (!Number.isSafeInteger(sourcePixels) || sourcePixels <= 0) {
    throw new RangeError('Source frame dimensions must produce a positive safe pixel count');
  }
  const sourceBytes = sourcePixels * DECODED_RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(sourceBytes)) {
    throw new RangeError('Source frame allocation exceeds the safe integer range');
  }

  const targetBytes = estimateActiveFrameBytes(targetWidth, targetHeight);
  const totalBytes = sourceBytes + targetBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new RangeError('Frame output allocation exceeds the safe integer range');
  }
  return totalBytes;
}

/** Derive concurrency while retaining decoded source and converted target frames. */
export function calculateFrameOutputConcurrency(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  requestedMaximum: number
): number {
  const requested = Math.max(1, Math.floor(requestedMaximum));
  const bytesPerFrame = estimateFrameOutputBytes(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight
  );
  return Math.min(requested, Math.floor(FRAME_PIPELINE_MEMORY_BUDGET_BYTES / bytesPerFrame));
}

/**
 * Derive the number of decoded source frames that may wait for one serialized
 * target conversion. The target working set is held aside for the lifetime of
 * the queue, so source reservations can never consume its headroom.
 */
export function calculateStagedFrameSourceCapacity(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number,
  targetWidth: number,
  targetHeight: number,
  requestedMaximum: number
): number {
  const requested = Math.max(1, Math.floor(requestedMaximum));
  const sourceBytes = estimateDecodedSourceFrameBytes(
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight
  );
  const targetWorkingBytes = estimateActiveFrameBytes(targetWidth, targetHeight);
  const sourceBudgetBytes = FRAME_PIPELINE_MEMORY_BUDGET_BYTES - targetWorkingBytes;
  if (sourceBudgetBytes < sourceBytes) return 0;
  return Math.min(requested, Math.floor(sourceBudgetBytes / sourceBytes));
}

/** Derive bounded concurrency from the shared live-frame memory reservation. */
export function calculateFrameConcurrency(
  width: number,
  height: number,
  requestedMaximum: number
): number {
  return Math.max(
    1,
    calculateFrameOutputConcurrency(width, height, width, height, requestedMaximum)
  );
}
