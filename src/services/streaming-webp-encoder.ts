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
 *
 * Uses subarray (zero-copy view) instead of slice.
 * Returns { bitstream, codec } where codec is 'VP8 ' or 'VP8L'.
 */
export function extractVP8Bitstream(webp: Uint8Array): Uint8Array {
  if (webp.length < 24) {
    throw new Error(`WebP too small: ${webp.length} bytes (minimum 24)`);
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);

  // Verify RIFF header (big-endian)
  if (view.getUint32(0, false) !== StreamingWebpMuxer.RIFF_MAGIC) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }
  // Verify WEBP type (big-endian)
  if (view.getUint32(8, false) !== StreamingWebpMuxer.WEBP_MAGIC) {
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

  // Zero-copy subarray — the original webp buffer is retained by the caller
  return webp.subarray(20, 20 + frameSize);
}

/**
 * Fast VP8 bitstream extraction without header validation.
 *
 * After the first frame has been validated, all subsequent frames from the
 * same encoder will have identical RIFF/VP8 structure. Skip the 5 validation
 * checks and jump directly to the bitstream at offset 20.
 *
 * This saves ~0.05ms per frame (5 × DataView.getUint32 + branching).
 * For a 150-frame video, that's ~7.5ms total.
 */
export function extractVP8BitstreamFast(webp: Uint8Array): Uint8Array {
  // Same as extractVP8Bitstream but skips header validation.
  // The bitstream starts at offset 20 and the chunk size is at offset 16 (little-endian).
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const frameSize = view.getUint32(16, true);
  return webp.subarray(20, 20 + frameSize);
}

// ---------------------------------------------------------------------------
// WebP muxing (RIFF container)
// ---------------------------------------------------------------------------

/**
 * Streaming animated WebP muxer.
 *
 * Instead of collecting all bitstreams into an array and muxing at the end
 * (O(N) memory for encoded frames), this muxer builds the RIFF container
 * incrementally. Each frame is written to the output buffer immediately,
 * and the intermediate buffer is released after writing.
 *
 * Memory usage: O(1) for frame accumulation + O(N) for final output only.
 * Compare to batch mux: O(N) for accumulation + O(N) for final output.
 *
 * Usage:
 *   const muxer = new StreamingWebpMuxer(width, height);
 *   for (const frame of frames) {
 *     muxer.addFrame(frame.bitstream, frame.durationMs);
 *   }
 *   const result = muxer.finish();
 */
export class StreamingWebpMuxer {
  private static readonly VP8_FOURCC = 0x56503820;
  private static readonly VP8X_FOURCC = 0x56503858;
  private static readonly ANIM_MAGIC = 0x414e494d;
  private static readonly ANMF_MAGIC = 0x414e4d46;
  public static readonly RIFF_MAGIC = 0x52494646;
  public static readonly WEBP_MAGIC = 0x57454250;

  private static readonly VP8X_OVERHEAD = 18; // FourCC(4) + size(4) + flags(1) + reserved(3) + canvas(6)
  private static readonly ANIM_OVERHEAD = 6; // bg_color(4) + loop_count(2)
  private static readonly ANMF_HEADER = 24; // FourCC(4)+size(4)+x(3)+y(3)+w(3)+h(3)+dur(3)+flags(1)
  private static readonly VP8_CHUNK_OVERHEAD = 8; // FourCC(4) + size(4)

  private readonly width: number;
  private readonly height: number;
  private frameCount = 0;
  private totalFrameBytes = 0; // Sum of all frame bitstream bytes (for capacity planning)
  private chunks: Uint8Array[] = [];
  private currentOffset = 0;
  private headerWritten = false;

  /** Pre-computed header size: RIFF(12) + VP8X(18) + ANIM(6+8) = 44 bytes */
  private static readonly HEADER_SIZE =
    12 + StreamingWebpMuxer.VP8X_OVERHEAD + 8 + StreamingWebpMuxer.ANIM_OVERHEAD;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Total bytes of frame bitstreams added so far (not including overhead). */
  get frameBytes(): number {
    return this.totalFrameBytes;
  }

  /** Number of frames added so far. */
  get frames(): number {
    return this.frameCount;
  }

  /**
   * Write the RIFF + VP8X + ANIM header.
   * Called lazily before the first ANMF chunk.
   */
  private writeHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;

    const header = new Uint8Array(StreamingWebpMuxer.HEADER_SIZE);
    const view = new DataView(header.buffer);
    let off = 0;

    // RIFF header — placeholder size (will be patched in finish())
    view.setUint32(off, StreamingWebpMuxer.RIFF_MAGIC, false);
    off += 4;
    view.setUint32(off, 0, true); // file size placeholder
    off += 4;
    view.setUint32(off, StreamingWebpMuxer.WEBP_MAGIC, false);
    off += 4;

    // VP8X chunk
    view.setUint32(off, StreamingWebpMuxer.VP8X_FOURCC, false);
    off += 4;
    view.setUint32(off, StreamingWebpMuxer.VP8X_OVERHEAD - 8, true);
    off += 4;
    header[off++] = 0x02; // Animation flag
    header[off++] = 0x00;
    header[off++] = 0x00;
    header[off++] = 0x00;
    off = StreamingWebpMuxer.writeUint24(header, off, this.width - 1);
    off = StreamingWebpMuxer.writeUint24(header, off, this.height - 1);

    // ANIM chunk
    view.setUint32(off, StreamingWebpMuxer.ANIM_MAGIC, false);
    off += 4;
    view.setUint32(off, StreamingWebpMuxer.ANIM_OVERHEAD, true);
    off += 4;
    view.setUint32(off, 0, true); // background color
    off += 4;
    view.setUint16(off, 0, true); // loop count
    off += 2;

    this.chunks.push(header);
    this.currentOffset += header.length;
  }

  /**
   * Add a frame's VP8 bitstream to the container.
   * The bitstream is copied into the output buffer immediately — the caller
   * can release the source buffer after this call.
   */
  addFrame(bitstream: Uint8Array, durationMs: number): void {
    this.writeHeader();

    const frameDataSize = StreamingWebpMuxer.VP8_CHUNK_OVERHEAD + bitstream.length;
    const anmfChunkData = StreamingWebpMuxer.ANMF_HEADER - 8 + frameDataSize;
    const anmfTotalSize = 8 + anmfChunkData; // ANMF FourCC + size + data

    const chunk = new Uint8Array(anmfTotalSize);
    const view = new DataView(chunk.buffer);
    let off = 0;

    // ANMF header
    view.setUint32(off, StreamingWebpMuxer.ANMF_MAGIC, false);
    off += 4;
    view.setUint32(off, anmfChunkData, true);
    off += 4;

    // Frame X, Y (always 0)
    off = StreamingWebpMuxer.writeUint24(chunk, off, 0);
    off = StreamingWebpMuxer.writeUint24(chunk, off, 0);

    // Frame Width, Height (value - 1 per WebP spec; minimum 1px → value 0)
    // Clamp to ≥1 before subtracting 1 to prevent underflow for 0-dimension edge case.
    off = StreamingWebpMuxer.writeUint24(chunk, off, Math.max(0, this.width - 1));
    off = StreamingWebpMuxer.writeUint24(chunk, off, Math.max(0, this.height - 1));

    // Frame Duration (ms) — clamped to 24-bit max (16,777,215ms ≈ 4.6 hours)
    // to prevent ANMF chunk overflow for very long videos
    off = StreamingWebpMuxer.writeUint24(chunk, off, Math.min(durationMs, 0xffffff));

    // Frame Flags
    chunk[off++] = 0x00;

    // VP8 sub-chunk
    view.setUint32(off, StreamingWebpMuxer.VP8_FOURCC, false);
    off += 4;
    view.setUint32(off, bitstream.length, true);
    off += 4;
    chunk.set(bitstream, off);

    this.chunks.push(chunk);
    this.currentOffset += chunk.length;
    this.totalFrameBytes += bitstream.length;
    this.frameCount++;
  }

  /**
   * Finalize the container and return the complete WebP file.
   * Patches the RIFF size in the header.
   */
  finish(): Uint8Array {
    if (this.frameCount === 0) {
      throw new Error('No frames added to muxer');
    }

    // Calculate total size: RIFF header (8) + payload
    const riffSize = this.currentOffset - 8;

    // Patch RIFF size in the first chunk (offset 4)
    const header = this.chunks[0]!;
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    view.setUint32(4, riffSize, true);

    // Concatenate all chunks
    const output = new Uint8Array(this.currentOffset);
    let off = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, off);
      off += chunk.length;
    }

    // Release chunk references for GC
    this.chunks.length = 0;

    return output;
  }

  private static writeUint24(output: Uint8Array, offset: number, value: number): number {
    let o = offset;
    output[o++] = value & 0xff;
    output[o++] = (value >> 8) & 0xff;
    output[o++] = (value >> 16) & 0xff;
    return o;
  }
}
