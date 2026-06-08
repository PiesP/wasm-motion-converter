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
  ConversionRequest,
  ConversionResponse,
  ConversionStatus,
} from '@t/conversion-types';
import {
  CANCELLED_MESSAGE,
  isCancellationError,
  throwIfAborted,
} from '@utils/cancellation-context';
import { isSupportedFormat } from '@utils/codec-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { selectSimplePath } from './simple-path-planner-service';

const STATUS_INITIALIZING = 'Initializing conversion...';
const STATUS_COMPLETE = 'Complete';
const STATUS_CANCELLED = 'Cancelled by user';
const STATUS_ERROR = 'Error';

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

  const status: ConversionStatus = {
    isConverting: false,
    progress: 0,
    statusMessage: '',
  };

  status.isConverting = true;
  status.progress = 0;
  status.statusMessage = STATUS_INITIALIZING;

  request.onProgress?.(0);
  request.onStatus?.(STATUS_INITIALIZING);

  try {
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

    const blob =
      selection.path === 'gpu'
        ? await convertWithGpuFallback(request, operation.abortController.signal)
        : await convertWithCpu(request, operation.abortController.signal);

    if (activeOperation?.id !== operation.id) {
      throw new Error(CANCELLED_MESSAGE);
    }
    throwIfAborted(operation.abortController.signal);

    const metadata: ConversionMetadata = {
      path: selection.path,
      encoder: blob.encoderBackendUsed ?? (selection.path === 'gpu' ? 'webcodecs' : 'ffmpeg'),
      captureModeUsed: blob.captureModeUsed ?? null,
      conversionTimeMs: performance.now() - startedAt,
      wasTranscoded: blob.wasTranscoded,
      originalCodec: request.metadata?.codec,
    };

    status.isConverting = false;
    status.progress = 100;
    status.statusMessage = STATUS_COMPLETE;

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
      status.isConverting = false;
      status.progress = 0;
      status.statusMessage = STATUS_CANCELLED;
      request.onStatus?.(STATUS_CANCELLED);
      throw new Error(CANCELLED_MESSAGE);
    }

    status.isConverting = false;
    status.progress = 0;
    status.statusMessage = STATUS_ERROR;
    request.onStatus?.(STATUS_ERROR);

    logger.error('conversion', 'Conversion failed', {
      format: request.format,
      codec: request.metadata?.codec,
      error: getErrorMessage(error),
    });

    throw error;
  } finally {
    clearOperation(operation.id);
    cleanupWebCodecs();
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

  if (format === 'avif') {
    // AVIF encoding via FFmpeg CPU path.
    // Uses FFmpeg's libaom-av1 encoder if available in the WASM build,
    // otherwise falls back to WebP with a warning.
    // TODO: Add dedicated FFmpeg AVIF encoding command (libaom-av1/libsvtav1)
    throw new Error(
      'AVIF encoding is not yet available in this build. ' +
        'The FFmpeg WASM build must include libaom-av1 or libsvtav1 for AV1 encoding. ' +
        'Please use GIF or WebP format instead.'
    );
  }

  throw new Error(`Unsupported format: ${format}`);
}
