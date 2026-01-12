/**
 * FFmpeg Encoder
 *
 * Direct encoding operations for GIF and WebP formats using FFmpeg.
 * Handles palette generation, frame sequence encoding, and codec transcoding.
 *
 * Features:
 * - GIF encoding with palette generation and dithering
 * - WebP encoding with timestamp support
 * - Frame sequence encoding from WebCodecs
 * - AV1/HEVC transcoding via H.264 intermediate
 * - Conversion lock to prevent concurrent operations
 *
 * @module cpu-path/ffmpeg-encoder
 */

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type {
  ConversionOptions,
  ConversionOutputBlob,
  ConversionQuality,
  VideoMetadata,
} from "@t/conversion-types";
import { classifyConversionError } from "@utils/classify-conversion-error";
import { QUALITY_PRESETS } from "@utils/constants";
import { getErrorMessage } from "@utils/error-utils";
import { FFMPEG_INTERNALS } from "@utils/ffmpeg-constants";
import { logger } from "@utils/logger";
import { isMemoryCritical } from "@utils/memory-monitor";
import { performanceTracker } from "@utils/performance-tracker";
import { calculateTimeout } from "@utils/timeout-calculator";
import { getOptimalFPS } from "@utils/quality-optimizer";
import { getTimeoutForFormat } from "@utils/timeout-calculator";
import { withTimeout } from "@utils/with-timeout";
import { getProgressLoggingArgs } from "@services/ffmpeg/args";
import { getScaleFilter } from "@services/ffmpeg/filters";
import { getThreadingArgs } from "@services/ffmpeg/threading";
import type { FFmpegCore } from "./ffmpeg-core";
import type { FFmpegMonitoring } from "./ffmpeg-monitoring";
import type { FFmpegVFS } from "./ffmpeg-vfs";

/**
 * Detect frame file extension from frame file list
 * Returns 'png' or 'jpeg' based on first frame file extension
 */
function detectFrameExtension(frameFiles?: string[]): "png" | "jpeg" {
  if (!frameFiles || frameFiles.length === 0) {
    return "png"; // Default to PNG for backward compatibility
  }

  const firstFrame = frameFiles[0];
  if (!firstFrame) {
    return "png";
  }

  const extension = firstFrame.split(".").pop()?.toLowerCase();

  if (extension === "jpg" || extension === "jpeg") {
    return "jpeg";
  }

  return "png";
}

/**
 * FFmpeg input format override for transcoding operations
 */
export interface FFmpegInputOverride {
  format: "h264";
  framerate: number;
}

/**
 * Encoder dependencies
 */
export interface EncoderDependencies {
  core: FFmpegCore;
  vfs: FFmpegVFS;
  monitoring: FFmpegMonitoring;
  onProgress?: (progress: number) => void;
  onStatusUpdate?: (message: string) => void;
  shouldCancel?: () => boolean;
}

/**
 * FFmpeg encoder
 *
 * Manages direct encoding operations for GIF and WebP formats.
 */
export class FFmpegEncoder {
  private conversionLock = false;
  private cancellationRequested = false;
  private dependencies: EncoderDependencies | null = null;

  private getDurationMs(
    metadata?: VideoMetadata,
    options?: ConversionOptions
  ): number | undefined {
    // Prefer analyzed metadata when available. Fall back to options.duration when
    // callers already provided it (both are expressed in seconds).
    const durationSeconds = metadata?.duration ?? options?.duration;

    if (
      !Number.isFinite(durationSeconds) ||
      !durationSeconds ||
      durationSeconds <= 0
    ) {
      return undefined;
    }

    return Math.round(durationSeconds * 1000);
  }

  private isFFmpegProgressKeyValueLine(line: string): boolean {
    // FFmpeg `-progress pipe:1` emits key/value pairs on stdout.
    // Logging each line is extremely noisy and makes captured dev logs hard to read.
    // We keep parsing these lines for progress, but suppress their console output.
    const key = line.split("=")[0]?.trim();
    if (!key) {
      return false;
    }

    return (
      key === "frame" ||
      key === "fps" ||
      key === "stream_0_0_q" ||
      key === "bitrate" ||
      key === "total_size" ||
      key === "out_time_us" ||
      key === "out_time_ms" ||
      key === "out_time" ||
      key === "dup_frames" ||
      key === "drop_frames" ||
      key === "speed" ||
      key === "progress"
    );
  }

  /**
   * Set encoder dependencies
   */
  setDependencies(deps: EncoderDependencies): void {
    this.dependencies = deps;
  }

  /**
   * Get dependencies
   */
  private getDeps(): EncoderDependencies {
    if (!this.dependencies) {
      throw new Error("Encoder dependencies not set");
    }
    return this.dependencies;
  }

  /**
   * Update status message
   */
  private updateStatus(message: string): void {
    this.getDeps().onStatusUpdate?.(message);
  }

  /**
   * Acquire conversion lock to prevent concurrent conversions
   */
  private acquireConversionLock(): boolean {
    if (this.conversionLock) {
      logger.warn(
        "conversion",
        "Conversion already in progress, rejecting concurrent request",
        {
          locked: this.conversionLock,
        }
      );
      return false;
    }
    this.conversionLock = true;
    return true;
  }

  /**
   * Release conversion lock
   */
  private releaseConversionLock(): void {
    this.conversionLock = false;
  }

  /**
   * Validate that FFmpeg is properly initialized
   *
   * Checks FFmpeg state and logs diagnostic information.
   *
   * @throws Error if FFmpeg is not in valid state
   */
  private validateFFmpegState(): void {
    const { core } = this.getDeps();

    if (!core.isLoaded()) {
      logger.error("conversion", "FFmpeg validation failed: not loaded", {
        isLoaded: core.isLoaded(),
        isInitializing: core.isInitializing(),
      });
      throw new Error("FFmpeg is not loaded. Please initialize FFmpeg first.");
    }

    try {
      // This will throw if FFmpeg instance is null or invalid
      core.getFFmpeg();
      logger.debug("conversion", "FFmpeg state validation passed");
    } catch (error) {
      logger.error("conversion", "FFmpeg validation failed: instance check", {
        error: getErrorMessage(error),
      });
      throw new Error(`FFmpeg instance invalid: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Create FFmpeg log handler for conversion operations
   */
  private createFFmpegLogHandler(
    totalDuration?: number,
    progressStart?: number,
    progressEnd?: number
  ): (event: { type: string; message: string }) => void {
    const { core, monitoring } = this.getDeps();

    return ({ type, message }: { type: string; message: string }) => {
      const trimmed = message.trim();
      monitoring.updateLogActivity();
      core.addLogEntry(type, message);

      // ffmpeg.wasm may emit a standalone "Aborted()" line on stderr even when the
      // exec call has already completed successfully. This is noisy and misleading
      // in dev logs, so we suppress it from console logging.
      if (type === "stderr" && trimmed === "Aborted()") {
        return;
      }

      // Suppress ultra-noisy stdout key/value lines from FFmpeg progress output.
      // These are still stored in the rolling log buffer for diagnostics.
      if (type === "stdout" && this.isFFmpegProgressKeyValueLine(trimmed)) {
        // Still allow progress parsing below.
      } else {
        logger.debug("ffmpeg", `[${type}] ${message}`);
      }

      if (
        type === "fferr" ||
        message.includes("Error") ||
        message.includes("failed")
      ) {
        logger.warn("ffmpeg", `FFmpeg warning/error: ${message}`);
      }

      // Parse progress from FFmpeg logs when native progress events don't fire
      if (
        totalDuration &&
        progressStart !== undefined &&
        progressEnd !== undefined
      ) {
        this.parseProgressFromLog(
          message,
          totalDuration,
          progressStart,
          progressEnd
        );
      }
    };
  }

  /**
   * Parse progress information from FFmpeg log messages
   */
  private parseProgressFromLog(
    message: string,
    totalDuration: number,
    progressStart: number,
    progressEnd: number
  ): void {
    const { monitoring } = this.getDeps();

    // Parse time information: "time=00:01:23.45"
    const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (timeMatch) {
      const hours = Number.parseInt(timeMatch[1] ?? "0", 10);
      const minutes = Number.parseInt(timeMatch[2] ?? "0", 10);
      const seconds = Number.parseFloat(timeMatch[3] ?? "0");
      const currentTime = hours * 3600 + minutes * 60 + seconds;

      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
      logger.debug("ffmpeg", "Parsed progress from time", {
        hours,
        minutes,
        seconds,
        currentTime,
        totalDuration,
        progressRatio,
        calculatedProgress: Math.round(calculatedProgress),
      });
      return;
    }

    // Parse progress-format output: "out_time_ms=1234"
    const outTimeMsMatch = message.match(/out_time_ms=(\d+)/);
    if (outTimeMsMatch) {
      const currentTime = Number.parseInt(outTimeMsMatch[1] ?? "0", 10) / 1000;
      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
      logger.debug("ffmpeg", "Parsed progress from out_time_ms", {
        outTimeMs: outTimeMsMatch[1],
        currentTime,
        totalDuration,
        progressRatio,
        calculatedProgress: Math.round(calculatedProgress),
      });
    }
  }

  /**
   * Build FFmpeg input arguments
   */
  private buildInputArgs(
    inputFileName: string,
    inputOverride?: FFmpegInputOverride
  ): string[] {
    if (inputOverride) {
      logger.debug("conversion", "Using input format override", {
        format: inputOverride.format,
        framerate: inputOverride.framerate,
      });
      return [
        "-f",
        inputOverride.format,
        "-r",
        inputOverride.framerate.toString(),
        "-i",
        inputFileName,
      ];
    }

    return ["-i", inputFileName];
  }

  /**
   * Enrich conversion error with context
   *
   * Safely adds error context without causing stack overflow.
   * If error classification fails, returns the original error.
   */
  private enrichConversionError(params: {
    error: unknown;
    format: "gif" | "webp";
    options: ConversionOptions;
    metadata?: VideoMetadata;
  }): Error {
    const { error, format, options, metadata } = params;
    const message = getErrorMessage(error);

    // Prevent stack overflow during error handling
    try {
      const { core } = this.getDeps();

      // Safely get logs with fallback
      let ffmpegLogs: string[] | undefined;
      try {
        ffmpegLogs = core.getRecentLogs();
      } catch {
        ffmpegLogs = undefined;
      }

      const context = classifyConversionError(
        message,
        metadata ?? null,
        { format, quality: options.quality, scale: options.scale },
        ffmpegLogs
      );

      if (error instanceof Error) {
        (error as unknown as { errorContext?: unknown }).errorContext ??=
          context;
        return error;
      }

      const enriched = new Error(message);
      (enriched as unknown as { errorContext?: unknown }).errorContext =
        context;
      return enriched;
    } catch (enrichError) {
      // If error enrichment fails, return original error
      logger.warn("conversion", "Failed to enrich error context", {
        originalError: message,
        enrichError: getErrorMessage(enrichError),
      });

      if (error instanceof Error) {
        return error;
      }

      return new Error(message);
    }
  }

  async encodeFrameSequence(params: {
    format: "gif" | "webp";
    options: ConversionOptions;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    frameFiles?: string[];
    frameTimestamps?: number[];
  }): Promise<ConversionOutputBlob> {
    const {
      format,
      options,
      frameCount,
      fps,
      durationSeconds,
      frameFiles: providedFrameFiles,
    } = params;
    const { core, vfs } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error("Another conversion is already in progress");
    }

    try {
      // Validate FFmpeg state before attempting encoding
      logger.debug("conversion", "Starting frame sequence encoding", {
        format,
        frameCount,
        fps,
        quality: options.quality,
      });

      this.validateFFmpegState();

      const ffmpeg = core.getFFmpeg();
      const outputFileName = format === "gif" ? "output.gif" : "output.webp";

      // Validate frame sequence exists
      await this.validateFrameSequence(frameCount, format);

      if (format === "gif") {
        await this.encodeFramesToGIFWithPalette(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds,
          providedFrameFiles
        );
      } else {
        await this.encodeFramesToWebP(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds,
          providedFrameFiles
        );
      }

      // Read + validate output (single pass to avoid double-reading the same file)
      const outputData = await vfs.readValidatedOutputFile(
        ffmpeg,
        outputFileName,
        format,
        "Output validation failed"
      );
      const blob = new Blob([new Uint8Array(outputData)], {
        type: format === "gif" ? "image/gif" : "image/webp",
      }) as ConversionOutputBlob;

      // Cleanup
      const frameFilesToClean = providedFrameFiles || [];
      if (frameFilesToClean.length === 0) {
        // Fallback: reconstruct frame file names if not provided (old behavior for CPU path)
        for (let i = 0; i < frameCount; i++) {
          frameFilesToClean.push(`frame${i.toString().padStart(5, "0")}.png`);
        }
      }
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [...frameFilesToClean, FFMPEG_INTERNALS.PALETTE_FILE_NAME],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format,
        options,
      });
    } finally {
      this.releaseConversionLock();
    }
  }

  /**
   * Validate frame sequence
   */
  private async validateFrameSequence(
    frameCount: number,
    format: "gif" | "webp"
  ): Promise<void> {
    logger.debug("conversion", "Validating frame sequence", {
      frameCount,
      format,
    });

    // GIF requires animation (>=2 frames), WebP supports static (1 frame)
    if (format === "gif" && frameCount < 2) {
      throw new Error("GIF requires at least 2 frames for animation");
    }

    if (frameCount < 1) {
      throw new Error("Frame sequence must contain at least 1 frame");
    }
  }

  /**
   * Encode frames to GIF with palette generation
   */
  private async encodeFramesToGIFWithPalette(
    ffmpeg: FFmpeg,
    outputFileName: string,
    settings: { fps: number; frameCount: number; quality: ConversionQuality },
    durationSeconds: number,
    frameFiles?: string[]
  ): Promise<void> {
    const { monitoring } = this.getDeps();

    const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
    const { fps, frameCount, quality } = settings;

    const qualitySettings = QUALITY_PRESETS.gif[quality];
    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const paletteEnd = 70;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;

    // Detect frame file extension (PNG or JPEG) for correct FFmpeg input pattern
    const frameExtension = detectFrameExtension(frameFiles);
    const inputPattern = `frame_%06d.${frameExtension}`;

    logger.info("conversion", "Generating GIF palette from frame sequence", {
      frameCount,
      fps,
      colors: qualitySettings.colors,
      frameFormat: frameExtension,
    });

    // Generate palette
    const paletteThreadArgs = getThreadingArgs("filter-complex");
    // Use concat instead of spread to prevent stack overflow
    const paletteCmd = ([] as string[])
      .concat(Array.from(paletteThreadArgs))
      .concat([
        "-framerate",
        fps.toString(),
        "-i",
        inputPattern,
        "-vf",
        `palettegen=max_colors=${qualitySettings.colors}`,
        "-update",
        "1",
        paletteFileName,
      ]);

    const paletteLogHandler = this.createFFmpegLogHandler(
      durationSeconds,
      encodeStart,
      paletteEnd
    );
    ffmpeg.on("log", paletteLogHandler);

    const paletteHeartbeat = monitoring.startProgressHeartbeat(
      encodeStart,
      paletteEnd,
      Math.max(15, Math.min(durationSeconds, 45))
    );

    // Calculate adaptive timeout for GIF palette generation
    const gifTimeout = calculateTimeout("gif", durationSeconds * 1000);

    try {
      await withTimeout(
        ffmpeg.exec(paletteCmd),
        gifTimeout,
        `WebCodecs GIF palette generation timed out after ${
          gifTimeout / 1000
        } seconds.`,
        () => {
          const { core, onStatusUpdate } = this.getDeps();
          onStatusUpdate?.("Terminating FFmpeg...");
          core.terminate();
        }
      );
    } finally {
      ffmpeg.off("log", paletteLogHandler);
      monitoring.stopProgressHeartbeat(paletteHeartbeat);
    }

    // Convert frames to GIF using palette
    const conversionThreadArgs = getThreadingArgs("filter-complex");
    const ditherMode = quality === "high" ? "sierra2_4a" : "bayer";
    // Use concat instead of spread to prevent stack overflow
    const conversionCmd = ([] as string[])
      .concat(Array.from(conversionThreadArgs))
      .concat([
        "-framerate",
        fps.toString(),
        "-i",
        inputPattern,
        "-i",
        paletteFileName,
        "-filter_complex",
        `paletteuse=dither=${ditherMode}`,
        outputFileName,
      ]);

    const conversionLogHandler = this.createFFmpegLogHandler(
      durationSeconds,
      paletteEnd,
      encodeEnd
    );
    ffmpeg.on("log", conversionLogHandler);

    const conversionHeartbeat = monitoring.startProgressHeartbeat(
      paletteEnd,
      encodeEnd,
      Math.max(20, Math.min(durationSeconds * 1.2, 60))
    );

    try {
      await withTimeout(
        ffmpeg.exec(conversionCmd),
        gifTimeout, // Reuse GIF timeout (already calculated above)
        `WebCodecs GIF conversion timed out after ${
          gifTimeout / 1000
        } seconds.`,
        () => {
          const { core, onStatusUpdate } = this.getDeps();
          onStatusUpdate?.("Terminating FFmpeg...");
          core.terminate();
        }
      );
    } finally {
      ffmpeg.off("log", conversionLogHandler);
      monitoring.stopProgressHeartbeat(conversionHeartbeat);
    }
  }

  /**
   * Encode frames to WebP
   */
  private async encodeFramesToWebP(
    ffmpeg: FFmpeg,
    outputFileName: string,
    settings: { fps: number; frameCount: number; quality: ConversionQuality },
    durationSeconds: number,
    frameFiles?: string[]
  ): Promise<void> {
    const { monitoring } = this.getDeps();

    const { fps, frameCount, quality } = settings;
    const qualitySettings = QUALITY_PRESETS.webp[quality];

    const isValidLibwebpPreset = (preset: string): boolean =>
      preset === "default" ||
      preset === "picture" ||
      preset === "photo" ||
      preset === "drawing" ||
      preset === "icon" ||
      preset === "text";

    const presetArgs = isValidLibwebpPreset(qualitySettings.preset)
      ? (["-preset", qualitySettings.preset] as const)
      : null;

    if (!presetArgs) {
      logger.warn("conversion", "Skipping unsupported libwebp preset", {
        preset: qualitySettings.preset,
      });
    }

    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;

    // Detect frame file extension (PNG or JPEG) for correct FFmpeg input pattern
    const frameExtension = detectFrameExtension(frameFiles);
    const inputPattern = `frame_%06d.${frameExtension}`;

    // WebP encoding in WASM can be slow enough to hit timeouts on larger frames.
    // Use limited multithreading when cross-origin isolation is available.
    const canUseThreads = globalThis.crossOriginIsolated === true;
    const hwConcurrency = navigator.hardwareConcurrency || 2;
    const threads = canUseThreads
      ? Math.min(4, Math.max(2, Math.floor(hwConcurrency * 0.5)))
      : 1;
    const webpThreadArgs = [
      "-threads",
      threads.toString(),
      "-filter_threads",
      "1",
    ];

    // Use concat instead of spread to prevent stack overflow
    const webpCmd = ([] as string[])
      .concat(webpThreadArgs)
      .concat([
        "-framerate",
        fps.toString(),
        "-i",
        inputPattern,
        "-c:v",
        "libwebp",
        "-lossless",
        "0",
        "-quality",
        qualitySettings.quality.toString(),
      ])
      .concat(presetArgs ? Array.from(presetArgs) : [])
      .concat([
        "-compression_level",
        qualitySettings.compressionLevel.toString(),
        "-method",
        qualitySettings.method.toString(),
        "-loop",
        "0",
        outputFileName,
      ]);

    logger.info("conversion", "Encoding frames directly to WebP", {
      frameCount,
      fps,
      quality: qualitySettings.quality,
      output: outputFileName,
      frameFormat: frameExtension,
      durationSeconds,
      preset: qualitySettings.preset,
      compressionLevel: qualitySettings.compressionLevel,
      method: qualitySettings.method,
      threads,
      canUseThreads,
    });

    const webpLogHandler = this.createFFmpegLogHandler(
      durationSeconds,
      encodeStart,
      encodeEnd
    );
    ffmpeg.on("log", webpLogHandler);

    const webpHeartbeat = monitoring.startProgressHeartbeat(
      encodeStart,
      encodeEnd,
      Math.max(15, Math.min(durationSeconds, 45))
    );

    // Calculate adaptive timeout for WebP encoding (VP9/complex codec support)
    // Base: 120s, per-second: 15s, max: 360s (6 minutes)
    const webpTimeout = calculateTimeout("webp", durationSeconds * 1000);

    try {
      await withTimeout(
        ffmpeg.exec(webpCmd),
        webpTimeout,
        `Direct WebP encoding timed out after ${webpTimeout / 1000} seconds.`,
        () => {
          const { core, onStatusUpdate } = this.getDeps();
          onStatusUpdate?.("Terminating FFmpeg...");
          core.terminate();
        }
      );
    } catch (error) {
      // CRITICAL: Stop heartbeat immediately on error to prevent interval leaks
      monitoring.stopProgressHeartbeat(webpHeartbeat);
      throw error;
    } finally {
      ffmpeg.off("log", webpLogHandler);
      // Defensive: Ensure heartbeat stopped (safe to call twice)
      monitoring.stopProgressHeartbeat(webpHeartbeat);
    }

    logger.info("conversion", "Direct WebP encoding complete");
  }

  /**
   * Convert video to GIF
   *
   * Main entry point for GIF conversion. Handles palette generation,
   * quality settings, and fallback strategies.
   */
  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    const { core, vfs, monitoring } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error("Another conversion is already in progress");
    }

    performanceTracker.startPhase("conversion");

    try {
      const ffmpeg = core.getFFmpeg();
      const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
      const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
      const outputFileName = "output.gif";

      // Ensure input file
      await vfs.ensureInputFile(ffmpeg, file);

      const quality = options.quality || "medium";
      const scale = options.scale || 1.0;
      const fps = getOptimalFPS(metadata?.framerate || 30, quality, "gif");

      const qualitySettings = QUALITY_PRESETS.gif[quality];
      const scaleFilter = getScaleFilter(quality, scale);

      logger.info("conversion", "Starting GIF conversion", {
        quality,
        scale,
        fps,
        colors: qualitySettings.colors,
      });

      const conversionTimeout = getTimeoutForFormat(
        "gif",
        this.getDurationMs(metadata, options)
      );

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START);

      // Build input args
      const inputArgs = this.buildInputArgs(inputFileName, inputOverride);

      // Generate palette
      const paletteThreadArgs = getThreadingArgs("filter-complex");
      const paletteFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps},palettegen=max_colors=${qualitySettings.colors}`
        : `fps=${fps},palettegen=max_colors=${qualitySettings.colors}`;

      // Use concat instead of spread to prevent stack overflow
      const paletteCmd = ([] as string[])
        .concat(Array.from(paletteThreadArgs))
        .concat(inputArgs)
        .concat(["-vf", paletteFilterChain, "-update", "1", paletteFileName]);

      // Log command safely without join() to prevent stack overflow
      logger.info("ffmpeg", "Palette generation command", {
        cmdLength: paletteCmd.length,
        cmdPreview: paletteCmd.slice(0, 5),
      });

      const paletteHeartbeat = monitoring.startProgressHeartbeat(
        FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START,
        FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_END,
        30
      );

      performanceTracker.startPhase("palette-gen");
      logger.performance("Starting GIF palette generation");

      try {
        try {
          // Validate command array depth to prevent stack overflow
          const maxCmdLength = 200; // Reasonable limit for command array
          if (paletteCmd.length > maxCmdLength) {
            logger.error(
              "ffmpeg",
              "Command array too large, potential stack overflow",
              {
                cmdLength: paletteCmd.length,
                maxAllowed: maxCmdLength,
              }
            );
            throw new Error(
              `FFmpeg command array too large (${paletteCmd.length} elements). ` +
                "This may indicate a configuration error."
            );
          }

          logger.info("ffmpeg", "Executing palette generation", {
            cmdLength: paletteCmd.length,
            timeout: conversionTimeout,
          });

          await withTimeout(
            ffmpeg.exec(paletteCmd),
            conversionTimeout,
            `GIF palette generation timed out after ${
              conversionTimeout / 1000
            } seconds.`,
            () => {
              const { core, onStatusUpdate } = this.getDeps();
              onStatusUpdate?.("Terminating FFmpeg...");
              core.terminate();
            }
          );

          logger.debug("ffmpeg", "Palette generation completed successfully");
        } catch (execError) {
          // Log detailed error information
          const errorMsg =
            execError instanceof Error ? execError.message : String(execError);
          const errorStack =
            execError instanceof Error ? execError.stack : undefined;

          logger.error("ffmpeg", "Palette generation failed", {
            error: errorMsg,
            errorType:
              execError instanceof Error
                ? execError.constructor.name
                : typeof execError,
            stackPreview: errorStack?.split("\n").slice(0, 3),
          });

          // Wrap FFmpeg exec errors to prevent stack overflow during error handling
          if (
            execError instanceof Error &&
            (execError.message.includes("Maximum call stack size exceeded") ||
              execError.message.includes("stack overflow"))
          ) {
            logger.error(
              "ffmpeg",
              "Stack overflow detected in FFmpeg execution",
              {
                command: "palette-gen",
                cmdLength: paletteCmd.length,
                cmdPreview: paletteCmd.slice(0, 10).join(" "),
              }
            );
            throw new Error(
              "FFmpeg palette generation failed: stack overflow in execution. " +
                "Try restarting the browser or using a simpler video file."
            );
          }
          throw execError;
        }
      } catch (error) {
        // CRITICAL: Stop heartbeat immediately on error to prevent interval leaks
        monitoring.stopProgressHeartbeat(paletteHeartbeat);
        throw error;
      } finally {
        // Defensive: Ensure heartbeat stopped (safe to call twice)
        monitoring.stopProgressHeartbeat(paletteHeartbeat);
      }

      performanceTracker.endPhase("palette-gen");
      logger.performance("GIF palette generation complete");
      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START);

      if (this.cancellationRequested) {
        throw new Error("Conversion cancelled by user");
      }

      // Convert to GIF using palette
      const conversionThreadArgs = getThreadingArgs("filter-complex");
      const ditherMode = quality === "high" ? "sierra2_4a" : "bayer";
      const gifFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps}[v];[v][1:v]paletteuse=dither=${ditherMode}`
        : `fps=${fps}[v];[v][1:v]paletteuse=dither=${ditherMode}`;

      // Use concat instead of spread to prevent stack overflow
      const gifCmd = ([] as string[])
        .concat(Array.from(conversionThreadArgs))
        .concat(inputArgs)
        .concat(["-i", paletteFileName, "-lavfi", gifFilterChain])
        .concat(Array.from(getProgressLoggingArgs()))
        .concat([outputFileName]);

      // Log command safely without join() to prevent stack overflow
      logger.debug("ffmpeg", "GIF conversion command", {
        cmdLength: gifCmd.length,
        cmdPreview: gifCmd.slice(0, 5),
      });

      logger.performance("Starting GIF encoding");

      // Register log handler for progress tracking
      const estimatedDuration = metadata?.duration || 30;
      const gifLogHandler = this.createFFmpegLogHandler(
        estimatedDuration,
        FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START,
        FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END
      );
      ffmpeg.on("log", gifLogHandler);

      const heartbeat = monitoring.startProgressHeartbeat(
        FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START,
        FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END,
        estimatedDuration
      );

      try {
        try {
          await withTimeout(
            ffmpeg.exec(gifCmd),
            conversionTimeout,
            `GIF conversion timed out after ${
              conversionTimeout / 1000
            } seconds.`,
            () => {
              const { core, onStatusUpdate } = this.getDeps();
              onStatusUpdate?.("Terminating FFmpeg...");
              core.terminate();
            }
          );
        } catch (execError) {
          // Wrap FFmpeg exec errors to prevent stack overflow during error handling
          if (
            execError instanceof Error &&
            execError.message === "Maximum call stack size exceeded"
          ) {
            logger.error(
              "ffmpeg",
              "Stack overflow detected in FFmpeg execution",
              {
                command: "gif-encode",
                cmdLength: gifCmd.length,
              }
            );
            throw new Error(
              "FFmpeg GIF encoding failed: stack overflow in execution"
            );
          }
          logger.warn(
            "conversion",
            "GIF conversion failed, will attempt cleanup"
          );
          throw execError;
        }
      } catch (error) {
        // CRITICAL: Stop heartbeat immediately on error to prevent interval leaks
        monitoring.stopProgressHeartbeat(heartbeat);
        logger.warn(
          "conversion",
          "GIF conversion failed, will attempt cleanup"
        );
        throw error;
      } finally {
        ffmpeg.off("log", gifLogHandler);
        // Defensive: Ensure heartbeat stopped (safe to call twice)
        monitoring.stopProgressHeartbeat(heartbeat);
      }

      logger.performance("GIF encoding complete");

      // Read + validate output (single pass to avoid double-reading the same file)
      const outputData = await vfs.readValidatedOutputFile(
        ffmpeg,
        outputFileName,
        "gif",
        "GIF output validation failed"
      );
      const blob = new Blob([new Uint8Array(outputData)], {
        type: "image/gif",
      }) as ConversionOutputBlob;

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE);
      logger.info("conversion", "GIF conversion completed successfully", {
        outputSize: blob.size,
      });

      // Cleanup
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [paletteFileName],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: "gif",
        options,
        metadata,
      });
    } finally {
      this.releaseConversionLock();
      performanceTracker.endPhase("conversion");
    }
  }

  /**
   * Convert video to WebP
   *
   * Main entry point for WebP conversion. Handles quality settings,
   * scaling, and fallback strategies.
   */
  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    const { core, vfs, monitoring } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error("Another conversion is already in progress");
    }

    performanceTracker.startPhase("conversion");

    try {
      const ffmpeg = core.getFFmpeg();
      const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
      const outputFileName = "output.webp";

      // Ensure input file
      await vfs.ensureInputFile(ffmpeg, file);

      const quality = options.quality || "medium";
      const scale = options.scale || 1.0;
      const fps = getOptimalFPS(metadata?.framerate || 30, quality, "webp");

      const qualitySettings = QUALITY_PRESETS.webp[quality];
      const scaleFilter = getScaleFilter(quality, scale);

      const isValidLibwebpPreset = (preset: string): boolean =>
        preset === "default" ||
        preset === "picture" ||
        preset === "photo" ||
        preset === "drawing" ||
        preset === "icon" ||
        preset === "text";

      const presetArgs = isValidLibwebpPreset(qualitySettings.preset)
        ? (["-preset", qualitySettings.preset] as const)
        : null;

      if (!presetArgs) {
        logger.warn("conversion", "Skipping unsupported libwebp preset", {
          preset: qualitySettings.preset,
        });
      }

      logger.info("conversion", "Starting WebP conversion", {
        quality,
        scale,
        fps,
      });

      const conversionTimeout = getTimeoutForFormat(
        "webp",
        this.getDurationMs(metadata, options)
      );

      monitoring.updateProgress(
        FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START
      );

      // Build input args
      const inputArgs = this.buildInputArgs(inputFileName, inputOverride);

      if (this.cancellationRequested) {
        throw new Error("Conversion cancelled by user");
      }

      // Try main conversion
      try {
        // Register log handler for progress tracking
        const estimatedDuration = metadata?.duration || 30;
        const webpLogHandler = this.createFFmpegLogHandler(
          estimatedDuration,
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END
        );
        ffmpeg.on("log", webpLogHandler);

        const heartbeat = monitoring.startProgressHeartbeat(
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END,
          estimatedDuration
        );

        const isH264Input = inputOverride?.format === "h264";
        const webpThreadArgs = getThreadingArgs(
          scaleFilter || isH264Input ? "scale-filter" : "simple"
        );

        const webpFilterArgs = scaleFilter
          ? `${scaleFilter},fps=${fps}`
          : `fps=${fps}`;

        // Use concat instead of spread to prevent stack overflow
        const webpCmd = ([] as string[])
          .concat(Array.from(webpThreadArgs))
          .concat(inputArgs)
          .concat([
            "-vf",
            webpFilterArgs,
            "-c:v",
            "libwebp",
            "-lossless",
            "0",
            "-quality",
            qualitySettings.quality.toString(),
          ])
          .concat(presetArgs ? Array.from(presetArgs) : [])
          .concat([
            "-compression_level",
            qualitySettings.compressionLevel.toString(),
            "-method",
            qualitySettings.method.toString(),
            "-loop",
            "0",
          ])
          .concat(Array.from(getProgressLoggingArgs()))
          .concat([outputFileName]);

        // Log command safely without join() to prevent stack overflow
        logger.info("ffmpeg", "WebP conversion command", {
          cmdLength: webpCmd.length,
          cmdPreview: webpCmd.slice(0, 5),
        });

        performanceTracker.startPhase("webp-encode");
        logger.performance("Starting WebP encoding");

        try {
          try {
            // Validate command array depth to prevent stack overflow
            const maxCmdLength = 200; // Reasonable limit for command array
            if (webpCmd.length > maxCmdLength) {
              logger.error(
                "ffmpeg",
                "Command array too large, potential stack overflow",
                {
                  cmdLength: webpCmd.length,
                  maxAllowed: maxCmdLength,
                }
              );
              throw new Error(
                `FFmpeg command array too large (${webpCmd.length} elements). ` +
                  "This may indicate a configuration error."
              );
            }

            logger.info("ffmpeg", "Executing WebP conversion", {
              cmdLength: webpCmd.length,
              timeout: conversionTimeout,
            });

            await withTimeout(
              ffmpeg.exec(webpCmd),
              conversionTimeout,
              `WebP conversion timed out after ${
                conversionTimeout / 1000
              } seconds.`,
              () => {
                const { core, onStatusUpdate } = this.getDeps();
                onStatusUpdate?.("Terminating FFmpeg...");
                core.terminate();
              }
            );

            logger.debug("ffmpeg", "WebP conversion completed successfully");
          } catch (execError) {
            // Log detailed error information
            const errorMsg =
              execError instanceof Error
                ? execError.message
                : String(execError);
            const errorStack =
              execError instanceof Error ? execError.stack : undefined;

            logger.error("ffmpeg", "WebP conversion failed", {
              error: errorMsg,
              errorType:
                execError instanceof Error
                  ? execError.constructor.name
                  : typeof execError,
              stackPreview: errorStack?.split("\n").slice(0, 3),
            });

            // Wrap FFmpeg exec errors to prevent stack overflow during error handling
            if (
              execError instanceof Error &&
              (execError.message.includes("Maximum call stack size exceeded") ||
                execError.message.includes("stack overflow"))
            ) {
              logger.error(
                "ffmpeg",
                "Stack overflow detected in FFmpeg execution",
                {
                  command: "webp-encode",
                  cmdLength: webpCmd.length,
                  cmdPreview: webpCmd.slice(0, 10),
                }
              );
              throw new Error(
                "FFmpeg WebP encoding failed: stack overflow in execution. " +
                  "Try restarting the browser or using a simpler video file."
              );
            }
            throw execError;
          }
        } catch (error) {
          // CRITICAL: Stop heartbeat immediately on error to prevent interval leaks
          monitoring.stopProgressHeartbeat(heartbeat);
          throw error;
        } finally {
          ffmpeg.off("log", webpLogHandler);
          // Defensive: Ensure heartbeat stopped (safe to call twice)
          monitoring.stopProgressHeartbeat(heartbeat);
        }

        performanceTracker.endPhase("webp-encode");
        logger.performance("WebP encoding complete");
      } catch (error) {
        logger.warn(
          "conversion",
          "WebP conversion failed, will attempt cleanup"
        );
        throw error;
      }

      // Read + validate output (single pass to avoid double-reading the same file)
      const outputData = await vfs.readValidatedOutputFile(
        ffmpeg,
        outputFileName,
        "webp",
        "WebP output validation failed"
      );
      const blob = new Blob([new Uint8Array(outputData)], {
        type: "image/webp",
      }) as ConversionOutputBlob;

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE);
      logger.info("conversion", "WebP conversion completed successfully", {
        outputSize: blob.size,
      });

      // Cleanup
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: "webp",
        options,
        metadata,
      });
    } finally {
      this.releaseConversionLock();
      performanceTracker.endPhase("conversion");
    }
  }

  /**
   * Cancel ongoing conversion
   */
  cancelConversion(): void {
    const { monitoring } = this.getDeps();
    if (!monitoring.isActive()) {
      return;
    }
    this.cancellationRequested = true;
    this.updateStatus("Cancelling conversion...");
    // Cancellation is handled via flag; monitoring stops when conversion ends
  }

  /**
   * Check if cancellation was requested
   */
  isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }
}
