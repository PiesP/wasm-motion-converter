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
 * WebP simple format: "VP8 " marker (4 bytes) + frame size (4 bytes) + bitstream
 */
function extractVP8Bitstream(webp: Uint8Array): Uint8Array {
  // RIFF/WEBP simple format layout:
  //   0-3:   "RIFF"
  //   4-7:   file size - 8
  //   8-11:  "WEBP"
  //   12-15: "VP8 " (lossy) or "VP8L" (lossless)
  //   16-19: frame bitstream size
  //   20+:   raw VP8/VP8L bitstream
  if (webp.length < 24) {
    throw new Error(`WebP too small: ${webp.length} bytes (minimum 24)`);
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);

  // Verify RIFF header (big-endian: 0x52494646)
  if (view.getUint32(0, false) !== 0x52494646) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }
  // Verify WEBP type (big-endian: 0x57454250)
  if (view.getUint32(8, false) !== 0x57454250) {
    throw new Error(`Invalid WEBP type: 0x${view.getUint32(8, false).toString(16)}`);
  }

  // Identify codec chunk at offset 12 (big-endian)
  const codec = view.getUint32(12, false);
  if (codec !== 0x56503820 /* "VP8 " */ && codec !== 0x5650384c /* "VP8L" */) {
    throw new Error(`Unknown WebP codec: 0x${codec.toString(16)}`);
  }

  const frameSize = view.getUint32(16, true); // chunk size is little-endian
  if (20 + frameSize > webp.length) {
    throw new Error(`Frame size ${frameSize} exceeds buffer ${webp.length}`);
  }

  return webp.slice(20, 20 + frameSize);
}

// ---------------------------------------------------------------------------
// WebP muxing (RIFF container)
// ---------------------------------------------------------------------------

/**
 * Create an animated WebP container from individual VP8 bitstreams.
 *
 * Structure:
 *   RIFF header (12 bytes)
 *   ANIM chunk (16 bytes) — global animation params
 *   ANMF chunks (20 bytes header + bitstream per frame)
 */
function muxAnimatedWebP(
  bitstreams: { data: Uint8Array; duration: number }[],
  width: number,
  height: number
): Uint8Array {
  if (bitstreams.length === 0) {
    throw new Error('No bitstreams to mux');
  }

  // Calculate total size
  let payloadSize = 4; // "WEBP"
  payloadSize += 4 + 4 + 6; // ANIM chunk: "ANIM" + size(4) + bg_color(4) + loop_count(2)

  for (const bs of bitstreams) {
    // ANMF chunk: "ANMF" + size + x(4) + y(4) + w(4) + h(4) + duration(4) + flags(2) + bitstream
    payloadSize += 4 + 4 + 4 + 4 + 4 + 4 + 4 + 2 + bs.data.length;
  }

  const totalSize = 8 + payloadSize; // RIFF header (8) + payload
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let offset = 0;

  // RIFF header
  view.setUint32(offset, RIFF_MAGIC, true);
  offset += 4;
  view.setUint32(offset, totalSize - 8, true);
  offset += 4;
  view.setUint32(offset, WEBP_MAGIC, true);
  offset += 4;

  // ANIM chunk — global animation parameters
  view.setUint32(offset, ANIM_MAGIC, true);
  offset += 4;
  view.setUint32(offset, 6, true);
  offset += 4; // chunk data size
  view.setUint32(offset, 0x00000000, true);
  offset += 4; // background color (ARGB)
  view.setUint16(offset, 0, true);
  offset += 2; // loop count (0 = infinite)

  // ANMF chunks — one per frame
  for (const bs of bitstreams) {
    const chunkDataSize = 4 + 4 + 4 + 4 + 4 + 2 + bs.data.length;

    view.setUint32(offset, ANMF_MAGIC, true);
    offset += 4;
    view.setUint32(offset, chunkDataSize, true);
    offset += 4;
    view.setUint32(offset, 0, true);
    offset += 4; // x offset
    view.setUint32(offset, 0, true);
    offset += 4; // y offset
    view.setUint32(offset, width, true);
    offset += 4; // width
    view.setUint32(offset, height, true);
    offset += 4; // height
    view.setUint32(offset, bs.duration, true);
    offset += 4; // duration in ms
    view.setUint16(offset, 0x0000, true);
    offset += 2; // flags

    output.set(bs.data, offset);
    offset += bs.data.length;
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
 *
 * Memory: Only 1 frame's RGB data is in WASM memory at any time.
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

    // Encode single frame via wasm-webp
    const webpResult = await encodeRGB(frame.data, frame.width, frame.height, opts.quality);

    if (!webpResult || webpResult.length === 0) {
      throw new Error(`encodeRGB returned ${webpResult ? 'empty' : 'null'} for frame ${i}`);
    }

    // Extract VP8 bitstream from the WebP container
    const bitstream = extractVP8Bitstream(
      webpResult instanceof Uint8Array ? webpResult : new Uint8Array(webpResult)
    );

    encodedFrames.push({ data: bitstream, duration: frame.duration });
  }

  // Mux all encoded frames into animated WebP
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
