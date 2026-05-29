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
import { createId } from '@utils/format-utils';
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

const status: ConversionStatus = {
  isConverting: false,
  progress: 0,
  statusMessage: '',
};

export async function convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
  // Cancel any stale operation from a previous call that didn't clean up
  if (activeOperation) {
    activeOperation.abortController.abort();
    activeOperation = null;
  }

  const operationId = createId();
  const startedAt = performance.now();
  const abortController = new AbortController();

  activeOperation = { id: operationId, abortController };

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
      abortSignal: abortController.signal,
    });

    if (activeOperation?.id !== operationId) {
      throw new Error(CANCELLED_MESSAGE);
    }
    throwIfAborted(abortController.signal);

    const blob =
      selection.path === 'gpu'
        ? await convertWithGpuFallback(request, abortController.signal)
        : await convertWithCpu(request, abortController.signal);

    if (activeOperation?.id !== operationId) {
      throw new Error(CANCELLED_MESSAGE);
    }
    throwIfAborted(abortController.signal);

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

    request.onProgress?.(100);
    request.onStatus?.(STATUS_COMPLETE);

    logger.info('conversion', 'Conversion completed', {
      format: request.format,
      path: selection.path,
      reason: selection.reason,
      codec: request.metadata?.codec,
      encoder: metadata.encoder,
    });

    return { blob, metadata };
  } catch (error) {
    if (abortController.signal.aborted || isCancellationError(error)) {
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
    if (activeOperation?.id === operationId) {
      activeOperation = null;
    }
    cleanupWebCodecs();
  }
}

export function cancelConversion(): void {
  activeOperation?.abortController.abort();
  ffmpegService.cancelConversion();
  cleanupWebCodecs();
  status.isConverting = false;
  status.progress = 0;
  status.statusMessage = STATUS_CANCELLED;
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
