// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Frame Assembler Service
 *
 * Writes raw RGBA frame data to FFmpeg's Virtual File System (VFS) for
 * encoding. Supports three output modes:
 *
 * 1. **rawvideo** — fastest path, writes concatenated RGBA bytes directly.
 *    FFmpeg reads with: `-f rawvideo -pixel_format rgba -video_size WxH -i filename`
 * 2. **PNG sequence** — backward-compatible, encodes each frame via OffscreenCanvas.
 * 3. **WebP sequence** — smaller output than PNG, falls back to PNG if WebP unavailable.
 *
 * All methods process frames in batches to limit peak JS heap usage.
 *
 * @example
 * ```ts
 * // Raw video (fastest)
 * await frameAssemblerService.writeRawVideo({
 *   ffmpeg, pixels, width: 1920, height: 1080, frameCount: 30,
 *   outputFileName: 'input.raw',
 * });
 *
 * // PNG sequence (backward compat)
 * const files = await frameAssemblerService.writePngSequence({
 *   ffmpeg, frames, quality: 1.0, onProgress: (c, t) => console.log(c, t),
 * });
 * // files → ['frame_000000.png', 'frame_000001.png', ...]
 * ```
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { logger } from '@utils/logger';

// ── Interfaces ──────────────────────────────────────────────────────────────

/** Parameters for writing concatenated RGBA frames as rawvideo to VFS. */
export interface RawVideoParams {
  /** FFmpeg instance (provides FS access). */
  ffmpeg: FFmpeg;
  /** Concatenated RGBA pixel data for all frames. */
  pixels: Uint8Array;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Number of frames represented in `pixels`. */
  frameCount: number;
  /** Destination file name inside the VFS (e.g. 'input.raw'). */
  outputFileName: string;
}

/** Parameters for writing frames as an image sequence (PNG or WebP) to VFS. */
export interface PngSequenceParams {
  /** FFmpeg instance (provides FS access). */
  ffmpeg: FFmpeg;
  /** Individual frames with RGBA pixel data and dimensions. */
  frames: Array<{ pixels: Uint8Array; width: number; height: number }>;
  /** Image quality 0–1 (used for WebP; PNG ignores this). */
  quality: number;
  /** Optional VFS directory prefix (e.g. 'frames/'). Defaults to ''. */
  outputDir?: string;
  /** Optional progress callback (current, total). */
  onProgress?: (current: number, total: number) => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Number of frames to encode & write per batch. Keeps peak memory bounded. */
const BATCH_SIZE = 5;

/** Default WebP quality when the caller does not specify one. */
const DEFAULT_WEBP_QUALITY = 0.85;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an ImageData from RGBA pixel data with an explicit ArrayBuffer view
 * to satisfy strict ImageData typing (noUncheckedSharedArrayBuffer).
 */
function makeImageData(pixels: Uint8Array, width: number, height: number): ImageData {
  return new ImageData(
    new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength / 4),
    width,
    height
  );
}

// ── Service ─────────────────────────────────────────────────────────────────

export class FrameAssemblerService {
  // ── Raw Video ──────────────────────────────────────────────────────────

  /**
   * Write concatenated RGBA frames to VFS as rawvideo.
   *
   * This is the fastest path — no encoding overhead. The entire pixel buffer
   * is written in a single `writeFile` call. FFmpeg can read the file
   * with: `-f rawvideo -pixel_format rgba -video_size WxH -i filename`
   *
   * @param params - Raw video parameters (ffmpeg, pixels, dimensions, etc.)
   */
  async writeRawVideo(params: RawVideoParams): Promise<void> {
    const { ffmpeg, pixels, width, height, frameCount, outputFileName } = params;

    const expectedBytes = width * height * 4 * frameCount;
    const sizeMiB = pixels.byteLength / (1024 * 1024);

    logger.info('conversion', 'Writing raw video to VFS', {
      file: outputFileName,
      width,
      height,
      frameCount,
      bytesWritten: pixels.byteLength,
      expectedBytes,
      sizeMiB: Number(sizeMiB.toFixed(2)),
    });

    if (pixels.byteLength !== expectedBytes) {
      logger.warn('conversion', 'Pixel buffer size mismatch', {
        actual: pixels.byteLength,
        expected: expectedBytes,
      });
    }

    await ffmpeg.writeFile(outputFileName, pixels);

    logger.debug('conversion', 'Raw video write complete', { file: outputFileName });
  }

  // ── PNG Sequence ───────────────────────────────────────────────────────

  /**
   * Write frames as a PNG image sequence to VFS.
   *
   * Each frame is encoded as PNG via OffscreenCanvas → putImageData →
   * convertToBlob('image/png'). Frames are processed in batches of
   * {@link BATCH_SIZE} to limit peak memory usage.
   *
   * @param params - Sequence parameters (ffmpeg, frames, quality, callbacks)
   * @returns Array of VFS file names (e.g. ['frame_000000.png', ...])
   */
  async writePngSequence(params: PngSequenceParams): Promise<string[]> {
    const { ffmpeg, frames, outputDir = '', onProgress } = params;
    const total = frames.length;
    const fileNames: string[] = [];

    logger.info('conversion', 'Writing PNG sequence to VFS', {
      frameCount: total,
      outputDir: outputDir || '(root)',
    });

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, total);
      const encodedBatch: Array<{ fileName: string; data: Uint8Array }> = [];

      for (let frameIdx = i; frameIdx < batchEnd; frameIdx++) {
        const frame = frames[frameIdx];
        if (!frame) continue;

        const { pixels, width, height } = frame;
        const fileName = `${outputDir}frame_${String(frameIdx).padStart(6, '0')}.png`;

        const data = await this.encodePng(pixels, width, height);
        encodedBatch.push({ fileName, data });
        fileNames.push(fileName);
      }

      // Write the batch to VFS, then release references
      for (const { fileName, data } of encodedBatch) {
        await ffmpeg.writeFile(fileName, data);
      }

      // Release batch data for GC
      encodedBatch.length = 0;

      onProgress?.(batchEnd, total);

      logger.debug('conversion', 'PNG batch written', {
        batchStart: i,
        batchEnd,
        total,
      });
    }

    logger.info('conversion', 'PNG sequence write complete', {
      filesWritten: fileNames.length,
    });

    return fileNames;
  }

  // ── WebP Sequence ──────────────────────────────────────────────────────

  /**
   * Write frames as a WebP image sequence to VFS.
   *
   * Attempts WebP encoding via OffscreenCanvas.convertToBlob({ type: 'image/webp' }).
   * If WebP is not supported (e.g. Firefox), falls back to PNG automatically.
   *
   * @param params - Sequence parameters (ffmpeg, frames, quality, callbacks)
   * @returns Array of VFS file names (e.g. ['frame_000000.webp', ...])
   */
  async writeWebpSequence(params: PngSequenceParams): Promise<string[]> {
    const { ffmpeg, frames, quality, outputDir = '', onProgress } = params;
    const total = frames.length;
    const fileNames: string[] = [];
    const webpQuality = quality > 0 ? quality : DEFAULT_WEBP_QUALITY;

    logger.info('conversion', 'Writing WebP sequence to VFS', {
      frameCount: total,
      quality: webpQuality,
      outputDir: outputDir || '(root)',
    });

    // Probe WebP support with the first frame
    const firstFrame = frames[0];
    const useWebp = firstFrame
      ? await this.probeWebpSupport(
          firstFrame.pixels,
          firstFrame.width,
          firstFrame.height,
          webpQuality
        )
      : false;

    if (!useWebp) {
      logger.warn('conversion', 'WebP not supported, falling back to PNG');
    }

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, total);
      const encodedBatch: Array<{ fileName: string; data: Uint8Array }> = [];

      for (let frameIdx = i; frameIdx < batchEnd; frameIdx++) {
        const frame = frames[frameIdx];
        if (!frame) continue;

        const { pixels, width, height } = frame;
        const ext = useWebp ? 'webp' : 'png';
        const fileName = `${outputDir}frame_${String(frameIdx).padStart(6, '0')}.${ext}`;

        const data = useWebp
          ? await this.encodeWebp(pixels, width, height, webpQuality)
          : await this.encodePng(pixels, width, height);

        encodedBatch.push({ fileName, data });
        fileNames.push(fileName);
      }

      // Write the batch to VFS, then release references
      for (const { fileName, data } of encodedBatch) {
        await ffmpeg.writeFile(fileName, data);
      }

      // Release batch data for GC
      encodedBatch.length = 0;

      onProgress?.(batchEnd, total);

      logger.debug('conversion', `${useWebp ? 'WebP' : 'PNG (fallback)'} batch written`, {
        batchStart: i,
        batchEnd,
        total,
      });
    }

    logger.info('conversion', 'WebP sequence write complete', {
      filesWritten: fileNames.length,
      format: useWebp ? 'webp' : 'png (fallback)',
    });

    return fileNames;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Encode a single RGBA frame as PNG via OffscreenCanvas.
   *
   * @param pixels - RGBA pixel data
   * @param width  - Frame width
   * @param height - Frame height
   * @returns PNG file bytes
   */
  private async encodePng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get OffscreenCanvas 2D context for PNG encoding');
    }

    const imageData = makeImageData(pixels, width, height);
    ctx.putImageData(imageData, 0, 0);

    const blob = await offscreen.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Encode a single RGBA frame as WebP via OffscreenCanvas.
   *
   * @param pixels  - RGBA pixel data
   * @param width   - Frame width
   * @param height  - Frame height
   * @param quality - WebP quality 0–1
   * @returns WebP file bytes
   */
  private async encodeWebp(
    pixels: Uint8Array,
    width: number,
    height: number,
    quality: number
  ): Promise<Uint8Array> {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get OffscreenCanvas 2D context for WebP encoding');
    }

    const imageData = makeImageData(pixels, width, height);
    ctx.putImageData(imageData, 0, 0);

    const blob = await offscreen.convertToBlob({
      type: 'image/webp',
      quality,
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Probe whether the browser can encode WebP via OffscreenCanvas.
   *
   * Attempts to encode a small test frame and checks the resulting MIME type.
   * Returns `false` if the browser falls back to PNG (e.g. Firefox).
   *
   * @param pixels  - RGBA pixel data for the test frame
   * @param width   - Frame width
   * @param height  - Frame height
   * @param quality - WebP quality to test with
   * @returns `true` if WebP encoding is supported
   */
  private async probeWebpSupport(
    pixels: Uint8Array,
    width: number,
    height: number,
    quality: number
  ): Promise<boolean> {
    try {
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      if (!ctx) return false;

      const imageData = makeImageData(pixels, width, height);
      ctx.putImageData(imageData, 0, 0);

      const blob = await offscreen.convertToBlob({
        type: 'image/webp',
        quality,
      });

      return blob.type === 'image/webp';
    } catch {
      return false;
    }
  }
}

/** Global singleton instance of the frame assembler service. */
export const frameAssemblerService = new FrameAssemblerService();
