// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service — Streaming Architecture
 *
 * Interleaves decoding and encoding: each selected frame is indexed immediately,
 * then written when the next selected source timestamp fixes its display hold.
 * One RGBA scratch and at most two indexed frames are retained while an exact
 * duplicate is checked; the second index is charged to the existing budget.
 *
 * Previous architecture held ALL decoded frames in an array, causing:
 *   - 1080p @ 30fps × 5s = 146 frames × 6MB = ~900MB peak
 *   - GC thrashing from per-frame allocations
 *
 * Pipeline:
 *   1. decodeFrames streams frames via callback (no array accumulation)
 *   2. Per frame: exact RGBA scratch → dither → quantize/applyPalette → pending index
 *   3. Encoder writes GIF incrementally
 */

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import {
  GIF_LZW_RATIO,
  GIF_MAX_BUFFER_BYTES,
  GIF_MAX_FRAME_DELAY_CS,
  GIF_MIN_FRAME_DELAY_MS,
} from '@utils/constants';
import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames, type PresentationInterval } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { OutputLimitError, resolveOutputLimits } from './output-limits';

const QUALITY_COLORS: Record<BaseEncoderOptions['quality'], number> = {
  low: 64, // 128 → 64: perceptual studies show banding is visible below ~32 colors,
  // but 64 colors provides acceptable quality for "low" preset while
  // reducing palette computation time and file size
  medium: 128,
  high: 256,
};

// Bayer ordered dithering strength per quality (0-255 range, lower = subtler)
// low quality: dithering disabled (0) — fewer colors don't benefit from dithering
const QUALITY_DITHER_STRENGTH: Record<BaseEncoderOptions['quality'], number> = {
  low: 0,
  medium: 8,
  high: 12, // 4 → 12: high quality needs stronger dithering to produce
  // smooth gradients with full 256-color palette; 4 was too subtle
};

/** Conservative allowance for the bounded 256-color remap and hash tables. */
const GIF_PALETTE_COMPARISON_BYTES = 32 * 1024;

interface GifEncoderOptions extends BaseEncoderOptions {
  /** Assert the aggregate Worker budget using the GIF stream's live peak bytes. */
  assertAdditionalMemoryBytes?: ((additionalBytes: number) => void) | undefined;
}

// ─── Bayer Ordered Dithering ────────────────────────────────────────

// Bayer ordered dithering 8x8 pattern (pre-normalized to 0-63 range)
const BAYER_8X8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Pre-computed scaled threshold LUT cache.
 * Key = dither strength (0-255), Value = flattened 64-element Int8Array.
 *
 * Bounded to at most 3 entries (one per quality level: 0, 8, 12).
 * Each entry is a 64-element Int8Array (~64 bytes).
 *
 * Instead of computing (BAYER[y][x] - 32) * scale per-pixel per-frame,
 * we pre-compute the threshold for each quality's strength once.
 */
const DITHER_LUT_CACHE: Map<number, Int8Array> = new Map();

function getDitherLUT(strength: number): Int8Array {
  let lut = DITHER_LUT_CACHE.get(strength);
  if (lut) return lut;

  const scale = strength / 64;
  lut = new Int8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      lut[y * 8 + x] = ((BAYER_8X8[y]![x]! - 32) * scale) | 0;
    }
  }
  DITHER_LUT_CACHE.set(strength, lut);
  return lut;
}

/**
 * Apply Bayer ordered dithering to the RGB channels of an RGBA buffer in-place.
 * Uses pre-computed LUT for thresholds — avoids per-pixel multiply.
 * Skips pixels where threshold === 0 (1/64 of pixels at strength=8).
 */
function bayerDitherRgba(rgba: Uint8Array, width: number, height: number, strength: number): void {
  if (strength <= 0) return;

  const lut = getDitherLUT(strength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    const lutRow = y & 7;
    for (let x = 0; x < width; x++) {
      const threshold = lut[lutRow * 8 + (x & 7)]!;
      if (threshold === 0) continue;

      const idx = rowOffset + x * 4;
      const r = rgba[idx]!;
      const g = rgba[idx + 1]!;
      const b = rgba[idx + 2]!;

      const rt = r + threshold;
      const gt = g + threshold;
      const bt = b + threshold;
      rgba[idx] = rt < 0 ? 0 : rt > 255 ? 255 : rt;
      rgba[idx + 1] = gt < 0 ? 0 : gt > 255 ? 255 : gt;
      rgba[idx + 2] = bt < 0 ? 0 : bt > 255 ? 255 : bt;
    }
  }
}

const GIF_MIN_FRAME_DELAY_CS = GIF_MIN_FRAME_DELAY_MS / 10;

/** Quantize absolute source time once, so frame-by-frame rounding cannot drift. */
function gifTimeCs(presentationUs: number): number {
  if (!Number.isSafeInteger(presentationUs) || presentationUs < 0) {
    throw new RangeError('GIF presentation time exceeds integer range');
  }
  return Math.round(presentationUs / 10_000);
}

function packedGifColor(color: number[]): number {
  return ((color[0]! & 255) << 16) | ((color[1]! & 255) << 8) | (color[2]! & 255);
}

function gifColorDepth(colorCount: number): number {
  return Math.max(2, Math.ceil(Math.log2(Math.max(2, colorCount))));
}

/** Preserve each expanded RGB pixel while dropping unused and duplicate entries. */
function compactIndexedPalette(
  index: Uint8Array,
  palette: number[][]
): {
  palette: number[][];
  colorHash: number;
} {
  if (palette.length < 1 || palette.length > 256) {
    throw new RangeError('GIF palette must contain between 1 and 256 colors');
  }
  const oldToNew = new Int16Array(palette.length);
  oldToNew.fill(-1);
  const colorToNew = new Map<number, number>();
  const compact: number[][] = [];
  let colorHash = 0x811c9dc5;
  for (let pixel = 0; pixel < index.length; pixel++) {
    const oldIndex = index[pixel]!;
    const color = palette[oldIndex];
    if (!color || color.length < 3) throw new RangeError('GIF palette index is invalid');
    const packed = packedGifColor(color);
    let newIndex = oldToNew[oldIndex]!;
    if (newIndex < 0) {
      newIndex = colorToNew.get(packed) ?? -1;
      if (newIndex < 0) {
        newIndex = compact.length;
        compact.push(color);
        colorToNew.set(packed, newIndex);
      }
      oldToNew[oldIndex] = newIndex;
    }
    index[pixel] = newIndex;
    colorHash = Math.imul(colorHash ^ packed, 0x01000193);
  }
  return { palette: compact, colorHash };
}

/** A hash only filters candidates; every expanded RGB pixel is proven equal. */
function sameExpandedGifPixels(
  firstIndex: Uint8Array,
  firstPalette: number[][],
  firstHash: number,
  nextIndex: Uint8Array,
  nextPalette: number[][],
  nextHash: number
): boolean {
  if (firstHash !== nextHash || firstIndex.length !== nextIndex.length) return false;
  for (let pixel = 0; pixel < firstIndex.length; pixel++) {
    if (
      packedGifColor(firstPalette[firstIndex[pixel]!]!) !==
      packedGifColor(nextPalette[nextIndex[pixel]!]!)
    ) {
      return false;
    }
  }
  return true;
}

/** Reuse the first emitted frame's global table only at the same LZW depth. */
function remapToGifGlobalPalette(
  index: Uint8Array,
  palette: number[][],
  globalPalette: number[][]
): boolean {
  if (gifColorDepth(globalPalette.length) !== gifColorDepth(palette.length)) return false;
  const remap = new Uint8Array(palette.length);
  for (let local = 0; local < palette.length; local++) {
    const color = packedGifColor(palette[local]!);
    const global = globalPalette.findIndex((entry) => packedGifColor(entry) === color);
    if (global < 0) return false;
    remap[local] = global;
  }
  for (let pixel = 0; pixel < index.length; pixel++) index[pixel] = remap[index[pixel]!]!;
  return true;
}

/**
 * Encode demuxed video frames to GIF with streaming decode→encode.
 *
 * Instead of collecting all decoded frames into an array first, each frame
 * is encoded immediately upon decoding. This reduces peak memory from
 * O(N × frame_size) to O(frame_size).
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: GifEncoderOptions,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const maxColors = QUALITY_COLORS[opts.quality];
  const ditherStrength = QUALITY_DITHER_STRENGTH[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;
  const outputLimits = resolveOutputLimits('gif', opts);

  logger.info('encoders', '  │  ├─ GIF: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encoder — writes frames one at a time
  const estimatedFrames = Math.max(1, Math.floor(demux.totalFrames / (opts.frameDecimation ?? 1)));
  const estimatedBytes = Math.min(w * h * estimatedFrames * GIF_LZW_RATIO, GIF_MAX_BUFFER_BYTES);
  let initialCapacity = 1;
  const requestedInitialCapacity = Math.max(4096, Math.round(estimatedBytes));
  while (
    initialCapacity < requestedInitialCapacity &&
    initialCapacity < outputLimits.maxOutputBytes
  ) {
    initialCapacity *= 2;
  }
  const initialStreamCapacity = Math.min(outputLimits.maxOutputBytes, initialCapacity);
  opts.assertAdditionalMemoryBytes?.(initialStreamCapacity);
  const encoder = GIFEncoder({
    auto: true,
    // A power-of-two starting capacity keeps gifenc's geometric growth from
    // overshooting the power-of-two production byte ceiling.
    initialCapacity: initialStreamCapacity,
  });
  const pixelCount = w * h;
  const exactRgbaBytes = pixelCount * 4;
  let exactRgbaScratch: Uint8Array | null = null;
  let lastIndexedData: Uint8Array | null = null;
  let liveIndexedBytes = 0;
  let comparisonWorkingBytes = 0;

  const assertGifWorkingMemory = (
    streamPeakBytes: number,
    scratchBytes = exactRgbaScratch?.byteLength ?? 0,
    indexedBytes = liveIndexedBytes + comparisonWorkingBytes
  ): void => {
    const additionalBytes = streamPeakBytes + scratchBytes + indexedBytes;
    if (!Number.isSafeInteger(additionalBytes)) {
      throw new RangeError('GIF working memory estimate exceeds the safe integer range');
    }
    opts.assertAdditionalMemoryBytes?.(additionalBytes);
  };

  // gifenc grows its stream automatically. Wrap every supported write method so
  // each logical write and any geometric capacity growth are authorized before
  // gifenc allocates or mutates its buffer. During growth, gifenc retains the old
  // buffer while allocating and copying into the new one, so both capacities must
  // fit inside the output memory budget simultaneously.
  let streamBytes = encoder.bytesView().byteLength;
  const originalWriteByte = encoder.stream.writeByte.bind(encoder.stream);
  const originalWriteBytes = encoder.stream.writeBytes.bind(encoder.stream);
  const originalWriteBytesView = encoder.stream.writeBytesView.bind(encoder.stream);

  function predictStreamCapacity(currentCapacity: number, requiredCapacity: number): number {
    if (currentCapacity >= requiredCapacity) return currentCapacity;
    const geometricCapacity = Math.floor(
      currentCapacity * (currentCapacity < 1024 * 1024 ? 2 : 1.125)
    );
    return Math.max(requiredCapacity, geometricCapacity, currentCapacity === 0 ? 0 : 256);
  }

  function assertCanWriteBytes(byteLength: number): void {
    const requiredCapacity = streamBytes + byteLength;
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity > outputLimits.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }

    const currentCapacity = encoder.stream.buffer.byteLength;
    if (requiredCapacity <= currentCapacity) {
      assertGifWorkingMemory(currentCapacity);
      return;
    }
    const nextCapacity = predictStreamCapacity(currentCapacity, requiredCapacity);
    if (
      !Number.isSafeInteger(nextCapacity) ||
      nextCapacity > outputLimits.maxOutputBytes ||
      currentCapacity + nextCapacity > outputLimits.maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }
    assertGifWorkingMemory(currentCapacity + nextCapacity);
  }

  encoder.stream.writeByte = (byte: number): void => {
    assertCanWriteBytes(1);
    originalWriteByte(byte);
    streamBytes++;
  };
  encoder.stream.writeBytes = (
    bytes: Uint8Array | number[],
    offset = 0,
    length = bytes.length - offset
  ): void => {
    const safeLength = Math.max(0, Math.min(length, bytes.length - offset));
    assertCanWriteBytes(safeLength);
    originalWriteBytes(bytes, offset, safeLength);
    streamBytes += safeLength;
  };
  encoder.stream.writeBytesView = (
    bytes: Uint8Array,
    offset = 0,
    length = bytes.byteLength - offset
  ): void => {
    const safeLength = Math.max(0, Math.min(length, bytes.byteLength - offset));
    assertCanWriteBytes(safeLength);
    originalWriteBytesView(bytes, offset, safeLength);
    streamBytes += safeLength;
  };

  let lastPalette: number[][] | null = null;
  let globalPalette: number[][] | null = null;
  let lastColorHash = 0;
  let outputTotalDelay = 0;
  let encodeIdx = 0;
  let outputFrames = 0;
  let splitFrames = 0;
  let totalInputFrames = 0;
  /** Estimated total frames from demuxer — used for progress reporting only */
  let estimatedTotalFrames = 0;
  let skippedByDecimation = 0;
  let smartSkipped = 0;
  let sourceTotalMs = demux.sourceTotalMs;

  let pendingStartUs: number | null = null;
  let pendingStartCs: number | null = null;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController(opts.decimationMemoryCheck);

  function assertCanWriteOutputFrame(): void {
    if (outputFrames >= outputLimits.maxFrames) {
      throw new OutputLimitError('gif', 'frame', outputLimits.maxFrames);
    }
  }

  function writeIndexedFrame(
    indexed: Uint8Array,
    delay: number,
    palette: number[][],
    useGlobalPalette: boolean
  ): void {
    if (
      !Number.isInteger(delay) ||
      delay < GIF_MIN_FRAME_DELAY_MS ||
      delay > GIF_MAX_FRAME_DELAY_CS * 10
    ) {
      throw new RangeError('GIF frame delay violates the viewer-safe schedule');
    }
    assertCanWriteOutputFrame();
    const writeStart = opts.profileOperation ? performance.now() : null;
    encoder.writeFrame(indexed, w, h, {
      ...(useGlobalPalette ? {} : { palette }),
      colorDepth: gifColorDepth(useGlobalPalette ? globalPalette!.length : palette.length),
      repeat: 0,
      delay,
    });
    if (!globalPalette) globalPalette = palette;
    if (writeStart !== null) {
      opts.profileOperation?.('gifFrameWrite', Math.max(0, performance.now() - writeStart));
    }
    outputFrames++;
  }

  function prepareIndexedFrame(
    rgbaData: Uint8Array,
    palette: number[][]
  ): { indexed: Uint8Array; palette: number[][]; colorHash: number; indexedBytes: number } {
    const comparisonBytes = lastIndexedData ? GIF_PALETTE_COMPARISON_BYTES : 0;
    assertGifWorkingMemory(
      encoder.stream.buffer.byteLength,
      exactRgbaBytes,
      liveIndexedBytes + pixelCount + comparisonBytes
    );
    const paletteMapStart = opts.profileOperation ? performance.now() : null;
    const indexed = applyPalette(rgbaData, palette, 'rgb565');
    if (paletteMapStart !== null) {
      opts.profileOperation?.(
        'gifPaletteMapping',
        Math.max(0, performance.now() - paletteMapStart)
      );
    }
    if (indexed.byteLength !== pixelCount) {
      throw new RangeError(
        `gifenc returned ${indexed.byteLength} indices for ${pixelCount} pixels`
      );
    }
    const indexedBytes =
      indexed.buffer instanceof ArrayBuffer ? indexed.buffer.byteLength : indexed.byteLength;
    assertGifWorkingMemory(
      encoder.stream.buffer.byteLength,
      exactRgbaBytes,
      liveIndexedBytes + indexedBytes + comparisonBytes
    );
    const compact = compactIndexedPalette(indexed, palette);
    return { indexed, ...compact, indexedBytes };
  }

  async function flushPending(endCs: number): Promise<void> {
    if (!lastIndexedData || !lastPalette) return;
    if (!Number.isSafeInteger(endCs) || endCs - pendingStartCs! < GIF_MIN_FRAME_DELAY_CS) {
      throw new RangeError('Invalid GIF presentation duration');
    }
    // This is a representable source interval, established before comparing
    // indexed colors. Duplicate/palette optimization must preserve its timing.
    let useGlobalPalette =
      globalPalette !== null &&
      remapToGifGlobalPalette(lastIndexedData, lastPalette, globalPalette);
    let remainingCs = endCs - pendingStartCs!;
    while (remainingCs > 0) {
      if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
      let chunkCs = Math.min(remainingCs, GIF_MAX_FRAME_DELAY_CS);
      if (remainingCs - chunkCs === 1) chunkCs--;
      writeIndexedFrame(lastIndexedData, chunkCs * 10, lastPalette, useGlobalPalette);
      outputTotalDelay += chunkCs;
      // The first emitted frame established the global palette. Its own
      // continuation can omit a redundant local table.
      if (globalPalette === lastPalette) useGlobalPalette = true;
      remainingCs -= chunkCs;
      if (remainingCs > 0) splitFrames++;
      if ((splitFrames & 63) === 0 && remainingCs > 0) await yieldToMain();
    }
    lastIndexedData = null;
    lastPalette = null;
    lastColorHash = 0;
    liveIndexedBytes = 0;
    pendingStartUs = null;
    pendingStartCs = null;
  }

  try {
    // Decode frames with a streaming callback and retain one pending index.
    const {
      totalInputFrames: totalDecoded,
      skippedByDecimation: decoderSkippedByDecimation,
      smartSkipped: decoderSmartSkipped,
      sourceTotalMs: decodedSourceTotalMs,
      presentationEndUs,
      consumedChunks,
      decodedFrames,
      selectedFrames,
    } = await decodeFrames(
      demux,
      {
        width: w,
        height: h,
        frameDecimation,
        minimumSourceFrameGap: opts.minimumSourceFrameGap,
        pressureCadenceRatio: opts.pressureCadenceRatio,
        hwAccel: 'prefer-hardware',
        smartFrameSkip: opts.smartFrameSkip,
        pixelFormat: 'rgba',
        profileOperation: opts.profileOperation,
        profileCopyPath: opts.profileCopyPath,
        onFrameDecoded: (nativeFrameCount, total) => {
          estimatedTotalFrames = total;
          // Forward the decoder's bounded, selection-independent observations.
          opts.onFrameDecoded?.(nativeFrameCount, total);
        },
        // Streaming callback: index each selected frame after flushing its predecessor.
        onFrameAvailable: async (
          rgbaData: Uint8Array,
          _frameDurationMs: number,
          frameNum: number,
          _memoryHandoff: unknown,
          presentation: PresentationInterval
        ) => {
          if (signal?.aborted) {
            globalBufferPool.release(rgbaData);
            throw new DOMException('Cancelled', 'AbortError');
          }

          totalInputFrames = frameNum;

          // Yield to browser event loop every 5 frames to prevent UI freezing.
          // Per-frame setTimeout(0) adds 1-4ms overhead per frame (150-600ms total
          // for a 150-frame video). Yielding every 5 frames reduces this to ~30-120ms
          // while still keeping the UI responsive.
          if (frameNum % 5 === 0) {
            try {
              await yieldToMain();
            } catch (error) {
              globalBufferPool.release(rgbaData);
              throw error;
            }
          }
          if (signal?.aborted) {
            globalBufferPool.release(rgbaData);
            throw new DOMException('Cancelled', 'AbortError');
          }

          if (
            !Number.isSafeInteger(presentation.startUs) ||
            !Number.isSafeInteger(presentation.endUs) ||
            presentation.startUs < 0 ||
            presentation.endUs <= presentation.startUs
          ) {
            globalBufferPool.release(rgbaData);
            throw new RangeError('Invalid GIF presentation interval');
          }

          // ── Dynamic decimation based on memory pressure ──
          const shouldSkip = decimationController.shouldSkip(frameNum);

          if (shouldSkip) {
            // The next selected source timestamp extends the preceding hold.
            globalBufferPool.release(rgbaData);
            return;
          }

          const frameStartCs = gifTimeCs(presentation.startUs);
          // A new distinct image cannot be displayed for less than 2cs. Keep
          // the pending image and omit this source sample; a later sample may
          // still be admitted at its own timestamp. Rounded absolute starts
          // shift admitted boundaries by at most 5ms without cumulative drift.
          if (pendingStartCs !== null && frameStartCs - pendingStartCs < GIF_MIN_FRAME_DELAY_CS) {
            globalBufferPool.release(rgbaData);
            return;
          }

          let rgbaReleased = false;
          try {
            if (lastIndexedData) {
              // A second index is optional. If the aggregate guard cannot
              // admit it, flush first and take the original one-index path.
              try {
                assertGifWorkingMemory(
                  encoder.stream.buffer.byteLength,
                  exactRgbaBytes,
                  liveIndexedBytes + pixelCount + GIF_PALETTE_COMPARISON_BYTES
                );
              } catch (error) {
                if (!(error instanceof Error) || !/memory/i.test(error.message)) throw error;
                await flushPending(frameStartCs);
              }
            }
            if (!lastIndexedData) assertCanWriteOutputFrame();
            if (rgbaData.byteLength < exactRgbaBytes) {
              throw new RangeError(
                `Decoded RGBA buffer is too small: expected ${exactRgbaBytes} bytes, got ${rgbaData.byteLength}`
              );
            }
            assertGifWorkingMemory(
              encoder.stream.buffer.byteLength,
              exactRgbaBytes,
              liveIndexedBytes
            );
            if (!exactRgbaScratch) {
              exactRgbaScratch = new Uint8Array(exactRgbaBytes);
            }
            const pixelPreparationStart = opts.profileOperation ? performance.now() : null;
            exactRgbaScratch.set(rgbaData.subarray(0, exactRgbaBytes));
            globalBufferPool.release(rgbaData);
            rgbaReleased = true;

            if (ditherStrength > 0) {
              bayerDitherRgba(exactRgbaScratch, w, h, ditherStrength);
            }
            if (pixelPreparationStart !== null) {
              opts.profileOperation?.(
                'gifPixelPreparation',
                Math.max(0, performance.now() - pixelPreparationStart)
              );
            }

            // Quantize independently; only an exact post-quantization match may
            // extend the pending frame's source presentation interval.
            const quantizationStart = opts.profileOperation ? performance.now() : null;
            const framePalette = quantize(exactRgbaScratch, maxColors, { format: 'rgb565' });
            if (quantizationStart !== null) {
              opts.profileOperation?.(
                'gifQuantization',
                Math.max(0, performance.now() - quantizationStart)
              );
            }
            const candidate = prepareIndexedFrame(exactRgbaScratch, framePalette);
            const precedingIndexedBytes = liveIndexedBytes;
            liveIndexedBytes += candidate.indexedBytes;
            comparisonWorkingBytes = lastIndexedData ? GIF_PALETTE_COMPARISON_BYTES : 0;
            if (
              lastIndexedData &&
              lastPalette &&
              sameExpandedGifPixels(
                lastIndexedData,
                lastPalette,
                lastColorHash,
                candidate.indexed,
                candidate.palette,
                candidate.colorHash
              )
            ) {
              liveIndexedBytes = precedingIndexedBytes;
              comparisonWorkingBytes = 0;
            } else {
              if (lastIndexedData) await flushPending(frameStartCs);
              lastIndexedData = candidate.indexed;
              lastPalette = candidate.palette;
              lastColorHash = candidate.colorHash;
              liveIndexedBytes = candidate.indexedBytes;
              comparisonWorkingBytes = 0;
              pendingStartUs = presentation.startUs;
              pendingStartCs = frameStartCs;
            }
          } finally {
            if (!rgbaReleased) globalBufferPool.release(rgbaData);
          }

          // Report encoding progress (50~90% range in pipeline)
          if (opts.onFrameEncoded) {
            opts.onFrameEncoded(encodeIdx + 1, estimatedTotalFrames);
          }

          encodeIdx++;
        },
      },
      signal
    );
    sourceTotalMs = decodedSourceTotalMs;

    totalInputFrames = totalDecoded;
    skippedByDecimation = decoderSkippedByDecimation;
    smartSkipped = decoderSmartSkipped;

    if (encodeIdx === 0) {
      throw new Error('No frames decoded for GIF encoding');
    }
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    if (lastIndexedData) {
      if (!Number.isSafeInteger(presentationEndUs)) {
        throw new RangeError('Missing GIF presentation end');
      }
      if (presentationEndUs < pendingStartUs!) {
        throw new RangeError('Invalid GIF presentation end');
      }
      // Extend only the final hold when its quantized tail is unrepresentable.
      // This adds at most 20ms beyond the rounded endpoint (itself within 5ms
      // of source time), rather than adding a minimum to every input frame.
      await flushPending(
        Math.max(gifTimeCs(presentationEndUs), pendingStartCs! + GIF_MIN_FRAME_DELAY_CS)
      );
    }

    // Pixel scratch and the tail index are no longer needed during GIF stream
    // finalization, which may allocate a second output-sized buffer.
    exactRgbaScratch = null;
    lastIndexedData = null;
    liveIndexedBytes = 0;
    comparisonWorkingBytes = 0;
    const finalizationStart = opts.profileOperation ? performance.now() : null;
    encoder.finish();
    if (finalizationStart !== null)
      opts.profileOperation?.('muxFinalization', performance.now() - finalizationStart);
    const streamCapacity = encoder.stream.buffer.byteLength;
    const finalCopyPeakBytes = streamCapacity + streamBytes;
    if (
      !Number.isSafeInteger(finalCopyPeakBytes) ||
      finalCopyPeakBytes > outputLimits.maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }
    opts.assertAdditionalMemoryBytes?.(finalCopyPeakBytes);
    const copyStart = opts.profileOperation ? performance.now() : null;
    const rawBytes = encoder.bytes();
    if (copyStart !== null) opts.profileOperation?.('outputCopy', performance.now() - copyStart);
    const totalElapsed = (performance.now() - startTime) / 1000;
    opts.onEncodingComplete?.({
      consumedChunks,
      decodedFrames,
      selectedFrames,
      encodedFrames: encodeIdx,
      emittedFrames: outputFrames,
    });

    logger.info('encoders', 'GIF encoding complete', {
      decodedFrames: totalInputFrames,
      keptFrames: encodeIdx,
      totalFrames: demux.totalFrames,
      outputBytes: rawBytes.length,
      fps: Math.round(encodeIdx / totalElapsed),
      duration: `${totalElapsed.toFixed(2)}s`,
      resolution: `${w}×${h}`,
      quality: opts.quality,
      maxColors,
      frameDecimation,
      skippedByDecimation,
      smartSkipped,
      splitFrames,
      sourceDurationMs: Math.round(sourceTotalMs),
      outputDurationCs: Math.round(outputTotalDelay),
      timingErrorCs: Math.round(outputTotalDelay - Math.round(sourceTotalMs / 10)),
      dynamicSkipCount: decimationController.getSkipCount(),
    });
    logger.info('encoders', '  │  └─ GIF: encode finished', {
      keptFrames: encodeIdx,
      outputBytes: rawBytes.length,
      duration: `${totalElapsed.toFixed(2)}s`,
      skippedByDecimation,
      smartSkipped,
    });

    return rawBytes;
  } finally {
    exactRgbaScratch = null;
    lastIndexedData = null;
    liveIndexedBytes = 0;
    comparisonWorkingBytes = 0;
  }
}
