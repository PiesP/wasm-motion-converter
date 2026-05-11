import { ffmpegService } from '@services/ffmpeg-service';
import { webcodecsConversionService } from '@services/webcodecs-conversion-service';
import type { ConversionFormat } from '@t/conversion-types';
import { CONVERSION_FORMATS } from '@t/conversion-types';
import {
  CANCELLED_MESSAGE,
  isCancellationError,
  throwIfAborted,
} from '@utils/cancellation-context';
import { createId } from '@utils/create-id';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import { selectSimplePath } from './simple-path-planner-service';
import type {
  ConversionMetadata,
  ConversionRequest,
  ConversionResponse,
  ConversionStatus,
} from './types-service';

const STATUS_INITIALIZING = 'Initializing conversion...';
const STATUS_COMPLETE = 'Complete';
const STATUS_CANCELLED = 'Cancelled by user';
const STATUS_ERROR = 'Error';

function isSupportedFormat(format: string): format is ConversionFormat {
  return (CONVERSION_FORMATS as readonly string[]).includes(format);
}

function getSupportedFormat(request: ConversionRequest): ConversionFormat {
  if (isSupportedFormat(request.format)) {
    return request.format;
  }

  throw new Error(`Unsupported format: ${request.format}`);
}

class ConversionOrchestrator {
  private status: ConversionStatus = {
    isConverting: false,
    progress: 0,
    statusMessage: '',
  };

  private activeOperationId: string | null = null;
  private abortController: AbortController | null = null;

  async convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
    const operationId = createId();
    const startedAt = performance.now();
    const abortController = new AbortController();

    this.activeOperationId = operationId;
    this.abortController = abortController;
    this.status = {
      isConverting: true,
      progress: 0,
      statusMessage: STATUS_INITIALIZING,
    };

    request.onProgress?.(0);
    request.onStatus?.(STATUS_INITIALIZING);

    try {
      const selection = await selectSimplePath({
        file: request.file,
        format: request.format,
        metadata: request.metadata,
        abortSignal: abortController.signal,
      });

      const operationActive = this.activeOperationId === operationId;
      if (!operationActive) {
        throw new Error(CANCELLED_MESSAGE);
      }
      throwIfAborted(abortController.signal);

      const blob =
        selection.path === 'gpu'
          ? await this.convertWithGpuFallback(request, abortController.signal)
          : await this.convertWithCpu(request);

      if (this.activeOperationId !== operationId) {
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

      this.status = {
        isConverting: false,
        progress: 100,
        statusMessage: STATUS_COMPLETE,
      };

      request.onProgress?.(100);
      request.onStatus?.(STATUS_COMPLETE);

      logger.info('conversion', 'Conversion completed', {
        format: request.format,
        path: selection.path,
        reason: selection.reason,
        codec: request.metadata?.codec,
        encoder: metadata.encoder,
      });

      return {
        blob,
        metadata,
      };
    } catch (error) {
      if (abortController.signal.aborted || isCancellationError(error)) {
        this.status = {
          isConverting: false,
          progress: 0,
          statusMessage: STATUS_CANCELLED,
        };

        request.onStatus?.(STATUS_CANCELLED);
        throw new Error(CANCELLED_MESSAGE);
      }

      this.status = {
        isConverting: false,
        progress: 0,
        statusMessage: STATUS_ERROR,
      };

      request.onStatus?.(STATUS_ERROR);

      logger.error('conversion', 'Conversion failed', {
        format: request.format,
        codec: request.metadata?.codec,
        error: getErrorMessage(error),
      });

      throw error;
    } finally {
      if (this.activeOperationId === operationId) {
        this.activeOperationId = null;
      }

      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  cancel(): void {
    this.abortController?.abort();
    ffmpegService.cancelConversion();
    this.status = {
      isConverting: false,
      progress: 0,
      statusMessage: STATUS_CANCELLED,
    };
  }

  getStatus(): ConversionStatus {
    return { ...this.status };
  }

  private async convertWithGpuFallback(
    request: ConversionRequest,
    abortSignal: AbortSignal
  ): Promise<Awaited<ConversionResponse['blob']>> {
    const format = getSupportedFormat(request);

    try {
      return await webcodecsConversionService.convert(
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

      return this.convertWithCpu(request);
    }
  }

  private async convertWithCpu(
    request: ConversionRequest
  ): Promise<Awaited<ConversionResponse['blob']>> {
    const format = getSupportedFormat(request);

    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }

    if (format === 'gif') {
      return ffmpegService.convertToGIF(request.file, request.options, request.metadata);
    }

    if (format === 'webp') {
      return ffmpegService.convertToWebP(request.file, request.options, request.metadata);
    }

    throw new Error(`Unsupported format: ${format}`);
  }
}

const orchestrator = new ConversionOrchestrator();

export async function convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
  return orchestrator.convertVideo(request);
}

export function cancelConversion(): void {
  orchestrator.cancel();
}
