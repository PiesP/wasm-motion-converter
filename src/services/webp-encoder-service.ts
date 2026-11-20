// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service — Streaming Architecture (Decode→Encode Interleaved)
 *
 * The product software route uses conversion-owned ABI2 VP8. The legacy
 * wasm-webp entrypoint remains for independent comparison tests. Both keep
 * ordered decode→encode delivery and share the presentation muxer.
 *
 * Pipeline:
 *   1. decodeFrames streams frames via onFrameAvailable callback
 *   2. Per frame: borrowed VP8 keyframe → presentation muxer
 *   3. Finalize the animated RIFF/WEBP container
 */

import { getErrorMessage } from '@piesp/browser-core/error';
import type { ProgressCallback } from '@t/conversion-types';
import { WEBP_QUALITY_PERCENT } from '@utils/constants';
import { logger } from '@utils/logger';

import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { WebpFrameMemoryBudget } from './frame-memory';
import { OutputLimitError, resolveOutputLimits } from './output-limits';
import { createOwnedVp8Encoder } from './owned-vp8-core';
import { OwnedVp8MemoryAdmissionError, OwnedVp8OutputLimitError } from './owned-vp8-errors';
import { OwnedVp8MemoryBroker } from './owned-vp8-memory';
import { withPooledBuffer } from './pooled-buffer';
import { extractVP8Bitstream, StreamingWebpMuxer } from './streaming-webp-encoder';
import { encodeRGBReuse } from './wasm-webp-singleton';

/**
 * Candidate product software path. One owned module instance spans all frames;
 * the decoder's target reservation remains held until each borrowed write ends.
 */
export async function encodeWebpOwned(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const quality = WEBP_QUALITY_PERCENT[opts.quality];
  if (quality !== 60 && quality !== 75 && quality !== 85)
    throw new Error('Owned VP8 quality preset is unsupported');
  const outputLimits = resolveOutputLimits('webp', opts);
  const frameDecimation = opts.frameDecimation ?? 1;

  logger.info('encoders', '  │  ├─ WebP: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encode state — use incremental muxer to avoid O(N) memory accumulation
  const muxer = new StreamingWebpMuxer(w, h, opts, opts.profileOperation);
  const frameMemoryBudget = new WebpFrameMemoryBudget({
    codedWidth: demux.config.codedWidth ?? srcW,
    codedHeight: demux.config.codedHeight ?? srcH,
    displayWidth: demux.config.displayAspectWidth ?? srcW,
    displayHeight: demux.config.displayAspectHeight ?? srcH,
    targetWidth: w,
    targetHeight: h,
    workerCount: 1,
    sourceHeadroomFrames: 1,
    serialSoftware: true,
  });
  let broker: OwnedVp8MemoryBroker;
  try {
    broker = new OwnedVp8MemoryBroker(
      demux,
      frameMemoryBudget,
      muxer,
      opts.assertOwnedVp8AdditionalMemoryBytes ?? (() => undefined),
      outputLimits.maxOutputBytes
    );
  } catch (error) {
    frameMemoryBudget.dispose();
    throw error;
  }
  let encoder: Awaited<ReturnType<typeof createOwnedVp8Encoder>> | undefined;
  let totalInputFrames = 0;
  let skippedByDecimation = 0;
  let encodeIdx = 0;
  let ownedVp8Steps = 0;
  let ownedVp8HostTaskYields = 0;
  let ownedVp8PeakActualLinearCapacityBytes = 0;
  let ownedVp8PeakReservedLinearCapacityBytes = 0;

  // Additional sampling policy uses supplied conversion accounting when available.
  const decimationController = createDynamicDecimationController(opts.decimationMemoryCheck);

  // Decode frames with streaming callback — each frame is encoded immediately
  try {
    encoder = await createOwnedVp8Encoder({
      accounting: broker,
      ...(signal ? { signal } : {}),
    });
    const activeEncoder = encoder;
    const {
      totalInputFrames: totalDecoded,
      skippedByDecimation: totalSkipped,
      smartSkipped: totalSmartSkipped,
      consumedChunks,
      selectedFrames,
      presentationEndUs,
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
        pixelFormat: 'rgb',
        frameMemoryBudget,
        profileOperation: opts.profileOperation,
        profileCopyPath: opts.profileCopyPath,
        stagedCopyLookahead: false,
        onFrameDecoded: (frameNum, total) => {
          opts.onFrameDecoded?.(frameNum, total);
          totalInputFrames = total;
          // Report encoding progress during streaming (onFrameDecoded is already
          // called by decodeFrames internally — no duplicate call here)
          if (onProgress && encodeIdx > 0) {
            const encodePct = total > 0 ? Math.round((encodeIdx / total) * 40) : 0;
            onProgress({
              phase: 'encoding',
              progress: 50 + Math.min(40, encodePct),
              fps: 0,
              etaSeconds: null,
              memoryMB: null,
              currentFrame: encodeIdx,
              totalFrames: total,
            });
          }
        },
        // Streaming callback: encode each frame immediately upon decoding
        onFrameAvailable: async (rgbData, _frameDurationMs, _frameNum, memoryHandoff, timing) => {
          if (signal?.aborted) {
            globalBufferPool.release(rgbData);
            throw new DOMException('Cancelled', 'AbortError');
          }

          // ── Dynamic decimation based on memory pressure ──
          const shouldSkip = decimationController.shouldSkip(_frameNum);

          if (shouldSkip) {
            // Release buffer and skip encoding
            globalBufferPool.release(rgbData);
            return;
          }

          return withPooledBuffer(rgbData, async () => {
            const target = memoryHandoff?.take();
            if (!target)
              throw new OwnedVp8MemoryAdmissionError('Owned VP8 target reservation is missing');
            try {
              const encodingStart = opts.profileOperation ? performance.now() : null;
              const stats = await activeEncoder.encode(
                rgbData.subarray(0, w * h * 3),
                {
                  width: w,
                  height: h,
                  stride: w * 3,
                  layout: 4,
                  quality,
                  outputLimit: outputLimits.maxOutputBytes,
                  externalLiveBytes: broker.frameLiveBytes,
                  retainedOutputBytes: muxer.retainedBytes,
                },
                (rawVp8) => {
                  broker.assertPresentationCopy(timing.startUs);
                  muxer.addPresentationFrame(rawVp8, timing);
                  broker.presentationCopySettled();
                }
              );
              if (encodingStart !== null)
                opts.profileOperation?.('webpEncoding', performance.now() - encodingStart);
              ownedVp8Steps += stats.steps;
              ownedVp8HostTaskYields += stats.hostTaskYields;
              ownedVp8PeakActualLinearCapacityBytes = Math.max(
                ownedVp8PeakActualLinearCapacityBytes,
                stats.actualLinearCapacityBytes
              );
              ownedVp8PeakReservedLinearCapacityBytes = Math.max(
                ownedVp8PeakReservedLinearCapacityBytes,
                stats.reservedLinearCapacityBytes
              );
              encodeIdx++;
              opts.onFrameEncoded?.(encodeIdx, demux.totalFrames);
            } finally {
              target.release();
            }
          });
        },
      },
      signal
    );

    totalInputFrames = totalDecoded;
    skippedByDecimation = totalSkipped;

    // No decoder callback may still hold a borrowed VP8 lease after decodeFrames
    // completes. Release linear memory before Blob finalization; retain the
    // canvas reservation until final cleanup because its cache can remain live.
    encoder.retire();

    if (encodeIdx === 0) {
      throw new Error('No frames decoded for WebP encoding');
    }

    broker.assertFinishPresentation(presentationEndUs);
    muxer.finishPresentation(presentationEndUs);
    broker.assertFinalization();

    // Mux all encoded frames into animated WebP container
    const result = await muxer.finish(signal);
    const totalElapsed = (performance.now() - startTime) / 1000;

    onProgress?.({
      phase: 'encoding',
      progress: 90,
      fps: 0,
      etaSeconds: 0,
      memoryMB: null,
      currentFrame: encodeIdx,
      encodedFrames: encodeIdx,
      emittedFrames: muxer.frames,
      outputFrames: muxer.frames,
      totalFrames: Math.max(muxer.frames, totalInputFrames),
    });
    opts.onEncodingComplete?.({
      consumedChunks,
      decodedFrames: totalInputFrames,
      selectedFrames,
      encodedFrames: encodeIdx,
      emittedFrames: muxer.frames,
      ownedVp8Frames: encodeIdx,
      ownedVp8Steps,
      ownedVp8HostTaskYields,
      ownedVp8PeakActualLinearCapacityBytes,
      ownedVp8PeakReservedLinearCapacityBytes,
    });

    logger.info('encoders', 'WebP encoding complete', {
      decodedFrames: totalInputFrames,
      keptFrames: muxer.frames,
      totalFrames: demux.totalFrames,
      frameDecimation,
      outputBytes: result.length,
      fps: Math.round(muxer.frames / totalElapsed),
      duration: `${totalElapsed.toFixed(2)}s`,
      resolution: `${w}×${h}`,
      quality,
      skippedByDecimation,
      smartSkipped: totalSmartSkipped,
      dynamicSkipCount: decimationController.getSkipCount(),
    });
    logger.info('encoders', '  │  └─ WebP: encode finished', {
      keptFrames: muxer.frames,
      outputBytes: result.length,
      duration: `${totalElapsed.toFixed(2)}s`,
      frameDecimation,
      skippedByDecimation,
      smartSkipped: totalSmartSkipped,
    });

    return result;
  } catch (error) {
    // The decoder preserves an output-limit failure during frame delivery as its cause.
    if (
      error instanceof OutputLimitError ||
      (error instanceof Error && error.cause instanceof OutputLimitError)
    )
      throw new OwnedVp8OutputLimitError(getErrorMessage(error), { cause: error });
    throw error;
  } finally {
    try {
      encoder?.retire();
    } finally {
      broker.dispose();
      frameMemoryBudget.dispose();
    }
  }
}

/** Retained wasm-webp comparison entrypoint; product software routing selects
 * encodeWebpOwned explicitly and never falls back after an ABI2 failure. */
export async function encodeWebp(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const quality = WEBP_QUALITY_PERCENT[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;

  logger.info('encoders', '  │  ├─ WebP: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encode state — use incremental muxer to avoid O(N) memory accumulation
  const muxer = new StreamingWebpMuxer(w, h, opts, opts.profileOperation);
  let totalInputFrames = 0;
  let skippedByDecimation = 0;
  let encodeIdx = 0;

  // Additional sampling policy uses supplied conversion accounting when available.
  const decimationController = createDynamicDecimationController(opts.decimationMemoryCheck);

  // Decode frames with streaming callback — each frame is encoded immediately
  const {
    totalInputFrames: totalDecoded,
    skippedByDecimation: totalSkipped,
    smartSkipped: totalSmartSkipped,
    consumedChunks,
    selectedFrames,
    presentationEndUs,
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
      profileOperation: opts.profileOperation,
      profileCopyPath: opts.profileCopyPath,
      stagedCopyLookahead: true,
      onFrameDecoded: (frameNum, total) => {
        opts.onFrameDecoded?.(frameNum, total);
        totalInputFrames = total;
        // Report encoding progress during streaming (onFrameDecoded is already
        // called by decodeFrames internally — no duplicate call here)
        if (onProgress && encodeIdx > 0) {
          const encodePct = total > 0 ? Math.round((encodeIdx / total) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: null,
            currentFrame: encodeIdx,
            totalFrames: total,
          });
        }
      },
      // Streaming callback: encode each frame immediately upon decoding
      onFrameAvailable: async (rgbData, _frameDurationMs, _frameNum, _memoryHandoff, timing) => {
        if (signal?.aborted) {
          globalBufferPool.release(rgbData);
          throw new DOMException('Cancelled', 'AbortError');
        }

        // ── Dynamic decimation based on memory pressure ──
        const shouldSkip = decimationController.shouldSkip(_frameNum);

        if (shouldSkip) {
          // Release buffer and skip encoding
          globalBufferPool.release(rgbData);
          return;
        }

        return withPooledBuffer(rgbData, async () => {
          // Encode through the cached WASM module; its result is a borrowed view.
          const encodingStart = opts.profileOperation ? performance.now() : null;
          const webpResult = await encodeRGBReuse(rgbData, w, h, quality);
          if (encodingStart !== null)
            opts.profileOperation?.('webpEncoding', performance.now() - encodingStart);
          if (!webpResult || webpResult.length === 0) {
            throw new Error(
              `encodeRGBReuse returned ${webpResult ? 'empty' : 'null'} for frame ${encodeIdx}`
            );
          }

          // encodeRGB returns a Uint8Array view over WASM memory — no copy needed.
          // extractVP8Bitstream creates a subarray view, keeping the original alive.
          // WASM memory lifecycle: the wasm-webp module allocates a single linear memory
          // buffer that grows as needed. encodeRGB writes into this buffer and returns a view
          // that remains valid until the next encodeRGB call or the module is freed.
          // addPresentationFrame copies the data into the muxer immediately, so
          // the view is only borrowed and the WASM memory can be safely reused.
          const bitstream = extractVP8Bitstream(webpResult);

          muxer.addPresentationFrame(bitstream, timing);
          encodeIdx++;
          opts.onFrameEncoded?.(encodeIdx, demux.totalFrames);
        });
      },
    },
    signal
  );

  totalInputFrames = totalDecoded;
  skippedByDecimation = totalSkipped;

  if (encodeIdx === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  muxer.finishPresentation(presentationEndUs);

  // Mux all encoded frames into animated WebP container
  const result = await muxer.finish(signal);
  const totalElapsed = (performance.now() - startTime) / 1000;

  onProgress?.({
    phase: 'encoding',
    progress: 90,
    fps: 0,
    etaSeconds: 0,
    memoryMB: null,
    currentFrame: encodeIdx,
    encodedFrames: encodeIdx,
    emittedFrames: muxer.frames,
    outputFrames: muxer.frames,
    totalFrames: Math.max(muxer.frames, totalInputFrames),
  });
  opts.onEncodingComplete?.({
    consumedChunks,
    decodedFrames: totalInputFrames,
    selectedFrames,
    encodedFrames: encodeIdx,
    emittedFrames: muxer.frames,
  });

  logger.info('encoders', 'WebP encoding complete', {
    decodedFrames: totalInputFrames,
    keptFrames: muxer.frames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality,
    skippedByDecimation,
    smartSkipped: totalSmartSkipped,
    dynamicSkipCount: decimationController.getSkipCount(),
  });
  logger.info('encoders', '  │  └─ WebP: encode finished', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation,
    smartSkipped: totalSmartSkipped,
  });

  return result;
}
