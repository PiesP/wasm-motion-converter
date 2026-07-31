// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Worker
 *
 * Each worker receives RGB frame data + dimensions + quality, uses
 * OffscreenCanvas.convertToBlob() for fast WebP encoding, then extracts
 * and returns the VP8 bitstream.
 *
 * Protocol:
 *   Main → Worker: { id, rgbData, width, height, quality, durationMs }
 *   Worker → Main: { id, bitstream } or { id, error }
 */

import { getErrorMessage } from '@piesp/browser-core/error';
import { extractAndNormalizeCanvasVp8 } from './webp-bitstream';

// ─── Worker Entry Point ────────────────────────────────────────────

interface EncodeRequest {
  id: number;
  rgbData: Uint8Array;
  width: number;
  height: number;
  quality: number;
  durationMs: number;
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
  const { id, rgbData, width, height, quality } = request;

  // Get or create cached OffscreenCanvas
  const { canvas: offscreen, ctx: offCtx } = ensureCanvas(width, height);

  // Convert RGB → RGBA for putImageData (3 bpp → 4 bpp)
  const pixelCount = width * height;
  const rgbaData = new Uint8ClampedArray(pixelCount * 4);
  // Fast conversion: unrolled step-3/step-4
  for (let i = 0, j = 0; i < rgbData.length; i += 3, j += 4) {
    rgbaData[j] = rgbData[i]!;
    rgbaData[j + 1] = rgbData[i + 1]!;
    rgbaData[j + 2] = rgbData[i + 2]!;
    rgbaData[j + 3] = 255;
  }

  const imageData = new ImageData(rgbaData, width, height);
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

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  // Dedicated Worker messages arrive through the worker's private channel with
  // a null source. Reject any cross-context source before reading its payload.
  if (event.source !== null && event.source !== self) {
    return;
  }

  const request = event.data;

  try {
    const result = await handleEncode(request);
    // Transfer the bitstream's underlying ArrayBuffer back
    self.postMessage(result, [result.bitstream.buffer]);
  } catch (err) {
    const message = getErrorMessage(err);
    self.postMessage({ id: request.id, error: message });
  }
};
