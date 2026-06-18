// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Streaming WebP Animation Encoder
 *
 * Encodes animated WebP by processing frames one at a time using wasm-webp's
 * single-frame encodeRGB API, then muxing the results into an animated WebP
 * container in JavaScript.
 *
 * Memory usage: O(1) per frame during encoding (only 1 RGB frame in memory
 * at a time), O(N) for the final muxed output. Compare to batch
 * encodeAnimation: O(N) RGB frames + O(N) WASM internal buffers.
 *
 * Pipeline:
 *   1. For each decoded frame: encodeRGB() → extract VP8 bitstream
 *   2. Collect all encoded bitstreams
 *   3. Mux into RIFF/WEBP container with VP8X + ANIM + ANMF chunks
 */

import { logger } from '@utils/logger';
import { encodeRGB } from 'wasm-webp';

// ---------------------------------------------------------------------------
// WebP format constants for muxing
// ---------------------------------------------------------------------------

const ANIM_MAGIC = 0x414e494d; // "ANIM"
const ANMF_MAGIC = 0x414e4d46; // "ANMF"
const RIFF_MAGIC = 0x52494646; // "RIFF"
const WEBP_MAGIC = 0x57454250; // "WEBP"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamingWebPFrame {
  /** RGB pixel data (3 bytes per pixel) */
  data: Uint8Array;
  width: number;
  height: number;
  /** Frame duration in milliseconds */
  duration: number;
}

export interface StreamingWebPEncodeOptions {
  width: number;
  height: number;
  quality: number; // 0-100
  signal?: AbortSignal;
  /** Callback fired after each frame is encoded (for progress tracking) */
  onFrameEncoded?: (frameIndex: number, totalFrames: number) => void;
}

// ---------------------------------------------------------------------------
// VP8 bitstream extraction
// ---------------------------------------------------------------------------

/**
 * Extract the VP8 bitstream from a simple WebP (VP8) file.
 *
 * Simple VP8 WebP layout:
 *   0-3:   "RIFF"
 *   4-7:   file size - 8 (LE)
 *   8-11:  "WEBP"
 *   12-15: "VP8 " or "VP8L"
 *   16-19: chunk size (LE)
 *   20+:   raw VP8/VP8L bitstream
 */
function extractVP8Bitstream(webp: Uint8Array): Uint8Array {
  if (webp.length < 24) {
    throw new Error(`WebP too small: ${webp.length} bytes (minimum 24)`);
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);

  // Verify RIFF header (big-endian)
  if (view.getUint32(0, false) !== RIFF_MAGIC) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }
  // Verify WEBP type (big-endian)
  if (view.getUint32(8, false) !== WEBP_MAGIC) {
    throw new Error(`Invalid WEBP type: 0x${view.getUint32(8, false).toString(16)}`);
  }

  // Identify codec (big-endian)
  const codec = view.getUint32(12, false);
  if (codec !== 0x56503820 && codec !== 0x5650384c) {
    throw new Error(`Unknown WebP codec: 0x${codec.toString(16)}`);
  }

  const frameSize = view.getUint32(16, true); // chunk size is little-endian
  if (20 + frameSize > webp.length) {
    throw new Error(`Frame size ${frameSize} exceeds buffer ${webp.length}`);
  }

  // Use subarray instead of slice to avoid copying the VP8 bitstream.
  // The original webp buffer is retained by the caller (encodedFrames array),
  // so this view remains valid for the lifetime of the conversion.
  return webp.subarray(20, 20 + frameSize);
}

// ---------------------------------------------------------------------------
// WebP muxing (RIFF container)
// ---------------------------------------------------------------------------

/**
 * Write a 24-bit little-endian value to the output buffer. Returns new offset.
 */
function writeUint24(output: Uint8Array, offset: number, value: number): number {
  let o = offset;
  output[o++] = value & 0xff;
  output[o++] = (value >> 8) & 0xff;
  output[o++] = (value >> 16) & 0xff;
  return o;
}

/**
 * Create an animated WebP container from individual VP8 bitstreams.
 *
 * RIFF/WEBP animated layout (RFC 9649):
 *   RIFF header (12 bytes)
 *   VP8X chunk (18 bytes) — canvas dimensions + animation flag
 *   ANIM chunk (16 bytes) — global animation params
 *   ANMF chunks — one per frame:
 *     FourCC "ANMF" (4) + size (4) + x(3) + y(3) + w(3) + h(3) + duration(3) + flags(1)
 *     VP8 sub-chunk: FourCC "VP8 " (4) + size (4) + VP8 bitstream data
 */
function muxAnimatedWebP(
  bitstreams: { data: Uint8Array; duration: number }[],
  width: number,
  height: number
): Uint8Array {
  if (bitstreams.length === 0) {
    throw new Error('No bitstreams to mux');
  }

  const VP8_FOURCC = 0x56503820; // "VP8 " big-endian
  const VP8X_FOURCC = 0x56503858; // "VP8X" big-endian

  // VP8X chunk: FourCC(4) + size(4) + flags(1) + reserved(3) + canvas_w-1(3) + canvas_h-1(3) = 18 bytes
  const vp8xChunkData = 10; // flags(1) + reserved(3) + canvas_w-1(3) + canvas_h-1(3)
  const vp8xOverhead = 4 + 4 + vp8xChunkData; // 18 bytes

  // ANMF header: FourCC(4) + size(4) + x(3) + y(3) + w(3) + h(3) + dur(3) + flags(1) = 24
  const anmfHeader = 4 + 4 + 3 + 3 + 3 + 3 + 3 + 1;
  // VP8 sub-chunk inside ANMF: FourCC(4) + size(4) + data
  const vp8ChunkOverhead = 4 + 4;

  let payloadSize = 4; // "WEBP"
  payloadSize += vp8xOverhead; // VP8X chunk (required for animated WebP)
  payloadSize += 4 + 4 + 6; // ANIM: FourCC + size + bg_color(4) + loop_count(2)
  for (const bs of bitstreams) {
    payloadSize += anmfHeader + vp8ChunkOverhead + bs.data.length;
  }

  const totalSize = 8 + payloadSize;
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let off = 0;

  // RIFF header — chunk IDs are big-endian, sizes are little-endian
  view.setUint32(off, RIFF_MAGIC, false);
  off += 4;
  view.setUint32(off, totalSize - 8, true);
  off += 4;
  view.setUint32(off, WEBP_MAGIC, false);
  off += 4;

  // VP8X chunk — required for animated WebP (RFC 9649 §2.7.1.1)
  // Flags: bit 0 = ICC, bit 1 = Alpha, bit 2 = EXIF, bit 3 = XMP, bit 4 = Animation
  view.setUint32(off, VP8X_FOURCC, false);
  off += 4;
  view.setUint32(off, vp8xChunkData, true);
  off += 4;
  output[off++] = 0x02; // Flags: Animation bit set
  output[off++] = 0x00; // Reserved
  output[off++] = 0x00; // Reserved
  output[off++] = 0x00; // Reserved
  off = writeUint24(output, off, width - 1); // Canvas Width Minus One
  off = writeUint24(output, off, height - 1); // Canvas Height Minus One

  // ANIM chunk
  view.setUint32(off, ANIM_MAGIC, false);
  off += 4;
  view.setUint32(off, 6, true);
  off += 4;
  view.setUint32(off, 0, true);
  off += 4; // background color
  view.setUint16(off, 0, true);
  off += 2; // loop count

  // ANMF chunks
  for (const bs of bitstreams) {
    const frameDataSize = vp8ChunkOverhead + bs.data.length;
    const chunkData = anmfHeader - 8 + frameDataSize;

    view.setUint32(off, ANMF_MAGIC, false);
    off += 4;
    view.setUint32(off, chunkData, true);
    off += 4;

    // Frame X, Y (3 bytes each, always 0)
    off = writeUint24(output, off, 0); // x
    off = writeUint24(output, off, 0); // y

    // Frame Width, Height (3 bytes each, stored as value - 1 per WebP spec)
    off = writeUint24(output, off, width > 1 ? width - 1 : 0);
    off = writeUint24(output, off, height > 1 ? height - 1 : 0);

    // Frame Duration (3 bytes LE, milliseconds)
    off = writeUint24(output, off, bs.duration);

    // Frame Flags (1 byte)
    output[off++] = 0x00;

    // VP8 sub-chunk inside ANMF Frame Data (RFC 9649 §2.7.1.3)
    view.setUint32(off, VP8_FOURCC, false);
    off += 4;
    view.setUint32(off, bs.data.length, true);
    off += 4;
    output.set(bs.data, off);
    off += bs.data.length;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Streaming encoder
// ---------------------------------------------------------------------------

/**
 * Encode an array of decoded RGB frames to animated WebP using streaming.
 * Each frame is encoded individually via wasm-webp's encodeRGB, then muxed
 * into the final animated WebP container.
 */
export async function encodeStreamingWebP(
  frames: StreamingWebPFrame[],
  opts: StreamingWebPEncodeOptions
): Promise<Uint8Array> {
  if (frames.length === 0) {
    throw new Error('No frames to encode');
  }

  const startTime = performance.now();
  const encodedFrames: { data: Uint8Array; duration: number }[] = [];

  logger.info('encoders', 'Streaming WebP encoding started', {
    frames: frames.length,
    width: opts.width,
    height: opts.height,
    quality: opts.quality,
  });

  for (let i = 0; i < frames.length; i++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    const frame = frames[i]!;

    const webpResult = await encodeRGB(frame.data, frame.width, frame.height, opts.quality);

    if (!webpResult || webpResult.length === 0) {
      throw new Error(`encodeRGB returned ${webpResult ? 'empty' : 'null'} for frame ${i}`);
    }

    const webpData = webpResult instanceof Uint8Array ? webpResult : new Uint8Array(webpResult);
    const bitstream = extractVP8Bitstream(webpData);

    encodedFrames.push({ data: bitstream, duration: frame.duration });
    opts.onFrameEncoded?.(i + 1, frames.length);
  }

  const result = muxAnimatedWebP(encodedFrames, opts.width, opts.height);
  const elapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'Streaming WebP encoding complete', {
    frames: frames.length,
    outputBytes: result.length,
    duration: `${elapsed.toFixed(2)}s`,
    fps: Math.round(frames.length / elapsed),
  });

  return result;
}
