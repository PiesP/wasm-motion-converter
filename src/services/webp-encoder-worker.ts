// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Worker
 *
 * Each worker receives opaque RGBA frame data + dimensions + quality, uses
 * OffscreenCanvas.convertToBlob() for fast WebP encoding, then extracts
 * and returns the VP8 bitstream.
 *
 * Protocol:
 *   Main → Worker: { id, rgbaData, width, height, quality, durationMs }
 *   Worker → Main: { id, bitstream } or { id, error }
 */

import { getErrorMessage } from '@piesp/browser-core/error';
import { isRecord } from '@piesp/browser-core/util';
import { MAX_FRAME_PIXEL_COUNT } from '@utils/constants';
import { extractAndNormalizeCanvasVp8 } from './webp-bitstream';

// ─── Worker Entry Point ────────────────────────────────────────────

interface EncodeRequest {
  id: number;
  rgbaData: Uint8Array;
  width: number;
  height: number;
  quality: number;
  durationMs: number;
}

const RGBA_BYTES_PER_PIXEL = 4;

function isEncodeTaskId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isEncodeRequest(value: unknown): value is EncodeRequest {
  if (!isRecord(value)) return false;
  if (!isEncodeTaskId(value.id)) return false;
  if (!(value.rgbaData instanceof Uint8Array)) return false;
  if (!isPositiveSafeInteger(value.width)) return false;
  if (!isPositiveSafeInteger(value.height)) return false;
  if (
    typeof value.quality !== 'number' ||
    !Number.isFinite(value.quality) ||
    value.quality < 0 ||
    value.quality > 1
  ) {
    return false;
  }
  if (
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  ) {
    return false;
  }

  const pixelCount = value.width * value.height;
  const expectedRgbaBytes = pixelCount * RGBA_BYTES_PER_PIXEL;
  const maxPooledRgbaBytes = 2 ** Math.ceil(Math.log2(expectedRgbaBytes));
  return (
    Number.isSafeInteger(pixelCount) &&
    pixelCount <= MAX_FRAME_PIXEL_COUNT &&
    value.rgbaData.buffer instanceof ArrayBuffer &&
    value.rgbaData.byteLength >= expectedRgbaBytes &&
    value.rgbaData.byteLength <= maxPooledRgbaBytes &&
    value.rgbaData.buffer.byteLength <= maxPooledRgbaBytes &&
    value.rgbaData.byteOffset <= value.rgbaData.buffer.byteLength - expectedRgbaBytes
  );
}

let canvas: OffscreenCanvas | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let lastWidth = 0;
let lastHeight = 0;

function ensureCanvas(
  width: number,
  height: number
): { canvas: OffscreenCanvas; ctx: CanvasRenderingContext2D } {
  if (!canvas || lastWidth !== width || lastHeight !== height) {
    canvas = new OffscreenCanvas(width, height);
    const c = canvas.getContext('2d', {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    if (!c) throw new Error('Failed to get 2D context from OffscreenCanvas');
    ctx = c;
    lastWidth = width;
    lastHeight = height;
  }
  return { canvas: canvas!, ctx: ctx! };
}

async function handleEncode(
  request: EncodeRequest
): Promise<{ id: number; bitstream: Uint8Array }> {
  const { id, rgbaData, width, height, quality } = request;

  // Get or create cached OffscreenCanvas
  const { canvas: offscreen, ctx: offCtx } = ensureCanvas(width, height);

  const pixelCount = width * height;
  const exactRgba = new Uint8ClampedArray(
    rgbaData.buffer as ArrayBuffer,
    rgbaData.byteOffset,
    pixelCount * RGBA_BYTES_PER_PIXEL
  );
  const imageData = new ImageData(exactRgba, width, height);
  offCtx.putImageData(imageData, 0, 0);

  // Encode to WebP via convertToBlob
  const blob = await offscreen.convertToBlob({
    type: 'image/webp',
    quality,
  });

  if (!blob || blob.size === 0) {
    throw new Error(`convertToBlob returned ${blob ? 'empty' : 'null'} for frame`);
  }

  // Read blob as ArrayBuffer, convert to Uint8Array
  const arrayBuffer = await blob.arrayBuffer();
  const webpBuffer = new Uint8Array(arrayBuffer);

  // Always use full VP8 bitstream extraction. convertToBlob may produce VP8X
  // (extended) format for any frame, not just the first. The former fast-path
  // assumption (simple VP8 at offset 20) produced garbage bitstreams for VP8X
  // frames, resulting in broken animated WebP output.
  const bitstream = extractAndNormalizeCanvasVp8(webpBuffer);

  return { id, bitstream };
}

// ─── Message Handler ───────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  // Dedicated Worker messages arrive through the worker's private channel with
  // a null source. Reject any cross-context source before reading its payload.
  if (event.source !== null && event.source !== self) {
    return;
  }

  const request = event.data;
  if (!isEncodeRequest(request)) {
    if (isRecord(request) && isEncodeTaskId(request.id)) {
      self.postMessage({ id: request.id, error: 'Invalid WebP encode request' });
    }
    return;
  }

  try {
    const result = await handleEncode(request);
    // Transfer the bitstream's underlying ArrayBuffer back
    self.postMessage(result, [result.bitstream.buffer]);
  } catch (err) {
    const message = getErrorMessage(err);
    self.postMessage({ id: request.id, error: message });
  }
};
