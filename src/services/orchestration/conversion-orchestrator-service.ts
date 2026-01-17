/**
 * Conversion Orchestrator
 *
 * Main entry point for video conversion. Replaces conversion-service.ts.
 * Coordinates path selection, strategy resolution, and execution across
 * GPU (WebCodecs) and CPU (FFmpeg) paths.
 *
 * Architecture:
 * 1. Select conversion path (GPU vs CPU vs WebAV)
 * 2. Resolve conversion strategy (FPS, scale, workers)
 * 3. Execute via appropriate path
 * 4. Return result with metadata
 */

import { ffmpegService } from '@services/ffmpeg-service'; // Legacy service (will be replaced in Phase 4)
import {
  buildLightweightMetadataFromTrack,
  resolveMetadata,
} from '@services/orchestration/conversion-metadata-utils-service';
import { resolveGifEncoderStrategy } from '@services/orchestration/gif-encoder-strategy-service';
import {
  type FailurePhase,
  strategyHistoryService,
} from '@services/orchestration/strategy-history-service';
import { strategyRegistryService } from '@services/orchestration/strategy-registry-service';
import { ProgressReporter } from '@services/shared/progress-reporter-service';
import { capabilityService } from '@services/video-pipeline/capability-service';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { videoPipelineService } from '@services/video-pipeline/video-pipeline-service';
import type { WebAVMP4Service } from '@services/webav/webav-mp4-service';
import type {
  ConversionFormat,
  ErrorContext,
  GifEncoderPreference,
  VideoMetadata,
} from '@t/conversion-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { isAv1Codec } from '@utils/codec-utils';
import { detectContainerFormat } from '@utils/container-utils';
import { createId } from '@utils/create-id';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import {
  type ConversionDebugOutcome,
  setConversionAutoSelectionDebug,
  setConversionPhaseTimingsDebug,
  updateConversionAutoSelectionDebug,
} from './conversion-debug-service';

const STATUS_INITIALIZING = 'Initializing conversion...';
const STATUS_COMPLETE = 'Complete';
const STATUS_CANCELLED = 'Cancelled by user';
const STATUS_ERROR = 'Error';
const ERROR_CONVERSION_CANCELLED = 'Conversion cancelled by user';
const ERROR_CONVERSION_ABORTED = 'Conversion aborted';

import { conversionMetricsService } from './conversion-metrics-service';
import { getDevConversionOverrides } from './dev-conversion-overrides-service';
import type {
  ConversionMetadata,
  ConversionPath,
  ConversionRequest,
  ConversionResponse,
  ConversionStatus,
  PathSelection,
} from './types-service';

/**
 * Conversion orchestrator class
 *
 * Stateful orchestrator that manages a single conversion operation.
 */
class ConversionOrchestrator {
  private status: ConversionStatus = {
    isConverting: false,
    progress: 0,
    statusMessage: '',
  };

  private activeOperationId: string | null = null;
  private webavService: WebAVMP4Service | null = null;
  private abortController: AbortController | null = null;

  /**
   * Convert video using optimal path
   *
   * Main conversion function. Analyzes input, selects path, executes conversion.
   *
   * @param request - Conversion request
   * @returns Promise resolving to conversion response
   * @throws Error if conversion fails
   */
  async convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
    const startTime = Date.now();
    const perfStart = performance.now();
    let analysisStart = perfStart;
    let conversionStart = perfStart;
    let outputSizeBytes: number | null = null;
    let encoderBackendUsedForMetrics: string | null = null;
    let captureModeUsedForMetrics: string | null = null;
    let executedPathForMetrics: ConversionPath | null = null;
    let debugOutcome: ConversionDebugOutcome | undefined;

    const operationId = createId();
    this.activeOperationId = operationId;
    const isActive = () => this.activeOperationId === operationId;

    // Initialize AbortController for cancellation support
    const abortController = new AbortController();
    this.abortController = abortController;

    const throwIfAborted = () => {
      this.throwIfAborted(abortController.signal);
    };

    // Capture the planned path/codec so failures can be attributed correctly.
    // This improves session-scoped learning and reduces repeated failing attempts.
    let plannedSelection: PathSelection | null = null;
    let plannedCodecForHistory: string | undefined = request.metadata?.codec;

    try {
      // Update status
      if (isActive()) {
        this.status = {
          isConverting: true,
          progress: 0,
          statusMessage: STATUS_INITIALIZING,
          phase: 'initializing',
        };
      }

      // Ensure log output is annotated with a progress indicator from the very beginning
      // of the conversion lifecycle, even before the first progress tick is emitted.
      logger.setConversionProgress(0);

      // Create progress reporter
      const progressReporter = new ProgressReporter({
        isActive,
        onProgress: (progress) => {
          if (!isActive()) return;
          this.status.progress = progress;
          request.onProgress?.(progress);
        },
        onStatus: (message) => {
          if (!isActive()) return;
          this.status.statusMessage = message;
          request.onStatus?.(message);
        },
      });

      // Define phases
      progressReporter.definePhases([
        { name: 'initialization', weight: 1 },
        { name: 'analysis', weight: 1 },
        { name: 'conversion', weight: 18 }, // Main work
      ]);

      // Phase 1: Initialization
      progressReporter.startPhase('initialization', 'Initializing...');
      // Warm up capability probing early to reduce latency for the planning step.
      // Intentionally non-blocking to keep UI responsive.
      void capabilityService.detectCapabilities().catch(() => undefined);
      void extendedCapabilityService.detectCapabilities().catch(() => undefined);
      progressReporter.report(1.0);

      // Phase 2: Analysis
      progressReporter.startPhase('analysis', 'Analyzing video...');
      analysisStart = performance.now();

      throwIfAborted();
      const { selection: pathSelection, metadata: plannedMetadata } = await this.selectPath({
        file: request.file,
        format: request.format,
        metadata: request.metadata,
        gifEncoderPreference: request.format === 'gif' ? request.options.gifEncoder : undefined,
        abortSignal: abortController.signal,
      });

      throwIfAborted();

      plannedSelection = pathSelection;
      plannedCodecForHistory = plannedMetadata?.codec ?? plannedCodecForHistory;

      // If we are taking the CPU path, ensure FFmpeg is ready and probe full metadata when needed.
      // This keeps GPU conversions from paying the FFmpeg init cost up front.
      const metadata =
        pathSelection.path === 'cpu'
          ? await resolveMetadata(request.file, plannedMetadata)
          : plannedMetadata;

      throwIfAborted();
      progressReporter.report(1.0);

      const {
        effectiveRequest,
        effectiveGifEncoder,
        effectiveOptions,
        devOverrides,
        requestedGifEncoder,
      } = this.resolveGifEncoderConfig({
        request,
        path: pathSelection.path,
        metadata,
      });

      logger.info('conversion', 'Starting conversion', {
        file: request.file.name,
        fileSizeBytes: request.file.size,
        format: request.format,
        path: pathSelection.path,
        reason: pathSelection.reason,
        codec: metadata?.codec,
        quality: request.options.quality,
        scale: request.options.scale,
        gifEncoder: requestedGifEncoder,
        gifEncoderResolved: request.format === 'gif' ? effectiveGifEncoder : null,
        devForcedPath: import.meta.env.DEV ? (devOverrides?.forcedPath ?? null) : null,
        devDisableFallback: import.meta.env.DEV ? (devOverrides?.disableFallback ?? null) : null,
        devForcedGifEncoder: import.meta.env.DEV ? (devOverrides?.forcedGifEncoder ?? null) : null,
        devForcedCaptureMode: import.meta.env.DEV
          ? (devOverrides?.forcedCaptureMode ?? null)
          : null,
        devDisableDemuxerInAuto: import.meta.env.DEV
          ? (devOverrides?.disableDemuxerInAuto ?? null)
          : null,
        devForcedStrategyCodec: import.meta.env.DEV
          ? (devOverrides?.forcedStrategyCodec ?? null)
          : null,
        durationSeconds: request.options.duration ?? null,
      });

      // Enhanced strategy logging (dev mode)
      if (import.meta.env.DEV && metadata?.codec) {
        try {
          const container = detectContainerFormat(request.file);
          const extendedCaps = extendedCapabilityService.getCached();
          const reasoning = strategyRegistryService.getStrategyReasoning({
            codec: metadata.codec,
            format: request.format,
            container: container as import('@t/video-pipeline-types').ContainerFormat,
            capabilities: extendedCaps,
            durationSeconds: metadata.duration,
          });

          logger.debug('conversion', 'Strategy Decision Factors', reasoning.factors);
          logger.debug('conversion', 'Alternatives Considered', reasoning.alternativesConsidered);
        } catch (error) {
          // Non-critical - don't block conversion
          logger.debug('conversion', 'Strategy reasoning generation failed (non-critical)', {
            error: getErrorMessage(error),
          });
        }
      }

      // Phase 3: Conversion
      progressReporter.startPhase('conversion', 'Converting...');
      conversionStart = performance.now();

      const conversionMetadata: ConversionMetadata = {
        path: pathSelection.path,
        encoder: 'unknown',
        conversionTimeMs: 0,
        wasTranscoded: false,
        originalCodec: metadata?.codec,
      };

      let blob: Blob;

      // Execute based on selected path
      switch (pathSelection.path) {
        case 'webav':
          blob = await this.convertViaWebAVPath(
            request,
            metadata,
            conversionMetadata,
            progressReporter
          );
          break;

        case 'gpu':
          blob = await this.convertViaGPUPath(
            effectiveRequest,
            metadata,
            conversionMetadata,
            abortController.signal
          );
          break;

        default:
          blob = await this.convertViaCPUPath(
            request,
            metadata,
            conversionMetadata,
            abortController.signal
          );
          break;
      }

      executedPathForMetrics = conversionMetadata.path;

      // If the user cancelled (or this operation was superseded), do not treat the result
      // as a successful conversion. This avoids late-arriving completions mutating shared
      // UI/log state after rapid cancel/retry.
      if (!isActive() || abortController.signal.aborted) {
        throw new Error(ERROR_CONVERSION_CANCELLED);
      }

      // Update final metadata
      conversionMetadata.conversionTimeMs = Date.now() - startTime;

      // Best-effort: conversion services may attach the actual encoder backend onto the
      // output blob. Prefer the runtime-reported backend over the planned one.
      const encoderBackendUsed =
        (blob as unknown as { encoderBackendUsed?: string | null }).encoderBackendUsed ?? null;
      if (encoderBackendUsed) {
        conversionMetadata.encoder = encoderBackendUsed;
      }
      encoderBackendUsedForMetrics = encoderBackendUsed ?? conversionMetadata.encoder;

      outputSizeBytes = blob.size;

      // Best-effort: WebCodecs conversion services may attach capture mode metadata
      // directly onto the output blob for debugging/learning purposes.
      const captureModeUsed =
        (blob as unknown as { captureModeUsed?: string | null }).captureModeUsed ?? null;
      if (captureModeUsed) {
        conversionMetadata.captureModeUsed = captureModeUsed;
      }
      captureModeUsedForMetrics = captureModeUsed;

      debugOutcome = 'success';
      if (import.meta.env.DEV) {
        updateConversionAutoSelectionDebug({
          executedPath: conversionMetadata.path,
          encoderBackend: conversionMetadata.encoder,
          outcome: debugOutcome,
        });
      }

      progressReporter.complete('Conversion complete');

      if (isActive()) {
        this.status = {
          isConverting: false,
          progress: 100,
          statusMessage: STATUS_COMPLETE,
        };
      }

      logger.info('conversion', 'Conversion completed successfully', {
        file: request.file.name,
        format: request.format,
        path: conversionMetadata.path,
        encoder: conversionMetadata.encoder,
        durationMs: conversionMetadata.conversionTimeMs,
      });

      // Record successful conversion to history
      if (metadata?.codec) {
        try {
          strategyHistoryService.recordConversion({
            codec: metadata.codec,
            format: request.format,
            path: conversionMetadata.path,
            captureModeUsed: conversionMetadata.captureModeUsed ?? null,
            durationMs: conversionMetadata.conversionTimeMs,
            success: true,
            timestamp: Date.now(),
          });
        } catch (error) {
          // Non-critical - don't block return
          logger.debug('conversion', 'Failed to record conversion history (non-critical)', {
            error: getErrorMessage(error),
          });
        }
      }

      // Performance metrics logging (always visible, even in production)
      const ffmpegFrameInputKind =
        (blob as unknown as { ffmpegFrameInputKind?: string | null }).ffmpegFrameInputKind ?? null;
      const ffmpegRawvideoBytesUsed =
        (blob as unknown as { ffmpegRawvideoBytesUsed?: number | null }).ffmpegRawvideoBytesUsed ??
        null;

      logger.performance('Conversion Strategy Executed', {
        codec: metadata?.codec,
        format: request.format,
        path: conversionMetadata.path,
        plannedPath: pathSelection.path,
        hadFallback: conversionMetadata.path !== pathSelection.path,
        encoderBackendUsed: encoderBackendUsedForMetrics,
        captureModeUsed: captureModeUsedForMetrics,
        gifEncoderRequested:
          request.format === 'gif' ? (request.options.gifEncoder ?? 'auto') : null,
        gifEncoderResolved:
          request.format === 'gif' ? (effectiveOptions.gifEncoder ?? 'auto') : null,
        ffmpegFrameInputKind,
        ffmpegRawvideoBytesUsed,
        durationMs: conversionMetadata.conversionTimeMs,
        outputSizeMB: (blob.size / (1024 * 1024)).toFixed(2),
        performanceRating:
          conversionMetadata.conversionTimeMs < 10000
            ? 'fast'
            : conversionMetadata.conversionTimeMs < 30000
              ? 'medium'
              : 'slow',
      });

      return {
        blob,
        metadata: conversionMetadata,
      };
    } catch (error) {
      // Check if the conversion was cancelled or superseded by a newer conversion.
      const wasCancelled = abortController.signal.aborted;
      const wasSuperseded = !isActive();

      if (wasCancelled || wasSuperseded) {
        debugOutcome = 'cancelled';
        if (import.meta.env.DEV) {
          updateConversionAutoSelectionDebug({
            outcome: debugOutcome,
          });
        }
        if (!wasSuperseded) {
          logger.info('conversion', 'Conversion was cancelled by user');
        }
        if (isActive()) {
          this.status = {
            isConverting: false,
            progress: this.status.progress,
            statusMessage: STATUS_CANCELLED,
          };
        }
        throw new Error(ERROR_CONVERSION_CANCELLED);
      }

      debugOutcome = 'error';
      if (import.meta.env.DEV) {
        updateConversionAutoSelectionDebug({
          outcome: debugOutcome,
          errorMessage: getErrorMessage(error),
        });
      }

      if (isActive()) {
        this.status = {
          isConverting: false,
          progress: 0,
          statusMessage: STATUS_ERROR,
        };
      }

      const errorMessage = getErrorMessage(error);
      const errorContext: ErrorContext = classifyConversionError(
        errorMessage,
        request.metadata ?? null,
        { format: request.format, quality: request.options.quality, scale: request.options.scale }
      );

      // Log the error without full classification (will be done in consumer)
      // to avoid redundant error processing and potential stack overflow
      logger.error('conversion', 'Conversion failed', {
        file: request.file.name,
        format: request.format,
        error: errorMessage,
        failurePhase: errorContext.phase ?? null,
      });

      // Record failed conversion to history (if we have enough info)
      if (plannedCodecForHistory) {
        try {
          strategyHistoryService.recordConversion({
            codec: plannedCodecForHistory,
            format: request.format,
            path: plannedSelection?.path ?? 'cpu',
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: errorMessage.slice(0, 300),
            failurePhase: (errorContext.phase ?? null) as FailurePhase,
            timestamp: Date.now(),
          });
        } catch (historyError) {
          // Non-critical - don't mask original error
          logger.debug('conversion', 'Failed to record conversion failure (non-critical)', {
            error: getErrorMessage(historyError),
          });
        }
      }

      throw error;
    } finally {
      const perfEnd = performance.now();
      const initMs = Math.max(0, analysisStart - perfStart);
      const analysisMs = Math.max(0, conversionStart - analysisStart);
      const conversionMs = Math.max(0, perfEnd - conversionStart);
      const totalMs = Math.max(0, perfEnd - perfStart);

      if (import.meta.env.DEV) {
        setConversionPhaseTimingsDebug({
          timestamp: Date.now(),
          initializationMs: initMs,
          analysisMs,
          conversionMs,
          totalMs,
          outcome: debugOutcome,
        });
      }

      // Record lightweight session metrics for tuning path selection.
      // Skip superseded operations to avoid polluting metrics during rapid cancel/retry.
      if (isActive()) {
        try {
          const codecForMetrics = plannedCodecForHistory ?? request.metadata?.codec ?? 'unknown';
          conversionMetricsService.record({
            timestamp: Date.now(),
            codec: codecForMetrics,
            format: request.format,
            plannedPath: plannedSelection?.path ?? 'cpu',
            executedPath: executedPathForMetrics ?? plannedSelection?.path ?? 'cpu',
            encoderBackendUsed: encoderBackendUsedForMetrics,
            captureModeUsed: captureModeUsedForMetrics,
            durationMs: Math.max(0, Date.now() - startTime),
            outputSizeBytes,
            initializationMs: Math.round(initMs),
            analysisMs: Math.round(analysisMs),
            conversionMs: Math.round(conversionMs),
            totalMs: Math.round(totalMs),
            outcome: debugOutcome ?? 'error',
          });
        } catch (metricsError) {
          logger.debug('conversion', 'Failed to record conversion metrics (non-critical)', {
            error: getErrorMessage(metricsError),
          });
        }
      }

      // Only the currently-active operation may clear shared orchestrator state.
      // This prevents late-arriving completions from a stale conversion from
      // nulling out the progress reporter/abort controller of a newer conversion.
      if (isActive()) {
        this.abortController = null;
        this.activeOperationId = null;

        // Defensive: ensure the progress decoration never leaks into subsequent logs.
        logger.clearConversionProgress();
      }
    }
  }

  /**
   * Get current conversion status
   */
  getStatus(): ConversionStatus {
    return { ...this.status };
  }

  /**
   * Cancel current conversion
   *
   * Signals the abort controller to stop ongoing conversion operations.
   * Affects frame extraction, encoding, and file I/O operations.
   */
  cancel(): void {
    // Cascade cancellation to services that have their own cancellation mechanisms.
    // This is intentionally best-effort: some Web APIs cannot be force-cancelled immediately.
    try {
      ffmpegService.cancelConversion();
    } catch {
      // Non-critical
    }

    try {
      this.webavService?.cancel();
    } catch {
      // Non-critical
    }

    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
      logger.info('conversion', 'Conversion cancellation requested');
      this.status = {
        isConverting: false,
        progress: this.status.progress,
        statusMessage: 'Cancelled by user',
      };
    }
  }

  /**
   * Throw when the current conversion has been cancelled.
   *
   * This is used to short-circuit analysis/planning steps that otherwise
   * continue doing expensive work (demuxer init, capability probing) after
   * the user has already cancelled.
   */
  private throwIfAborted(signal?: AbortSignal): void {
    const abortSignal = signal ?? this.abortController?.signal;
    if (abortSignal?.aborted) {
      throw new Error(ERROR_CONVERSION_ABORTED);
    }
  }

  /**
   * Get abort signal for cancellation support
   */
  getAbortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /**
   * Ensure FFmpeg is initialized
   */
  private async ensureFFmpegInitialized(): Promise<void> {
    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }
  }

  private async getWebAVService(): Promise<WebAVMP4Service> {
    if (this.webavService) return this.webavService;

    const { createWebAVMP4Service } = await import('@services/webav/webav-mp4-service');
    this.webavService = createWebAVMP4Service();
    return this.webavService;
  }

  /**
   * Resolve video metadata
   *
   * For complex codecs (AV1, VP9, HEVC), metadata is mandatory for proper processing.
   * This prevents issues with timeout calculation and codec detection.
   */
  /**
   * Select conversion path (video-pipeline powered)
   */
  private resolveGifEncoderConfig(params: {
    request: ConversionRequest;
    path: ConversionPath;
    metadata?: VideoMetadata;
  }): {
    effectiveRequest: ConversionRequest;
    effectiveGifEncoder: GifEncoderPreference | null;
    effectiveOptions: ConversionRequest['options'];
    devOverrides: ReturnType<typeof getDevConversionOverrides> | null;
    requestedGifEncoder: GifEncoderPreference | null;
  } {
    // Resolve the *effective* GIF encoder strategy for this run.
    // Notes:
    // - The UI no longer exposes encoder choice.
    // - We still keep an internal hint field (options.gifEncoder) so the orchestrator can
    //   route complex codecs through a faster FFmpeg palette path when safe.
    const requestedGifEncoder: GifEncoderPreference | null =
      params.request.format === 'gif' ? (params.request.options.gifEncoder ?? 'auto') : null;

    const devOverrides = import.meta.env.DEV ? getDevConversionOverrides() : null;
    const hasDevForcedGifEncoder =
      params.request.format === 'gif' && !!devOverrides && devOverrides.forcedGifEncoder !== 'auto';

    const effectiveOptions = { ...params.request.options };
    let effectiveGifEncoder: GifEncoderPreference | null = requestedGifEncoder;

    if (
      params.request.format === 'gif' &&
      devOverrides &&
      devOverrides.forcedGifEncoder === 'ffmpeg-palette'
    ) {
      effectiveOptions.gifEncoder = 'ffmpeg-palette';
      effectiveGifEncoder = 'ffmpeg-palette';
    }

    if (
      params.request.format === 'gif' &&
      requestedGifEncoder === 'auto' &&
      params.path === 'gpu' &&
      !hasDevForcedGifEncoder
    ) {
      const resolved = resolveGifEncoderStrategy({
        path: params.path,
        options: effectiveOptions,
        requestedGifEncoder,
        metadata: params.metadata,
        hasDevForcedGifEncoder,
      });
      effectiveOptions.gifEncoder = resolved.options.gifEncoder;
      effectiveGifEncoder = resolved.resolved;
    }

    const effectiveRequest: ConversionRequest = {
      ...params.request,
      options: effectiveOptions,
    };

    return {
      effectiveRequest,
      effectiveGifEncoder,
      effectiveOptions,
      devOverrides,
      requestedGifEncoder,
    };
  }

  private async selectPath(params: {
    file: File;
    format: ConversionFormat;
    metadata?: VideoMetadata;
    gifEncoderPreference?: GifEncoderPreference;
    abortSignal: AbortSignal;
  }): Promise<{
    selection: PathSelection;
    metadata: VideoMetadata | undefined;
  }> {
    const { file, format } = params;

    const devOverrides = import.meta.env.DEV ? getDevConversionOverrides() : null;
    const gifEncoderPreference: GifEncoderPreference | undefined =
      format === 'gif' && devOverrides && devOverrides.forcedGifEncoder === 'ffmpeg-palette'
        ? 'ffmpeg-palette'
        : params.gifEncoderPreference;

    this.throwIfAborted(params.abortSignal);

    // WebAV path for MP4 (native WebCodecs pipeline).
    if (format === 'mp4') {
      this.throwIfAborted(params.abortSignal);
      const webavService = await this.getWebAVService();
      this.throwIfAborted(params.abortSignal);
      const webavAvailable = await webavService.isAvailable();
      if (!webavAvailable) {
        throw new Error('MP4 conversion is not available in this browser (WebAV required).');
      }

      if (import.meta.env.DEV) {
        const caps = extendedCapabilityService.getCached();
        setConversionAutoSelectionDebug({
          timestamp: Date.now(),
          format,
          codec: params.metadata?.codec,
          container: detectContainerFormat(file),
          plannedPath: 'webav',
          plannedReason: 'WebAV MP4 encoding',
          hardwareAccelerated: caps.hardwareAccelerated,
          sharedArrayBuffer: caps.sharedArrayBuffer,
          crossOriginIsolated: caps.crossOriginIsolated,
          workerSupport: caps.workerSupport,
        });
      }

      return {
        selection: {
          path: 'webav',
          reason: 'WebAV MP4 encoding',
        },
        metadata: params.metadata,
      };
    }

    if (format !== 'gif' && format !== 'webp') {
      throw new Error(`Unsupported format: ${format}`);
    }

    // Dev-only escape hatches: allow deterministic forcing of path and select encoder variants.
    // Intended for performance/stability testing (not exposed in production).
    if (import.meta.env.DEV && devOverrides) {
      if (format === 'gif' && devOverrides.forcedGifEncoder === 'ffmpeg-direct') {
        const caps = extendedCapabilityService.getCached();
        setConversionAutoSelectionDebug({
          timestamp: Date.now(),
          format,
          codec: params.metadata?.codec,
          container: detectContainerFormat(file),
          plannedPath: 'cpu',
          plannedReason: 'Dev override forced GIF encoder: ffmpeg-direct (CPU)',
          hardwareAccelerated: caps.hardwareAccelerated,
          sharedArrayBuffer: caps.sharedArrayBuffer,
          crossOriginIsolated: caps.crossOriginIsolated,
          workerSupport: caps.workerSupport,
        });

        return {
          selection: {
            path: 'cpu',
            reason: 'Dev override forced GIF encoder: ffmpeg-direct (CPU)',
            useDemuxer: false,
          },
          metadata: params.metadata,
        };
      }

      if (devOverrides.forcedPath === 'cpu') {
        if (import.meta.env.DEV) {
          const caps = extendedCapabilityService.getCached();
          setConversionAutoSelectionDebug({
            timestamp: Date.now(),
            format,
            codec: params.metadata?.codec,
            container: detectContainerFormat(file),
            plannedPath: 'cpu',
            plannedReason: 'Dev override forced CPU path (FFmpeg direct)',
            hardwareAccelerated: caps.hardwareAccelerated,
            sharedArrayBuffer: caps.sharedArrayBuffer,
            crossOriginIsolated: caps.crossOriginIsolated,
            workerSupport: caps.workerSupport,
          });
        }

        return {
          selection: {
            path: 'cpu',
            reason: 'Dev override forced CPU path (FFmpeg direct)',
            useDemuxer: false,
          },
          metadata: params.metadata,
        };
      }
    }

    // Experiment: allow users to force FFmpeg palettegen/paletteuse for GIF output.
    // Handle this before pipeline planning so we avoid unnecessary analysis work.
    // NOTE: AV1-in-MP4 decoding in ffmpeg.wasm is not reliable in all builds/environments.
    // If AV1 is detected, do not force the FFmpeg-direct CPU path. Instead, honor the
    // preference via a hybrid approach: WebCodecs decode + FFmpeg frame-sequence palette encode.
    if (format === 'gif' && gifEncoderPreference === 'ffmpeg-palette') {
      const codec = params.metadata?.codec;
      if (isAv1Codec(codec)) {
        logger.info(
          'conversion',
          'FFmpeg palette preference detected for AV1 input; will use WebCodecs decode + FFmpeg frame-sequence encoding',
          { codec }
        );
      } else {
        if (import.meta.env.DEV) {
          const caps = extendedCapabilityService.getCached();
          setConversionAutoSelectionDebug({
            timestamp: Date.now(),
            format,
            codec,
            container: detectContainerFormat(file),
            plannedPath: 'cpu',
            plannedReason: 'User forced FFmpeg palettegen/paletteuse',
            hardwareAccelerated: caps.hardwareAccelerated,
            sharedArrayBuffer: caps.sharedArrayBuffer,
            crossOriginIsolated: caps.crossOriginIsolated,
            workerSupport: caps.workerSupport,
          });
        }

        return {
          selection: {
            path: 'cpu',
            reason: 'User forced FFmpeg palettegen/paletteuse',
            useDemuxer: false,
          },
          metadata: params.metadata,
        };
      }
    }

    this.throwIfAborted(params.abortSignal);
    const plan = await videoPipelineService.planPipeline({
      file,
      format,
      abortSignal: params.abortSignal,
      metadata: params.metadata,
    });

    this.throwIfAborted(params.abortSignal);

    const trackMetadata = plan.track ? buildLightweightMetadataFromTrack(plan.track) : undefined;

    // Prefer demuxer-derived track metadata when the caller provided only quick
    // metadata (codec='unknown'). This prevents strategy selection from treating
    // known codecs (e.g., AV1 in MP4) as unknown and choosing an unsafe path.
    const plannedMetadata = trackMetadata
      ? {
          ...(params.metadata ?? trackMetadata),
          codec:
            params.metadata?.codec && params.metadata.codec !== 'unknown'
              ? params.metadata.codec
              : trackMetadata.codec,
          width:
            params.metadata?.width && params.metadata.width > 0
              ? params.metadata.width
              : trackMetadata.width,
          height:
            params.metadata?.height && params.metadata.height > 0
              ? params.metadata.height
              : trackMetadata.height,
          duration:
            params.metadata?.duration && params.metadata.duration > 0
              ? params.metadata.duration
              : trackMetadata.duration,
          framerate:
            params.metadata?.framerate && params.metadata.framerate > 0
              ? params.metadata.framerate
              : trackMetadata.framerate,
        }
      : params.metadata;

    // If pipeline planning forces FFmpeg full pipeline, respect it.
    if (plan.decodePath === 'ffmpeg-wasm-full') {
      return {
        selection: {
          path: 'cpu',
          reason: `video-pipeline selected ${plan.decodePath}`,
          useDemuxer: false,
        },
        metadata: plannedMetadata,
      };
    }

    // Use extended capabilities + strategy registry to reduce failed attempts.
    // This is intentionally awaited here to avoid choosing a suboptimal path when
    // cached capabilities are still defaults on first run.
    const extendedCaps = await extendedCapabilityService.detectCapabilities();

    this.throwIfAborted(params.abortSignal);
    const codecForStrategyBase = plannedMetadata?.codec ?? plan.track?.codec ?? 'unknown';
    const codecForStrategy =
      import.meta.env.DEV &&
      devOverrides &&
      devOverrides.forcedStrategyCodec &&
      devOverrides.forcedStrategyCodec !== 'auto'
        ? devOverrides.forcedStrategyCodec
        : codecForStrategyBase;

    const strategy = strategyRegistryService.getStrategy({
      codec: codecForStrategy,
      format,
      container: plan.container,
      capabilities: extendedCaps,
      durationSeconds: plannedMetadata?.duration,
    });

    if (import.meta.env.DEV) {
      logger.debug('conversion', 'Auto-selection inputs (dev)', {
        format,
        container: plan.container,
        codec: codecForStrategy,
        demuxerAvailable: plan.demuxer !== null,
        hardwareAccelerated: extendedCaps.hardwareAccelerated,
        crossOriginIsolated: extendedCaps.crossOriginIsolated,
        sharedArrayBuffer: extendedCaps.sharedArrayBuffer,
        workerSupport: extendedCaps.workerSupport,
      });
    }

    const strategyPath: PathSelection['path'] =
      strategy.preferredPath === 'gpu' || strategy.preferredPath === 'cpu'
        ? strategy.preferredPath
        : 'gpu';

    const selection: PathSelection = {
      path: strategyPath,
      reason: strategy.reason,
      // Demuxer availability only (actual capture mode selection happens inside the WebCodecs services).
      useDemuxer: plan.demuxer !== null,
    };

    // User-forced FFmpeg palette encoding for AV1 should stay on GPU path (WebCodecs decode),
    // but we want logs/debug state to reflect the explicit preference.
    if (format === 'gif' && gifEncoderPreference === 'ffmpeg-palette') {
      const codec = codecForStrategy;
      if (isAv1Codec(codec)) {
        selection.path = 'gpu';
        selection.reason =
          'User forced FFmpeg palettegen/paletteuse (WebCodecs decode + FFmpeg frame-sequence encode)';
      }
    }

    if (import.meta.env.DEV && devOverrides) {
      if (devOverrides.forcedPath === 'gpu') {
        selection.path = 'gpu';
        selection.reason = 'Dev override forced GPU path (WebCodecs decode)';
      }

      if (devOverrides.forcedPath === 'cpu') {
        selection.path = 'cpu';
        selection.reason = 'Dev override forced CPU path (FFmpeg direct)';
        selection.useDemuxer = false;
      }
    }

    if (import.meta.env.DEV) {
      setConversionAutoSelectionDebug({
        timestamp: Date.now(),
        format,
        codec: codecForStrategy,
        container: plan.container,
        plannedPath: selection.path,
        plannedReason: selection.reason,
        strategyConfidence: strategy.confidence,
        demuxerAvailable: plan.demuxer !== null,
        useDemuxerPlanned: selection.useDemuxer,
        hardwareAccelerated: extendedCaps.hardwareAccelerated,
        sharedArrayBuffer: extendedCaps.sharedArrayBuffer,
        crossOriginIsolated: extendedCaps.crossOriginIsolated,
        workerSupport: extendedCaps.workerSupport,
      });
    }

    return {
      selection,
      metadata: plannedMetadata,
    };
  }

  /**
   * Convert via WebAV path (native WebCodecs MP4 encoding)
   */
  private async convertViaWebAVPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata,
    progressReporter: ProgressReporter
  ) {
    logger.info('conversion', 'Executing WebAV path conversion', {
      format: request.format,
      codec: metadata?.codec,
    });

    conversionMetadata.encoder = 'webav';
    conversionMetadata.path = 'webav';

    if (import.meta.env.DEV) {
      updateConversionAutoSelectionDebug({
        executedPath: 'webav',
        encoderBackend: 'webav',
      });
    }

    try {
      const webavService = await this.getWebAVService();
      const blob = await webavService.convertToMP4(
        request.file,
        request.options,
        (progress: number) => {
          // Map 0-100 to conversion phase progress
          const phaseProgress = Math.round(progress);
          progressReporter.report(phaseProgress / 100);
          request.onProgress?.(phaseProgress);
        }
      );

      logger.info('conversion', 'WebAV MP4 conversion completed', {
        outputSize: `${(blob.size / 1024 / 1024).toFixed(1)}MB`,
      });

      return blob;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('conversion', 'WebAV MP4 conversion failed', {
        error: errorMessage,
      });

      // MP4 output is currently WebAV-only. The FFmpeg CPU path only supports GIF/WebP.
      // Keep this failure explicit to avoid masking the root cause with an unrelated error.
      throw new Error(
        `MP4 conversion failed. This build currently requires WebAV support for MP4 output. Original error: ${errorMessage}`
      );
    }
  }

  /**
   * Convert via GPU path (WebCodecs decode + WASM encode)
   */
  private async convertViaGPUPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata,
    abortSignal: AbortSignal
  ) {
    logger.info('conversion', 'Executing GPU path conversion', {
      format: request.format,
      codec: metadata?.codec,
    });

    // GPU path only supports GIF/WebP formats
    if (request.format !== 'gif' && request.format !== 'webp') {
      if (import.meta.env.DEV) {
        const overrides = getDevConversionOverrides();
        if (overrides.forcedPath === 'gpu' && overrides.disableFallback) {
          throw new Error(
            `Dev override forced GPU path with fallback disabled, but format '${request.format}' is not supported by GPU path.`
          );
        }
      }

      logger.warn('conversion', 'GPU path does not support this format, falling back to FFmpeg', {
        format: request.format,
      });
      return this.convertViaCPUPath(request, metadata, conversionMetadata, abortSignal);
    }

    if (import.meta.env.DEV && request.format === 'gif') {
      const overrides = getDevConversionOverrides();
      if (overrides.forcedGifEncoder === 'ffmpeg-direct') {
        const message =
          'Dev override forced GIF encoder ffmpeg-direct, but GPU path was selected/executed.';

        if (overrides.disableFallback) {
          throw new Error(`${message} Disable fallback is enabled, refusing to continue.`);
        }

        logger.warn('conversion', `${message} Falling back to CPU path.`, {
          codec: metadata?.codec,
        });

        return this.convertViaCPUPath(request, metadata, conversionMetadata, abortSignal);
      }
    }

    // For AV1 and other WebCodecs-required codecs, use WebCodecs service
    conversionMetadata.encoder = 'webcodecs';
    conversionMetadata.path = 'gpu';

    if (import.meta.env.DEV) {
      updateConversionAutoSelectionDebug({
        executedPath: 'gpu',
        encoderBackend: 'webcodecs',
      });
    }

    // Use WebCodecs conversion service for GPU-accelerated decoding
    const { webcodecsConversionService } = await import('@services/webcodecs-conversion-service');
    const result = await webcodecsConversionService.convert(
      request.file,
      request.format,
      request.options,
      metadata,
      abortSignal
    );

    if (result) {
      if (import.meta.env.DEV) {
        updateConversionAutoSelectionDebug({
          captureModeUsed:
            (result as unknown as { captureModeUsed?: string }).captureModeUsed ?? null,
          encoderBackend:
            (result as unknown as { encoderBackendUsed?: string }).encoderBackendUsed ??
            conversionMetadata.encoder,
        });
      }
      return result;
    }

    // Fallback to CPU if WebCodecs fails
    if (import.meta.env.DEV) {
      const overrides = getDevConversionOverrides();
      if (overrides.forcedPath === 'gpu' && overrides.disableFallback) {
        throw new Error(
          'Dev override forced GPU path with fallback disabled, but WebCodecs conversion produced no result.'
        );
      }
    }

    logger.warn('conversion', 'GPU path (WebCodecs) failed, falling back to FFmpeg');
    return this.convertViaCPUPath(request, metadata, conversionMetadata, abortSignal);
  }

  /**
   * Note on the hybrid GIF path (WebCodecs decode → FFmpeg palette encode)
   *
   * Earlier benchmarks (Jan 2026) showed catastrophic performance when the
   * hybrid path staged frames as a PNG image sequence (heavy JS encode + VFS writes).
   *
   * The pipeline now prefers rawvideo staging (single RGBA buffer + frames.rgba),
   * which removes the PNG bottleneck and makes the hybrid path viable for AV1.
   *
   * - AV1: FFmpeg-direct decode in WASM can be unreliable; prefer WebCodecs decode.
   * - When rawvideo staging is eligible (memory headroom available), auto strategy may
   *   resolve to the FFmpeg palette encoder for better performance.
   */

  /**
   * Convert via CPU path (FFmpeg direct)
   */
  private async convertViaCPUPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata,
    abortSignal: AbortSignal
  ): Promise<Blob> {
    this.throwIfAborted(abortSignal);

    logger.info('conversion', 'Executing CPU path conversion (FFmpeg direct)', {
      format: request.format,
    });

    await this.ensureFFmpegInitialized();

    this.throwIfAborted(abortSignal);

    conversionMetadata.encoder = 'ffmpeg';
    conversionMetadata.path = 'cpu';

    if (import.meta.env.DEV) {
      updateConversionAutoSelectionDebug({
        executedPath: 'cpu',
        encoderBackend: 'ffmpeg',
      });
    }

    // Use legacy FFmpeg service (will be replaced with ffmpeg-pipeline in Phase 4)
    // Call the appropriate method based on format
    if (request.format === 'gif') {
      const blob = await ffmpegService.convertToGIF(request.file, request.options, metadata);
      this.throwIfAborted(abortSignal);
      return blob;
    } else if (request.format === 'webp') {
      const blob = await ffmpegService.convertToWebP(request.file, request.options, metadata);
      this.throwIfAborted(abortSignal);
      return blob;
    } else {
      throw new Error(`Unsupported format for CPU path: ${request.format}`);
    }
  }
}

/**
 * Global orchestrator instance
 */
const orchestrator = new ConversionOrchestrator();

/**
 * Convert video (convenience function)
 *
 * Main API function for video conversion. Use this instead of
 * directly instantiating ConversionOrchestrator.
 *
 * @param request - Conversion request
 * @returns Promise resolving to conversion response
 *
 * @example
 * const result = await convertVideo({
 *   file,
 *   format: 'gif',
 *   options: { quality: 'high', scale: 1.0 },
 *   onProgress: (p) => logger.debug('progress', 'Conversion progress', { progress: p })
 * });
 */
export async function convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
  return orchestrator.convertVideo(request);
}

/**
 * Cancel the current conversion (if any).
 */
export function cancelConversion(): void {
  orchestrator.cancel();
}
