// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Animated AVIF encoder service.
 *
 * The Emscripten binding is deliberately stateful: each decoded RGB frame is
 * copied into libavif and released before the next frame is decoded. This
 * avoids retaining the complete frame sequence in JavaScript memory.
 */

import type { ProgressCallback } from '@t/conversion-types';
import {
  AVIF_REPETITION_COUNT,
  AVIF_SPEED,
  assertAvifEncodeResolution,
  avifQualityFor,
  durationToAvifTimescale,
} from './avif-format';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';

export interface AvifWasmEncoder {
  addFrame(frame: Uint8Array, durationInTimescales: number): void;
  finish(): Uint8Array;
  delete?: (() => void) | undefined;
}

export interface AvifWasmModule {
  AvifAnimationEncoder: new (
    width: number,
    height: number,
    channels: number,
    quality: number,
    speed: number,
    repetitionCount: number
  ) => AvifWasmEncoder;
}

export interface AvifAnimationEncoderOptions {
  width: number;
  height: number;
  quality: BaseEncoderOptions['quality'];
}

export interface AvifAnimationEncoder {
  addFrame(frame: Uint8Array, durationMs: number): void;
  finish(): Uint8Array;
  dispose(): void;
}

export type AvifWasmModuleFactory = () => Promise<AvifWasmModule>;

interface PendingAvifFrame {
  data: Uint8Array;
  durationMs: number;
}

const AVIF_ENCODER_SCRIPT_URL = `${import.meta.env.BASE_URL}wasm/avif-encoder.js`;

async function loadAvifWasmModule(): Promise<AvifWasmModule> {
  const imported = (await import(/* @vite-ignore */ AVIF_ENCODER_SCRIPT_URL)) as {
    default: (options?: { locateFile?: (path: string) => string }) => Promise<AvifWasmModule>;
  };
  const scriptUrl = new URL(
    AVIF_ENCODER_SCRIPT_URL,
    globalThis.location?.href ?? 'http://localhost/'
  );
  return imported.default({ locateFile: (path) => new URL(path, scriptUrl).href });
}

/** Create one stateful encoder instance for a conversion run. */
export async function createAvifAnimationEncoder(
  options: AvifAnimationEncoderOptions,
  moduleFactory: AvifWasmModuleFactory = loadAvifWasmModule
): Promise<AvifAnimationEncoder> {
  const module = await moduleFactory();
  const wasmEncoder = new module.AvifAnimationEncoder(
    options.width,
    options.height,
    3,
    avifQualityFor(options.quality),
    AVIF_SPEED,
    AVIF_REPETITION_COUNT
  );
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    wasmEncoder.delete?.();
  };

  return {
    addFrame(frame, durationMs) {
      if (disposed) throw new Error('AVIF encoder is already finalized');
      wasmEncoder.addFrame(frame, durationToAvifTimescale(durationMs));
    },
    finish() {
      if (disposed) throw new Error('AVIF encoder is already finalized');
      try {
        const output = wasmEncoder.finish();
        dispose();
        return output;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    dispose,
  };
}

/** Encode a demuxed video stream to animated AVIF without accumulating frames. */
export async function encodeAvif(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const width = Math.max(1, Math.floor(opts.width * opts.scale));
  const height = Math.max(1, Math.floor(opts.height * opts.scale));
  assertAvifEncodeResolution(width, height);
  const frameDecimation = opts.frameDecimation ?? 1;
  const encoder = await createAvifAnimationEncoder({
    width,
    height,
    quality: opts.quality,
  });
  const decimationController = createDynamicDecimationController();
  let pendingFrame: PendingAvifFrame | null = null;
  let accumulatedDurationMs = 0;
  let encodedFrames = 0;
  let frameProcessingChain = Promise.resolve();
  let frameProcessingError: unknown = null;

  const releasePendingFrame = (): void => {
    if (!pendingFrame) return;
    globalBufferPool.release(pendingFrame.data);
    pendingFrame = null;
  };

  try {
    const decodeResult = await decodeFrames(
      demux,
      {
        width,
        height,
        frameDecimation,
        hwAccel: 'prefer-hardware',
        smartFrameSkip: opts.smartFrameSkip,
        onFrameDecoded: opts.onFrameDecoded,
        onFrameAvailable: (rgbData, frameDurationMs, frameNum) => {
          // VideoDecoder may have several asynchronous frame conversions in flight.
          // libavif's sequence encoder is stateful, so enqueue the complete frame
          // handoff to preserve presentation order and bound WASM ownership.
          const processFrame = frameProcessingChain.then(() => {
            if (frameProcessingError) {
              globalBufferPool.release(rgbData);
              return;
            }

            if (signal?.aborted) {
              globalBufferPool.release(rgbData);
              throw new DOMException('Cancelled', 'AbortError');
            }

            if (decimationController.shouldSkip(frameNum)) {
              accumulatedDurationMs += frameDurationMs;
              globalBufferPool.release(rgbData);
              return;
            }

            const durationMs = frameDurationMs + accumulatedDurationMs;
            accumulatedDurationMs = 0;

            if (pendingFrame) {
              try {
                encoder.addFrame(pendingFrame.data, pendingFrame.durationMs);
                encodedFrames++;
              } finally {
                releasePendingFrame();
              }
            }
            pendingFrame = { data: rgbData, durationMs };

            onProgress?.({
              phase: 'encoding',
              progress: Math.min(
                93,
                73 + Math.round((encodedFrames / Math.max(1, demux.totalFrames)) * 20)
              ),
              fps: 0,
              etaSeconds: null,
              memoryMB: 0,
              currentFrame: encodedFrames,
              totalFrames: demux.totalFrames,
            });
          });

          frameProcessingChain = processFrame.catch((error: unknown) => {
            frameProcessingError ??= error;
          });
          return processFrame;
        },
      },
      signal
    );

    const lastFrame = pendingFrame as PendingAvifFrame | null;
    if (!lastFrame) throw new Error('No frames decoded for AVIF encoding');
    lastFrame.durationMs += decodeResult.tailAccumulatedMs + accumulatedDurationMs;
    try {
      encoder.addFrame(lastFrame.data, lastFrame.durationMs);
      encodedFrames++;
    } finally {
      globalBufferPool.release(lastFrame.data);
      pendingFrame = null;
    }

    const output = encoder.finish();
    if (output.byteLength === 0) throw new Error('AVIF encoder produced an empty output');
    return output;
  } catch (error) {
    releasePendingFrame();
    encoder.dispose();
    throw error;
  }
}
