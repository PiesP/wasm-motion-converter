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
 *   3. Mux into RIFF/WEBP container with ANIM + ANMF chunks
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

  const bitstream = webp.slice(20, 20 + frameSize);

  // Fix VP8 frame tag: ensure showFrame bit (bit 4 of byte 0) is set.
  // encodeRGB produces frames with showFrame=0 which is fine for single-frame
  // WebP but causes browsers to not display frames in animated WebP.
  return bitstream;
}

// ---------------------------------------------------------------------------
// WebP muxing (RIFF container)
// ---------------------------------------------------------------------------

/**
 * Write a 24-bit little-endian value to the output buffer. Returns new offset.
 */
function writeUint24(output: Uint8Array, offset: number, value: number): number {
  output[offset++] = value & 0xff;
  output[offset++] = (value >> 8) & 0xff;
  output[offset++] = (value >> 16) & 0xff;
  return offset;
}

/**
 * Create an animated WebP container from individual VP8 bitstreams.
 *
 * RIFF/WEBP animated layout:
 *   RIFF header (12 bytes)
 *   ANIM chunk (16 bytes) — global animation params
 *   ANMF chunks — one per frame:
 *     FourCC "ANMF" (4) + size (4) + x(3) + y(3) + w(3) + h(3) + duration(3) + flags(1) + data
 */
function muxAnimatedWebP(
  bitstreams: { data: Uint8Array; duration: number }[],
  width: number,
  height: number
): Uint8Array {
  if (bitstreams.length === 0) {
    throw new Error('No bitstreams to mux');
  }

  // ANMF: FourCC(4) + size(4) + x(3) + y(3) + w(3) + h(3) + dur(3) + flags(1) = 24 bytes header
  const anmfHeader = 4 + 4 + 3 + 3 + 3 + 3 + 3 + 1;

  let payloadSize = 4; // "WEBP"
  payloadSize += 4 + 4 + 6; // ANIM: FourCC + size + bg_color(4) + loop_count(2)
  for (const bs of bitstreams) {
    payloadSize += anmfHeader + bs.data.length;
  }

  const totalSize = 8 + payloadSize;
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let off = 0;

  // RIFF header — chunk IDs are big-endian, sizes are little-endian
  view.setUint32(off, RIFF_MAGIC, false);
  off += 4; // "RIFF" big-endian
  view.setUint32(off, totalSize - 8, true);
  off += 4; // size little-endian
  view.setUint32(off, WEBP_MAGIC, false);
  off += 4; // "WEBP" big-endian

  // ANIM chunk
  view.setUint32(off, ANIM_MAGIC, false);
  off += 4; // "ANIM" big-endian
  view.setUint32(off, 6, true);
  off += 4; // size little-endian
  view.setUint32(off, 0, true);
  off += 4; // background color
  view.setUint16(off, 0, true);
  off += 2; // loop count

  // ANMF chunks
  for (const bs of bitstreams) {
    const chunkData = anmfHeader - 8 + bs.data.length;

    view.setUint32(off, ANMF_MAGIC, false);
    off += 4; // "ANMF" big-endian
    view.setUint32(off, chunkData, true);
    off += 4; // size little-endian

    // Frame X, Y (3 bytes each, always 0) — full canvas
    off = writeUint24(output, off, 0); // x
    off = writeUint24(output, off, 0); // y

    // Frame Width (3 bytes LE) — NOTE: WebP spec says width-1 but some decoders
    // accept width directly. Try width-1 first (correct per spec).
    off = writeUint24(output, off, width > 1 ? width - 1 : 0);

    // Frame Height (3 bytes LE)
    off = writeUint24(output, off, height > 1 ? height - 1 : 0);

    // Frame Duration (3 bytes LE, milliseconds)
    off = writeUint24(output, off, bs.duration);

    // Frame Flags (1 byte)
    // bit 0: blending method (0 = use alpha blending)
    // bit 1: disposal method (0 = do not dispose)
    output[off++] = 0x00;

    // Fix VP8 frame tag: ensure showFrame bit (bit 4 of byte 0) is set.
    // encodeRGB produces frames with showFrame=0 which browsers reject in animated WebP.
    if (bs.data.length >= 1) {
      const v = bs.data[0];
      if (v !== undefined && (v & 0x10) === 0) {
        bs.data[0] = v | 0x10;
      }
    }

    // Frame bitstream data
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
    const frame = frames[i]!;

    const webpResult = await encodeRGB(frame.data, frame.width, frame.height, opts.quality);

    if (!webpResult || webpResult.length === 0) {
      throw new Error(`encodeRGB returned ${webpResult ? 'empty' : 'null'} for frame ${i}`);
    }

    const bitstream = extractVP8Bitstream(
      webpResult instanceof Uint8Array ? webpResult : new Uint8Array(webpResult)
    );

    encodedFrames.push({ data: bitstream, duration: frame.duration });
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
