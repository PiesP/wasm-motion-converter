// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service — Streaming Architecture (Decode→Encode Interleaved)
 *
 * Uses wasm-webp's single-frame encodeRGB API with streaming decode→encode
 * interleaving. Frames are encoded immediately upon decoding, so only 1 RGB
 * frame exists in memory at any time during the decode→encode phase.
 *
 * Pipeline:
 *   1. decodeFrames streams frames via onFrameAvailable callback
 *   2. Per frame: encodeRGB() → VP8 bitstream extraction → collect
 *   3. muxAnimatedWebP() → final animated WebP container
 */

import type { ProgressCallback } from '@t/conversion-types';
import { WEBP_QUALITY_PERCENT } from '@utils/constants';
import { logger } from '@utils/logger';

import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { withPooledBuffer } from './pooled-buffer';
import { extractVP8Bitstream, StreamingWebpMuxer } from './streaming-webp-encoder';
import { encodeRGBReuse } from './wasm-webp-singleton';

/**
 * Encode demuxed video frames to animated WebP with streaming decode→encode.
 *
 * Pipeline:
 *   1. decodeFrames (streaming via onFrameAvailable) → per-frame encodeRGB
 *   2. Collect VP8 bitstreams
 *   3. Mux into RIFF/WEBP container
 */
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
