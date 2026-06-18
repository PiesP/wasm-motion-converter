// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service — Streaming Architecture (Decode→Encode Interleaved)
 *
 * Uses wasm-webp's single-frame encodeRGB API with streaming decode→encode
 * interleaving. Frames are encoded immediately upon decoding, so only 1 RGB
 * frame exists in memory at any time during the decode→encode phase.
 *
 * Previous architecture:
 *   1. decodeFrames → ALL RGB frames in array (batch)
 *   2. encodeStreamingWebP → encode one by one
 *   Wall-clock = decode_all + encode_all (sequential)
 *
 * New architecture:
 *   1. decodeFrames with onFrameAvailable → encode each frame immediately
 *   Wall-clock ≈ max(decode_all, encode_all) (pipelined)
 *
 * Pipeline:
 *   1. decodeFrames streams frames via onFrameAvailable callback
 *   2. Per frame: encodeRGB() → VP8 bitstream extraction → collect
 *   3. muxAnimatedWebP() → final animated WebP container
 */

import type { ConversionQuality } from '@t/conversion-types';
import type { ProgressCallback } from '@t/v2-conversion-types';
import { logger } from '@utils/logger';
import { encodeRGB } from 'wasm-webp';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import {
  extractVP8Bitstream,
  extractVP8BitstreamFast,
  StreamingWebpMuxer,
} from './streaming-webp-encoder';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: ConversionQuality;
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
}

const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 60,
  medium: 80,
  high: 92,
};

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
  opts: WebpEncodeOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;

  logger.info('encoders', '  │  ├─ WebP: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encode state — use incremental muxer to avoid O(N) memory accumulation
  const muxer = new StreamingWebpMuxer(w, h);
  let totalInputFrames = 0;
  let skippedByDecimation = 0;
  let encodeIdx = 0;

  // Decode frames with streaming callback — each frame is encoded immediately
  const { totalInputFrames: totalDecoded, skippedByDecimation: totalSkipped } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      onFrameDecoded: (_frameNum, total) => {
        totalInputFrames = total;
        if (opts.onFrameDecoded && (encodeIdx % 10 === 0 || encodeIdx === 0)) {
          opts.onFrameDecoded(encodeIdx, total);
        }
        // Report encoding progress during streaming
        if (onProgress && encodeIdx > 0) {
          const encodePct = total > 0 ? Math.round((encodeIdx / total) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: 0,
            currentFrame: encodeIdx,
            totalFrames: total,
          });
        }
      },
      // Streaming callback: encode each frame immediately upon decoding
      onFrameAvailable: async (rgbData: Uint8Array, frameDurationMs: number, _frameNum: number) => {
        if (signal?.aborted) {
          throw new DOMException('Cancelled', 'AbortError');
        }

        totalInputFrames = _frameNum;

        // Encode this frame immediately via wasm-webp
        const webpResult = await encodeRGB(rgbData, w, h, quality);
        if (!webpResult || webpResult.length === 0) {
          throw new Error(
            `encodeRGB returned ${webpResult ? 'empty' : 'null'} for frame ${encodeIdx}`
          );
        }

        const webpData = webpResult instanceof Uint8Array ? webpResult : new Uint8Array(webpResult);
        // First frame: full validation. Subsequent frames: fast path (same encoder = same format).
        const bitstream =
          encodeIdx === 0 ? extractVP8Bitstream(webpData) : extractVP8BitstreamFast(webpData);

        muxer.addFrame(bitstream, frameDurationMs);
        encodeIdx++;
      },
    },
    signal
  );

  totalInputFrames = totalDecoded;
  skippedByDecimation = totalSkipped;

  if (muxer.frames === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  // Mux all encoded frames into animated WebP container
  const result = muxer.finish();
  const totalElapsed = (performance.now() - startTime) / 1000;

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
  });
  logger.info('encoders', '  │  └─ WebP: encode finished', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation,
  });

  return result;
}
