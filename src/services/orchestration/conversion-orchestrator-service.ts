// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Conversion Orchestrator
 *
 * Top-level conversion lifecycle manager.
 * Coordinates WebCodecs (GPU) and FFmpeg (CPU) conversion paths.
 */

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import { cleanup as cleanupWebCodecs } from '@services/webcodecs-conversion-service';
import type {
  ConversionFormat,
  ConversionMetadata,
  ConversionQuality,
  ConversionRequest,
  ConversionResponse,
  VideoMetadata,
} from '@t/conversion-types';
import { createConversionOutputBlob } from '@t/conversion-types';
import {
  CANCELLED_MESSAGE,
  isCancellationError,
  throwIfAborted,
} from '@utils/cancellation-context';
import { isSupportedFormat } from '@utils/codec-utils';
import { getTargetFps } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { getAvailableMemory } from '@utils/memory-monitor';
import { performanceTracker } from '@utils/performance-tracker';
import { frameAssemblerService } from './frame-assembler-service';
import { frameExtractorService } from './frame-extractor-service';
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
 * In streaming mode, only the batch buffer is counted instead of the full frame buffer.
 *
 * @param metadata - Video metadata (width, height, duration, framerate)
 * @param format - Output format
 * @param quality - Quality preset
 * @param streaming - If true, estimate for streaming mode (batch buffer only)
 * @returns Estimated peak memory in bytes
 */
function estimateRequiredMemory(
  metadata: { width?: number; height?: number; duration?: number; framerate?: number } | undefined,
  _format: ConversionFormat,
  quality: 'low' | 'medium' | 'high',
  streaming = false
): number {
  const width = metadata?.width ?? 1920;
  const height = metadata?.height ?? 1080;
  const duration = metadata?.duration ?? 10;
  const fps = Math.min(metadata?.framerate ?? 30, getTargetFps(quality));
  const frameCount = Math.ceil(duration * fps);
  const frameBytes = width * height * 4;

  if (streaming) {
    // Streaming mode: only hold batch buffer (10 frames) + one pooled frame
    const BATCH_SIZE = 10;
    const batchBuffer = BATCH_SIZE * frameBytes;
    const pooledFrame = frameBytes; // one frame from pool
    const encodingOverhead = frameBytes * 2; // palette + output
    return Math.ceil(batchBuffer + pooledFrame + encodingOverhead);
  }

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
    // to hold decoded frames + encoding overhead without crashing.
    // Use streaming mode estimation when possible to reduce memory pressure.
    const requiredBytes = estimateRequiredMemory(
      request.metadata,
      request.format,
      request.options.quality,
      true // streaming mode: only batch buffer, not full frame buffer
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
      encoder: blob.encoderBackendUsed ?? 'ffmpeg',
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

  // Extract frames using the new FrameExtractorService
  const frameResult = await decodeFramesWithExtractor(
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
      frameCount: frameResult.frameCount,
      fps: Math.min(request.metadata?.framerate ?? 30, getTargetFps(request.options.quality)),
      durationSeconds: request.metadata?.duration ?? 10,
      frameFiles: [],
      frameInput: {
        kind: 'rawvideo',
        fileName: frameResult.fileName,
        width: frameResult.width,
        height: frameResult.height,
        pixelFormat: 'rgba',
      },
      progressOffset: 50, // software decode occupies 0-50%, encode occupies 50-100%
    },
    {
      onProgress: request.onProgress,
      onStatusUpdate: request.onStatus,
      shouldCancel: () => abortSignal.aborted,
    }
  );

  return createConversionOutputBlob(blob, {
    encoderBackendUsed: 'software-decode+ffmpeg',
    wasTranscoded: true,
    originalCodec: request.metadata?.codec,
  });
}

/**
 * Decode video frames using FrameExtractorService.
 * Uses createImageBitmap (GPU) when available, falls back to canvas.
 * Writes raw RGBA frames to FFmpeg VFS as rawvideo.
 */
async function decodeFramesWithExtractor(
  file: File,
  metadata: VideoMetadata | undefined,
  quality: ConversionQuality,
  format: ConversionFormat,
  abortSignal: AbortSignal
): Promise<{
  fileName: string;
  frameCount: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  const width = metadata?.width ?? 1920;
  const height = metadata?.height ?? 1080;

  // Wait for video to load
  const objectUrl = URL.createObjectURL(file);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
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
    timeoutId = setTimeout(
      () => settle(() => reject(new Error('Video load timeout (software decode)'))),
      10_000
    );
    // Set src AFTER handlers are attached to avoid race condition
    video.src = objectUrl;
  });

  throwIfAborted(abortSignal);

  const fps = Math.min(metadata?.framerate ?? 30, getTargetFps(quality));
  const duration = metadata?.duration ?? (video.duration || 10);
  const frameCount = Math.ceil(duration * fps);

  // Select best extraction strategy
  const strategy = await frameExtractorService.selectStrategy();
  logger.info('conversion', `Frame extraction strategy: ${strategy}`, {
    width,
    height,
    fps,
    frameCount,
  });

  ffmpegService.beginExternalConversion(metadata, quality, format, {
    enableLogSilenceCheck: false,
  });

  // Report initial progress so the UI shows 0% immediately
  ffmpegService.reportProgress(0);
  ffmpegService.reportStatus('Extracting frames...');

  const outputFileName = 'raw_frames.raw';

  try {
    // Extract all frames using streaming mode for reduced memory usage
    const writer = frameAssemblerService.createStreamingRawVideoWriter({
      ffmpeg: ffmpegService.getFFmpegInstance(),
      width,
      height,
      outputFileName,
      expectedFrameCount: frameCount,
    });

    const result = await frameExtractorService.extractFramesStreaming({
      video,
      fps,
      duration,
      options: { width, height },
      signal: abortSignal,
      onProgress: (current, total) => {
        // Map frame extraction (0-100%) to overall progress (0-50%)
        const progress = Math.round((current / total) * 50);
        ffmpegService.reportProgress(progress);
      },
      onFrame: async (frameData, _frameIndex, _totalFrames) => {
        // Write each frame immediately to the streaming writer
        writer.writeFrame(frameData);
      },
    });

    if (abortSignal.aborted) {
      throw new Error('Conversion cancelled by user');
    }

    // Finalize: concatenate all chunks and write to VFS
    await writer.finalize();

    ffmpegService.reportProgress(50);

    return {
      fileName: outputFileName,
      frameCount: result.frameCount,
      width: result.width,
      height: result.height,
      pixels: new Uint8Array(0), // Not used in streaming mode
    };
  } finally {
    ffmpegService.endExternalConversion();
    clearTimeout(timeoutId);
    video.onloadeddata = null;
    video.onerror = null;
    video.removeAttribute('src');
    URL.revokeObjectURL(objectUrl);
  }
}
