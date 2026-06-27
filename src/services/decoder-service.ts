// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common VideoDecoder pipeline for both GIF and WebP encoders.
 *
 * Extracts RGB frames from demuxed video chunks using VideoDecoder,
 * with hardware acceleration support, frame decimation, and abort handling.
 *
 * Supports two modes:
 * 1. Batch mode (WebP): collects all frames into an array (existing behavior)
 * 2. Streaming mode (GIF): calls onFrameAvailable per frame for immediate encoding
 *
 * Both encoders share the same demux output and frame extraction logic;
 * only the encoding step (gifenc vs wasm-webp) differs.
 */

import type { SmartFrameSkipMode } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import type { DemuxResult } from './demuxer-service';
import {
  computeDHash,
  copyFrameToRGB,
  getFrameDurationMs,
  getSkipThreshold,
  hammingDistance,
} from './frame-utils';

export interface DecodeOptions {
  width: number;
  height: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Hardware acceleration policy */
  hwAccel?: 'prefer-hardware' | 'prefer-software';
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
  /**
   * Streaming callback: fired for each decoded frame with RGB data.
   * When provided, frames are NOT accumulated into an array — instead they
   * are passed to this callback for immediate processing (e.g. encoding).
   * The callback receives ownership of the RGB buffer (must release to pool).
   */
  onFrameAvailable?: (
    rgbData: Uint8Array,
    durationMs: number,
    frameNum: number
  ) => Promise<void> | void;
  /**
   * Explicit decode mode. When 'stream', frames are passed to onFrameAvailable
   * immediately. When 'batch', frames are collected into an array.
   * @default 'stream' when onFrameAvailable is provided, 'batch' otherwise
   */
  mode?: 'stream' | 'batch';
  /**
   * Smart frame skip mode — enables similarity-based frame deduplication.
   * When enabled, consecutive similar frames are skipped and their durations
   * are accumulated into the next kept frame.
   * @default 'off'
   */
  smartFrameSkip?: SmartFrameSkipMode;
}

export interface DecodedFrame {
  /** RGB pixel data, length = width * height * 3 */
  data: Uint8Array;
  /** Frame display duration in milliseconds */
  duration: number;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  totalInputFrames: number;
  skippedByDecimation: number;
  /** Total source duration in milliseconds (from demux chunk durations) */
  sourceTotalMs: number;
  /** Total output duration in milliseconds (sum of all frame durations) */
  outputTotalMs: number;
}

/**
 * Decode demuxed video chunks to RGB frames.
 *
 * Pipeline:
 *   1. Configure VideoDecoder (hwAccel with software fallback)
 *   2. Feed all chunks from DemuxResult
 *   3. Per-frame: copyTo RGB → optional filter → accumulate skipped durations
 *   4a. Batch mode: collect into frames array
 *   4b. Stream mode: call onFrameAvailable callback per frame
 */
export async function decodeFrames(
  demux: DemuxResult,
  opts: DecodeOptions,
  signal?: AbortSignal
): Promise<DecodeResult> {
  const {
    width,
    height,
    frameDecimation = 1,
    hwAccel = 'prefer-software',
    onFrameDecoded,
    onFrameAvailable,
    mode,
    smartFrameSkip = 'off',
  } = opts;

  // Determine streaming mode: explicit 'stream' mode or infer from callback
  const streaming =
    mode === 'stream' || (mode !== 'batch' && typeof onFrameAvailable === 'function');

  // Warn if onFrameAvailable is provided but mode is explicitly 'batch'
  if (mode === 'batch' && typeof onFrameAvailable === 'function') {
    logger.warn(
      'encoders',
      'onFrameAvailable provided but mode is "batch" — streaming callback will be ignored',
      {
        mode,
      }
    );
  }
  const rgbFrames: DecodedFrame[] = streaming ? [] : []; // Only used in batch mode
  const pendingConversions: Promise<void>[] = [];

  // ── Backpressure for pendingConversions (RES-H2) ──
  // Limit the number of in-flight frame conversion promises to prevent
  // unbounded memory growth when decoding outpaces encoding.
  // The chunk-feeding loop checks this limit and waits for pending conversions
  // to drain before feeding more chunks to the decoder.
  const MAX_PENDING_CONVERSIONS = 10;

  let decodeError: Error | null = null;
  let inputFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;

  // ── Smart frame skip state ──
  const skipThreshold = getSkipThreshold(smartFrameSkip);
  let prevDHash: bigint | null = null;
  let consecutiveSkipMs = 0; // accumulated duration of skipped frames
  let smartSkippedCount = 0;
  // Noise floor estimation: collect frame diff stdDev from first N frames
  const noiseFloorSamples: number[] = [];
  const NOISE_SAMPLE_COUNT = 30;
  let noiseFloor = 0; // will be set after sampling phase

  // Check codec support (cached per codec+hw combo)
  const activeConfig = await resolveDecoderConfig(demux.config, hwAccel);

  logger.info('encoders', 'VideoDecoder configured', {
    codec: demux.config.codec,
    hwAccel: activeConfig.hardwareAcceleration,
    resolution: `${width}×${height}`,
    totalFrames: demux.totalFrames,
    frameDecimation,
    streaming,
  });

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      try {
        const frameDuration = getFrameDurationMs(frame);
        const frameNum = inputFrameCount++;

        // Frame decimation: skip every Nth frame
        if (frameDecimation > 1 && frameNum % frameDecimation !== 0) {
          accumulatedDuration += frameDuration;
          frame.close();
          skippedByDecimation++;
          return;
        }

        const totalDuration = frameDuration + accumulatedDuration;
        accumulatedDuration = 0;

        const conversion = (async () => {
          try {
            // Validate frame before attempting copy — frame may be invalid
            // if the decoder encountered an error or was flushed concurrently.
            if (!frame.codedWidth || !frame.codedHeight) {
              frame.close();
              return;
            }
            const rgbData = await copyFrameToRGB(frame, width, height);

            // ── Smart frame skip: similarity-based deduplication ──
            if (streaming && skipThreshold >= 0) {
              const dHash = computeDHash(rgbData, width, height);

              if (prevDHash !== null) {
                const dist = hammingDistance(prevDHash, dHash);

                // Noise floor estimation from first N frames
                if (noiseFloorSamples.length < NOISE_SAMPLE_COUNT) {
                  noiseFloorSamples.push(dist);
                  if (noiseFloorSamples.length === NOISE_SAMPLE_COUNT) {
                    // Use median as noise floor, scaled by factor k=3.5
                    const sorted = [...noiseFloorSamples].sort((a, b) => a - b);
                    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
                    noiseFloor = median * 3.5;
                  }
                }

                // Skip if similar AND consecutive skip time < 100ms
                const effectiveThreshold = Math.max(skipThreshold, Math.floor(noiseFloor));
                if (dist <= effectiveThreshold && consecutiveSkipMs < 100) {
                  // Skip this frame: accumulate duration, release buffer, return
                  consecutiveSkipMs += totalDuration;
                  smartSkippedCount++;
                  globalBufferPool.release(rgbData);
                  return;
                }
              }

              prevDHash = dHash;
              // Reset consecutive skip counter on kept frame
              consecutiveSkipMs = 0;
            }

            if (streaming) {
              // Streaming mode: pass frame to callback for immediate processing
              await onFrameAvailable!(rgbData, totalDuration, frameNum);
              // Note: onFrameAvailable is responsible for releasing rgbData
            } else {
              // Batch mode: collect into array (existing behavior for WebP)
              rgbFrames.push({ data: rgbData, duration: totalDuration });
            }

            // Report decoding progress — throttle to every 10 frames.
            // The modulo check has negligible overhead (~1ns per frame) and
            // avoids excessive callback invocations that would flood the
            // progress store and trigger unnecessary SolidJS re-renders.
            // At 60fps source, this fires ~6 times/second — smooth enough
            // for the UI progress bar without overwhelming the reactive system.
            if (
              onFrameDecoded &&
              (streaming
                ? inputFrameCount % 10 === 0
                : rgbFrames.length % 10 === 0 || rgbFrames.length === 1)
            ) {
              onFrameDecoded(streaming ? inputFrameCount : rgbFrames.length, demux.totalFrames);
            }
          } finally {
            frame.close();
          }
        })();

        // Track pending conversion for backpressure and final flush.
        pendingConversions.push(conversion);
      } catch (err) {
        // Ensure frame is always closed if error occurs before async IIFE
        frame.close();
        throw err;
      }
    },
    error(e: Error) {
      logger.error('encoders', 'VideoDecoder error', {
        codec: demux.config.codec,
        error: e.message,
      });
      decodeError = e;
    },
  });

  decoder.configure(activeConfig);

  try {
    // Feed all chunks with backpressure — prevent decode queue from growing unbounded.
    // VideoDecoder internally queues decoded frames; if we feed chunks faster than
    // they can be decoded, memory grows and GC pressure increases.
    // We pause when queue size exceeds a threshold and resume when it drains.
    const MAX_DECODE_QUEUE = 8;
    const chunks = demux.chunks;
    let chunkIdx = 0;

    while (chunkIdx < chunks.length) {
      if (signal?.aborted) {
        throw new DOMException('Cancelled', 'AbortError');
      }
      if (decodeError) break;

      // Backpressure: wait if decode queue is full.
      // Use requestAnimationFrame + setTimeout(0) to yield to the browser's
      // rendering loop, avoiding busy-wait CPU usage from setTimeout(1).
      while (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !signal?.aborted && !decodeError) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }

      // Backpressure on output processing (RES-H2): wait if too many
      // frame conversion promises are in flight. This prevents unbounded
      // memory growth when decoded frames accumulate faster than they
      // can be processed (e.g., copyToRGB + encoding).
      if (pendingConversions.length >= MAX_PENDING_CONVERSIONS) {
        await Promise.race(pendingConversions);
      }

      if (signal?.aborted) {
        throw new DOMException('Cancelled', 'AbortError');
      }
      if (decodeError) break;

      decoder.decode(chunks[chunkIdx]!);
      chunkIdx++;
    }

    // Flush decoder
    try {
      await decoder.flush();
    } catch (e) {
      if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
    }
    // Always await pending conversions before closing decoder to avoid VideoFrame leak
    await Promise.all(pendingConversions);

    if (decodeError) throw decodeError;

    // Add any remaining accumulated duration to the last frame (batch mode only)
    if (!streaming && accumulatedDuration > 0 && rgbFrames.length > 0) {
      const last = rgbFrames[rgbFrames.length - 1];
      if (last) last.duration += accumulatedDuration;
    }

    // Compute timing summary
    const sourceTotalMs = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;
    // Streaming mode: encoder handles frame timing internally, so outputTotalMs is not
    // tracked here. GIF/WebP encoders compute their own timing from frame durations.
    // Non-streaming: sum of all RGB frame durations.
    const outputTotalMs = streaming ? 0 : rgbFrames.reduce((sum, f) => sum + f.duration, 0);

    logger.info('encoders', 'Decoding complete', {
      totalInputFrames: inputFrameCount,
      outputFrames: streaming ? inputFrameCount - skippedByDecimation : rgbFrames.length,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      smartSkipMode: smartFrameSkip,
      noiseFloor: Math.round(noiseFloor * 100) / 100,
      resolution: `${width}×${height}`,
      streaming,
    });

    return {
      frames: rgbFrames,
      totalInputFrames: inputFrameCount,
      skippedByDecimation,
      sourceTotalMs,
      outputTotalMs,
    };
  } finally {
    // Close decoder only after all pending frames have been processed.
    // This guarantees VideoDecoder resources are released even if an error
    // occurs during decode (decodeError path) or cancellation (abort signal).
    decoder.close();
  }
}

// ─── Codec support cache ──────────────────────────────────────────
// isConfigSupported() is synchronous in some browsers but the spec says
// it returns a Promise. Cache results to avoid redundant calls when
// multiple conversions use the same codec.

interface CachedConfig {
  config: VideoDecoderConfig;
  hwSupported: boolean;
}

const CONFIG_CACHE_MAX_SIZE = 20;
const configCache = new Map<string, CachedConfig>();

function configCacheKey(cfg: VideoDecoderConfig): string {
  return `${cfg.codec}-${cfg.codedWidth}x${cfg.codedHeight}-${cfg.hardwareAcceleration ?? 'default'}`;
}

/**
 * LRU-evicting set for configCache.
 * Map iteration order is insertion order in JS, so deleting + re-inserting
 * an existing key moves it to the end (most-recently-used).
 */
function cacheSet(key: string, value: CachedConfig): void {
  if (configCache.has(key)) {
    configCache.delete(key);
  } else if (configCache.size >= CONFIG_CACHE_MAX_SIZE) {
    // Evict the oldest (first) entry
    const oldestKey = configCache.keys().next().value;
    if (oldestKey !== undefined) {
      configCache.delete(oldestKey);
    }
  }
  configCache.set(key, value);
}

async function resolveDecoderConfig(
  baseConfig: VideoDecoderConfig,
  hwAccel: 'prefer-hardware' | 'prefer-software'
): Promise<VideoDecoderConfig> {
  const key = configCacheKey(baseConfig);
  const cached = configCache.get(key);

  if (!cached) {
    const support = await VideoDecoder.isConfigSupported(baseConfig);
    if (!support.supported) {
      throw new Error(`Unsupported codec configuration: ${baseConfig.codec}`);
    }
    // Check HW support with a HW-specific config
    const hwConfig = { ...baseConfig, hardwareAcceleration: 'prefer-hardware' as const };
    const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
    cacheSet(key, { config: baseConfig, hwSupported: hwSupport.supported === true });
  } else {
    // Move to most-recently-used position
    cacheSet(key, cached);
  }

  const finalCached = configCache.get(key)!;
  if (hwAccel === 'prefer-hardware' && finalCached.hwSupported) {
    return { ...baseConfig, hardwareAcceleration: 'prefer-hardware' };
  }
  return { ...baseConfig, hardwareAcceleration: 'prefer-software' };
}
