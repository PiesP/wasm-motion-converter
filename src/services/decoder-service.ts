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
  createFrameProcessingContext,
  type FrameProcessingContext,
  getFrameDurationMs,
  getSkipThreshold,
  hammingDistance,
} from './frame-utils';
import { decodeFramesParallel } from './parallel-decoder';

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
   * GPU-only callback: passes raw VideoFrame to encoder without reading
   * pixels into JS memory. Used by VP8 VideoEncoder path for zero-copy
   * GPU encoding. When provided, smart frame skip and adaptive mode are
   * disabled (dHash requires RGB pixel data).
   * The caller OWNS the VideoFrame and MUST call frame.close().
   */
  onVideoFrameAvailable?: (
    frame: VideoFrame,
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
  /**
   * Remaining accumulated duration after the last kept frame.
   * Only meaningful in streaming mode — batch mode already adds
   * this to the last frame (see !streaming branch below).
   * In streaming mode, frames skipped after the last kept frame
   * have their durations accumulated but never consumed, causing
   * the output to play faster than the source. Encoders should
   * add this tail duration to the output (e.g., as extra delay
   * on the last frame).
   */
  tailAccumulatedMs: number;
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
    onVideoFrameAvailable,
    mode,
    smartFrameSkip: effectiveSmartSkip = 'off',
  } = opts;

  // ── Smart frame skip state (must be before parallel decode block) ──
  const skipThreshold = getSkipThreshold(effectiveSmartSkip);

  // Determine streaming mode: explicit 'stream' mode or infer from callback
  const streaming =
    mode === 'stream' ||
    (mode !== 'batch' &&
      (typeof onFrameAvailable === 'function' || typeof onVideoFrameAvailable === 'function'));

  // Warn if onFrameAvailable is provided but mode is explicitly 'batch'
  if (mode === 'batch' && typeof onFrameAvailable === 'function') {
    logger.warn(
      'decoders',
      'onFrameAvailable provided but mode is "batch" — streaming callback will be ignored',
      {
        mode,
      }
    );
  }
  const rgbFrames: DecodedFrame[] = streaming ? [] : []; // Only used in batch mode
  const pendingConversions: Promise<void>[] = [];

  // ── Attempt parallel decode via keyframe-segmented multi-decoder ──
  // Parallel decode splits the video at keyframe boundaries and decodes
  // segments concurrently, cutting the dominant decode phase (~70% of
  // total time) by up to 4x. Falls back to sequential decode if the
  // video has insufficient keyframes or if any segment fails.
  //
  // Only enabled for streaming callbacks (not GPU-only VideoFrame paths
  // which need raw VideoFrames, not RGB data). Smart frame skip and
  // adaptive mode are incompatible with parallel decode (per-frame
  // dHash comparison runs inside the sequential output handler).
  if (
    streaming &&
    typeof onFrameAvailable === 'function' &&
    effectiveSmartSkip === 'off' &&
    skipThreshold !== -2 // not adaptive mode
  ) {
    try {
      const parallelResult = await decodeFramesParallel(demux, { width, height, hwAccel }, signal);

      // Feed pre-decoded frames through streaming callback with decimation
      let frameIdx = 0;
      let decodeAccumulated = 0;
      let decimSkipped = 0;

      for (const frame of parallelResult.frames) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        // Apply frame decimation (same logic as sequential path)
        const globalIdx = frame.globalIndex;
        if (frameDecimation > 1 && globalIdx % frameDecimation !== 0) {
          decodeAccumulated += frame.durationMs;
          decimSkipped++;
          globalBufferPool.release(frame.data);
          continue;
        }

        const totalDur = frame.durationMs + decodeAccumulated;
        decodeAccumulated = 0;

        await onFrameAvailable(frame.data, totalDur, globalIdx);
        frameIdx++;

        if (onFrameDecoded && frameIdx % 10 === 0) {
          onFrameDecoded(frameIdx, demux.totalFrames);
        }
      }

      logger.warn('decoders', 'Parallel decode complete (integrated)', {
        frames: parallelResult.frames.length,
        kept: frameIdx,
        skippedByDecimation: decimSkipped,
        totalInput: parallelResult.totalInputFrames,
      });

      return {
        frames: [],
        totalInputFrames: parallelResult.totalInputFrames,
        skippedByDecimation: decimSkipped,
        sourceTotalMs: parallelResult.sourceTotalMs,
        outputTotalMs: 0,
        tailAccumulatedMs: 0,
      };
    } catch (err) {
      logger.warn('decoders', 'Parallel decode failed, falling back to sequential', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to sequential decode below
    }
  }

  // ── Smart frame skip state (continued) ──
  const isAdaptive = skipThreshold === -2;
  let prevDHash: bigint | null = null;
  let consecutiveSkipMs = 0; // accumulated duration of skipped frames

  // ── Backpressure for pendingConversions (RES-H2) ──
  const MAX_PENDING_CONVERSIONS = 10;

  let decodeError: Error | null = null;
  let inputFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;
  let smartSkippedCount = 0;
  // Noise floor estimation: collect frame diff stdDev from first N frames
  const noiseFloorSamples: number[] = [];
  const NOISE_SAMPLE_COUNT = 15; // reduced from 30 → faster adaptation for short videos
  let noiseFloor = 0; // will be set after sampling phase

  // ── Adaptive motion-classified decimation state ──
  // Running window of motion distances for scene analysis
  let adaptFrameCounter = 0;
  // Motion class thresholds (hamming distance)
  const ADAPT_STATIC_THRESHOLD = 1; // ≤1 → static (very similar)
  const ADAPT_SLOW_THRESHOLD = 3; // ≤3 → slow motion
  const ADAPT_NORMAL_THRESHOLD = 6; // ≤6 → normal motion (>6 → fast)
  // Decimation per motion class
  const ADAPT_DECIMATION = {
    static: 8, // keep every 8th frame (≈7.5fps from 60fps)
    slow: 3, // keep every 3rd frame (≈20fps from 60fps)
    normal: 2, // keep every 2nd frame (≈30fps from 60fps)
    fast: 1, // keep every frame
  };
  let adaptLastMotionClass: 'static' | 'slow' | 'normal' | 'fast' = 'normal';

  // Check codec support (cached per codec+hw combo)
  const activeConfig = await resolveDecoderConfig(demux.config, hwAccel);

  // Create per-conversion frame processing context (duration carry + copy path cache)
  const frameCtx: FrameProcessingContext = createFrameProcessingContext();

  logger.info('decoders', 'VideoDecoder configured', {
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
        const frameDuration = getFrameDurationMs(frame, frameCtx);
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

        // Carry-over from smart frame skip: when consecutive similar frames
        // are skipped, their durations are accumulated in consecutiveSkipMs.
        // When a frame is finally kept, those accumulated durations must be
        // added to totalDuration to preserve total playback time.
        // Without this, smart-skipped frame durations are permanently lost.
        let smartCarryoverMs = 0;

        const conversion = (async () => {
          try {
            // Validate frame before attempting copy — frame may be invalid
            // if the decoder encountered an error or was flushed concurrently.
            if (!frame.codedWidth || !frame.codedHeight) {
              frame.close();
              return;
            }

            // ── GPU-only path: pass VideoFrame directly to encoder ──
            // Skips copyFrameToRGB (GPU→CPU read) and all dHash-based processing.
            // Used by VP8 VideoEncoder path for zero-copy GPU encoding.
            // Smart frame skip and adaptive mode are disabled (require RGB data).
            if (typeof onVideoFrameAvailable === 'function') {
              // Transfer accumulated frame durations (decimation + smart skip carryover)
              const totalDur = totalDuration + smartCarryoverMs;
              smartCarryoverMs = 0;
              await onVideoFrameAvailable(frame, totalDur, frameNum);
              // Caller owns frame and MUST call frame.close()
              return;
            }

            const rgbData = await copyFrameToRGB(frame, width, height, frameCtx);

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
                    // Create a sorted copy to avoid mutating the source array
                    const sorted = [...noiseFloorSamples].sort((a, b) => a - b);
                    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
                    noiseFloor = median * 3.5;
                  }
                }

                // Skip if similar AND consecutive skip time < 500ms
                const effectiveThreshold = Math.max(skipThreshold, Math.floor(noiseFloor));
                if (dist <= effectiveThreshold && consecutiveSkipMs < 500) {
                  // Skip this frame: accumulate duration, release buffer, return
                  consecutiveSkipMs += totalDuration;
                  smartSkippedCount++;
                  globalBufferPool.release(rgbData);
                  return;
                }
              }

              prevDHash = dHash;
              // Transfer accumulated consecutive skip durations to this frame
              smartCarryoverMs = consecutiveSkipMs;
              consecutiveSkipMs = 0;
            }

            // ── Adaptive motion-classified decimation ──
            // Instead of fixed decimation, classify each frame's motion level
            // and apply variable decimation: static scenes get aggressive skip,
            // fast motion keeps all frames. Integrated with dHash already computed
            // above (reuses prevDHash/dist when available from smart skip).
            //
            // NOTE: This block is NEVER entered when onVideoFrameAvailable is active
            // (GPU-only path) because that path skips copyFrameToRGB entirely, meaning
            // no rgbData/dHash/hammingDistance is available. See the GPU-only check at
            // ~line 313.
            //
            // NOTE: The first frame is always classified as adaptLastMotionClass
            // (initially 'normal') because prevDHash is null until at least two frames
            // have been processed. This initial misclassification is expected and has
            // negligible impact — only one frame's decimation is affected.
            if (streaming && isAdaptive) {
              let motionClass: 'static' | 'slow' | 'normal' | 'fast' = adaptLastMotionClass;

              if (prevDHash !== null && noiseFloorSamples.length >= NOISE_SAMPLE_COUNT) {
                // Re-compute dHash if smart skip didn't do it (threshold=-2 path)
                const dHash = computeDHash(rgbData, width, height);
                const dist = prevDHash !== null ? hammingDistance(prevDHash, dHash) : 0;

                // Classify motion level using noise-floor-adapted thresholds.
                // Lower-noise videos get tighter thresholds (more aggressive skip),
                // noisier videos get wider thresholds (conservative skip).
                const effectiveStatic = Math.max(
                  ADAPT_STATIC_THRESHOLD,
                  Math.floor(noiseFloor / 3.5) // undo 3.5x scaling for raw threshold
                );
                const effectiveSlow = Math.max(ADAPT_SLOW_THRESHOLD, Math.floor(noiseFloor / 1.8));
                const effectiveNormal = Math.max(
                  ADAPT_NORMAL_THRESHOLD,
                  Math.floor(noiseFloor / 1.2)
                );
                if (dist <= effectiveStatic) {
                  motionClass = 'static';
                } else if (dist <= effectiveSlow) {
                  motionClass = 'slow';
                } else if (dist <= effectiveNormal) {
                  motionClass = 'normal';
                } else {
                  motionClass = 'fast';
                }

                // Scene change detection: if motion class jumps up, force keep
                const classOrder = { static: 0, slow: 1, normal: 2, fast: 3 } as const;
                if (classOrder[motionClass] > classOrder[adaptLastMotionClass] + 1) {
                  adaptFrameCounter = 0; // force keep on significant motion increase
                }
                adaptLastMotionClass = motionClass;
                prevDHash = dHash;
              }

              const decimation = ADAPT_DECIMATION[motionClass];
              const shouldSkip = adaptFrameCounter % decimation !== 0 && consecutiveSkipMs < 500; // 500ms safety limit

              adaptFrameCounter++;

              if (shouldSkip && motionClass !== 'fast') {
                consecutiveSkipMs += totalDuration;
                smartSkippedCount++;
                globalBufferPool.release(rgbData);
                return;
              }

              // Frame kept: reset counters, transfer accumulated duration
              smartCarryoverMs = consecutiveSkipMs;
              consecutiveSkipMs = 0;
            }

            if (streaming) {
              // Streaming mode: pass frame to callback for immediate processing.
              // Include smart-skip carryover to preserve total playback time.
              await onFrameAvailable!(rgbData, totalDuration + smartCarryoverMs, frameNum);
              smartCarryoverMs = 0;
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
      logger.error('decoders', 'VideoDecoder error', {
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
      // Use setTimeout(0) as primary yield mechanism because
      // requestAnimationFrame pauses in background tabs, causing deadlock
      // when the decoder still queues frames but rAF never fires.
      while (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !signal?.aborted && !decodeError) {
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 0);
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
    // Always await pending conversions before closing decoder to avoid VideoFrame leak.
    // Use Promise.allSettled so that even if some conversions fail (e.g., due to abort),
    // we still drain all pending work and close frames properly.
    await Promise.allSettled(pendingConversions);

    if (decodeError) throw decodeError;

    // Add any remaining accumulated duration to the last frame (batch mode only)
    if (!streaming && accumulatedDuration > 0 && rgbFrames.length > 0) {
      const last = rgbFrames[rgbFrames.length - 1];
      if (last) last.duration += accumulatedDuration;
    }

    // Compute timing summary
    const sourceTotalMs = demux.sourceTotalMs;
    // Streaming mode: encoder handles frame timing internally, so outputTotalMs is not
    // tracked here. GIF/WebP encoders compute their own timing from frame durations.
    // Non-streaming: sum of all RGB frame durations.
    const outputTotalMs = streaming ? 0 : rgbFrames.reduce((sum, f) => sum + f.duration, 0);

    logger.info('decoders', 'Decoding complete', {
      totalInputFrames: inputFrameCount,
      outputFrames: streaming ? inputFrameCount - skippedByDecimation : rgbFrames.length,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      smartSkipMode: effectiveSmartSkip,
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
      tailAccumulatedMs: streaming ? accumulatedDuration : 0,
    };
  } finally {
    // Close decoder only after all pending frame conversions have settled.
    // This guarantees no VideoFrame is still being processed when the decoder
    // is closed, preventing \"close() called while a flush is in progress\"
    // and other VideoDecoder close races.
    await Promise.allSettled(pendingConversions);
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

/**
 * LRU-evicting cache for VideoDecoder config support checks.
 * Map iteration order is insertion order in JS, so deleting + re-inserting
 * an existing key moves it to the most-recently-used position.
 */
class LruConfigCache {
  private cache = new Map<string, CachedConfig>();

  get(key: string): CachedConfig | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to most-recently-used position
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  set(key: string, value: CachedConfig): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= CONFIG_CACHE_MAX_SIZE) {
      // Evict the oldest (first) entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.get(key) !== undefined;
  }
}

const configCache = new LruConfigCache();

function configCacheKey(cfg: VideoDecoderConfig): string {
  return `${cfg.codec}-${cfg.codedWidth}x${cfg.codedHeight}-${cfg.hardwareAcceleration ?? 'default'}`;
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
    configCache.set(key, { config: baseConfig, hwSupported: hwSupport.supported === true });
  }

  const finalCached = configCache.get(key)!;
  if (hwAccel === 'prefer-hardware' && finalCached.hwSupported) {
    return { ...baseConfig, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: false };
  }
  return { ...baseConfig, hardwareAcceleration: 'prefer-software', optimizeForLatency: false };
}
