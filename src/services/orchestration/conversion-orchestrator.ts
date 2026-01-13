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

import type { ConversionFormat, VideoMetadata } from '@t/conversion-types';
import type { VideoTrackInfo } from '@t/video-pipeline-types';
import type { WebAVMP4Service } from '@services/webav/webav-mp4-service';
import { capabilityService } from '@services/video-pipeline/capability-service';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { videoPipelineService } from '@services/video-pipeline/video-pipeline-service';
import { strategyRegistryService } from '@services/orchestration/strategy-registry-service';
import { strategyHistoryService } from '@services/orchestration/strategy-history-service';
import { isAv1Codec, isH264Codec, isHevcCodec, normalizeCodecString } from '@utils/codec-utils';
import { detectContainerFormat } from '@utils/container-utils';
import { createId } from '@utils/create-id';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { ffmpegService } from '@services/ffmpeg-service'; // Legacy service (will be replaced in Phase 4)
import { ProgressReporter } from '@services/shared/progress-reporter';
import {
  setConversionAutoSelectionDebug,
  setConversionPhaseTimingsDebug,
  updateConversionAutoSelectionDebug,
  type ConversionDebugOutcome,
} from './conversion-debug';
import { conversionMetricsService } from './conversion-metrics-service';
import type {
  ConversionMetadata,
  ConversionRequest,
  ConversionResponse,
  ConversionPath,
  ConversionStatus,
  PathSelection,
} from './types';

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
          statusMessage: 'Initializing conversion...',
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
        abortSignal: abortController.signal,
      });

      throwIfAborted();

      plannedSelection = pathSelection;
      plannedCodecForHistory = plannedMetadata?.codec ?? plannedCodecForHistory;

      // If we are taking the CPU path, ensure FFmpeg is ready and probe full metadata when needed.
      // This keeps GPU conversions from paying the FFmpeg init cost up front.
      const metadata =
        pathSelection.path === 'cpu'
          ? await this.resolveMetadata(request.file, plannedMetadata)
          : plannedMetadata;

      throwIfAborted();
      progressReporter.report(1.0);

      logger.info('conversion', 'Starting conversion', {
        file: request.file.name,
        fileSizeBytes: request.file.size,
        format: request.format,
        path: pathSelection.path,
        reason: pathSelection.reason,
        codec: metadata?.codec,
        quality: request.options.quality,
        scale: request.options.scale,
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
            request,
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
        throw new Error('Conversion cancelled by user');
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
          statusMessage: 'Complete',
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
      logger.performance('Conversion Strategy Executed', {
        codec: metadata?.codec,
        format: request.format,
        path: conversionMetadata.path,
        plannedPath: pathSelection.path,
        hadFallback: conversionMetadata.path !== pathSelection.path,
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
            statusMessage: 'Cancelled by user',
          };
        }
        throw new Error('Conversion cancelled by user');
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
          statusMessage: 'Error',
        };
      }

      const errorMessage = getErrorMessage(error);

      // Log the error without full classification (will be done in consumer)
      // to avoid redundant error processing and potential stack overflow
      logger.error('conversion', 'Conversion failed', {
        file: request.file.name,
        format: request.format,
        error: errorMessage,
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
      throw new Error('Conversion aborted');
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
  private async resolveMetadata(
    file: File,
    metadata?: VideoMetadata
  ): Promise<VideoMetadata | undefined> {
    if (metadata?.codec && metadata.codec !== 'unknown') {
      return metadata;
    }

    try {
      await this.ensureFFmpegInitialized();
      const probed = await ffmpegService.getVideoMetadata(file);

      // For complex codecs, metadata is mandatory
      const codec = probed?.codec?.toLowerCase();
      if (codec === 'av1' || codec === 'vp9' || codec === 'hevc') {
        if (!probed || !probed.duration || probed.duration === 0) {
          throw new Error(
            `Failed to extract metadata for ${codec.toUpperCase()} codec. ` +
              'This codec requires complete metadata for processing. ' +
              'The file may be corrupted or in an unsupported format.'
          );
        }
        logger.info('conversion', 'Mandatory metadata extracted for complex codec', {
          codec: probed.codec,
          duration: probed.duration,
          resolution: `${probed.width}x${probed.height}`,
        });
      }

      return probed;
    } catch (error) {
      const errorMsg = getErrorMessage(error);

      // Re-throw if it's our mandatory metadata error
      if (errorMsg.includes('Failed to extract metadata')) {
        throw error;
      }

      logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
        error: errorMsg,
      });
      return metadata;
    }
  }

  /**
   * Select conversion path (video-pipeline powered)
   */
  private async selectPath(params: {
    file: File;
    format: ConversionFormat;
    metadata?: VideoMetadata;
    abortSignal: AbortSignal;
  }): Promise<{
    selection: PathSelection;
    metadata: VideoMetadata | undefined;
  }> {
    const { file, format } = params;

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

    this.throwIfAborted(params.abortSignal);
    const plan = await videoPipelineService.planPipeline({
      file,
      format,
      abortSignal: params.abortSignal,
      metadata: params.metadata,
    });

    this.throwIfAborted(params.abortSignal);

    const plannedMetadata =
      params.metadata ??
      (plan.track ? this.buildLightweightMetadataFromTrack(plan.track) : undefined);

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
    const codecForStrategy = plannedMetadata?.codec ?? plan.track?.codec ?? 'unknown';

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

  private buildLightweightMetadataFromTrack(track: VideoTrackInfo): VideoMetadata {
    const codec = this.normalizeCodecForMetadata(track.codec);

    return {
      width: track.width,
      height: track.height,
      duration: Number.isFinite(track.duration) ? track.duration : 0,
      codec,
      framerate: Number.isFinite(track.frameRate) ? track.frameRate : 0,
      bitrate: 0,
    };
  }

  private normalizeCodecForMetadata(codec: string): string {
    const c = normalizeCodecString(codec);
    if (isAv1Codec(c)) return 'av1';
    if (isH264Codec(c)) return 'h264';
    if (isHevcCodec(c)) return 'hevc';
    if (c.includes('vp09') || c.includes('vp9')) return 'vp9';
    if (c.includes('vp08') || c.includes('vp8')) return 'vp8';
    return c.length > 0 ? c : 'unknown';
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
      logger.warn('conversion', 'GPU path does not support this format, falling back to FFmpeg', {
        format: request.format,
      });
      return this.convertViaCPUPath(request, metadata, conversionMetadata, abortSignal);
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
    logger.warn('conversion', 'GPU path (WebCodecs) failed, falling back to FFmpeg');
    return this.convertViaCPUPath(request, metadata, conversionMetadata, abortSignal);
  }

  /**
   * Note: Hybrid path (WebCodecs decode + FFmpeg encode) was benchmarked
   * in January 2026 and rejected due to catastrophic performance (47x slower
   * than CPU path). See docs/TODO.md and tmp/benchmark-analysis-2026-01-13.md
   * for details.
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
 *   onProgress: (p) => console.log(`${p}%`)
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
