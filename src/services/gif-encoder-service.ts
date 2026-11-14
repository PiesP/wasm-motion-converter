// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service — Streaming Architecture
 *
 * Interleaves decoding and encoding: each selected frame is indexed immediately,
 * then written when the next selected source timestamp fixes its display hold.
 * The conversion owns one admitted RGBA arena and at most two protected indexed
 * frames. When that layout cannot fit, the admitted JS-index route is used.
 *
 * Previous architecture held ALL decoded frames in an array, causing:
 *   - 1080p @ 30fps × 5s = 146 frames × 6MB = ~900MB peak
 *   - GC thrashing from per-frame allocations
 *
 * Pipeline:
 *   1. decodeFrames streams frames via callback (no array accumulation)
 *   2. Per frame: admitted WASM RGBA → exact dither → quantize/mapPalette → pending index
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

import { globalBufferPool } from './buffer-pool';
import { decodeFrames, type PresentationInterval } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { OwnedGifWriter } from './gif-owned-writer';
import { createGifScalarQuantizer } from './gif-scalar-wasm';
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
/** Ordered number[][] conversion and retained GIF palettes (at most 256 colors). */
const GIF_SCALAR_PALETTE_BYTES = 32 * 1024;

interface GifEncoderOptions extends BaseEncoderOptions {
  /** Assert the aggregate Worker budget using the GIF stream's live peak bytes. */
  assertAdditionalMemoryBytes?: ((additionalBytes: number) => void) | undefined;
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
  const pixelCount = w * h;
  const exactRgbaBytes = pixelCount * 4;
  let lastIndexedData: Uint8Array | number | null = null;
  let liveIndexedBytes = 0;
  let comparisonWorkingBytes = 0;
  let wasmCapacity = 0;

  const assertGifWorkingMemory = (
    streamPeakBytes: number,
    indexedBytes = liveIndexedBytes + comparisonWorkingBytes,
    wasmPeakBytes = wasmCapacity
  ): void => {
    const additionalBytes =
      streamPeakBytes +
      indexedBytes +
      wasmPeakBytes +
      (wasmPeakBytes > 0 ? GIF_SCALAR_PALETTE_BYTES : 0);
    if (!Number.isSafeInteger(additionalBytes)) {
      throw new RangeError('GIF working memory estimate exceeds the safe integer range');
    }
    opts.assertAdditionalMemoryBytes?.(additionalBytes);
  };

  const encoder = new OwnedGifWriter(
    initialStreamCapacity,
    outputLimits.maxOutputBytes,
    (peak) => assertGifWorkingMemory(peak),
    (indices, depth) => quantizePalette.compress(indices, depth)
  );
  const quantizePalette = await createGifScalarQuantizer(
    (oldBytes, newBytes) =>
      assertGifWorkingMemory(
        encoder.stream.buffer.byteLength,
        liveIndexedBytes + comparisonWorkingBytes,
        oldBytes + newBytes
      ),
    (bytes) => {
      wasmCapacity = bytes;
    },
    signal
  );
  // A refused prospective reservation keeps the entire conversion on the
  // existing JS-index route. A failed actual growth remains terminal.
  const retained = quantizePalette.enableRetained?.(pixelCount) ?? false;

  let lastPalette: number[][] | null = null;
  let globalPalette: number[][] | null = null;
  let retainedGlobalLength = 0;
  let lastColorHash = 0;
  let outputTotalDelay = 0;
  let encodeIdx = 0;
  let retainedMappedFrames = 0;
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
  let firstPendingStartUs: number | null = null;
  let lastIndexedBytes = 0;
  type PendingFrame = {
    indexed: Uint8Array | number;
    palette: number[][] | null;
    colorHash: number;
    indexedBytes: number;
    startUs: number;
    startCs: number;
  };
  let deferredPredecessor: PendingFrame | null = null;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController(opts.decimationMemoryCheck);

  function assertCanWriteOutputFrame(): void {
    if (outputFrames >= outputLimits.maxFrames) {
      throw new OutputLimitError('gif', 'frame', outputLimits.maxFrames);
    }
  }

  function writeIndexedFrame(
    indexed: Uint8Array | number,
    delay: number,
    palette: number[][] | null,
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
    if (retained) {
      if (typeof indexed !== 'number') throw new RangeError('Invalid retained GIF frame');
      const paletteLength = quantizePalette.retainedPaletteLength(indexed);
      const localPalette = useGlobalPalette ? undefined : quantizePalette.retainedPalette(indexed);
      const depth = gifColorDepth(useGlobalPalette ? retainedGlobalLength : paletteLength);
      const compressed = quantizePalette.compressRetained(indexed, depth);
      encoder.writeCompressedFrame(compressed, pixelCount, w, h, {
        ...(localPalette ? { palette: localPalette } : {}),
        colorDepth: depth,
        repeat: 0,
        delay,
      });
      if (retainedGlobalLength === 0) {
        quantizePalette.captureGlobalPalette(indexed);
        retainedGlobalLength = paletteLength;
      }
    } else {
      if (!(indexed instanceof Uint8Array) || !palette)
        throw new RangeError('Invalid indexed GIF frame');
      encoder.writeFrame(indexed, w, h, {
        ...(useGlobalPalette ? {} : { palette }),
        colorDepth: gifColorDepth(useGlobalPalette ? globalPalette!.length : palette.length),
        repeat: 0,
        delay,
      });
      if (!globalPalette) globalPalette = palette;
    }
    if (writeStart !== null) {
      const elapsed = Math.max(0, performance.now() - writeStart);
      opts.profileOperation?.('gifFrameWrite', elapsed);
      if (retained) opts.profileOperation?.('gifRetainedFrameWrite', elapsed);
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
      liveIndexedBytes + pixelCount + comparisonBytes
    );
    const paletteMapStart = opts.profileOperation ? performance.now() : null;
    const indexed = quantizePalette.mapPalette(rgbaData, palette);
    if (paletteMapStart !== null) {
      opts.profileOperation?.(
        'gifPaletteMapping',
        Math.max(0, performance.now() - paletteMapStart)
      );
    }
    if (indexed.byteLength !== pixelCount) {
      throw new RangeError(
        `GIF mapper returned ${indexed.byteLength} indices for ${pixelCount} pixels`
      );
    }
    const indexedBytes =
      indexed.buffer instanceof ArrayBuffer ? indexed.buffer.byteLength : indexed.byteLength;
    assertGifWorkingMemory(
      encoder.stream.buffer.byteLength,
      liveIndexedBytes + indexedBytes + comparisonBytes
    );
    const compact = compactIndexedPalette(indexed, palette);
    return { indexed, ...compact, indexedBytes };
  }

  async function flushPending(endCs: number): Promise<void> {
    if (!lastIndexedData || (!retained && !lastPalette)) return;
    if (!Number.isSafeInteger(endCs) || endCs - pendingStartCs! < GIF_MIN_FRAME_DELAY_CS) {
      throw new RangeError('Invalid GIF presentation duration');
    }
    // This is a representable source interval, established before comparing
    // indexed colors. Duplicate/palette optimization must preserve its timing.
    let useGlobalPalette = retained
      ? retainedGlobalLength !== 0 && quantizePalette.remapRetainedGlobal(lastIndexedData as number)
      : globalPalette !== null &&
        remapToGifGlobalPalette(lastIndexedData as Uint8Array, lastPalette!, globalPalette);
    let remainingCs = endCs - pendingStartCs!;
    while (remainingCs > 0) {
      if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
      let chunkCs = Math.min(remainingCs, GIF_MAX_FRAME_DELAY_CS);
      if (remainingCs - chunkCs === 1) chunkCs--;
      writeIndexedFrame(lastIndexedData, chunkCs * 10, lastPalette, useGlobalPalette);
      outputTotalDelay += chunkCs;
      // The first emitted frame established the global palette. Its own
      // continuation can omit a redundant local table.
      if (retained ? retainedGlobalLength !== 0 : globalPalette === lastPalette)
        useGlobalPalette = true;
      remainingCs -= chunkCs;
      if (remainingCs > 0) splitFrames++;
      if ((splitFrames & 63) === 0 && remainingCs > 0) await yieldToMain();
    }
    liveIndexedBytes -= lastIndexedBytes;
    if (retained) quantizePalette.releaseRetained(lastIndexedData as number);
    lastIndexedBytes = 0;
    lastIndexedData = null;
    lastPalette = null;
    lastColorHash = 0;
    pendingStartUs = null;
    pendingStartCs = null;
  }

  async function flushDeferredPredecessor(): Promise<void> {
    if (!deferredPredecessor) return;
    const successor: PendingFrame = {
      indexed: lastIndexedData!,
      palette: lastPalette,
      colorHash: lastColorHash,
      indexedBytes: lastIndexedBytes,
      startUs: pendingStartUs!,
      startCs: pendingStartCs!,
    };
    const predecessor = deferredPredecessor;
    deferredPredecessor = null;
    lastIndexedData = predecessor.indexed;
    lastPalette = predecessor.palette;
    lastColorHash = predecessor.colorHash;
    lastIndexedBytes = predecessor.indexedBytes;
    pendingStartUs = predecessor.startUs;
    pendingStartCs = predecessor.startCs;
    try {
      await flushPending(successor.startCs);
    } finally {
      lastIndexedData = successor.indexed;
      lastPalette = successor.palette;
      lastColorHash = successor.colorHash;
      lastIndexedBytes = successor.indexedBytes;
      pendingStartUs = successor.startUs;
      pendingStartCs = successor.startCs;
    }
  }

  try {
    // Decode frames with a streaming callback and retain at most two pending indices.
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
            // A predecessor is retained only until another representable sample
            // proves that its successor has a full 2cs hold.
            if (deferredPredecessor) await flushDeferredPredecessor();

            const projectedEndCs = Math.max(
              gifTimeCs(presentation.endUs),
              frameStartCs + GIF_MIN_FRAME_DELAY_CS
            );
            const deferPredecessor =
              lastIndexedData !== null &&
              firstPendingStartUs !== null &&
              (outputTotalDelay + projectedEndCs - pendingStartCs!) * 10 -
                (presentation.endUs - firstPendingStartUs) / 1000 >
                20;
            if (lastIndexedData && !retained) {
              // A second index is optional. If the aggregate guard cannot
              // admit it, flush first and take the original one-index path.
              try {
                assertGifWorkingMemory(
                  encoder.stream.buffer.byteLength,
                  liveIndexedBytes + pixelCount + GIF_PALETTE_COMPARISON_BYTES
                );
              } catch (error) {
                if (!(error instanceof Error) || !/memory/i.test(error.message)) throw error;
                // If this may be the terminal scene, retaining its predecessor
                // is necessary to coalesce the endpoint without inflating it.
                if (deferPredecessor) {
                  globalBufferPool.release(rgbaData);
                  rgbaReleased = true;
                  return;
                }
                await flushPending(frameStartCs);
              }
            }
            if (!lastIndexedData) assertCanWriteOutputFrame();
            if (rgbaData.byteLength < exactRgbaBytes) {
              throw new RangeError(
                `Decoded RGBA buffer is too small: expected ${exactRgbaBytes} bytes, got ${rgbaData.byteLength}`
              );
            }
            assertGifWorkingMemory(encoder.stream.buffer.byteLength, liveIndexedBytes);
            const pixelPreparationStart = opts.profileOperation ? performance.now() : null;
            const exactRgba = rgbaData.subarray(0, exactRgbaBytes);
            quantizePalette.prepare(exactRgba, w, h, ditherStrength);
            globalBufferPool.release(rgbaData);
            rgbaReleased = true;
            if (pixelPreparationStart !== null) {
              opts.profileOperation?.(
                'gifPixelPreparation',
                Math.max(0, performance.now() - pixelPreparationStart)
              );
            }

            // Quantize independently; only an exact post-quantization match may
            // extend the pending frame's source presentation interval.
            const quantizationStart = opts.profileOperation ? performance.now() : null;
            const framePalette = retained
              ? quantizePalette.quantizePreparedRetained(maxColors)
              : quantizePalette.quantizePrepared(maxColors);
            if (quantizationStart !== null) {
              opts.profileOperation?.(
                'gifQuantization',
                Math.max(0, performance.now() - quantizationStart)
              );
            }
            const retainedMappingStart =
              retained && opts.profileOperation ? performance.now() : null;
            const candidate = retained
              ? {
                  indexed: quantizePalette.mapRetained(exactRgba, framePalette as number),
                  palette: null,
                  colorHash: 0,
                  indexedBytes: 0,
                }
              : prepareIndexedFrame(exactRgba, framePalette as number[][]);
            if (retained) retainedMappedFrames++;
            if (retainedMappingStart !== null) {
              const elapsed = Math.max(0, performance.now() - retainedMappingStart);
              opts.profileOperation?.('gifPaletteMapping', elapsed);
              opts.profileOperation?.('gifRetainedIndexMapping', elapsed);
            }
            const precedingIndexedBytes = liveIndexedBytes;
            liveIndexedBytes += candidate.indexedBytes;
            comparisonWorkingBytes =
              !retained && lastIndexedData ? GIF_PALETTE_COMPARISON_BYTES : 0;
            if (
              lastIndexedData &&
              (retained
                ? quantizePalette.sameRetainedPixels(
                    lastIndexedData as number,
                    candidate.indexed as number
                  )
                : lastPalette &&
                  sameExpandedGifPixels(
                    lastIndexedData as Uint8Array,
                    lastPalette,
                    lastColorHash,
                    candidate.indexed as Uint8Array,
                    candidate.palette!,
                    candidate.colorHash
                  ))
            ) {
              if (retained) quantizePalette.releaseRetained(candidate.indexed as number);
              liveIndexedBytes = precedingIndexedBytes;
              comparisonWorkingBytes = 0;
            } else {
              if (lastIndexedData && deferPredecessor) {
                deferredPredecessor = {
                  indexed: lastIndexedData,
                  palette: lastPalette,
                  colorHash: lastColorHash,
                  indexedBytes: lastIndexedBytes,
                  startUs: pendingStartUs!,
                  startCs: pendingStartCs!,
                };
              } else if (lastIndexedData) {
                await flushPending(frameStartCs);
              }
              lastIndexedData = retained
                ? quantizePalette.promoteRetained(candidate.indexed as number)
                : candidate.indexed;
              lastPalette = candidate.palette;
              lastColorHash = candidate.colorHash;
              lastIndexedBytes = candidate.indexedBytes;
              comparisonWorkingBytes = 0;
              pendingStartUs = presentation.startUs;
              pendingStartCs = frameStartCs;
              firstPendingStartUs ??= presentation.startUs;
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
      const finalEndCs = Math.max(
        gifTimeCs(presentationEndUs),
        pendingStartCs! + GIF_MIN_FRAME_DELAY_CS
      );
      // The decode callback may have installed this predecessor; TypeScript
      // cannot see assignments made through that callback.
      const terminalPredecessor = deferredPredecessor as PendingFrame | null;
      if (terminalPredecessor) {
        const projectedDurationMs =
          (outputTotalDelay + finalEndCs - terminalPredecessor.startCs) * 10;
        const sourceDurationMs = (presentationEndUs - firstPendingStartUs!) / 1000;
        if (projectedDurationMs - sourceDurationMs > 20) {
          // A minimum 2cs terminal record would exceed the clip's 20ms
          // endpoint allowance. Keep the prior image through the rounded end;
          // no source image is introduced before its presentation timestamp.
          liveIndexedBytes -= lastIndexedBytes;
          if (retained) quantizePalette.releaseRetained(lastIndexedData as number);
          lastIndexedData = terminalPredecessor.indexed;
          lastPalette = terminalPredecessor.palette;
          lastColorHash = terminalPredecessor.colorHash;
          lastIndexedBytes = terminalPredecessor.indexedBytes;
          pendingStartUs = terminalPredecessor.startUs;
          pendingStartCs = terminalPredecessor.startCs;
          deferredPredecessor = null;
          await flushPending(gifTimeCs(presentationEndUs));
        } else {
          await flushDeferredPredecessor();
          await flushPending(finalEndCs);
        }
      } else {
        // A single minimum 2cs record may extend a short whole clip by 20ms.
        await flushPending(finalEndCs);
      }
    }

    // The tail index is no longer needed during GIF stream finalization,
    // which may allocate a second output-sized buffer.
    lastIndexedData = null;
    liveIndexedBytes = 0;
    comparisonWorkingBytes = 0;
    const finalizationStart = opts.profileOperation ? performance.now() : null;
    encoder.finish();
    if (finalizationStart !== null)
      opts.profileOperation?.('muxFinalization', performance.now() - finalizationStart);
    const streamCapacity = encoder.stream.buffer.byteLength;
    const finalCopyPeakBytes = streamCapacity + encoder.bytesView().byteLength;
    if (
      !Number.isSafeInteger(finalCopyPeakBytes) ||
      finalCopyPeakBytes > outputLimits.maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }
    opts.assertAdditionalMemoryBytes?.(
      finalCopyPeakBytes + wasmCapacity + (wasmCapacity > 0 ? GIF_SCALAR_PALETTE_BYTES : 0)
    );
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
      gifRetainedMappedFrames: retainedMappedFrames,
      gifRetainedImageDataWrites: retained ? outputFrames : 0,
      gifRetainedWasmCapacityBytes: retained ? wasmCapacity : 0,
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
    lastIndexedData = null;
    liveIndexedBytes = 0;
    comparisonWorkingBytes = 0;
  }
}
