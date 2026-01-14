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

import type { ConversionFormat, GifEncoderPreference, VideoMetadata } from '@t/conversion-types';
import type { VideoTrackInfo } from '@t/video-pipeline-types';
import type { WebAVMP4Service } from '@services/webav/webav-mp4-service';
import { capabilityService } from '@services/video-pipeline/capability-service';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { videoPipelineService } from '@services/video-pipeline/video-pipeline-service';
import { strategyRegistryService } from '@services/orchestration/strategy-registry-service';
import { strategyHistoryService } from '@services/orchestration/strategy-history-service';
import {
  isAv1Codec,
  isH264Codec,
  isHevcCodec,
  isVp9Codec,
  normalizeCodecString,
} from '@utils/codec-utils';
import { detectContainerFormat } from '@utils/container-utils';
import { createId } from '@utils/create-id';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { QUALITY_PRESETS } from '@utils/constants';
import { getOptimalFPS } from '@utils/quality-optimizer';
import { ffmpegService } from '@services/ffmpeg-service'; // Legacy service (will be replaced in Phase 4)
import { ProgressReporter } from '@services/shared/progress-reporter';
import { computeRawvideoEligibility } from '@services/webcodecs/conversion/rawvideo-eligibility';
import {
  setConversionAutoSelectionDebug,
  setConversionPhaseTimingsDebug,
  updateConversionAutoSelectionDebug,
  type ConversionDebugOutcome,
} from './conversion-debug';
import { conversionMetricsService } from './conversion-metrics-service';
import { getDevConversionOverrides } from './dev-conversion-overrides';
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
          ? await this.resolveMetadata(request.file, plannedMetadata)
          : plannedMetadata;

      throwIfAborted();
      progressReporter.report(1.0);

      // Resolve the *effective* GIF encoder strategy for this run.
      // Notes:
      // - The UI no longer exposes encoder choice.
      // - We still keep an internal hint field (options.gifEncoder) so the orchestrator can
      //   route complex codecs through a faster FFmpeg palette path when safe.
      const requestedGifEncoder: GifEncoderPreference | null =
        request.format === 'gif' ? (request.options.gifEncoder ?? 'auto') : null;

      const devOverrides = import.meta.env.DEV ? getDevConversionOverrides() : null;
      const hasDevForcedGifEncoder =
        request.format === 'gif' && !!devOverrides && devOverrides.forcedGifEncoder !== 'auto';

      const effectiveOptions = { ...request.options };
      let effectiveGifEncoder: GifEncoderPreference | null = requestedGifEncoder;

      if (
        request.format === 'gif' &&
        devOverrides &&
        devOverrides.forcedGifEncoder === 'ffmpeg-palette'
      ) {
        effectiveOptions.gifEncoder = 'ffmpeg-palette';
        effectiveGifEncoder = 'ffmpeg-palette';
      }

      if (
        request.format === 'gif' &&
        requestedGifEncoder === 'auto' &&
        pathSelection.path === 'gpu' &&
        !hasDevForcedGifEncoder
      ) {
        const caps = extendedCapabilityService.getCached();

        const codec = metadata?.codec;
        const isComplexGifCodec = isAv1Codec(codec) || isHevcCodec(codec) || isVp9Codec(codec);

        // Session-local learning: prefer the GIF encoder that is most stable on this device.
        // This is intentionally conservative for AV1 to avoid catastrophic outliers.
        const learnedGifEncoder = codec
          ? conversionMetricsService.getGifEncoderRecommendation(codec)
          : null;

        const nav = navigator as Navigator & {
          userAgentData?: { mobile?: boolean };
        };
        const isProbablyMobile =
          typeof nav.userAgentData?.mobile === 'boolean'
            ? nav.userAgentData.mobile
            : /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        // Prefer the scaled duration estimate from metadata when available.
        const preset = QUALITY_PRESETS.gif[effectiveOptions.quality];
        const presetFps = 'fps' in preset ? preset.fps : 15;
        const targetFps =
          metadata?.framerate && metadata.framerate > 0
            ? getOptimalFPS(metadata.framerate, effectiveOptions.quality, 'gif')
            : presetFps;

        const rawEligibility = computeRawvideoEligibility({
          metadata,
          targetFps,
          scale: effectiveOptions.scale,
          format: 'gif',
          intent: 'auto',
        });

        const isLowMemoryDevice =
          (typeof rawEligibility.deviceMemoryGB === 'number' &&
            rawEligibility.deviceMemoryGB < 4) ||
          (typeof rawEligibility.jsHeapSizeLimitMB === 'number' &&
            rawEligibility.jsHeapSizeLimitMB < 1536);

        const ffmpegThreadingAvailable =
          caps.crossOriginIsolated && caps.sharedArrayBuffer && caps.workerSupport;

        const durationSeconds =
          typeof metadata?.duration === 'number' && metadata.duration > 0
            ? metadata.duration
            : null;

        const computeDurationBudgetSeconds = (): number => {
          const base =
            effectiveOptions.scale === 1.0 ? 8 : effectiveOptions.scale === 0.75 ? 12 : 20;
          const qualityAdjust =
            effectiveOptions.quality === 'high' ? -2 : effectiveOptions.quality === 'low' ? 2 : 0;
          return Math.max(6, base + qualityAdjust);
        };

        const computeFrameBudget = (): number => {
          const base =
            effectiveOptions.scale === 1.0 ? 280 : effectiveOptions.scale === 0.75 ? 360 : 520;
          const qualityAdjust = effectiveOptions.quality === 'high' ? -60 : 0;
          return Math.max(180, base + qualityAdjust);
        };

        const computeRawByteRatioThreshold = (): number | null => {
          if (durationSeconds === null) {
            return null;
          }

          // Base thresholds by scale. These are intentionally conservative for auto.
          let t =
            effectiveOptions.scale === 1.0 ? 0.6 : effectiveOptions.scale === 0.75 ? 0.65 : 0.72;

          // Longer clips increase risk of allocation pressure and GC stalls.
          if (durationSeconds > 10) {
            t -= 0.1;
          } else if (durationSeconds > 6) {
            t -= 0.05;
          }

          // Higher quality tends to increase FPS and frame count.
          if (effectiveOptions.quality === 'high') {
            t -= 0.05;
          } else if (effectiveOptions.quality === 'low') {
            t += 0.03;
          }

          // Clamp to a sane range.
          return Math.min(0.78, Math.max(0.45, t));
        };

        const estimatedRawBytes = rawEligibility.estimatedRawBytes ?? 0;
        const rawByteRatio =
          rawEligibility.rawvideoMaxBytes > 0 && estimatedRawBytes > 0
            ? estimatedRawBytes / rawEligibility.rawvideoMaxBytes
            : null;
        const rawByteRatioThreshold = computeRawByteRatioThreshold();

        const durationBudgetSeconds = computeDurationBudgetSeconds();
        const withinDurationBudget =
          durationSeconds !== null &&
          Number.isFinite(durationSeconds) &&
          durationSeconds <= durationBudgetSeconds;

        const frameBudget = computeFrameBudget();
        const estimatedFramesForRaw = rawEligibility.estimatedFramesForRaw;
        const withinFrameBudget =
          typeof estimatedFramesForRaw === 'number' &&
          Number.isFinite(estimatedFramesForRaw) &&
          estimatedFramesForRaw > 0 &&
          estimatedFramesForRaw <= frameBudget;

        const withinRawByteRatioBudget =
          rawByteRatio !== null &&
          rawByteRatioThreshold !== null &&
          Number.isFinite(rawByteRatio) &&
          rawByteRatio <= rawByteRatioThreshold;

        const rawvideoHasHeadroom =
          rawEligibility.enabled &&
          estimatedRawBytes > 0 &&
          withinDurationBudget &&
          withinFrameBudget &&
          withinRawByteRatioBudget;

        // Auto strategy: for complex codecs (AV1/HEVC/VP9), prefer WebCodecs decode.
        // If we have enough memory headroom to stage rawvideo, *optionally* prefer the
        // FFmpeg palette pipeline. For AV1, only enable this automatically when the
        // session metrics indicate it is stable on this device.
        // Guardrails: avoid this path on mobile / low-memory devices.
        const shouldConsiderAutoPalette =
          isComplexGifCodec &&
          ffmpegThreadingAvailable &&
          rawvideoHasHeadroom &&
          !isProbablyMobile &&
          !isLowMemoryDevice;

        const learnedPrefersModern =
          learnedGifEncoder?.recommendedEncoder === 'modern-gif-worker' &&
          learnedGifEncoder.confidence >= 0.5;
        const learnedPrefersPalette =
          learnedGifEncoder?.recommendedEncoder === 'ffmpeg-palette' &&
          learnedGifEncoder.confidence >= 0.6;

        const allowAutoPaletteForCodec =
          // AV1 is the most sensitive to outliers; require evidence before auto-enabling.
          isAv1Codec(codec) ? learnedPrefersPalette : true;

        if (shouldConsiderAutoPalette && allowAutoPaletteForCodec && !learnedPrefersModern) {
          effectiveOptions.gifEncoder = 'ffmpeg-palette';
          effectiveGifEncoder = 'ffmpeg-palette';

          logger.info(
            'conversion',
            'Auto GIF encoder resolved to FFmpeg palette (rawvideo eligible)',
            {
              requested: requestedGifEncoder,
              resolved: effectiveGifEncoder,
              codec,
              isComplexGifCodec,
              learnedGifEncoder,
              crossOriginIsolated: caps.crossOriginIsolated,
              sharedArrayBuffer: caps.sharedArrayBuffer,
              workerSupport: caps.workerSupport,
              isProbablyMobile,
              isLowMemoryDevice,
              durationSeconds,
              durationBudgetSeconds,
              withinDurationBudget,
              targetFps,
              estimatedFramesForRaw,
              frameBudget,
              withinFrameBudget,
              estimatedRawBytes: rawEligibility.estimatedRawBytes,
              rawvideoMaxBytes: rawEligibility.rawvideoMaxBytes,
              rawByteRatio,
              rawByteRatioThreshold,
              withinRawByteRatioBudget,
              jsHeapSizeLimitMB: rawEligibility.jsHeapSizeLimitMB,
              deviceMemoryGB: rawEligibility.deviceMemoryGB,
              isMemoryCritical: rawEligibility.isMemoryCritical,
            }
          );
        } else {
          logger.debug('conversion', 'Auto GIF encoder kept default', {
            requested: requestedGifEncoder,
            resolved: requestedGifEncoder,
            codec,
            isComplexGifCodec,
            ffmpegThreadingAvailable,
            rawvideoEligible: rawEligibility.enabled,
            rawvideoHasHeadroom,
            isProbablyMobile,
            isLowMemoryDevice,
            learnedGifEncoder,
            durationSeconds,
            durationBudgetSeconds,
            withinDurationBudget,
            estimatedRawBytes: rawEligibility.estimatedRawBytes,
            rawvideoMaxBytes: rawEligibility.rawvideoMaxBytes,
            rawByteRatio,
            rawByteRatioThreshold,
            withinRawByteRatioBudget,
            estimatedFramesForRaw,
            frameBudget,
            withinFrameBudget,
            isMemoryCritical: rawEligibility.isMemoryCritical,
          });
        }
      }

      const effectiveRequest: ConversionRequest = {
        ...request,
        options: effectiveOptions,
      };

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
