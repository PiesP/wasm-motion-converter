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
// ─── VP8 Bitstream Extraction ──────────────────────────────────────
// Same logic as streaming-webp-encoder.ts, inlined for worker independence
// because Vite Worker URL imports cannot reference external ES modules.
// In production builds this file is loaded separately via new Worker(),
// so importing from streaming-webp-encoder.ts is not possible.
// This duplication is intentional and necessary for Worker isolation.
// NOTE: Duplicated from streaming-webp-encoder.ts. Vite Worker URL imports prevent sharing ES modules.
// Both implementations must be kept in sync. See streaming-webp-encoder.ts for canonical version.
// Constants are imported from @utils/constants since those are plain value exports.

const RIFF_MAGIC = 0x52494646;
const WEBP_MAGIC = 0x57454250;
const VP8_FOURCC = 0x56503820;
const VP8X_FOURCC = 0x56503858;

function extractVP8Bitstream(webpBuffer: Uint8Array): Uint8Array {
  if (webpBuffer.length < 24) {
    throw new Error(`WebP too small: ${webpBuffer.length} bytes (minimum 24)`);
  }

  const view = new DataView(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);

  // Verify RIFF header
  if (view.getUint32(0, false) !== RIFF_MAGIC) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }
  // Verify WEBP type
  if (view.getUint32(8, false) !== WEBP_MAGIC) {
    throw new Error(`Invalid WEBP type: 0x${view.getUint32(8, false).toString(16)}`);
  }

  // Determine format
  const fourCC = view.getUint32(12, false);

  if (fourCC === VP8_FOURCC) {
    // Mirrors @utils/constants VP8_FOURCC for Worker isolation
    // Simple VP8 format — bitstream starts at offset 20
    const frameSize = view.getUint32(16, true);
    if (20 + frameSize > webpBuffer.length) {
      throw new Error(`Frame size ${frameSize} exceeds buffer ${webpBuffer.length}`);
    }
    return webpBuffer.subarray(20, 20 + frameSize);
  }

  if (fourCC === VP8X_FOURCC) {
    // VP8X extended format — scan chunks to find VP8
    const vp8xSize = view.getUint32(16, true);
    let offset = 12 + 8 + vp8xSize;

    while (offset + 8 <= webpBuffer.length) {
      const chunkFourCC = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkFourCC === VP8_FOURCC) {
        // Mirrors @utils/constants VP8_FOURCC for Worker isolation
        if (offset + 8 + chunkSize > webpBuffer.length) {
          throw new Error(`VP8 chunk size ${chunkSize} exceeds buffer ${webpBuffer.length}`);
        }
        return webpBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      }

      offset += 8 + chunkSize + (chunkSize % 2);
    }

    throw new Error('VP8X container does not contain a VP8 chunk');
  }

  const codecStr = String.fromCharCode(
    webpBuffer[12]!,
    webpBuffer[13]!,
    webpBuffer[14]!,
    webpBuffer[15]!
  );
  throw new Error(`Unknown WebP format: "${codecStr}" (0x${fourCC.toString(16)})`);
}

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
  const bitstream = extractVP8Bitstream(webpBuffer);

  return { id, bitstream };
}

// ─── Message Handler ───────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const request = event.data;

  try {
    const result = await handleEncode(request);
    // Transfer the bitstream's underlying ArrayBuffer back
    self.postMessage(result, [result.bitstream.buffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ id: request.id, error: message });
  }
};
