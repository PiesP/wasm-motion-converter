// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Conversion Orchestrator
 *
 * Top-level conversion lifecycle manager.
 * Coordinates WebCodecs (GPU) and FFmpeg (CPU) conversion paths.
 */

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import {
  cleanup as cleanupWebCodecs,
  convert as webcodecsConvert,
} from '@services/webcodecs-conversion-service';
import type {
  ConversionFormat,
  ConversionMetadata,
  ConversionOutputBlob,
  ConversionQuality,
  ConversionRequest,
  ConversionResponse,
  VideoMetadata,
} from '@t/conversion-types';
import {
  CANCELLED_MESSAGE,
  isCancellationError,
  throwIfAborted,
} from '@utils/cancellation-context';
import { isSupportedFormat } from '@utils/codec-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { getAvailableMemory } from '@utils/memory-monitor';
import { performanceTracker } from '@utils/performance-tracker';
import { selectSimplePath } from './simple-path-planner-service';

const STATUS_INITIALIZING = 'Initializing conversion...';
const STATUS_COMPLETE = 'Complete';
const STATUS_CANCELLED = 'Cancelled by user';
const STATUS_ERROR = 'Error';

/**
 * Estimate peak memory needed for a conversion.
 *
 * Accounts for:
 * - Frame storage: width × height × 4 bytes × estimated frame count
 * - Encoding overhead: ~1.5× frame data for palette + output assembly
 * - VFS overhead (FFmpeg path): input file + output file in WASM heap
 *
 * @param metadata - Video metadata (width, height, duration, framerate)
 * @param format - Output format
 * @param quality - Quality preset
 * @returns Estimated peak memory in bytes
 */
function estimateRequiredMemory(
  metadata: { width?: number; height?: number; duration?: number; framerate?: number } | undefined,
  _format: ConversionFormat,
  quality: 'low' | 'medium' | 'high'
): number {
  const width = metadata?.width ?? 1920;
  const height = metadata?.height ?? 1080;
  const duration = metadata?.duration ?? 10;
  const fps = Math.min(
    metadata?.framerate ?? 30,
    quality === 'low' ? 10 : quality === 'medium' ? 15 : 20
  );
  const frameCount = Math.ceil(duration * fps);
  const frameBytes = width * height * 4;

  // Single raw buffer for all frames (streaming, no intermediate files)
  const rawBuffer = frameCount * frameBytes;

  // FFmpeg encoding overhead: ~1x for palette/output assembly
  const encodingOverhead = rawBuffer;

  return Math.ceil(rawBuffer + encodingOverhead);
}

function getSupportedFormat(request: ConversionRequest): ConversionFormat {
  if (isSupportedFormat(request.format)) {
    return request.format;
  }
  throw new Error(`Unsupported format: ${request.format}`);
}

interface ActiveOperation {
  id: string;
  abortController: AbortController;
}

let activeOperation: ActiveOperation | null = null;
let operationCounter = 0;

function createOperation(): ActiveOperation {
  const id = `op-${++operationCounter}`;
  const abortController = new AbortController();
  const op: ActiveOperation = { id, abortController };
  activeOperation = op;
  return op;
}

function clearOperation(id: string): void {
  if (activeOperation?.id === id) {
    activeOperation = null;
  }
}

function abortActiveOperation(): void {
  if (activeOperation) {
    activeOperation.abortController.abort();
    activeOperation = null;
  }
}

export async function convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
  // Cancel any stale operation from a previous call that didn't clean up
  abortActiveOperation();

  const operation = createOperation();
  const startedAt = performance.now();

  // Reset performance tracker for this conversion session
  performanceTracker.reset();

  request.onProgress?.(0);
  request.onStatus?.(STATUS_INITIALIZING);

  try {
    // Pre-conversion memory check: estimate if we have enough heap space
    // to hold all decoded frames + encoding overhead without crashing.
    const requiredBytes = estimateRequiredMemory(
      request.metadata,
      request.format,
      request.options.quality
    );
    const availableBytes = getAvailableMemory();

    const MEMORY_HEADROOM_RATIO = 0.8; // 20% headroom for GC and other operations

    if (requiredBytes > availableBytes * MEMORY_HEADROOM_RATIO) {
      logger.warn('conversion', 'Pre-conversion memory check failed', {
        requiredMB: Math.round(requiredBytes / 1024 / 1024),
        availableMB: Math.round(availableBytes / 1024 / 1024),
        width: request.metadata?.width,
        height: request.metadata?.height,
        duration: request.metadata?.duration,
        format: request.format,
        quality: request.options.quality,
      });
      throw new Error(
        `Insufficient memory for conversion. Need ~${Math.round(requiredBytes / 1024 / 1024)}MB ` +
          `but only ~${Math.round(availableBytes / 1024 / 1024)}MB available. ` +
          'Try reducing quality, scale, or trim duration.'
      );
    }

    const selection = await selectSimplePath({
      file: request.file,
      format: request.format,
      metadata: request.metadata,
      abortSignal: operation.abortController.signal,
    });

    if (activeOperation?.id !== operation.id) {
      throw new Error(CANCELLED_MESSAGE);
    }
    throwIfAborted(operation.abortController.signal);

    let blob: Awaited<ConversionResponse['blob']>;
    switch (selection.path) {
      case 'software':
        blob = await convertWithSoftwareDecode(request, operation.abortController.signal);
        break;
      case 'gpu':
        blob = await convertWithGpuFallback(request, operation.abortController.signal);
        break;
      default:
        blob = await convertWithCpu(request, operation.abortController.signal);
        break;
    }

    if (activeOperation?.id !== operation.id) {
      throw new Error(CANCELLED_MESSAGE);
    }
    throwIfAborted(operation.abortController.signal);

    const metadata: ConversionMetadata = {
      path: selection.path,
      encoder:
        blob.encoderBackendUsed ??
        (selection.path === 'gpu' ? 'ffmpeg-rawvideo-streaming' : 'ffmpeg'),
      conversionTimeMs: performance.now() - startedAt,
      wasTranscoded: blob.wasTranscoded,
      originalCodec: request.metadata?.codec,
    };

    request.onStatus?.(STATUS_COMPLETE);
    request.onProgress?.(100);

    logger.info('conversion', 'Conversion completed', {
      format: request.format,
      path: selection.path,
      reason: selection.reason,
      codec: request.metadata?.codec,
      encoder: metadata.encoder,
    });

    return { blob, metadata };
  } catch (error) {
    if (operation.abortController.signal.aborted || isCancellationError(error)) {
      request.onStatus?.(STATUS_CANCELLED);
      throw new Error(CANCELLED_MESSAGE);
    }

    request.onStatus?.(STATUS_ERROR);

    logger.error('conversion', 'Conversion failed', {
      format: request.format,
      codec: request.metadata?.codec,
      error: getErrorMessage(error),
    });

    throw error;
  } finally {
    clearOperation(operation.id);
  }
}

export function cancelConversion(): void {
  abortActiveOperation();
  ffmpegService.cancelConversion();
  cleanupWebCodecs();
}

async function convertWithGpuFallback(
  request: ConversionRequest,
  abortSignal: AbortSignal
): Promise<Awaited<ConversionResponse['blob']>> {
  const format = getSupportedFormat(request);

  try {
    return await webcodecsConvert(
      request.file,
      format,
      request.options,
      request.metadata,
      abortSignal
    );
  } catch (error) {
    if (abortSignal.aborted || isCancellationError(error)) {
      throw error;
    }

    logger.warn('conversion', 'GPU path failed, falling back to FFmpeg', {
      format: request.format,
      codec: request.metadata?.codec,
      error: getErrorMessage(error),
    });

    // Forward the abort signal so cancellation during fallback is honored
    return convertWithCpu(request, abortSignal);
  }
}

async function convertWithCpu(
  request: ConversionRequest,
  abortSignal?: AbortSignal
): Promise<Awaited<ConversionResponse['blob']>> {
  if (abortSignal) throwIfAborted(abortSignal);
  const format = getSupportedFormat(request);

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  if (format === 'gif') {
    return ffmpegService.convertToGIF(
      request.file,
      request.options,
      request.metadata,
      undefined,
      undefined,
      abortSignal
    );
  }

  if (format === 'webp') {
    return ffmpegService.convertToWebP(
      request.file,
      request.options,
      request.metadata,
      undefined,
      undefined,
      abortSignal
    );
  }

  throw new Error(`Unsupported format: ${format}`);
}

async function convertWithSoftwareDecode(
  request: ConversionRequest,
  abortSignal: AbortSignal
): Promise<Awaited<ConversionResponse['blob']>> {
  if (abortSignal) throwIfAborted(abortSignal);
  const format = getSupportedFormat(request);

  logger.info('conversion', 'Software decode path: browser decode → FFmpeg encode', {
    codec: request.metadata?.codec,
    format,
  });

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  // Use <video> + Canvas to decode frames, then encode via FFmpeg
  const frameFiles = await decodeFramesToVFS(
    request.file,
    request.metadata,
    request.options.quality,
    request.format,
    abortSignal
  );

  if (abortSignal) throwIfAborted(abortSignal);

  const blob = await ffmpegService.encodeFrameSequence(
    {
      format,
      options: request.options,
      frameCount: frameFiles.length,
      fps: Math.min(
        request.metadata?.framerate ?? 30,
        request.options.quality === 'low' ? 10 : request.options.quality === 'medium' ? 15 : 20
      ),
      durationSeconds: request.metadata?.duration ?? 10,
      frameFiles,
      frameInput: { kind: 'image-sequence', frameFiles },
    },
    {
      onProgress: request.onProgress,
      onStatusUpdate: request.onStatus,
      shouldCancel: () => abortSignal.aborted,
    }
  );

  const typed = blob as ConversionOutputBlob;
  typed.encoderBackendUsed = 'software-decode+ffmpeg';
  typed.wasTranscoded = true;
  typed.originalCodec = request.metadata?.codec;

  return typed;
}

/**
 * Decode video frames using <video> + Canvas pipeline.
 * Works for any codec the browser can decode (including AV1).
 */
async function decodeFramesToVFS(
  file: File,
  metadata: VideoMetadata | undefined,
  quality: ConversionQuality,
  format: ConversionFormat,
  abortSignal: AbortSignal
): Promise<string[]> {
  // Create hidden video element
  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not get canvas 2D context');
  }

  const width = metadata?.width ?? 1920;
  const height = metadata?.height ?? 1080;
  canvas.width = width;
  canvas.height = height;

  // Wait for video metadata and first frame
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    video.onloadeddata = () => settle(resolve);
    video.onerror = () =>
      settle(() => reject(new Error('Failed to load video for software decode')));
    setTimeout(
      () => settle(() => reject(new Error('Video load timeout (software decode)'))),
      10_000
    );
    video.load();
  });

  const fps = Math.min(
    metadata?.framerate ?? 30,
    quality === 'low' ? 10 : quality === 'medium' ? 15 : 20
  );
  const duration = metadata?.duration ?? (video.duration || 10);
  const frameCount = Math.ceil(duration * fps);
  const frameFiles: string[] = [];

  ffmpegService.beginExternalConversion(metadata, quality, format, {
    enableLogSilenceCheck: false,
  });

  try {
    for (let i = 0; i < frameCount; i++) {
      if (abortSignal.aborted) {
        throw new Error('Conversion cancelled by user');
      }

      const time = i / fps;
      if (time >= video.duration) break;

      // Seek to frame time
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        video.onseeked = () => settle(resolve);
        video.onerror = () => settle(() => reject(new Error(`Seek failed at ${time.toFixed(2)}s`)));
        setTimeout(
          () => settle(() => reject(new Error(`Seek timeout at ${time.toFixed(2)}s`))),
          5_000
        );
        video.currentTime = time;
      });

      // Draw frame to canvas
      ctx.drawImage(video, 0, 0, width, height);

      // Get PNG data
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error('Canvas toBlob failed'));
          },
          'image/png',
          0.92
        );
      });

      const arrayBuffer = await blob.arrayBuffer();
      const fileName = `frame_${i.toString().padStart(6, '0')}.png`;

      await ffmpegService.writeVirtualFile(fileName, new Uint8Array(arrayBuffer));
      frameFiles.push(fileName);

      // Report progress (decode phase = 0-50%)
      const progress = Math.round((i / frameCount) * 50);
      ffmpegService.reportProgress(progress);
    }
  } finally {
    ffmpegService.endExternalConversion();
    URL.revokeObjectURL(video.src);
  }

  return frameFiles;
}
