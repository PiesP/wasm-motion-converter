// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebP Encoder Service (@jsquash/webp — SIMD WASM)
 *
 * Provides a fast, browser-native WebP encoding path using the @jsquash/webp
 * WASM module (derived from Squoosh/Chrome Labs). Supports animated WebP output
 * by encoding individual frames via libwebp SIMD and then muxing them into a
 * valid animated WebP RIFF container.
 *
 * This service is designed to replace the slower FFmpeg WASM libwebp path for
 * WebP output, especially when combined with GPU frame extraction.
 *
 * ## Architecture
 *
 * ```
 * RGBA Frames → @jsquash/webp (per-frame VP8) → Animated WebP Muxer → Blob
 * ```
 *
 * Because @jsquash/webp only supports single-image encoding, this service
 * encodes each frame individually (VP8 lossy) and then assembles a valid
 * animated WebP container using the RIFF/ANIM/ANMF chunk format defined in
 * the WebP specification.
 *
 * ## Quality Mapping
 *
 * | Preset | libwebp quality | Target FPS |
 * |--------|----------------|------------|
 * | low    | 50             | 10         |
 * | medium | 60             | 15         |
 * | high   | 75             | 20         |
 *
 * @example
 * ```ts
 * if (await WebpEncoderService.isAvailable()) {
 *   const blob = await webpEncoderService.encode({
 *     frames: extractedFrames,
 *     fps: 15,
 *     quality: 'medium',
 *     onProgress: (current, total) => console.log(`${current}/${total}`),
 *     signal: abortController.signal,
 *   });
 * }
 * ```
 */

import { throwIfAborted } from '@utils/cancellation-context';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single video frame with raw RGBA pixel data. */
export interface WebpEncoderFrame {
  /** RGBA pixel data (4 bytes per pixel: R, G, B, A). */
  pixels: Uint8Array;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/** Quality presets for WebP encoding. */
export type WebpEncoderQuality = 'low' | 'medium' | 'high';

/** Options for the `encode()` method. */
export interface WebpEncoderOptions {
  /** Array of RGBA frames to encode into an animated WebP. */
  frames: WebpEncoderFrame[];
  /** Target frames per second for the animation. */
  fps: number;
  /** Quality preset. */
  quality: WebpEncoderQuality;
  /** Optional progress callback (current frame, total frames). */
  onProgress?: (current: number, total: number) => void;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Quality preset → libwebp quality value (0–100). */
const QUALITY_MAP: Record<WebpEncoderQuality, number> = {
  low: 50,
  medium: 60,
  high: 75,
};

/** Number of frames to encode per batch to limit peak memory. */
const BATCH_SIZE = 5;

/** Magic bytes for RIFF container format. */
const RIFF_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const WEBP_MAGIC = new Uint8Array([0x57, 0x45, 0x42, 0x50]); // "WEBP"
const ANIM_FOURCC = 0x4d494e41; // "ANIM" → LE uint32
const ANMF_FOURCC = 0x464d4e41; // "ANMF" → LE uint32

// ── Helpers: WebP Binary Format ──────────────────────────────────────────────

/**
 * Extract the image data chunk (VP8 or VP8L) from a single-image WebP buffer.
 *
 * Handles both simple (VP8/VP8L) and extended (VP8X) WebP containers:
 *   Simple: RIFF(12) + VP8/VP8L(8+N) + optional padding
 *   Extended: RIFF(12) + VP8X(8+12) + VP8/VP8L(8+N) + optional padding
 *
 * This function scans for the VP8/VP8L sub-chunk and returns it
 * (fourCC + size + data + padding) suitable for embedding in an ANMF chunk.
 *
 * @param buffer - Raw WebP file bytes from @jsquash/webp `encode()`
 * @returns The VP8/VP8L sub-chunk bytes, or null if parsing fails
 */
function extractImageChunk(buffer: ArrayBuffer): Uint8Array | null {
  if (buffer.byteLength < 21) return null; // Min: RIFF(12) + VP8(8) + 1 data byte

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Verify RIFF header
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== RIFF_MAGIC[i]) return null;
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[8 + i] !== WEBP_MAGIC[i]) return null;
  }

  // Scan chunks to find VP8 or VP8L (skip VP8X and other chunks)
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkFourCC = view.getUint32(offset, true);
    const chunkSize = view.getUint32(offset + 4, true);
    const paddedSize = chunkSize % 2 === 0 ? chunkSize : chunkSize + 1;
    const totalChunkLen = 8 + paddedSize;

    if (chunkFourCC === 0x20505638 || chunkFourCC === 0x4c505638) {
      // Found "VP8 " (0x20505638) or "VP8L" (0x4c505638)
      if (offset + totalChunkLen > buffer.byteLength) return null;
      return bytes.slice(offset, offset + totalChunkLen);
    }

    // Skip this chunk (VP8X, ICCP, EXIF, XMP, etc.)
    offset += totalChunkLen;
  }

  return null; // No VP8/VP8L chunk found
}

/**
 * Encode a single RGBA frame to WebP via @jsquash/webp.
 *
 * Dynamically imports the encoder module on first call (code splitting).
 * Creates an ImageData from the raw RGBA pixels and passes it to the
 * WASM-based encoder.
 *
 * @param frame - The frame to encode
 * @param quality - libwebp quality value (0–100)
 * @returns Raw WebP file bytes (single-image RIFF container)
 */
async function encodeFrameToWebp(frame: WebpEncoderFrame, quality: number): Promise<ArrayBuffer> {
  // Dynamic import for code splitting — WASM loaded lazily
  const { encode } = await import('@jsquash/webp');

  // Copy pixel data to a fresh buffer to avoid "detached ArrayBuffer" errors.
  // The WASM encoder may detach the underlying buffer during encoding.
  const pixelCopy = new Uint8ClampedArray(frame.pixels.length);
  pixelCopy.set(frame.pixels);

  const imageData = new ImageData(pixelCopy, frame.width, frame.height);

  return encode(imageData, { quality });
}

// ── Helpers: Write Utilities ─────────────────────────────────────────────────

/** Write a uint32 as little-endian into a Uint8Array at the given offset. */
function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

/** Write a uint24 as little-endian into a Uint8Array at the given offset. */
function writeUint24LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
}

/** Write a uint16 as little-endian into a Uint8Array at the given offset. */
function writeUint16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

// ── Helpers: Animated WebP Muxer ─────────────────────────────────────────────

/**
 * Build a valid animated WebP RIFF container from individually encoded frames.
 *
 * Animated WebP binary structure:
 * ```
 * RIFF "WEBP"
 *   ANIM (bgcolor + loop_count)
 *   ANMF { frame_descriptor(16B) + VP8_chunk }
 *   ANMF { frame_descriptor(16B) + VP8_chunk }
 *   ...
 * ```
 *
 * @param frameChunks - Array of VP8/VP8L sub-chunks, one per frame
 * @param frameDurationMs - Duration per frame in milliseconds
 * @returns Complete animated WebP as ArrayBuffer
 */
function buildAnimatedWebP(
  frameChunks: Uint8Array[],
  frameDurationMs: number,
  width: number,
  height: number
): ArrayBuffer {
  // Calculate total size
  let totalPayloadSize = 0;

  // ANIM chunk: fourCC(4) + size(4) + bgcolor(4) + loop_count(2) = 14
  totalPayloadSize += 14;

  // For each frame: fourCC(4) + subchunk_size(4) + frame_descriptor(16) + vp8_chunk_size
  const frameDescriptorSize = 16;
  for (const chunk of frameChunks) {
    totalPayloadSize += 8 + frameDescriptorSize + chunk.byteLength;
  }

  // RIFF header size: "RIFF"(4) + file_size(4) + "WEBP"(4) = 12
  const totalSize = 12 + totalPayloadSize;
  const buffer = new ArrayBuffer(totalSize);
  const buf = new Uint8Array(buffer);

  // RIFF header
  buf.set(RIFF_MAGIC, 0);
  writeUint32LE(buf, 4, totalSize - 8); // file size = total - 8
  buf.set(WEBP_MAGIC, 8);

  // ANIM chunk
  let pos = 12;
  writeUint32LE(buf, pos, ANIM_FOURCC); // "ANIM"
  pos += 4;
  writeUint32LE(buf, pos, 6); // chunk size
  pos += 4;
  // bgcolor: RGBA (0,0,0,0) = transparent black
  writeUint32LE(buf, pos, 0x00000000);
  pos += 4;
  // loop_count: 0 = infinite loop
  writeUint16LE(buf, pos, 0);
  pos += 2;

  // ANMF chunks for each frame
  const frameWidthMinusOne = width - 1;
  const frameHeightMinusOne = height - 1;

  for (const chunk of frameChunks) {
    const subchunkSize = frameDescriptorSize + chunk.byteLength;

    // ANMF header
    writeUint32LE(buf, pos, ANMF_FOURCC); // "ANMF"
    pos += 4;
    writeUint32LE(buf, pos, subchunkSize);
    pos += 4;

    // Frame descriptor (16 bytes)
    // frame_x (3 bytes, uint24 LE): 0
    writeUint24LE(buf, pos, 0);
    pos += 3;
    // frame_y (3 bytes, uint24 LE): 0
    writeUint24LE(buf, pos, 0);
    pos += 3;
    // frame_width - 1 (3 bytes, uint24 LE)
    writeUint24LE(buf, pos, frameWidthMinusOne);
    pos += 3;
    // frame_height - 1 (3 bytes, uint24 LE)
    writeUint24LE(buf, pos, frameHeightMinusOne);
    pos += 3;
    // frame_duration (3 bytes, uint24 LE)
    writeUint24LE(buf, pos, frameDurationMs);
    pos += 3;
    // flags byte:
    //   bit 0 (LSB): blending method (0 = alpha blending)
    //   bit 1: disposal method (0 = do not dispose)
    //   bits 2-7: reserved (0)
    buf[pos] = 0x00;
    pos += 1;

    // Copy VP8/VP8L sub-chunk directly
    buf.set(chunk, pos);
    pos += chunk.byteLength;
  }

  return buffer;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class WebpEncoderService {
  private initPromise: Promise<void> | null = null;
  private available: boolean | null = null;

  /**
   * Encode an array of RGBA frames into an animated WebP blob.
   *
   * Uses @jsquash/webp (WASM SIMD) for per-frame VP8 encoding, then muxes
   * the frames into a valid animated WebP RIFF container.
   *
   * Frames are processed in batches of {@link BATCH_SIZE} to limit peak
   * memory usage.
   *
   * @param options - Encoding options (frames, fps, quality, callbacks)
   * @returns Animated WebP as a Blob with MIME type "image/webp"
   */
  async encode(options: WebpEncoderOptions): Promise<Blob> {
    const { frames, fps, quality, onProgress, signal } = options;
    const total = frames.length;

    if (total === 0) {
      throw new Error('No frames provided for WebP encoding');
    }

    const libwebpQuality = QUALITY_MAP[quality];
    const frameDurationMs = Math.max(1, Math.round(1000 / fps));

    // Enforce WebP frame duration limits
    if (frameDurationMs > 0xffffff) {
      throw new Error(
        `Frame duration ${frameDurationMs}ms exceeds WebP maximum (${0xffffff}ms). Reduce FPS.`
      );
    }

    logger.info('encoders', 'Starting @jsquash/webp encoding', {
      frameCount: total,
      fps,
      quality,
      libwebpQuality,
      frameDurationMs,
    });

    const width = frames[0]?.width ?? 0;
    const height = frames[0]?.height ?? 0;

    // Encode each frame to VP8 via @jsquash/webp, then extract the VP8 chunk
    const vp8Chunks: Uint8Array[] = new Array(total);
    let successCount = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (signal) throwIfAborted(signal);

      const batchEnd = Math.min(i + BATCH_SIZE, total);

      for (let frameIdx = i; frameIdx < batchEnd; frameIdx++) {
        if (signal) throwIfAborted(signal);

        const frame = frames[frameIdx];
        if (!frame) continue;

        try {
          const webpBuffer = await encodeFrameToWebp(frame, libwebpQuality);
          const chunk = extractImageChunk(webpBuffer);

          if (!chunk) {
            throw new Error(
              `Failed to extract VP8/VP8L chunk from encoded frame ${frameIdx}. ` +
                'The encoder may have produced an unsupported WebP variant (e.g. VP8X).'
            );
          }

          vp8Chunks[frameIdx] = chunk;
          successCount++;
        } catch (error) {
          if (signal?.aborted) {
            throw new Error('Conversion cancelled by user');
          }
          logger.error('encoders', `Frame ${frameIdx} encoding failed`, {
            error: getErrorMessage(error),
            frameIdx,
          });
          throw error;
        }
      }

      // Release references to encoded frame data for GC between batches
      onProgress?.(batchEnd, total);

      logger.debug('encoders', '@jsquash/webp batch encoded', {
        batchStart: i,
        batchEnd,
        total,
        successCount,
      });
    }

    if (successCount !== total) {
      logger.warn('encoders', 'Some frames failed to encode', {
        expected: total,
        encoded: successCount,
      });
    }

    if (signal) throwIfAborted(signal);

    // Mux individual VP8 frames into an animated WebP container
    logger.info('encoders', 'Muxing animated WebP', {
      frameCount: successCount,
      frameDurationMs,
      width,
      height,
    });

    const animatedBuffer = buildAnimatedWebP(
      vp8Chunks.filter((c): c is Uint8Array => c !== undefined),
      frameDurationMs,
      width,
      height
    );

    const blob = new Blob([animatedBuffer], { type: 'image/webp' });

    logger.info('encoders', '@jsquash/webp encoding complete', {
      frameCount: successCount,
      outputBytes: blob.size,
    });

    return blob;
  }

  /**
   * Check if @jsquash/webp can be loaded and used.
   *
   * Attempts a dynamic import of the module. Returns `true` if the module
   * loads and initialises successfully, `false` otherwise.
   *
   * @returns `true` if @jsquash/webp is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await import('@jsquash/webp');
      logger.info('encoders', '@jsquash/webp is available');
      return true;
    } catch (error) {
      logger.warn('encoders', '@jsquash/webp is not available', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Get the encoder backend identifier for metadata tracking.
   *
   * @returns The string 'jsquash-webp'
   */
  static getEncoderBackend(): string {
    return 'jsquash-webp';
  }

  /**
   * Pre-initialise the @jsquash/webp WASM module.
   *
   * Call this early (e.g. during app startup) to ensure the WASM module is
   * loaded and ready before encoding begins. Subsequent calls return the
   * cached initialisation promise.
   *
   * @returns `true` if initialisation succeeded
   */
  async initialize(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    if (this.initPromise) {
      await this.initPromise;
      return this.available ?? false;
    }

    this.initPromise = (async () => {
      try {
        // Trigger a test import + encode to warm up the WASM module
        const { encode } = await import('@jsquash/webp');

        // Quick smoke test with a minimal 1x1 image to trigger WASM init
        const testData = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
        await encode(testData, { quality: 75 });

        this.available = true;
        logger.info('encoders', '@jsquash/webp initialized successfully');
      } catch (error) {
        this.available = false;
        logger.error('encoders', '@jsquash/webp initialization failed', {
          error: getErrorMessage(error),
        });
      }
    })();

    await this.initPromise;
    return this.available ?? false;
  }
}

/** Global singleton instance of the WebP encoder service. */
export const webpEncoderService = new WebpEncoderService();
