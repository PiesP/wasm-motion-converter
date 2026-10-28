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

import { VP8_FOURCC as SHARED_VP8_FOURCC, VP8X_FOURCC } from '@utils/constants';

import type { ProfileOperationRecorder } from './conversion-profiler';
import type { OutputLimitOverrides, OutputLimits } from './output-limits';
import { OutputLimitError, resolveOutputLimits } from './output-limits';
import { extractVp8Chunk, validateVp8Frame } from './webp-bitstream';

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
 *   12-15: "VP8 " (or "VP8X" followed by an opaque VP8 chunk)
 *   16-19: chunk size (LE)
 *   20+:   raw VP8 bitstream for the simple form
 *
 * Returns a borrowed view; the muxer copies it before the encoder reuses the
 * underlying WASM memory. Unsupported codecs and alpha fail closed.
 */
export function extractVP8Bitstream(webp: Uint8Array): Uint8Array {
  return extractVp8Chunk(webp);
}

/**
// WebP muxing (RIFF container)
// ---------------------------------------------------------------------------

/**
 * Streaming animated WebP muxer.
 *
 * Builds RIFF incrementally, retaining at most one compressed presentation
 * frame until its visible hold can be established at the next source PTS.
 *
 * Memory usage: O(1) for pending frame accumulation + O(N) for final output.
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
  // Ordinary image viewers replace holds <=10ms with 100ms. Coalesce dense
  // presentations against absolute PTS instead of stretching every frame.
  private static readonly MIN_PRESENTATION_HOLD_MS = 11;
  private pending: { bitstream: Uint8Array; startUs: number } | null = null;
  private lastPresentationStartUs: number | null = null;
  private static readonly VP8_FOURCC = SHARED_VP8_FOURCC;
  private static readonly VP8X_FOURCC = VP8X_FOURCC;
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
  // Only locally allocated headers and frame chunks enter this collection.
  // Borrowed codec views retain their broader backing type at the input boundary.
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private currentOffset = 0;
  private headerWritten = false;
  private iccProfile: Uint8Array | null | undefined;
  private readonly limits: OutputLimits;
  private readonly profileOperation: ProfileOperationRecorder | undefined;

  /** Pre-computed header size: RIFF(12) + VP8X(18) + ANIM(6+8) = 44 bytes */
  private static readonly HEADER_SIZE =
    12 + StreamingWebpMuxer.VP8X_OVERHEAD + 8 + StreamingWebpMuxer.ANIM_OVERHEAD;

  private headerSize(profile = this.iccProfile): number {
    return (
      StreamingWebpMuxer.HEADER_SIZE + (profile ? 8 + profile.length + (profile.length & 1) : 0)
    );
  }

  private checkProfile(profile: Uint8Array | null): void {
    if (profile && (profile.length === 0 || profile.length > 0xffffffff))
      throw new Error('Invalid WebP ICC profile');
    if (this.iccProfile === undefined) return;
    const previous = this.iccProfile;
    if (previous === null && profile === null) return;
    if (
      !previous ||
      !profile ||
      previous.length !== profile.length ||
      !profile.every((byte, index) => byte === previous[index])
    )
      throw new Error('WebP frames have inconsistent ICC profiles');
  }

  private retainProfile(profile: Uint8Array | null): void {
    if (this.iccProfile === undefined) this.iccProfile = profile ? new Uint8Array(profile) : null;
  }

  constructor(
    width: number,
    height: number,
    limits?: OutputLimitOverrides,
    profileOperation?: ProfileOperationRecorder
  ) {
    if (
      !Number.isInteger(width) ||
      width < 1 ||
      width > 0x1000000 ||
      !Number.isInteger(height) ||
      height < 1 ||
      height > 0x1000000
    ) {
      throw new RangeError('Invalid WebP canvas dimensions');
    }
    this.width = width;
    this.height = height;
    this.limits = resolveOutputLimits('webp', limits);
    this.profileOperation = profileOperation;
  }

  /** Total retained payload bytes, including the one pending presentation frame. */
  get frameBytes(): number {
    return (
      this.totalFrameBytes +
      (this.pending ? this.pending.bitstream.length + (this.pending.bitstream.length & 1) : 0)
    );
  }

  /** Number of frames added so far. */
  get frames(): number {
    return this.frameCount;
  }

  private reservePending(
    bitstream: Uint8Array,
    previousBytes: number,
    profile: Uint8Array | null
  ): void {
    const size =
      this.currentOffset +
      (this.headerWritten ? 0 : this.headerSize(profile)) +
      StreamingWebpMuxer.ANMF_HEADER +
      StreamingWebpMuxer.VP8_CHUNK_OVERHEAD +
      bitstream.length +
      (bitstream.length & 1) +
      (profile?.length ?? 0); // Retained profile in addition to its output chunk.
    // The previous compressed view can remain live while its replacement is copied.
    const copyPeakBytes =
      this.currentOffset + previousBytes + bitstream.length + (profile?.length ?? 0);
    if (
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(copyPeakBytes) ||
      Math.max(size, copyPeakBytes) > this.limits.maxOutputBytes
    ) {
      throw new OutputLimitError('webp', 'byte', this.limits.maxOutputBytes);
    }
  }

  /** Copy the borrowed codec view now; finalize its hold at the next source PTS. */
  addPresentationFrame(
    bitstream: Uint8Array,
    timing: { startUs: number; endUs: number },
    iccProfile: Uint8Array | null = null
  ): void {
    if (
      !Number.isSafeInteger(timing.startUs) ||
      timing.startUs < 0 ||
      !Number.isSafeInteger(timing.endUs) ||
      timing.endUs <= timing.startUs
    ) {
      throw new RangeError('Invalid WebP presentation interval');
    }
    validateVp8Frame(bitstream, this.width, this.height);
    this.checkProfile(iccProfile);
    if (this.lastPresentationStartUs !== null && timing.startUs <= this.lastPresentationStartUs) {
      throw new RangeError('WebP presentations are out of order');
    }
    this.lastPresentationStartUs = timing.startUs;
    const previous = this.pending;
    if (previous) {
      if (timing.startUs <= previous.startUs)
        throw new RangeError('WebP presentations are out of order');
      // Exact compressed-frame equality is safe only after validating codec and canvas size.
      if (
        bitstream.length === previous.bitstream.length &&
        bitstream.every((byte, index) => byte === previous.bitstream[index])
      )
        return;
      const durationMs = Math.round(timing.startUs / 1000) - Math.round(previous.startUs / 1000);
      if (durationMs < StreamingWebpMuxer.MIN_PRESENTATION_HOLD_MS) return;
      this.emitPending(durationMs);
    }
    this.reservePending(bitstream, previous?.bitstream.length ?? 0, iccProfile);
    this.retainProfile(iccProfile);
    this.pending = { bitstream: new Uint8Array(bitstream), startUs: timing.startUs };
  }

  /** Round absolute boundaries once, rather than rounding each source duration. */
  finishPresentation(endUs: number): void {
    if (!this.pending) return;
    if (!Number.isSafeInteger(endUs) || endUs <= this.pending.startUs) {
      throw new RangeError('Invalid WebP presentation endpoint');
    }
    const durationMs = Math.round(endUs / 1000) - Math.round(this.pending.startUs / 1000);
    if (durationMs === 0 && this.frameCount > 0) {
      this.pending = null;
      return;
    }
    // Keep a distinct final scene. Only this endpoint can extend (by at most
    // 10ms); cumulative rounding and coalescing prevent per-frame drift.
    this.emitPending(Math.max(StreamingWebpMuxer.MIN_PRESENTATION_HOLD_MS, durationMs));
  }

  private emitPending(durationMs: number): void {
    const pending = this.pending;
    if (!pending) return;
    const count = Math.ceil(durationMs / 0xffffff);
    if (this.frameCount + count > this.limits.maxFrames) {
      throw new OutputLimitError('webp', 'frame', this.limits.maxFrames);
    }
    const frameSize =
      StreamingWebpMuxer.ANMF_HEADER +
      StreamingWebpMuxer.VP8_CHUNK_OVERHEAD +
      pending.bitstream.length +
      (pending.bitstream.length & 1);
    const nextSize =
      this.currentOffset +
      (this.headerWritten ? 0 : this.headerSize()) +
      count * frameSize +
      (this.iccProfile?.length ?? 0);
    if (!Number.isSafeInteger(nextSize) || nextSize > this.limits.maxOutputBytes) {
      throw new OutputLimitError('webp', 'byte', this.limits.maxOutputBytes);
    }
    this.pending = null;
    try {
      let remaining = durationMs;
      while (remaining > 0) {
        // A 24-bit continuation must not introduce another viewer-normalized
        // short hold. Borrow from its preceding chunk without moving the end.
        const hold =
          remaining > 0xffffff && remaining < 0xffffff + StreamingWebpMuxer.MIN_PRESENTATION_HOLD_MS
            ? remaining - StreamingWebpMuxer.MIN_PRESENTATION_HOLD_MS
            : Math.min(remaining, 0xffffff);
        this.addFrame(pending.bitstream, hold, this.iccProfile);
        remaining -= hold;
      }
    } catch (error) {
      this.pending = pending;
      throw error;
    }
  }

  private setLastFrameDuration(durationMs: number): void {
    const chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || this.frameCount === 0) throw new Error('No frame to finalize');
    const payloadSize = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(
      28,
      true
    );
    const payload = chunk.subarray(32, 32 + payloadSize);
    StreamingWebpMuxer.writeUint24(chunk, 20, Math.min(durationMs, 0xffffff));
    let remainingMs = durationMs - 0xffffff;
    while (remainingMs > 0) {
      const hold = Math.min(remainingMs, 0xffffff);
      this.addFrame(payload, hold, this.iccProfile);
      remainingMs -= hold;
    }
  }

  /**
   * Write the RIFF + VP8X + ANIM header.
   * Called lazily before the first ANMF chunk.
   */
  private writeHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;

    const header = new Uint8Array(this.headerSize());
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
    header[off++] = 0x02 | (this.iccProfile ? 0x20 : 0); // Animation and ICC flags
    header[off++] = 0x00;
    header[off++] = 0x00;
    header[off++] = 0x00;
    off = StreamingWebpMuxer.writeUint24(header, off, this.width - 1);
    off = StreamingWebpMuxer.writeUint24(header, off, this.height - 1);

    if (this.iccProfile) {
      view.setUint32(off, 0x49434350, false); // ICCP
      off += 4;
      view.setUint32(off, this.iccProfile.length, true);
      off += 4;
      header.set(this.iccProfile, off);
      off += this.iccProfile.length + (this.iccProfile.length & 1);
    }

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
  addFrame(bitstream: Uint8Array, durationMs: number, iccProfile?: Uint8Array | null): void {
    if (this.pending) throw new Error('Cannot mix WebP frame and presentation APIs');
    this.checkProfile(iccProfile ?? null);
    const muxStart = this.profileOperation ? performance.now() : null;
    // RIFF spec requires all chunks to be even-length. When the VP8
    // bitstream is odd-length, a 0x00 pad byte must follow the data.
    const needsPadding = (bitstream.length & 1) === 1;
    const paddedBitstreamLen = bitstream.length + (needsPadding ? 1 : 0);
    const frameDataSize = StreamingWebpMuxer.VP8_CHUNK_OVERHEAD + paddedBitstreamLen;
    const anmfChunkData = StreamingWebpMuxer.ANMF_HEADER - 8 + frameDataSize;
    const anmfTotalSize = 8 + anmfChunkData; // ANMF FourCC + size + data

    if (this.frameCount >= this.limits.maxFrames) {
      throw new OutputLimitError('webp', 'frame', this.limits.maxFrames);
    }
    const headerBytes = this.headerWritten ? 0 : this.headerSize(iccProfile ?? null);
    const nextOffset =
      this.currentOffset +
      headerBytes +
      anmfTotalSize +
      (this.iccProfile?.length ?? iccProfile?.length ?? 0);
    if (!Number.isSafeInteger(nextOffset) || nextOffset > this.limits.maxOutputBytes) {
      throw new OutputLimitError('webp', 'byte', this.limits.maxOutputBytes);
    }

    this.retainProfile(iccProfile ?? null);
    this.writeHeader();

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

    // Completed presentation holds are split before the 24-bit duration limit.
    off = StreamingWebpMuxer.writeUint24(chunk, off, Math.min(Math.round(durationMs), 0xffffff));

    // Frame Flags
    chunk[off++] = 0x00;

    // VP8 sub-chunk (FourCC + size + data + optional pad byte)
    view.setUint32(off, StreamingWebpMuxer.VP8_FOURCC, false);
    off += 4;
    // RIFF chunk sizes exclude the optional alignment padding byte.
    view.setUint32(off, bitstream.length, true);
    off += 4;
    chunk.set(bitstream, off);
    if (needsPadding) {
      chunk[off + bitstream.length] = 0x00;
    }

    this.chunks.push(chunk);
    this.currentOffset += chunk.length;
    this.totalFrameBytes += paddedBitstreamLen;
    this.frameCount++;
    if (muxStart !== null) this.profileOperation?.('webpMuxing', performance.now() - muxStart);
  }

  /**
   * Finalize the container and return the complete WebP file.
   * Patches the RIFF size, then records concatenation and the final output copy.
   */
  async finish(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.pending) throw new Error('WebP presentation has no endpoint');
    if (this.frameCount === 0) {
      throw new Error('No frames added to muxer');
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    // Calculate total size: RIFF header (8) + payload
    const riffSize = this.currentOffset - 8;

    // Patch RIFF size in the first chunk (offset 4)
    const header = this.chunks[0]!;
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    view.setUint32(4, riffSize, true);

    // Concatenate the owned chunks without assuming a browser-specific copy strategy.
    const finalizeStart = this.profileOperation ? performance.now() : null;
    const blob = new Blob(this.chunks, { type: 'image/webp' });
    // The Blob owns the bytes now; the final allocation guard accounts for both forms.
    this.chunks.length = 0;
    if (finalizeStart !== null)
      this.profileOperation?.('muxFinalization', performance.now() - finalizeStart);
    const copyStart = this.profileOperation ? performance.now() : null;
    const output = new Uint8Array(await blob.arrayBuffer());
    if (copyStart !== null) this.profileOperation?.('outputCopy', performance.now() - copyStart);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    return output;
  }

  /**
   * Add extra duration to the last frame already in the muxer.
   *
   * Used when dynamic decimation skips frames at the end of the video:
   * their accumulated duration would otherwise be lost. Reads the existing
   * ANMF duration (3-byte LE at offset 20), adds `extraMs`, and splits
   * continuations at the 24-bit maximum under the existing output limits.
   */
  padLastFrameDuration(extraMs: number): void {
    if (this.frameCount === 0 || extraMs <= 0) return;

    const lastChunk = this.chunks[this.chunks.length - 1]!;
    // ANMF chunk layout: FourCC(4) + size(4) + x(3) + y(3) + w(3) + h(3) + dur(3) + flags(1)
    const durOffset = 20;
    const view = new DataView(lastChunk.buffer, lastChunk.byteOffset, lastChunk.byteLength);

    // Read existing 3-byte LE duration
    const existingMs =
      view.getUint8(durOffset) |
      (view.getUint8(durOffset + 1) << 8) |
      (view.getUint8(durOffset + 2) << 16);

    this.setLastFrameDuration(existingMs + Math.round(extraMs));
  }

  private static writeUint24(output: Uint8Array, offset: number, value: number): number {
    let o = offset;
    output[o++] = value & 0xff;
    output[o++] = (value >> 8) & 0xff;
    output[o++] = (value >> 16) & 0xff;
    return o;
  }
}
