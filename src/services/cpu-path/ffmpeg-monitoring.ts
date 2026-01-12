/**
 * FFmpeg Monitoring
 *
 * Watchdog timers, heartbeat progress tracking, and log silence detection
 * for FFmpeg conversion operations.
 *
 * Features:
 * - Adaptive watchdog timeout based on video characteristics
 * - Progress heartbeat for long-running operations
 * - Log silence detection with strike system
 * - Stall detection and automatic recovery
 *
 * @module cpu-path/ffmpeg-monitoring
 */

import type { ConversionQuality, VideoMetadata } from "@t/conversion-types";
import {
  calculateAdaptiveWatchdogTimeout,
  FFMPEG_INTERNALS,
} from "@utils/ffmpeg-constants";
import { logger } from "@utils/logger";

/**
 * Monitoring callbacks
 */
export interface MonitoringCallbacks {
  /** Called when progress updates */
  onProgress?: (progress: number, isHeartbeat: boolean) => void;
  /** Called when status message updates */
  onStatus?: (message: string) => void;
  /** Called when watchdog detects stall and needs termination */
  onTerminate?: () => void;
}

/**
 * Watchdog start options
 */
export interface WatchdogOptions {
  /** Video metadata for adaptive timeout calculation */
  metadata?: VideoMetadata;
  /** Conversion quality for adaptive timeout calculation */
  quality?: ConversionQuality;
  /** Output format (affects base timeout - WebP needs longer timeout) */
  format?: "gif" | "webp" | "mp4";
  /** Enable log silence detection (default: true) */
  enableLogSilenceCheck?: boolean;
}

/**
 * FFmpeg monitoring service
 *
 * Manages watchdog timers, progress heartbeats, and log silence detection
 * to ensure FFmpeg conversions don't stall indefinitely.
 */
export class FFmpegMonitoring {
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private logSilenceInterval: ReturnType<typeof setInterval> | null = null;
  private activeHeartbeats: Set<ReturnType<typeof setInterval>> = new Set();

  private lastProgressTime = 0;
  private lastLogTime = 0;
  private lastProgressValue = -1;
  private logSilenceStrikes = 0;
  private isConverting = false;
  private currentWatchdogTimeout: number =
    FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS;

  private callbacks: MonitoringCallbacks = {};

  /**
   * Set monitoring callbacks
   */
  setCallbacks(callbacks: MonitoringCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Update progress and reset watchdog
   *
   * @param progress - Progress percentage (0-100)
   * @param isHeartbeat - Whether this is a heartbeat update
   */
  updateProgress(progress: number, isHeartbeat = false): void {
    if (this.isConverting) {
      const now = Date.now();
      this.lastProgressTime = now;
      this.lastProgressValue = progress;

      // Keep the logger's conversion progress context in sync so all log lines
      // can be annotated with the current percent while converting.
      logger.setConversionProgress(progress);
    }

    this.callbacks.onProgress?.(progress, isHeartbeat);
  }

  /**
   * Update log timestamp to reset silence detection
   */
  updateLogActivity(): void {
    this.lastLogTime = Date.now();
    this.logSilenceStrikes = 0;
  }

  /**
   * Start watchdog monitoring
   *
   * Monitors conversion progress and detects stalls. Uses adaptive timeout
   * based on video characteristics (resolution, duration, quality) and format.
   * WebP format uses 360s base timeout to handle VP9/complex codec encoding.
   *
   * @param options - Watchdog configuration options
   */
  startWatchdog(options: WatchdogOptions = {}): void {
    // Idempotent start: ensure any previous timers/heartbeats are cleared first.
    // This prevents duplicate watchdog intervals from leaking across runs.
    this.stopWatchdog();

    const { metadata, quality, format, enableLogSilenceCheck = true } = options;

    this.lastProgressTime = Date.now();
    this.lastLogTime = Date.now();
    this.logSilenceStrikes = 0;
    this.isConverting = true;
    this.lastProgressValue = -1;

    // Initialize log progress decoration early so start-of-conversion logs
    // carry a progress indicator even before the first real tick arrives.
    logger.setConversionProgress(0);

    // Use format-specific base timeout
    // WebP needs longer timeout due to slow libwebp encoder with VP9/complex codecs
    const baseTimeout =
      format === "webp"
        ? FFMPEG_INTERNALS.WATCHDOG_WEBP_BASE_TIMEOUT_MS
        : FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS;

    // Calculate adaptive timeout based on video characteristics
    this.currentWatchdogTimeout = calculateAdaptiveWatchdogTimeout(
      baseTimeout,
      {
        resolution: metadata
          ? { width: metadata.width, height: metadata.height }
          : undefined,
        duration: metadata?.duration,
        quality,
      }
    );

    logger.debug("watchdog", "Watchdog started", {
      format: format || "unknown",
      baseTimeout:
        format === "webp"
          ? `${FFMPEG_INTERNALS.WATCHDOG_WEBP_BASE_TIMEOUT_MS / 1000}s`
          : `${FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS / 1000}s`,
      adaptiveTimeout: `${this.currentWatchdogTimeout / 1000}s`,
      resolution: metadata ? `${metadata.width}x${metadata.height}` : "unknown",
      duration: metadata?.duration
        ? `${metadata.duration.toFixed(1)}s`
        : "unknown",
      quality: quality || "unknown",
    });

    // Clear existing timers (defensive; stopWatchdog() already cleared these)
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.logSilenceInterval) {
      clearInterval(this.logSilenceInterval);
      this.logSilenceInterval = null;
    }

    // Start log silence detection
    if (enableLogSilenceCheck) {
      this.logSilenceInterval = setInterval(() => {
        const silenceMs = Date.now() - this.lastLogTime;
        if (silenceMs > FFMPEG_INTERNALS.LOG_SILENCE_TIMEOUT_MS) {
          this.logSilenceStrikes += 1;
          logger.warn("ffmpeg", "No FFmpeg logs detected for extended period", {
            silenceMs,
            strike: this.logSilenceStrikes,
            maxStrikes: FFMPEG_INTERNALS.LOG_SILENCE_MAX_STRIKES,
          });

          this.callbacks.onStatus?.(
            "FFmpeg encoder is unresponsive, checking..."
          );

          if (
            this.logSilenceStrikes >= FFMPEG_INTERNALS.LOG_SILENCE_MAX_STRIKES
          ) {
            logger.error(
              "ffmpeg",
              "FFmpeg produced no output after multiple checks, terminating as stalled"
            );
            this.callbacks.onStatus?.(
              "Conversion stalled - terminating (no encoder output)..."
            );
            this.callbacks.onTerminate?.();
          }
        }
      }, FFMPEG_INTERNALS.LOG_SILENCE_CHECK_INTERVAL_MS);
    }

    // Start watchdog timer
    this.watchdogTimer = setInterval(() => {
      const timeSinceProgress = Date.now() - this.lastProgressTime;
      logger.debug(
        "watchdog",
        `Watchdog check: ${(timeSinceProgress / 1000).toFixed(
          1
        )}s since last progress (timeout: ${
          this.currentWatchdogTimeout / 1000
        }s)`
      );

      if (timeSinceProgress > this.currentWatchdogTimeout) {
        logger.error(
          "watchdog",
          `Conversion stalled - no progress for ${(
            this.currentWatchdogTimeout / 1000
          ).toFixed(1)}s`,
          {
            lastProgress: this.lastProgressValue,
            timeSinceProgress: `${(timeSinceProgress / 1000).toFixed(1)}s`,
            timeout: `${(this.currentWatchdogTimeout / 1000).toFixed(1)}s`,
          }
        );
        this.callbacks.onStatus?.("Conversion stalled - terminating...");
        this.callbacks.onTerminate?.();
      }
    }, FFMPEG_INTERNALS.WATCHDOG_CHECK_INTERVAL_MS);
  }

  /**
   * Stop watchdog monitoring
   *
   * Clears all watchdog timers and resets conversion state.
   * After stopping, no watchdog checks will occur until startWatchdog() is called again.
   */
  stopWatchdog(): void {
    const hadWatchdogTimer = Boolean(this.watchdogTimer);
    const hadLogSilenceMonitor = Boolean(this.logSilenceInterval);
    const hadActiveHeartbeats = this.activeHeartbeats.size > 0;
    const wasConverting = this.isConverting;

    // Stop watchdog timer
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      logger.debug("watchdog", "Watchdog timer cleared");
    }

    // Stop log silence detection
    if (this.logSilenceInterval) {
      clearInterval(this.logSilenceInterval);
      this.logSilenceInterval = null;
      logger.debug("watchdog", "Log silence monitor cleared");
    }

    // Stop all active heartbeats
    for (const heartbeat of this.activeHeartbeats) {
      clearInterval(heartbeat);
    }
    this.activeHeartbeats.clear();

    // Mark conversion as complete
    this.isConverting = false;

    // Stop annotating log prefixes once conversion monitoring ends.
    logger.clearConversionProgress();

    // Avoid noisy duplicate reset logs when stopWatchdog() is called repeatedly.
    // Only emit when we actually transitioned from an active state.
    if (
      hadWatchdogTimer ||
      hadLogSilenceMonitor ||
      hadActiveHeartbeats ||
      wasConverting
    ) {
      logger.debug("watchdog", "Monitoring state reset");
    }
  }

  /**
   * Start progress heartbeat
   *
   * Emits synthetic progress updates for long-running operations to prevent
   * watchdog timeouts and provide user feedback.
   *
   * @param startProgress - Starting progress percentage
   * @param endProgress - Ending progress percentage
   * @param estimatedDurationSeconds - Estimated operation duration
   * @returns Interval ID for stopping the heartbeat
   */
  startProgressHeartbeat(
    startProgress: number,
    endProgress: number,
    estimatedDurationSeconds: number
  ): ReturnType<typeof setInterval> {
    const startTime = Date.now();
    const progressRange = endProgress - startProgress;

    logger.debug(
      "progress",
      `Starting heartbeat: ${startProgress}% -> ${endProgress}% (estimated ${estimatedDurationSeconds}s)`
    );

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const progressFraction = Math.min(
        elapsedSeconds / estimatedDurationSeconds,
        0.99
      );
      const currentProgress = startProgress + progressRange * progressFraction;
      const roundedProgress = Math.round(currentProgress);

      logger.debug(
        "progress",
        `Heartbeat update: ${roundedProgress}% (elapsed: ${elapsedSeconds.toFixed(
          1
        )}s, source: heartbeat)`
      );
      this.updateProgress(roundedProgress, true);
    }, FFMPEG_INTERNALS.HEARTBEAT_INTERVAL_MS);

    // Track the interval for cleanup
    this.activeHeartbeats.add(interval);
    return interval;
  }

  /**
   * Stop progress heartbeat
   *
   * @param intervalId - Interval ID from startProgressHeartbeat
   */
  stopProgressHeartbeat(
    intervalId: ReturnType<typeof setInterval> | null
  ): void {
    if (intervalId) {
      clearInterval(intervalId);
      this.activeHeartbeats.delete(intervalId);
      logger.debug("progress", "Heartbeat stopped");
    }
  }

  /**
   * Clean up all monitoring resources
   *
   * Clears all active timers and intervals to prevent memory leaks.
   */
  cleanupResources(): void {
    // Clear all active heartbeats
    for (const interval of this.activeHeartbeats) {
      clearInterval(interval);
    }
    this.activeHeartbeats.clear();

    // Clear watchdog timer
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    // Clear log silence monitor
    if (this.logSilenceInterval) {
      clearInterval(this.logSilenceInterval);
      this.logSilenceInterval = null;
      this.logSilenceStrikes = 0;
    }

    logger.debug("general", "Monitoring resources cleaned up");

    // Defensive: ensure we don't keep showing a stale conversion percent.
    logger.clearConversionProgress();
  }

  /**
   * Force cleanup of ALL monitoring resources (emergency cleanup)
   *
   * More aggressive than stopWatchdog() and cleanupResources() - clears everything
   * regardless of state and resets isConverting flag. Used in error/timeout paths
   * to guarantee no timers continue running.
   */
  forceCleanupAll(): void {
    logger.debug("watchdog", "Force cleanup initiated (clearing all timers)");

    // Clear watchdog timer
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    // Clear log silence monitor
    if (this.logSilenceInterval) {
      clearInterval(this.logSilenceInterval);
      this.logSilenceInterval = null;
      this.logSilenceStrikes = 0;
    }

    // Clear ALL active heartbeats
    const heartbeatCount = this.activeHeartbeats.size;
    for (const interval of this.activeHeartbeats) {
      clearInterval(interval);
    }
    this.activeHeartbeats.clear();

    // Reset conversion state
    this.isConverting = false;

    // Stop annotating log prefixes once we force-stop conversion monitoring.
    logger.clearConversionProgress();

    logger.info("watchdog", "Force cleanup complete", {
      heartbeatsCleared: heartbeatCount,
      watchdogCleared: true,
      logMonitorCleared: true,
    });
  }

  /**
   * Check if watchdog is currently active
   */
  isActive(): boolean {
    return this.isConverting;
  }

  /**
   * Get current watchdog timeout
   */
  getCurrentTimeout(): number {
    return this.currentWatchdogTimeout;
  }
}
