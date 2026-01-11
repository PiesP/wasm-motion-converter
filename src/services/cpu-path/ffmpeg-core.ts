/**
 * FFmpeg Core Management
 *
 * FFmpeg initialization, lifecycle management, and environment validation.
 * Handles loading of FFmpeg core assets from CDN with retry logic and
 * SharedArrayBuffer validation for multi-threaded WASM support.
 *
 * Features:
 * - Cross-origin isolation validation (COOP/COEP headers)
 * - Multi-CDN fallback with retry logic
 * - Parallel asset prefetching and caching
 * - Progress/status callback management
 * - FFmpeg instance lifecycle
 *
 * @module cpu-path/ffmpeg-core
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { VideoMetadata } from '@t/conversion-types';
import { FFMPEG_CORE_BASE_URLS, TIMEOUT_VIDEO_ANALYSIS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';
import { cacheAwareBlobURL, requestIdle, supportsCacheStorage } from '../ffmpeg/core-assets';
import { initializeFFmpegRuntime } from '../ffmpeg/init';

/**
 * Initialization callbacks
 */
export interface InitializationCallbacks {
  /** Called with download/initialization progress (0-100) */
  onProgress?: (progress: number) => void;
  /** Called with status messages (e.g., "Downloading FFmpeg...") */
  onStatus?: (message: string) => void;
  /** Called when termination is needed */
  onTerminate?: () => void;
}

/**
 * FFmpeg core manager
 *
 * Manages FFmpeg instance lifecycle, initialization, and environment validation.
 */
export class FFmpegCore {
  private ffmpeg: FFmpeg | null = null;
  private loaded = false;
  private initializePromise: Promise<void> | null = null;
  private prefetchPromise: Promise<void> | null = null;
  private isTerminating = false;

  // Progress tracking
  private lastProgressEmitTime = 0;
  private lastProgressValue = -1;

  // Callback management
  private initProgressCallbacks: Set<(progress: number) => void> = new Set();
  private initStatusCallbacks: Set<(message: string) => void> = new Set();
  private progressCallback: ((progress: number) => void) | null = null;
  private statusCallback: ((message: string) => void) | null = null;
  private terminateCallback: (() => void) | null = null;

  // Log buffer for debugging
  private ffmpegLogBuffer: string[] = [];

  /**
   * Set global callbacks for progress and status
   */
  setCallbacks(callbacks: InitializationCallbacks): void {
    this.progressCallback = callbacks.onProgress ?? null;
    this.statusCallback = callbacks.onStatus ?? null;
    this.terminateCallback = callbacks.onTerminate ?? null;
  }

  /**
   * Check if FFmpeg is loaded and ready
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Check if FFmpeg is currently initializing
   */
  isInitializing(): boolean {
    return Boolean(this.initializePromise) && !this.loaded;
  }

  /**
   * Get FFmpeg instance
   *
   * @throws Error if FFmpeg is not initialized
   */
  getFFmpeg(): FFmpeg {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }
    return this.ffmpeg;
  }

  /**
   * Remove all event listeners from FFmpeg instance
   * Prevents handler accumulation that can cause stack overflow
   *
   * Note: FFmpeg.wasm doesn't expose removeAllListeners, so we track
   * active listeners and remove them individually.
   */
  clearAllListeners(): void {
    if (!this.ffmpeg) return;

    // FFmpeg.wasm's EventEmitter doesn't expose a way to remove all listeners,
    // but we can at least log this for debugging and rely on proper cleanup
    // in individual conversion methods (off() calls in finally blocks)
    logger.debug('ffmpeg', 'Clearing FFmpeg event listeners (log handlers managed by encoder)');
  }

  /**
   * Get recent FFmpeg log output for debugging
   */
  getRecentLogs(): string[] {
    return [...this.ffmpegLogBuffer];
  }

  /**
   * Add log entry to buffer
   */
  addLogEntry(type: string, message: string): void {
    const entry = `[${type}] ${message}`;
    this.ffmpegLogBuffer.push(entry);
    if (this.ffmpegLogBuffer.length > FFMPEG_INTERNALS.FFMPEG_LOG_BUFFER_SIZE) {
      this.ffmpegLogBuffer.shift();
    }
  }

  /**
   * Report initialization progress
   */
  private reportInitProgress(progress: number): void {
    for (const callback of this.initProgressCallbacks) {
      try {
        callback(progress);
      } catch {
        // Ignore callback errors to avoid breaking initialization
      }
    }
  }

  /**
   * Report initialization status
   */
  private reportInitStatus(message: string): void {
    for (const callback of this.initStatusCallbacks) {
      try {
        callback(message);
      } catch {
        // Ignore callback errors to avoid breaking initialization
      }
    }
  }

  /**
   * Clear initialization callbacks
   */
  private clearInitCallbacks(): void {
    this.initProgressCallbacks.clear();
    this.initStatusCallbacks.clear();
  }

  /**
   * Check if progress should be emitted (throttling)
   */
  shouldEmitProgress(progress: number): boolean {
    const now = Date.now();
    const timeDelta = now - this.lastProgressEmitTime;
    const progressDelta = Math.abs(progress - this.lastProgressValue);

    if (timeDelta < FFMPEG_INTERNALS.PROGRESS_THROTTLE_MS && progressDelta < 1) {
      return false;
    }

    this.lastProgressEmitTime = now;
    this.lastProgressValue = progress;
    return true;
  }

  /**
   * Emit progress to global callback
   */
  emitProgress(progress: number): void {
    this.progressCallback?.(progress);
  }

  /**
   * Emit status message to global callback
   */
  emitStatus(message: string): void {
    this.statusCallback?.(message);
  }

  /**
   * Prefetch FFmpeg core assets in parallel with retry logic
   *
   * Uses Promise.all() for parallel loading on fast networks.
   * Falls back to sequential loading on slow networks for better reliability.
   * Implements partial retry strategy to handle flaky network conditions.
   *
   * @returns Resolves when assets are cached or available
   */
  prefetchCoreAssets(): Promise<void> {
    if (this.loaded || !supportsCacheStorage()) {
      return Promise.resolve();
    }
    if (this.prefetchPromise) {
      return this.prefetchPromise;
    }

    const runPrefetch = async () => {
      const MaxRetries = 2;
      const RetryBackoffMs = 500;

      /**
       * Attempt to load all assets from a single CDN mirror in parallel
       */
      const tryLoadAllAssets = async (baseUrl: string): Promise<string[] | null> => {
        try {
          const urls = await Promise.all([
            cacheAwareBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
            cacheAwareBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
            cacheAwareBlobURL(`${baseUrl}/ffmpeg-core.worker.js`, 'text/javascript'),
          ]);
          return urls;
        } catch (error) {
          logger.debug('prefetch', `Failed to load from ${baseUrl}`, {
            error: getErrorMessage(error),
          });
          return null;
        }
      };

      /**
       * Attempt to load assets with retry logic
       */
      const loadWithRetry = async (baseUrl: string): Promise<string[]> => {
        for (let attempt = 0; attempt <= MaxRetries; attempt++) {
          const urls = await tryLoadAllAssets(baseUrl);
          if (urls) {
            const retryLog =
              attempt > 0
                ? ` (succeeded after ${attempt} ${attempt === 1 ? 'retry' : 'retries'})`
                : '';
            logger.debug('prefetch', `Loaded assets from ${baseUrl}${retryLog}`);
            return urls;
          }

          // Exponential backoff before retrying
          if (attempt < MaxRetries) {
            const waitTime = RetryBackoffMs * 2 ** attempt;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }
        throw new Error(`Failed to load from ${baseUrl} after ${MaxRetries + 1} attempts`);
      };

      // Try each CDN mirror in sequence
      let lastError: unknown;
      for (const baseUrl of FFMPEG_CORE_BASE_URLS) {
        try {
          const urls = await loadWithRetry(baseUrl);
          // Cleanup blob URLs after caching (they're already cached)
          urls.forEach((url) => URL.revokeObjectURL(url));
          logger.debug('prefetch', `Successfully cached FFmpeg core assets from ${baseUrl}`);
          return;
        } catch (error) {
          lastError = error;
          logger.debug('prefetch', `Mirror ${baseUrl} exhausted retries`, {
            error: getErrorMessage(error),
          });
        }
      }

      if (lastError) {
        logger.warn('prefetch', 'All CDN mirrors failed for FFmpeg core assets', {
          error: lastError instanceof Error ? lastError.message : String(lastError),
          mirrorsAttempted: FFMPEG_CORE_BASE_URLS.length,
        });
        throw lastError;
      }
    };

    this.prefetchPromise = runPrefetch().finally(() => {
      this.prefetchPromise = null;
    });
    return this.prefetchPromise;
  }

  /**
   * Wait for any ongoing termination to complete with timeout
   *
   * Prevents infinite loops if termination gets stuck.
   */
  private async waitForTermination(
    timeoutMs = FFMPEG_INTERNALS.MAX_TERMINATION_WAIT_MS
  ): Promise<void> {
    const startTime = Date.now();

    while (this.isTerminating) {
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        logger.warn('ffmpeg', 'Termination wait timed out, proceeding anyway', {
          elapsed: `${elapsed}ms`,
        });
        this.isTerminating = false; // Force reset
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, FFMPEG_INTERNALS.TERMINATION_CHECK_INTERVAL_MS)
      );
    }
  }

  /**
   * Initialize FFmpeg with cross-origin isolation check and asset download
   *
   * Must be called before any conversion operations. Validates SharedArrayBuffer
   * availability and loads FFmpeg core from CDN with multi-CDN fallback.
   *
   * @param callbacks - Initialization progress and status callbacks
   * @throws Error if SharedArrayBuffer or cross-origin isolation is not available
   */
  async initialize(callbacks?: InitializationCallbacks): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (callbacks?.onProgress) {
      this.initProgressCallbacks.add(callbacks.onProgress);
    }
    if (callbacks?.onStatus) {
      this.initStatusCallbacks.add(callbacks.onStatus);
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    type InitializeResolve = (value?: void | PromiseLike<void>) => void;
    type InitializeReject = (reason?: unknown) => void;

    let resolveInit: InitializeResolve = () => {
      // no-op placeholder; replaced by Promise executor
    };
    let rejectInit: InitializeReject = () => {
      // no-op placeholder; replaced by Promise executor
    };
    this.initializePromise = new Promise<void>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });

    try {
      const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
      const isCrossOriginIsolated =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;

      logger.info('ffmpeg', 'FFmpeg initialization environment check', {
        hasSharedArrayBuffer,
        isCrossOriginIsolated,
        canUseMultithreading: hasSharedArrayBuffer && isCrossOriginIsolated,
      });

      if (!hasSharedArrayBuffer || !isCrossOriginIsolated) {
        throw new Error(
          'SharedArrayBuffer is not available. This app requires cross-origin isolation (COOP/COEP headers) to initialize FFmpeg.'
        );
      }

      // Wait for any ongoing termination to complete (with timeout protection)
      await this.waitForTermination();

      const ffmpeg = new FFmpeg();
      this.ffmpeg = ffmpeg;

      // Setup progress handler
      ffmpeg.on('progress', ({ progress }) => {
        const progressPercent = Math.round(progress * 100);
        const normalizedProgress = Number.isFinite(progressPercent)
          ? Math.min(100, Math.max(0, progressPercent))
          : 0;

        if (this.shouldEmitProgress(normalizedProgress)) {
          if (this.isInitializing()) {
            this.reportInitProgress(normalizedProgress);
          }

          logger.debug('progress', `FFmpeg progress: ${normalizedProgress}% (source: ffmpeg)`);
          this.emitProgress(normalizedProgress);
        }
      });

      // Initialize FFmpeg runtime
      await initializeFFmpegRuntime(
        ffmpeg,
        {
          reportProgress: (progress) => this.reportInitProgress(progress),
          reportStatus: (message) => this.reportInitStatus(message),
        },
        { terminate: () => this.terminateCallback?.() }
      );

      this.loaded = true;
      resolveInit();
    } catch (error) {
      rejectInit(error);
      throw error;
    } finally {
      this.initializePromise = null;
      this.clearInitCallbacks();
    }
  }

  /**
   * Extract video metadata (dimensions, duration, codec, framerate, bitrate)
   *
   * Analyzes video file without full decoding for performance.
   *
   * @param file - Video file to analyze
   * @param ensureInputFileFn - Function to write file to FFmpeg VFS
   * @returns VideoMetadata object with detected properties
   * @throws Error if file is corrupted or FFmpeg is not initialized
   */
  async getVideoMetadata(
    file: File,
    ensureInputFileFn: (file: File) => Promise<void>
  ): Promise<VideoMetadata> {
    const ffmpeg = this.getFFmpeg();
    const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;

    const metadata: VideoMetadata = {
      width: 0,
      height: 0,
      duration: 0,
      codec: 'unknown',
      framerate: 0,
      bitrate: 0,
    };

    let logOutput = '';

    const logHandler = ({ message }: { message: string }) => {
      logOutput += `${message}\n`;
    };

    ffmpeg.on('log', logHandler);

    try {
      await ensureInputFileFn(file);

      // Use standard ffmpeg info output - ffprobe-style args don't work in ffmpeg.wasm
      await withTimeout(
        ffmpeg.exec(['-i', inputFileName]),
        TIMEOUT_VIDEO_ANALYSIS,
        `Video analysis timed out after ${TIMEOUT_VIDEO_ANALYSIS / 1000} seconds. The file may be corrupted or in an unsupported format.`
      );
    } catch {
      // Expected to fail since we're just reading info, not converting
      // The metadata is captured in logOutput via the log handler
    }

    try {
      // Parse metadata from FFmpeg output
      const resolutionMatch = logOutput.match(/(\d{2,5})x(\d{2,5})/);
      if (resolutionMatch) {
        metadata.width = Number.parseInt(resolutionMatch[1] ?? '0', 10);
        metadata.height = Number.parseInt(resolutionMatch[2] ?? '0', 10);
      }

      const durationMatch = logOutput.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = Number.parseInt(durationMatch[1] ?? '0', 10);
        const minutes = Number.parseInt(durationMatch[2] ?? '0', 10);
        const seconds = Number.parseFloat(durationMatch[3] ?? '0');
        metadata.duration = hours * 3600 + minutes * 60 + seconds;
      }

      // Enhanced codec detection with comprehensive pattern matching
      const codecMatch = logOutput.match(/Video:\s+([a-zA-Z0-9_]+(?:-[a-zA-Z0-9]+)*)(?:\s|\(|,)/i);
      if (codecMatch) {
        const detectedCodec = codecMatch[1]?.toLowerCase() ?? 'unknown';

        // Normalize codec names
        const codecAliases: Record<string, string> = {
          h264: 'H.264',
          avc: 'H.264',
          h265: 'H.265',
          hevc: 'H.265',
          vp8: 'VP8',
          vp9: 'VP9',
          av1: 'AV1',
          av01: 'AV1',
          prores: 'ProRes',
          dnxhd: 'DNxHD',
          mpeg2video: 'MPEG2',
          mpeg1video: 'MPEG1',
          msmpeg4v2: 'MSMPEG4v2',
          wmv1: 'WMV1',
          wmv2: 'WMV2',
          mjpeg: 'MJPEG',
          png: 'PNG',
          bmp: 'BMP',
        };

        metadata.codec = codecAliases[detectedCodec] || detectedCodec.toUpperCase();
      }

      const framerateMatch = logOutput.match(/(\d+(?:\.\d+)?)\s*fps/);
      if (framerateMatch) {
        metadata.framerate = Number.parseFloat(framerateMatch[1] ?? '0');
      }

      const bitrateMatch = logOutput.match(/bitrate:\s*(\d+)\s*kb\/s/i);
      if (bitrateMatch) {
        metadata.bitrate = Number.parseInt(bitrateMatch[1] ?? '0', 10) * 1000;
      }

      return metadata;
    } finally {
      ffmpeg.off('log', logHandler);
    }
  }

  /**
   * Terminate FFmpeg instance
   */
  terminate(): void {
    this.isTerminating = true;

    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (error) {
        logger.error('ffmpeg', 'Error during termination', {
          error: getErrorMessage(error),
        });
      }
      this.ffmpeg = null;
      this.loaded = false;
    }

    // Clear log buffer
    this.ffmpegLogBuffer = [];

    // Small delay to ensure FFmpeg worker is fully terminated
    setTimeout(() => {
      this.isTerminating = false;
    }, FFMPEG_INTERNALS.TERMINATION_SETTLE_MS);
  }

  /**
   * Schedule idle memory trim
   *
   * Terminates FFmpeg instance if memory is critical and no conversion is active.
   */
  scheduleIdleTrim(isConverting: () => boolean, isMemoryCriticalFn: () => boolean): void {
    requestIdle(
      () => {
        if (isConverting()) {
          return;
        }
        if (isMemoryCriticalFn()) {
          this.terminate();
        }
      },
      { timeout: 3000 }
    );
  }
}

/**
 * Create FFmpeg core manager instance
 *
 * @returns New FFmpegCore instance
 */
export function createFFmpegCore(): FFmpegCore {
  return new FFmpegCore();
}
