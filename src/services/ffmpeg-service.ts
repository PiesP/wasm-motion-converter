import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type {
  ConversionOptions,
  ConversionQuality,
  VideoMetadata,
} from '../types/conversion-types';
import { canFFmpegDecode as canFFmpegDecodeCodec } from '../utils/codec-capabilities';
import {
  FFMPEG_CORE_BASE_URLS,
  FFMPEG_CORE_VERSION,
  QUALITY_PRESETS,
  TIMEOUT_CONVERSION,
  TIMEOUT_FFMPEG_DOWNLOAD,
  TIMEOUT_FFMPEG_INIT,
  TIMEOUT_FFMPEG_WORKER_CHECK,
  TIMEOUT_VIDEO_ANALYSIS,
} from '../utils/constants';
import { calculateAdaptiveWatchdogTimeout, FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';
import { performanceTracker } from '../utils/performance-tracker';
import { getOptimalFPS } from '../utils/quality-optimizer';
import { withTimeout } from '../utils/with-timeout';

// Legacy constants kept for backward compatibility with external timeout values
const DOWNLOAD_TIMEOUT_SECONDS = TIMEOUT_FFMPEG_DOWNLOAD / 1000;
const WORKER_CHECK_TIMEOUT_SECONDS = TIMEOUT_FFMPEG_WORKER_CHECK / 1000;
const FFMPEG_CACHE_NAME = `ffmpeg-core-${FFMPEG_CORE_VERSION}`;

const requestIdle = (callback: IdleRequestCallback, options?: IdleRequestOptions): number => {
  if (typeof requestIdleCallback !== 'undefined') {
    return requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    options?.timeout ?? 0
  );
};

const supportsCacheStorage = (): boolean => typeof caches !== 'undefined';

async function cacheAwareBlobURL(url: string, mimeType: string): Promise<string> {
  if (!supportsCacheStorage()) {
    return toBlobURL(url, mimeType);
  }

  const cache = await caches.open(FFMPEG_CACHE_NAME);
  const cachedResponse = await cache.match(url);
  if (cachedResponse) {
    const cachedBlob = await cachedResponse.blob();
    return URL.createObjectURL(cachedBlob);
  }

  const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
  if (!response.ok) {
    return toBlobURL(url, mimeType);
  }

  await cache.put(url, response.clone());
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function loadFFmpegAsset(url: string, mimeType: string, label: string): Promise<string> {
  return withTimeout(
    cacheAwareBlobURL(url, mimeType),
    TIMEOUT_FFMPEG_DOWNLOAD,
    `Downloading ${label} timed out after ${DOWNLOAD_TIMEOUT_SECONDS} seconds. Please check your network connection and ensure cdn.jsdelivr.net is reachable.`
  );
}

type WorkerIsolationStatus = {
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
};

async function verifyWorkerIsolation(): Promise<void> {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available in this browser.');
  }

  const script = `
    self.postMessage({
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      crossOriginIsolated: self.crossOriginIsolated === true,
    });
  `;

  const blobUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  let worker: Worker | null = null;

  try {
    worker = new Worker(blobUrl, { type: 'module' });
    const status = await withTimeout(
      new Promise<WorkerIsolationStatus>((resolve, reject) => {
        if (!worker) {
          reject(new Error('Failed to create FFmpeg worker.'));
          return;
        }
        worker.onmessage = (event) => resolve(event.data as WorkerIsolationStatus);
        worker.onerror = () =>
          reject(
            new Error(
              'Failed to start FFmpeg worker. Browser extensions or security settings may be blocking blob workers.'
            )
          );
      }),
      TIMEOUT_FFMPEG_WORKER_CHECK,
      `FFmpeg worker check timed out after ${WORKER_CHECK_TIMEOUT_SECONDS} seconds.`
    );

    if (!status.sharedArrayBuffer || !status.crossOriginIsolated) {
      throw new Error(
        'FFmpeg worker does not support SharedArrayBuffer. Cross-origin isolation is required for FFmpeg to run.'
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.name === 'SecurityError' ||
        error.message.includes('Failed to construct') ||
        error.message.includes('Worker')
      ) {
        throw new Error(
          'FFmpeg worker could not be created. Browser extensions or security settings may be blocking module/blob workers. Try disabling blockers or using an InPrivate window.'
        );
      }
    }
    throw error;
  } finally {
    if (worker) {
      worker.terminate();
    }
    URL.revokeObjectURL(blobUrl);
  }
}

function getOptimalThreadCount(): number {
  const cores = navigator.hardwareConcurrency || 2;
  // Use 75% of available cores for better performance on modern CPUs
  // Capped at 8 to prevent excessive resource usage
  return Math.min(Math.floor(cores * 0.75), 8);
}

/**
 * Unified threading strategy for FFmpeg operations
 * Different operations require different threading approaches to avoid ffmpeg.wasm deadlocks
 *
 * Note: Scale filters with multi-threading can provide 2-4x speedup on modern CPUs
 * However, this requires ffmpeg.wasm >= 0.12.x and may cause deadlocks on older versions
 * Current implementation uses single-threaded mode for stability
 */

/**
 * Determine optimal threading arguments for FFmpeg operations
 * Prevents deadlocks by using single-threading for complex filters
 * Implements experimental multi-threading for scale filters (controlled by feature flag)
 * @param operation Type of FFmpeg operation: 'filter-complex' | 'scale-filter' | 'simple'
 * @returns Array of FFmpeg threading command-line arguments
 * @note filter-complex always uses single threading to prevent deadlocks
 * @note scale-filter uses multi-threading only if __ENABLE_MULTI_THREAD_SCALE__ flag is true
 * @note simple operations use optimal thread count for maximum performance
 */
function getThreadingArgs(operation: 'filter-complex' | 'scale-filter' | 'simple'): string[] {
  // Feature flag for testing multi-threaded scale filters
  const enableMultiThreadScale =
    typeof window !== 'undefined' &&
    (window as Window & { __ENABLE_MULTI_THREAD_SCALE__?: boolean })
      .__ENABLE_MULTI_THREAD_SCALE__ === true;

  switch (operation) {
    case 'filter-complex':
      // Complex filter graphs need single-threaded mode to avoid deadlocks
      return ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
    case 'scale-filter': {
      // Scale filters can potentially use multi-threading with latest ffmpeg.wasm
      if (enableMultiThreadScale) {
        // Experimental: Multi-threaded scale filter (requires testing)
        const threads = Math.max(2, Math.floor(getOptimalThreadCount() / 2));
        return ['-threads', threads.toString(), '-filter_threads', threads.toString()];
      }
      // Default: Single-threaded for stability
      return ['-threads', '1', '-filter_threads', '1'];
    }
    case 'simple': {
      // Simple operations can use multi-threading
      const threads = getOptimalThreadCount();
      return ['-threads', threads.toString()];
    }
  }
}

function getScaleFilter(quality: ConversionQuality, scale: number): string | null {
  if (scale === 1.0) {
    return null; // No scaling needed at 100%
  }
  const filter = quality === 'high' ? 'lanczos' : quality === 'medium' ? 'bicubic' : 'bilinear';
  return `scale=iw*${scale}:ih*${scale}:flags=${filter}`;
}

class FFmpegService {
  private ffmpeg: FFmpeg | null = null;
  private loaded = false;
  private progressCallback: ((progress: number) => void) | null = null;
  private statusCallback: ((message: string) => void) | null = null;

  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressTime = 0;
  private isConverting = false;
  private lastProgressEmitTime = 0;
  private lastProgressValue = -1;
  private currentWatchdogTimeout: number = FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS; // Adaptive timeout
  private cachedInputKey: string | null = null;
  private inputCacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cancellationRequested = false;
  private isTerminating = false;
  private prefetchPromise: Promise<void> | null = null;
  private ffmpegLogBuffer: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private hasLoggedEnvironment = false;

  // Resource tracking for cleanup
  private activeHeartbeats: Set<ReturnType<typeof setInterval>> = new Set();
  private knownFiles: Set<string> = new Set();

  private getFFmpeg(): FFmpeg {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }
    return this.ffmpeg;
  }

  private emitProgress(progress: number, _isHeartbeat = false): void {
    if (this.isConverting) {
      this.lastProgressTime = Date.now();
      this.lastProgressValue = progress;
    }
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /**
   * Prefetch FFmpeg core assets in parallel with retry logic
   * Uses Promise.all() for parallel loading on fast networks
   * Falls back to sequential loading on slow networks for better reliability
   * Implements partial retry strategy to handle flaky network conditions
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
      const MAX_RETRIES = 2;
      const RETRY_BACKOFF_MS = 500;

      /**
       * Attempt to load all assets from a single CDN mirror in parallel
       * @param baseURL CDN mirror URL
       * @returns Array of blob URLs on success, null on failure
       */
      const tryLoadAllAssets = async (baseURL: string): Promise<string[] | null> => {
        try {
          const urls = await Promise.all([
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
          ]);
          return urls;
        } catch (error) {
          logger.debug('prefetch', `Failed to load from ${baseURL}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };

      /**
       * Attempt to load assets with retry logic
       * @param baseURL CDN mirror URL
       * @returns Blob URLs array on success
       */
      const loadWithRetry = async (baseURL: string): Promise<string[]> => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const urls = await tryLoadAllAssets(baseURL);
          if (urls) {
            const retryLog =
              attempt > 0
                ? ` (succeeded after ${attempt} ${attempt === 1 ? 'retry' : 'retries'})`
                : '';
            logger.debug('prefetch', `Loaded assets from ${baseURL}${retryLog}`);
            return urls;
          }

          // Exponential backoff before retrying
          if (attempt < MAX_RETRIES) {
            const waitTime = RETRY_BACKOFF_MS * 2 ** attempt;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }
        throw new Error(`Failed to load from ${baseURL} after ${MAX_RETRIES + 1} attempts`);
      };

      // Try each CDN mirror in sequence
      let lastError: unknown;
      for (const baseURL of FFMPEG_CORE_BASE_URLS) {
        try {
          const urls = await loadWithRetry(baseURL);
          // Cleanup blob URLs after caching (they're already cached)
          urls.forEach((url) => URL.revokeObjectURL(url));
          logger.debug('prefetch', `Successfully cached FFmpeg core assets from ${baseURL}`);
          return;
        } catch (error) {
          lastError = error;
          logger.debug('prefetch', `Mirror ${baseURL} exhausted retries`, {
            error: error instanceof Error ? error.message : String(error),
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

  private shouldEmitProgress(progress: number): boolean {
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
   * Wait for any ongoing termination to complete with timeout
   * Prevents infinite loops if termination gets stuck
   */
  private async waitForTermination(
    timeoutMs: number = FFMPEG_INTERNALS.MAX_TERMINATION_WAIT_MS
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
   * Creates a shared FFmpeg log handler for conversion operations
   * Logs all FFmpeg output, maintains a buffer of recent logs, and parses progress information
   *
   * @param totalDuration - Total duration in seconds for progress calculation (optional)
   * @param progressStart - Starting progress percentage (optional)
   * @param progressEnd - Ending progress percentage (optional)
   */
  private createFFmpegLogHandler(
    totalDuration?: number,
    progressStart?: number,
    progressEnd?: number
  ): (event: { type: string; message: string }) => void {
    return ({ type, message }: { type: string; message: string }) => {
      logger.debug('ffmpeg', `[${type}] ${message}`);

      this.ffmpegLogBuffer.push(`[${type}] ${message}`);
      if (this.ffmpegLogBuffer.length > FFMPEG_INTERNALS.FFMPEG_LOG_BUFFER_SIZE) {
        this.ffmpegLogBuffer.shift();
      }

      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
      }

      // Parse progress from FFmpeg logs when native progress events don't fire
      // This is especially useful for single-threaded filter operations
      if (totalDuration && progressStart !== undefined && progressEnd !== undefined) {
        this.parseProgressFromLog(message, totalDuration, progressStart, progressEnd);
      }
    };
  }

  /**
   * Parse progress information from FFmpeg log messages
   * Extracts frame count and time information as fallback when native progress events don't work
   */
  private parseProgressFromLog(
    message: string,
    totalDuration: number,
    progressStart: number,
    progressEnd: number
  ): void {
    // Parse time information: "time=00:01:23.45"
    const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (timeMatch) {
      const hours = Number.parseInt(timeMatch[1] ?? '0', 10);
      const minutes = Number.parseInt(timeMatch[2] ?? '0', 10);
      const seconds = Number.parseFloat(timeMatch[3] ?? '0');
      const currentTime = hours * 3600 + minutes * 60 + seconds;

      // Calculate progress as a percentage of total duration
      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      // Only emit if progress has changed significantly (avoid spam)
      if (Math.abs(calculatedProgress - this.lastProgressValue) > 0.5) {
        this.emitProgress(Math.round(calculatedProgress));
      }
      return;
    }

    // Parse frame information: "frame= 123" or "frame=123"
    const frameMatch = message.match(/frame=\s*(\d+)/);
    if (frameMatch && totalDuration > 0) {
      const currentFrame = Number.parseInt(frameMatch[1] ?? '0', 10);

      // Detect FFmpeg encoder stalls at frame 0
      if (currentFrame === 0 && message.includes('time=')) {
        const elapsedTime = Date.now() - (this.lastProgressTime || Date.now());
        if (elapsedTime > 5000) {
          logger.warn('conversion', 'FFmpeg encoder stalled at frame 0', {
            message: message.substring(0, 200),
            elapsedMs: elapsedTime,
          });
        }
      }

      // Estimate total frames based on typical frame rate (assume 30fps if unknown)
      const estimatedTotalFrames = totalDuration * 30;
      const progressRatio = Math.min(currentFrame / estimatedTotalFrames, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      // Only emit if progress has changed significantly
      if (Math.abs(calculatedProgress - this.lastProgressValue) > 0.5) {
        this.emitProgress(Math.round(calculatedProgress));
      }
    }
  }

  /**
   * Handles cleanup after conversion completes or fails
   * Manages input cache and deletes temporary files
   */
  private async handleConversionCleanup(
    outputFileName: string,
    additionalFiles: string[] = []
  ): Promise<void> {
    const files = [
      outputFileName,
      ...additionalFiles,
      FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE,
    ];

    // Manage input cache based on memory status
    if (isMemoryCritical()) {
      logger.debug('conversion', 'Memory critical - clearing cached input');
      await this.clearCachedInput();
    } else if (this.cachedInputKey) {
      logger.debug('conversion', 'Refreshing input cache with shorter TTL');
      this.setInputCache(this.cachedInputKey, FFMPEG_INTERNALS.INPUT_CACHE_POST_CONVERT_MS);
    }

    // Delete all temporary files
    await Promise.all(files.map((f) => this.safeDelete(f)));

    // Schedule idle memory trimming
    this.scheduleIdleTrim();
  }

  /**
   * Safe wrapper for writing files to FFmpeg filesystem
   * Logs and propagates errors for better debugging
   */
  private async safeWriteFile(fileName: string, data: Uint8Array | string): Promise<void> {
    const ffmpeg = this.getFFmpeg();
    try {
      await ffmpeg.writeFile(fileName, data);
      this.knownFiles.add(fileName);
      logger.debug('conversion', `Wrote file: ${fileName}`, {
        size: typeof data === 'string' ? data.length : data.byteLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('conversion', `Failed to write ${fileName}`, { error: message });
      throw new Error(`Failed to write ${fileName}: ${message}`);
    }
  }

  /**
   * Safe wrapper for reading files from FFmpeg filesystem
   * Logs and propagates errors for better debugging
   */
  private async safeReadFile(fileName: string): Promise<Uint8Array> {
    const ffmpeg = this.getFFmpeg();
    try {
      const data = await ffmpeg.readFile(fileName);
      logger.debug('conversion', `Read file: ${fileName}`, {
        size: data.length,
      });
      return new Uint8Array(data as Uint8Array);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('conversion', `Failed to read ${fileName}`, { error: message });
      throw new Error(`Failed to read ${fileName}: ${message}`);
    }
  }

  /**
   * Safe wrapper for deleting files from FFmpeg filesystem
   * Non-critical errors are logged but not propagated
   */
  private async safeDelete(fileName: string): Promise<void> {
    if (!this.ffmpeg) {
      return;
    }
    try {
      await this.ffmpeg.deleteFile(fileName);
      this.knownFiles.delete(fileName);
      logger.debug('conversion', `Deleted ${fileName}`);
    } catch (error) {
      // Silent failure - file might not exist
      logger.debug('conversion', `Could not delete ${fileName} (non-critical)`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if a file exists in FFmpeg filesystem
   * Uses Set-based tracking to avoid reading entire files into memory
   * Returns false if file doesn't exist or on error
   */
  private async safeFileExists(fileName: string): Promise<boolean> {
    if (!this.ffmpeg) {
      return false;
    }
    return this.knownFiles.has(fileName);
  }

  /**
   * Validate FFmpeg output file for correctness
   * Checks file size and basic format validity
   * @param fileName Output file to validate
   * @param expectedFormat Expected output format (gif/webp)
   * @returns Object with valid flag and optional reason for failure
   */
  private async validateOutputFile(
    fileName: string,
    expectedFormat: 'gif' | 'webp'
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      // Read file data (will throw if file doesn't exist)
      const data = await this.safeReadFile(fileName);

      // Check minimum size based on format
      const minSize =
        expectedFormat === 'gif'
          ? FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_GIF_SIZE_BYTES
          : FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_WEBP_SIZE_BYTES;

      if (data.length < minSize) {
        logger.warn('conversion', `Output file too small: ${data.length} bytes`, {
          expectedMinimum: minSize,
          format: expectedFormat,
        });
        return {
          valid: false,
          reason: `Output file too small (${data.length} bytes, expected ≥${minSize})`,
        };
      }

      // Validate file signature (magic bytes)
      if (expectedFormat === 'gif') {
        // GIF signature: "GIF89a" or "GIF87a"
        const gifSignature = String.fromCharCode(...data.slice(0, 6));
        if (!gifSignature.startsWith('GIF8')) {
          logger.warn('conversion', 'Invalid GIF signature', { signature: gifSignature });
          return { valid: false, reason: 'Invalid GIF file signature' };
        }
      } else if (expectedFormat === 'webp') {
        // WebP signature: "RIFF....WEBP"
        const riffSignature = String.fromCharCode(...data.slice(0, 4));
        const webpSignature = String.fromCharCode(...data.slice(8, 12));
        if (riffSignature !== 'RIFF' || webpSignature !== 'WEBP') {
          logger.warn('conversion', 'Invalid WebP signature', {
            riff: riffSignature,
            webp: webpSignature,
          });
          return { valid: false, reason: 'Invalid WebP file signature' };
        }
      }

      logger.debug('conversion', 'Output file validated successfully', {
        format: expectedFormat,
        size: data.length,
      });

      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('conversion', 'Failed to validate output file', { error: message });
      return { valid: false, reason: `Validation error: ${message}` };
    }
  }

  /**
   * Retry conversion with AV1-optimized decoder flags
   * Increases probe buffers and disables threading (AV1 + threads = issues)
   * @param inputFileName Input file name in FFmpeg filesystem
   * @param outputFileName Output file name
   * @param baseCommand Base FFmpeg command args (without input/threading)
   * @returns true if retry succeeded, false if failed
   */
  private async retryWithAV1DecoderTuning(
    inputFileName: string,
    outputFileName: string,
    baseCommand: string[]
  ): Promise<boolean> {
    logger.info('conversion', 'Attempting AV1 decoder retry with tuned flags');

    try {
      const ffmpeg = this.getFFmpeg();

      // AV1-optimized input flags
      const av1InputFlags = [
        '-analyzeduration',
        FFMPEG_INTERNALS.AV1_TRANSCODE.PROBE_DURATION_MS.toString(),
        '-probesize',
        (FFMPEG_INTERNALS.AV1_TRANSCODE.PROBE_SIZE_MB * 1024 * 1024).toString(),
        '-fflags',
        '+genpts', // Generate presentation timestamps
        '-threads',
        '1', // Force single-threaded (AV1 decoder has threading issues)
      ];

      const retryCommand = [...av1InputFlags, '-i', inputFileName, ...baseCommand, outputFileName];

      logger.debug('ffmpeg', 'AV1 retry command', { cmd: retryCommand.join(' ') });

      await withTimeout(
        ffmpeg.exec(retryCommand),
        TIMEOUT_CONVERSION,
        `AV1 decoder retry timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.terminateFFmpeg()
      );

      logger.info('conversion', 'AV1 decoder retry succeeded');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('conversion', 'AV1 decoder retry failed', { error: message });
      return false;
    }
  }

  /**
   * Transcode AV1 video to H.264 intermediate for better compatibility
   * 2-pass conversion: AV1→H.264 then H.264→GIF/WebP
   * @param inputFileName Original AV1 input file
   * @param outputFormat Target format
   * @param conversionCommand Command to convert H.264→output
   * @returns true if transcode succeeded, false if failed
   */
  private async transcodeToH264(
    inputFileName: string,
    outputFormat: 'gif' | 'webp',
    conversionCommand: string[],
    sourceCodec: string
  ): Promise<boolean> {
    const h264TempFile = FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE;

    logger.info('conversion', `Starting ${sourceCodec}→H.264 transcode fallback`);
    this.updateStatus(`Transcoding ${sourceCodec} to H.264 (this may take longer)...`);

    try {
      const ffmpeg = this.getFFmpeg();

      // PASS 1: codec→H.264 transcode
      const transcodeHeartbeat = this.startProgressHeartbeat(
        FFMPEG_INTERNALS.PROGRESS.AV1_TRANSCODE.DECODE_START,
        FFMPEG_INTERNALS.PROGRESS.AV1_TRANSCODE.DECODE_END,
        45 // Conservative estimate: 45 seconds
      );

      const transcodeCommand = [
        '-analyzeduration',
        FFMPEG_INTERNALS.AV1_TRANSCODE.PROBE_DURATION_MS.toString(),
        '-probesize',
        (FFMPEG_INTERNALS.AV1_TRANSCODE.PROBE_SIZE_MB * 1024 * 1024).toString(),
        '-i',
        inputFileName,
        '-c:v',
        'libx264',
        '-crf',
        FFMPEG_INTERNALS.AV1_TRANSCODE.INTERMEDIATE_CRF.toString(),
        '-preset',
        FFMPEG_INTERNALS.AV1_TRANSCODE.INTERMEDIATE_PRESET,
        '-pix_fmt',
        'yuv420p',
        '-an', // No audio
        '-threads',
        '1', // Single-threaded for stability
        h264TempFile,
      ];

      logger.debug('ffmpeg', `${sourceCodec}→H.264 transcode command`, {
        cmd: transcodeCommand.join(' '),
      });

      try {
        await withTimeout(
          ffmpeg.exec(transcodeCommand),
          TIMEOUT_CONVERSION,
          `${sourceCodec} to H.264 transcoding timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
          () => this.terminateFFmpeg()
        );
      } finally {
        this.stopProgressHeartbeat(transcodeHeartbeat);
      }

      // Verify H.264 intermediate was created
      if (!(await this.safeFileExists(h264TempFile))) {
        logger.error('conversion', 'H.264 intermediate file was not created');
        return false;
      }

      logger.info(
        'conversion',
        `${sourceCodec}→H.264 transcode complete, converting to final format`
      );
      this.updateStatus(`Converting H.264 to ${outputFormat.toUpperCase()}...`);

      // PASS 2: H.264→GIF/WebP conversion
      const convertHeartbeat = this.startProgressHeartbeat(
        FFMPEG_INTERNALS.PROGRESS.AV1_TRANSCODE.ENCODE_START,
        FFMPEG_INTERNALS.PROGRESS.AV1_TRANSCODE.ENCODE_END,
        30 // Conservative estimate: 30 seconds
      );

      // Replace input file in conversion command
      const finalCommand = conversionCommand.map((arg) =>
        arg === inputFileName ? h264TempFile : arg
      );

      logger.debug('ffmpeg', `H.264→${outputFormat} conversion command`, {
        cmd: finalCommand.join(' '),
      });

      try {
        await withTimeout(
          ffmpeg.exec(finalCommand),
          TIMEOUT_CONVERSION,
          `H.264 to ${outputFormat} conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
          () => this.terminateFFmpeg()
        );
      } finally {
        this.stopProgressHeartbeat(convertHeartbeat);
      }

      // Clean up H.264 temp file
      await this.safeDelete(h264TempFile);

      logger.info('conversion', `${sourceCodec} transcode fallback succeeded`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('conversion', `${sourceCodec} transcode fallback failed`, { error: message });

      // Clean up temp file on failure
      await this.safeDelete(h264TempFile);

      return false;
    }
  }

  /**
   * Initialize FFmpeg with cross-origin isolation check and asset download
   * Must be called before any conversion operations
   * Validates SharedArrayBuffer availability and loads FFmpeg core from CDN
   * @param onProgress Optional callback for download progress (0-100)
   * @param onStatus Optional callback for status messages (e.g., "Downloading FFmpeg...")
   * @throws Error if SharedArrayBuffer or cross-origin isolation is not available
   */
  async initialize(
    onProgress?: (progress: number) => void,
    onStatus?: (message: string) => void
  ): Promise<void> {
    if (this.loaded) {
      return;
    }

    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const isCrossOriginIsolated =
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;

    if (!hasSharedArrayBuffer || !isCrossOriginIsolated) {
      throw new Error(
        'SharedArrayBuffer is not available. This app requires cross-origin isolation (COOP/COEP headers) to initialize FFmpeg.'
      );
    }

    // Wait for any ongoing termination to complete (with timeout protection)
    await this.waitForTermination();

    const ffmpeg = new FFmpeg();
    this.ffmpeg = ffmpeg;

    ffmpeg.on('progress', ({ progress }) => {
      const progressPercent = Math.round(progress * 100);
      const normalizedProgress = Number.isFinite(progressPercent)
        ? Math.min(100, Math.max(0, progressPercent))
        : 0;

      if (this.shouldEmitProgress(normalizedProgress)) {
        if (onProgress && !this.isConverting) {
          onProgress(normalizedProgress);
        }

        logger.debug('progress', `FFmpeg progress: ${normalizedProgress}% (source: ffmpeg)`);
        this.emitProgress(normalizedProgress);
      }
    });

    let downloadProgress = 0;
    const reportProgress = (value: number) => {
      if (!onProgress) {
        return;
      }
      const clamped = Math.min(100, Math.max(0, Math.round(value)));
      onProgress(clamped);
    };
    const applyDownloadProgress = (weight: number, message: string) => (url: string) => {
      downloadProgress = Math.min(90, downloadProgress + weight);
      reportProgress(downloadProgress);
      if (onStatus) {
        onStatus(message);
      }
      return url;
    };

    const resolveFFmpegAssets = async (): Promise<[string, string, string]> => {
      let lastError: unknown;

      for (const baseURL of FFMPEG_CORE_BASE_URLS) {
        try {
          const hostLabel = (() => {
            try {
              return new URL(baseURL).host;
            } catch {
              return baseURL;
            }
          })();

          if (onStatus) {
            onStatus(`Downloading FFmpeg assets from ${hostLabel}...`);
          }

          performanceTracker.startPhase('ffmpeg-download', { cdn: hostLabel });
          logger.performance(`Starting FFmpeg asset download from ${hostLabel}`);

          return await Promise.all([
            loadFFmpegAsset(
              `${baseURL}/ffmpeg-core.js`,
              'text/javascript',
              'FFmpeg core script'
            ).then(applyDownloadProgress(10, 'FFmpeg core script downloaded.')),
            loadFFmpegAsset(
              `${baseURL}/ffmpeg-core.wasm`,
              'application/wasm',
              'FFmpeg core WASM'
            ).then(applyDownloadProgress(60, 'FFmpeg core WASM downloaded.')),
            loadFFmpegAsset(
              `${baseURL}/ffmpeg-core.worker.js`,
              'text/javascript',
              'FFmpeg worker'
            ).then(applyDownloadProgress(10, 'FFmpeg worker downloaded.')),
          ]);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError ?? new Error('Unable to download FFmpeg assets from available CDNs.');
    };

    const slowNetworkTimer =
      typeof window !== 'undefined'
        ? window.setTimeout(() => {
            if (downloadProgress < 25 && onStatus) {
              onStatus('Network seems slow. If this persists, check your connection or firewall.');
            }
          }, 12_000)
        : null;

    try {
      if (onStatus) {
        onStatus('Checking FFmpeg worker environment...');
      }
      reportProgress(2);
      await verifyWorkerIsolation();

      reportProgress(5);
      const [coreURL, wasmURL, workerURL] = await resolveFFmpegAssets();
      performanceTracker.endPhase('ffmpeg-download');
      logger.performance('FFmpeg asset download complete');

      reportProgress(Math.max(downloadProgress, 90));
      if (onStatus) {
        onStatus('Initializing FFmpeg runtime...');
      }

      performanceTracker.startPhase('ffmpeg-init');
      logger.performance('Starting FFmpeg initialization');

      await withTimeout(
        ffmpeg.load({
          coreURL,
          wasmURL,
          workerURL,
        }),
        TIMEOUT_FFMPEG_INIT,
        `FFmpeg initialization timed out after ${TIMEOUT_FFMPEG_INIT / 1000} seconds. Please check your internet connection and try again.`,
        () => this.terminateFFmpeg()
      );
      performanceTracker.endPhase('ffmpeg-init');
      logger.performance('FFmpeg initialization complete');

      reportProgress(100);
      if (onStatus) {
        onStatus('FFmpeg ready.');
      }
      this.loaded = true;
    } catch (error) {
      this.terminateFFmpeg();
      console.error('FFmpeg initialization failed:', error);
      if (error instanceof Error && error.message.includes('called FFmpeg.terminate()')) {
        throw new Error(
          'FFmpeg worker failed to initialize. This is often caused by blocked module/blob workers or strict browser security settings. Try disabling ad blockers, using an InPrivate window, or testing another browser.'
        );
      }
      throw error;
    } finally {
      if (slowNetworkTimer) {
        clearTimeout(slowNetworkTimer);
      }
    }
  }

  /**
   * Extract video metadata (dimensions, duration, codec, framerate, bitrate)
   * Analyzes video file without full decoding for performance
   * @param file Video file to analyze
   * @returns VideoMetadata object with detected properties
   * @throws Error if file is corrupted or FFmpeg is not initialized
   */
  async getVideoMetadata(file: File): Promise<VideoMetadata> {
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
      await this.ensureInputFile(file);

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
      // Handles: h264, h265, hevc, vp8, vp9, av1, av01, prores, dnxhd, etc.
      // FFmpeg output examples:
      //   - "Video: h264 (High)" -> h264
      //   - "Video: hevc (Main 10)" -> hevc
      //   - "Video: av1 (Profile 0)" -> av1
      //   - "Video: vp9 (Profile 0)" -> vp9
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

      await this.clearCachedInput();
      return metadata;
    } finally {
      ffmpeg.off('log', logHandler);
    }
  }

  private resetFFmpegLogBuffer(): void {
    this.ffmpegLogBuffer = [];
  }

  /**
   * Check if FFmpeg.wasm can decode a given codec
   * Delegates to codec-capabilities module for centralized capability management
   */
  private canFFmpegDecode(codec: string): boolean {
    return canFFmpegDecodeCodec(codec);
  }

  private needsTranscoding(metadata?: VideoMetadata): { needed: boolean; codec: string } {
    const codecStr = metadata?.codec?.toLowerCase() ?? '';

    // Check for AV1
    if (codecStr.includes('av1') || codecStr.includes('av01')) {
      return { needed: true, codec: 'AV1' };
    }

    // Check for HEVC (H.265)
    if (
      codecStr.includes('hevc') ||
      codecStr.includes('h265') ||
      codecStr.includes('h.265') ||
      codecStr.includes('hvc1') ||
      codecStr.includes('hev1')
    ) {
      return { needed: true, codec: 'HEVC' };
    }

    // Check for VP9
    if (codecStr.includes('vp9') || codecStr.includes('vp09')) {
      return { needed: true, codec: 'VP9' };
    }

    // Fallback: check FFmpeg log buffer
    const logEntry = this.ffmpegLogBuffer.find((log) => {
      const entry = log.toLowerCase();
      if (entry.includes('av1') || entry.includes('av01')) {
        return true;
      }
      if (
        entry.includes('hevc') ||
        entry.includes('h265') ||
        entry.includes('h.265') ||
        entry.includes('hvc1') ||
        entry.includes('hev1')
      ) {
        return true;
      }
      if (entry.includes('vp9') || entry.includes('vp09')) {
        return true;
      }
      return false;
    });

    if (logEntry) {
      const entry = logEntry.toLowerCase();
      if (entry.includes('av1') || entry.includes('av01')) {
        return { needed: true, codec: 'AV1' };
      }
      if (
        entry.includes('hevc') ||
        entry.includes('h265') ||
        entry.includes('h.265') ||
        entry.includes('hvc1') ||
        entry.includes('hev1')
      ) {
        return { needed: true, codec: 'HEVC' };
      }
      if (entry.includes('vp9') || entry.includes('vp09')) {
        return { needed: true, codec: 'VP9' };
      }
    }

    return { needed: false, codec: '' };
  }

  private async resolveMetadataForConversion(
    file: File,
    metadata?: VideoMetadata
  ): Promise<VideoMetadata | undefined> {
    if (metadata?.codec && metadata.codec !== 'unknown') {
      return metadata;
    }

    try {
      const analyzed = await this.getVideoMetadata(file);
      return analyzed;
    } catch (error) {
      logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
        error: error instanceof Error ? error.message : String(error),
      });
      return metadata;
    }
  }

  private logEnvironmentContext(): void {
    if (this.hasLoggedEnvironment || typeof navigator === 'undefined') {
      return;
    }

    const nav = navigator as Navigator & {
      deviceMemory?: number;
      userAgentData?: {
        brands?: { brand: string; version: string }[];
        mobile?: boolean;
        platform?: string;
      };
    };
    const brands = nav.userAgentData?.brands
      ?.map((brand) => `${brand.brand}/${brand.version}`)
      .join(', ');
    const platform = nav.userAgentData?.platform ?? navigator.platform;

    logger.info('general', 'Environment info', {
      userAgent: navigator.userAgent,
      platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: navigator.languages,
      mobile: nav.userAgentData?.mobile,
      brands,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      crossOriginIsolated:
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
      requestVideoFrameCallback:
        typeof HTMLVideoElement !== 'undefined' &&
        'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      mediaCapabilities: typeof navigator.mediaCapabilities !== 'undefined',
    });

    this.hasLoggedEnvironment = true;
  }

  private logConversionContext(
    file: File,
    format: 'gif' | 'webp',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): void {
    this.logEnvironmentContext();

    logger.info('conversion', 'Conversion context', {
      format,
      quality: options.quality,
      scale: options.scale,
      fileName: file.name,
      fileType: file.type || 'unknown',
      fileSize: file.size,
      lastModified: file.lastModified,
      duration: metadata?.duration,
      width: metadata?.width,
      height: metadata?.height,
      codec: metadata?.codec,
      framerate: metadata?.framerate,
      bitrate: metadata?.bitrate,
    });
  }

  private getFrameSequencePattern(): string {
    return `${FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX}%0${FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS}d.${FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT}`;
  }

  private getFrameInputArgs(fps: number): string[] {
    return [
      '-framerate',
      fps.toString(),
      '-start_number',
      FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER.toString(),
      '-i',
      this.getFrameSequencePattern(),
    ];
  }

  async encodeFrameSequence(params: {
    format: 'gif' | 'webp';
    options: ConversionOptions;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    frameFiles: string[];
  }): Promise<Blob> {
    if (!this.loaded || !this.ffmpeg) {
      logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
      await this.initialize();
    }
    const ffmpeg = this.getFFmpeg();
    const { format, options, frameCount, fps, durationSeconds, frameFiles } = params;
    const outputFileName = format === 'gif' ? 'output.gif' : 'output.webp';
    const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;

    try {
      await this.validateFrameSequence(frameCount, format);
      const inputArgs = this.getFrameInputArgs(fps);
      this.emitProgress(encodeStart);

      if (format === 'gif') {
        const settings = QUALITY_PRESETS.gif[options.quality];
        await this.encodeFramesToGif(
          ffmpeg,
          inputArgs,
          outputFileName,
          paletteFileName,
          options.quality,
          settings,
          durationSeconds,
          encodeStart,
          encodeEnd
        );
      } else {
        const settings = QUALITY_PRESETS.webp[options.quality];
        await this.encodeFramesToWebP(
          ffmpeg,
          inputArgs,
          outputFileName,
          settings,
          durationSeconds,
          encodeStart,
          encodeEnd,
          frameCount
        );
      }

      const validation = await this.validateOutputFile(outputFileName, format);
      if (!validation.valid) {
        throw new Error(
          `${format.toUpperCase()} conversion produced invalid output: ${validation.reason}`
        );
      }

      const data = await this.safeReadFile(outputFileName);

      await this.handleConversionCleanup(outputFileName, [
        ...frameFiles,
        ...(format === 'gif' ? [paletteFileName] : []),
      ]);

      return new Blob([new Uint8Array(data as Uint8Array)], {
        type: format === 'gif' ? 'image/gif' : 'image/webp',
      });
    } catch (error) {
      await this.safeDelete(outputFileName);
      await this.cleanupFrameFiles(frameFiles);
      if (format === 'gif') {
        await this.safeDelete(paletteFileName);
      }
      throw error;
    }
  }

  private async encodeFramesToGif(
    ffmpeg: FFmpeg,
    inputArgs: string[],
    outputFileName: string,
    paletteFileName: string,
    quality: ConversionQuality,
    settings: { fps: number; colors: number },
    durationSeconds: number,
    encodeStart: number,
    encodeEnd: number
  ): Promise<void> {
    const paletteEnd = Math.round((encodeStart + encodeEnd) / 2);
    const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
    const paletteThreadArgs = getThreadingArgs('scale-filter');
    const paletteCmd = [
      ...paletteThreadArgs,
      ...inputArgs,
      '-vf',
      `palettegen=max_colors=${settings.colors}`,
      '-update',
      '1',
      paletteFileName,
    ];

    const paletteLogHandler = this.createFFmpegLogHandler(durationSeconds, encodeStart, paletteEnd);
    ffmpeg.on('log', paletteLogHandler);

    const paletteHeartbeat = this.startProgressHeartbeat(
      encodeStart,
      paletteEnd,
      Math.max(15, Math.min(durationSeconds, 45))
    );

    try {
      await withTimeout(
        ffmpeg.exec(paletteCmd),
        TIMEOUT_CONVERSION,
        `WebCodecs GIF palette generation timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.terminateFFmpeg()
      );
    } finally {
      ffmpeg.off('log', paletteLogHandler);
      this.stopProgressHeartbeat(paletteHeartbeat);
    }

    const conversionThreadArgs = getThreadingArgs('filter-complex');
    const conversionCmd = [
      ...conversionThreadArgs,
      ...inputArgs,
      '-i',
      paletteFileName,
      '-filter_complex',
      `paletteuse=dither=${ditherMode}`,
      outputFileName,
    ];

    const conversionLogHandler = this.createFFmpegLogHandler(
      durationSeconds,
      paletteEnd,
      encodeEnd
    );
    ffmpeg.on('log', conversionLogHandler);

    const conversionHeartbeat = this.startProgressHeartbeat(
      paletteEnd,
      encodeEnd,
      Math.max(20, Math.min(durationSeconds * 1.2, 60))
    );

    try {
      await withTimeout(
        ffmpeg.exec(conversionCmd),
        TIMEOUT_CONVERSION,
        `WebCodecs GIF conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.terminateFFmpeg()
      );
    } finally {
      ffmpeg.off('log', conversionLogHandler);
      this.stopProgressHeartbeat(conversionHeartbeat);
    }
  }

  private async validateFrameSequence(frameCount: number, format: 'gif' | 'webp'): Promise<void> {
    // This is a lightweight validation using knownFiles tracking
    // More comprehensive validation happens during FFmpeg encoding
    logger.debug('conversion', 'Validating frame sequence', {
      frameCount,
      format,
    });

    // Note: Actual frame integrity validation happens when FFmpeg reads them
    // If frames are 0-byte or corrupted, FFmpeg will fail with clear errors
    // that trigger the fallback mechanism

    // GIF requires animation (>=2 frames), WebP supports static (1 frame)
    const minFrames = format === 'gif' ? 2 : 1;
    if (frameCount < minFrames) {
      throw new Error(
        `Frame sequence too small for ${format.toUpperCase()} conversion ` +
          `(minimum: ${minFrames}, got: ${frameCount})`
      );
    }
  }

  private async encodeFramesToWebP(
    ffmpeg: FFmpeg,
    inputArgs: string[],
    outputFileName: string,
    settings: {
      fps: number;
      quality: number;
      preset: string;
      compressionLevel: number;
      method: number;
    },
    durationSeconds: number,
    encodeStart: number,
    encodeEnd: number,
    frameCount: number
  ): Promise<void> {
    const isStatic = frameCount === 1;

    if (isStatic) {
      // OPTIMIZED: Direct single-frame PNG-to-WebP encoding
      const staticCmd = [
        '-i',
        `${FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX}${String(FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER).padStart(FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS, '0')}.${FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT}`,
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-quality',
        settings.quality.toString(),
        '-preset',
        settings.preset,
        '-compression_level',
        settings.compressionLevel.toString(),
        '-method',
        settings.method.toString(),
        outputFileName,
      ];

      logger.info('conversion', 'Encoding static WebP (single frame)', {
        quality: settings.quality,
        compressionLevel: settings.compressionLevel,
      });

      const logHandler = this.createFFmpegLogHandler(durationSeconds, encodeStart, encodeEnd);
      ffmpeg.on('log', logHandler);

      // Shorter timeout for single-frame encoding (30s vs 300s)
      const staticTimeout = 30_000;
      const heartbeat = this.startProgressHeartbeat(encodeStart, encodeEnd, 5);

      try {
        await withTimeout(
          ffmpeg.exec(staticCmd),
          staticTimeout,
          `Static WebP encoding timed out after ${staticTimeout / 1000}s. ` +
            `Check logs for FFmpeg stalls or WASM loading failures.`,
          () => this.terminateFFmpeg()
        );
      } finally {
        ffmpeg.off('log', logHandler);
        this.stopProgressHeartbeat(heartbeat);
      }
    } else {
      // ANIMATED: Multi-frame WebP encoding (existing logic)
      const webpThreadArgs = getThreadingArgs('simple');
      const webpCmd = [
        ...webpThreadArgs,
        ...inputArgs,
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-quality',
        settings.quality.toString(),
        '-preset',
        settings.preset,
        '-compression_level',
        Math.max(3, Math.min(settings.compressionLevel, 5)).toString(), // Cap compression level at 5 for speed
        '-method',
        Math.min(settings.method, 4).toString(), // Limit method to 4 for faster encoding
        '-deadline',
        'realtime', // Use realtime preset for fast encoding (instead of good/best)
        '-loop',
        '0',
        outputFileName,
      ];

      logger.info('conversion', 'Encoding animated WebP (multi-frame)', {
        frameCount,
        fps: settings.fps,
        quality: settings.quality,
      });

      const webpLogHandler = this.createFFmpegLogHandler(durationSeconds, encodeStart, encodeEnd);
      ffmpeg.on('log', webpLogHandler);

      const webpHeartbeat = this.startProgressHeartbeat(
        encodeStart,
        encodeEnd,
        Math.max(15, Math.min(durationSeconds, 45))
      );

      try {
        await withTimeout(
          ffmpeg.exec(webpCmd),
          TIMEOUT_CONVERSION,
          `WebCodecs WebP conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
          () => this.terminateFFmpeg()
        );
      } finally {
        ffmpeg.off('log', webpLogHandler);
        this.stopProgressHeartbeat(webpHeartbeat);
      }
    }
  }

  private async cleanupFrameFiles(frameFiles: string[]): Promise<void> {
    await Promise.all(frameFiles.map((file) => this.safeDelete(file)));
  }

  /**
   * Convert video file to animated GIF
   * Supports adaptive quality based on frame count and system memory
   * Implements fallback strategy for resource-constrained environments
   * @param file Input video file
   * @param options Conversion options (scale, quality, fps, startTime, endTime)
   * @param metadata Optional pre-analyzed video metadata to skip analysis
   * @returns Blob containing the GIF data
   * @throws Error if conversion fails after fallback attempts
   */
  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob> {
    const conversionStartTime = Date.now();

    // Check if FFmpeg needs reinitialization
    if (!this.loaded || !this.ffmpeg) {
      logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
      await this.initialize();
    }

    let ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const presetSettings = QUALITY_PRESETS.gif[quality];
    const resolvedMetadata = await this.resolveMetadataForConversion(file, metadata);
    const metadataForConversion = resolvedMetadata ?? metadata;
    const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
    const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
    const outputFileName = 'output.gif';

    // Calculate optimal FPS based on source video FPS and quality preset
    const optimalFps =
      metadataForConversion?.framerate && metadataForConversion.framerate > 0
        ? getOptimalFPS(metadataForConversion.framerate, quality, 'gif')
        : presetSettings.fps;

    // Create settings object with adaptive FPS
    const settings = {
      ...presetSettings,
      fps: optimalFps,
    };

    if (metadataForConversion?.framerate && optimalFps !== presetSettings.fps) {
      logger.info('conversion', 'Using adaptive FPS for GIF', {
        sourceFPS: metadataForConversion.framerate,
        presetFPS: presetSettings.fps,
        optimalFPS: optimalFps,
        quality,
      });
    }

    this.logConversionContext(file, 'gif', options, metadataForConversion);

    logger.info('conversion', 'Starting GIF conversion', {
      quality,
      scale,
      fps: settings.fps,
      colors: settings.colors,
      duration: metadataForConversion?.duration,
    });

    this.beginExternalConversion(metadataForConversion, quality);

    let ffmpegLogHandler: ((event: { type: string; message: string }) => void) | null = null;
    let conversionLogHandler: ((event: { type: string; message: string }) => void) | null = null;

    // Create log handler with progress parsing for palette generation
    const videoDuration = metadataForConversion?.duration;
    ffmpegLogHandler = this.createFFmpegLogHandler(
      videoDuration,
      FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START,
      FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_END
    );
    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      // Proactive codec transcoding check
      let wasTranscoded = false;
      let originalCodec = '';
      let actualInputFileName: string = inputFileName;

      const transcodeCheck = this.needsTranscoding(metadataForConversion);
      if (transcodeCheck.needed) {
        originalCodec = transcodeCheck.codec;

        // Check if FFmpeg can actually decode this codec
        if (!this.canFFmpegDecode(originalCodec)) {
          logger.warn(
            'conversion',
            `Detected ${originalCodec} codec, but FFmpeg.wasm cannot decode it (no decoder support). Skipping FFmpeg conversion - use WebCodecs path instead.`
          );
          throw new Error(
            `${originalCodec} codec is not supported by FFmpeg.wasm. This video requires hardware-accelerated decoding via WebCodecs.`
          );
        }

        logger.info(
          'conversion',
          `Detected ${originalCodec}, proactively transcoding to H.264 before GIF conversion`
        );

        // Build a temporary base command for transcoding
        const tempBaseCmd: string[] = [];
        const transcodeSuccess = await this.transcodeToH264(
          inputFileName,
          'gif',
          tempBaseCmd,
          originalCodec
        );

        if (transcodeSuccess) {
          wasTranscoded = true;
          actualInputFileName = FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE;
          logger.info(
            'conversion',
            'Proactive transcode succeeded, using H.264 intermediate for GIF conversion'
          );
        } else {
          logger.warn(
            'conversion',
            'Proactive transcode failed, continuing with original file (reactive fallback may catch it)'
          );
        }
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START);

      const scaleFilter = getScaleFilter(quality, scale);

      try {
        this.updateStatus('Generating color palette...');
        const paletteThreadArgs = getThreadingArgs('scale-filter');
        const paletteFilterChain = scaleFilter
          ? `fps=${settings.fps},${scaleFilter},palettegen=max_colors=${settings.colors}`
          : `fps=${settings.fps},palettegen=max_colors=${settings.colors}`;
        const paletteCmd = [
          ...paletteThreadArgs,
          '-i',
          actualInputFileName,
          '-vf',
          paletteFilterChain,
          '-update',
          '1', // Tell FFmpeg this is a single image, not a sequence
          paletteFileName,
        ];
        logger.debug('ffmpeg', 'Palette generation command', { cmd: paletteCmd.join(' ') });

        // Start heartbeat for palette generation to prevent watchdog timeout
        const paletteHeartbeat = this.startProgressHeartbeat(
          FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START,
          FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_END,
          30
        );

        performanceTracker.startPhase('palette-gen');
        logger.performance('Starting GIF palette generation');

        try {
          await withTimeout(
            ffmpeg.exec(paletteCmd),
            TIMEOUT_CONVERSION,
            `GIF palette generation timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
            () => this.terminateFFmpeg()
          );
        } finally {
          this.stopProgressHeartbeat(paletteHeartbeat);
        }

        performanceTracker.endPhase('palette-gen');
        logger.performance('GIF palette generation complete');
        logger.debug('conversion', 'Palette generation complete');
        this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START);

        if (this.cancellationRequested) {
          throw new Error('Conversion cancelled by user');
        }

        // Update log handler for final conversion phase with new progress range
        ffmpeg.off('log', ffmpegLogHandler);
        conversionLogHandler = this.createFFmpegLogHandler(
          videoDuration,
          FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START,
          FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END
        );
        ffmpeg.on('log', conversionLogHandler);

        this.updateStatus('Converting to GIF with palette...');
        const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
        const filterComplexThreadArgs = getThreadingArgs('filter-complex');
        const conversionFilterChain = scaleFilter
          ? `fps=${settings.fps},${scaleFilter}[x];[x][1:v]paletteuse=dither=${ditherMode}`
          : `fps=${settings.fps}[x];[x][1:v]paletteuse=dither=${ditherMode}`;
        const conversionCmd = [
          ...filterComplexThreadArgs,
          '-i',
          actualInputFileName,
          '-i',
          paletteFileName,
          '-filter_complex',
          conversionFilterChain,
          outputFileName,
        ];
        logger.debug('ffmpeg', 'GIF conversion command', { cmd: conversionCmd.join(' ') });
        await withTimeout(
          ffmpeg.exec(conversionCmd),
          TIMEOUT_CONVERSION,
          `GIF conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
          () => this.terminateFFmpeg()
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';

        // If error is due to cancellation or termination, don't attempt fallback
        if (
          errorMessage.includes('cancelled by user') ||
          (this.cancellationRequested && errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }

        console.warn(
          '[FFmpeg Service] Palette generation failed, falling back to direct conversion:',
          error
        );
        logger.warn('conversion', 'Palette generation failed, using fallback', {
          error: errorMessage,
        });
        this.updateStatus('Using fallback conversion method...');
        await this.safeDelete(paletteFileName);

        if (!this.ffmpeg || !this.loaded) {
          await this.initialize();
          ffmpeg = this.getFFmpeg();
          await this.ensureInputFile(file);
        }

        this.emitProgress(50);

        await this.convertToGIFDirect(
          actualInputFileName,
          outputFileName,
          settings,
          scaleFilter,
          file
        );
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END);

      // VALIDATE OUTPUT before reading
      const validation = await this.validateOutputFile(outputFileName, 'gif');

      if (!validation.valid) {
        logger.warn('conversion', 'GIF output validation failed', {
          reason: validation.reason,
        });

        // Check if this needs transcoding (AV1, HEVC, VP9)
        const transcodeCheck = this.needsTranscoding(metadataForConversion);

        if (transcodeCheck.needed && !this.cancellationRequested) {
          // Check if FFmpeg can actually decode this codec
          if (!this.canFFmpegDecode(transcodeCheck.codec)) {
            logger.error(
              'conversion',
              `${transcodeCheck.codec} codec detected but FFmpeg.wasm cannot decode it. Conversion impossible.`
            );
            throw new Error(
              `${transcodeCheck.codec} codec is not supported by FFmpeg.wasm. Please use WebCodecs path or convert the video to H.264 first.`
            );
          }

          logger.info(
            'conversion',
            `Detected ${transcodeCheck.codec} codec, attempting retry strategies`
          );

          // TIER 2: Retry with AV1-tuned decoder flags
          await this.safeDelete(outputFileName);
          await this.safeDelete(paletteFileName);
          this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START);

          // Reconstruct conversion command for retry
          const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
          const scaleFilter = getScaleFilter(quality, scale);
          const conversionFilterChain = scaleFilter
            ? `fps=${settings.fps},${scaleFilter}[x];[x][1:v]paletteuse=dither=${ditherMode}`
            : `fps=${settings.fps}[x];[x][1:v]paletteuse=dither=${ditherMode}`;
          const baseCmd = [
            '-i',
            inputFileName,
            '-i',
            paletteFileName,
            '-filter_complex',
            conversionFilterChain,
            outputFileName,
          ];

          const retrySuccess = await this.retryWithAV1DecoderTuning(
            inputFileName,
            outputFileName,
            baseCmd
          );

          if (retrySuccess) {
            const retryValidation = await this.validateOutputFile(outputFileName, 'gif');
            if (retryValidation.valid) {
              logger.info('conversion', 'AV1 decoder retry produced valid output');
              // Continue to read file below
            } else {
              // TIER 3: Transcode codec→H.264→GIF
              logger.info(
                'conversion',
                `Retry failed, attempting ${transcodeCheck.codec} transcode`
              );
              await this.safeDelete(outputFileName);

              const transcodeSuccess = await this.transcodeToH264(
                inputFileName,
                'gif',
                baseCmd,
                transcodeCheck.codec
              );

              if (!transcodeSuccess) {
                throw new Error(
                  `${transcodeCheck.codec} codec is not supported in this browser. ` +
                    'Please convert your video to H.264 (MP4) format using: ' +
                    'ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4 ' +
                    'then upload the converted file.'
                );
              }

              // Final validation
              const finalValidation = await this.validateOutputFile(outputFileName, 'gif');
              if (!finalValidation.valid) {
                throw new Error(
                  `GIF conversion produced invalid output: ${finalValidation.reason}`
                );
              }
            }
          } else {
            // Retry failed, try transcode
            logger.info(
              'conversion',
              `Decoder retry failed, attempting ${transcodeCheck.codec} transcode`
            );
            await this.safeDelete(outputFileName);

            const transcodeSuccess = await this.transcodeToH264(
              inputFileName,
              'gif',
              baseCmd,
              transcodeCheck.codec
            );

            if (!transcodeSuccess) {
              throw new Error(
                `${transcodeCheck.codec} codec is not supported in this browser. ` +
                  'Please convert your video to H.264 (MP4) format using: ' +
                  'ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4 ' +
                  'then upload the converted file.'
              );
            }

            // Final validation
            const finalValidation = await this.validateOutputFile(outputFileName, 'gif');
            if (!finalValidation.valid) {
              throw new Error(`GIF conversion produced invalid output: ${finalValidation.reason}`);
            }
          }
        } else {
          // No problematic codec detected or conversion cancelled - throw validation error
          throw new Error(
            `GIF conversion produced invalid output: ${validation.reason}. ` +
              'This may indicate a corrupted video file or unsupported codec (AV1, HEVC, VP9). ' +
              'If using an unsupported codec, please convert to H.264: ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4'
          );
        }
      }

      const data = await this.safeReadFile(outputFileName);

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE);

      const duration = Date.now() - conversionStartTime;
      logger.info('conversion', 'GIF conversion complete', {
        duration: `${(duration / 1000).toFixed(2)}s`,
        outputSize: data.length,
      });

      performanceTracker.saveToSessionStorage();
      logger.performance('Performance report saved to sessionStorage');

      await this.handleConversionCleanup(outputFileName, [paletteFileName]);

      const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/gif' });
      // Attach transcoding metadata for UI display
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic metadata attachment to Blob for UI
      (blob as any).wasTranscoded = wasTranscoded;
      if (wasTranscoded) {
        // biome-ignore lint/suspicious/noExplicitAny: Dynamic metadata attachment to Blob for UI
        (blob as any).originalCodec = originalCodec;
      }
      return blob;
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(paletteFileName);
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
      // Remove both log handlers (conversionLogHandler might not exist if error during palette gen)
      if (ffmpegLogHandler) {
        ffmpeg.off('log', ffmpegLogHandler);
        ffmpegLogHandler = null;
      }
      if (conversionLogHandler) {
        ffmpeg.off('log', conversionLogHandler);
        conversionLogHandler = null;
      }
      this.stopWatchdog();
    }
  }

  /**
   * Convert video file to lossy/lossless WebP format
   * Generates single frame from video using FFmpeg filtering
   * Supports variable quality and frame selection
   * @param file Input video file
   * @param options Conversion options (scale, quality, startTime, endTime)
   * @param metadata Optional pre-analyzed video metadata to skip analysis
   * @returns Blob containing the WebP image data
   * @throws Error if conversion fails after fallback attempts
   */
  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob> {
    const conversionStartTime = Date.now();

    // Check if FFmpeg needs reinitialization
    if (!this.loaded || !this.ffmpeg) {
      logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
      await this.initialize();
    }

    const ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const presetSettings = QUALITY_PRESETS.webp[quality];
    const resolvedMetadata = await this.resolveMetadataForConversion(file, metadata);
    const metadataForConversion = resolvedMetadata ?? metadata;
    const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
    const outputFileName = 'output.webp';

    // Calculate optimal FPS based on source video FPS and quality preset
    const optimalFps =
      metadataForConversion?.framerate && metadataForConversion.framerate > 0
        ? getOptimalFPS(metadataForConversion.framerate, quality, 'webp')
        : presetSettings.fps;

    // Create settings object with adaptive FPS
    const settings = {
      ...presetSettings,
      fps: optimalFps,
    };

    if (metadataForConversion?.framerate && optimalFps !== presetSettings.fps) {
      logger.info('conversion', 'Using adaptive FPS for WebP', {
        sourceFPS: metadataForConversion.framerate,
        presetFPS: presetSettings.fps,
        optimalFPS: optimalFps,
        quality,
      });
    }

    this.logConversionContext(file, 'webp', options, metadataForConversion);

    logger.info('conversion', 'Starting WebP conversion', {
      quality,
      scale,
      fps: settings.fps,
      webpQuality: settings.quality,
      preset: settings.preset,
      duration: metadataForConversion?.duration,
    });

    this.beginExternalConversion(metadataForConversion, quality);

    let ffmpegLogHandler: ((event: { type: string; message: string }) => void) | null = null;

    // Create log handler with progress parsing for WebP conversion
    const videoDuration = metadataForConversion?.duration;
    ffmpegLogHandler = this.createFFmpegLogHandler(
      videoDuration,
      FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
      FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END
    );
    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      // Proactive codec transcoding check
      let wasTranscoded = false;
      let originalCodec = '';
      let actualInputFileName: string = inputFileName;

      const transcodeCheck = this.needsTranscoding(metadataForConversion);
      if (transcodeCheck.needed) {
        originalCodec = transcodeCheck.codec;

        // Check if FFmpeg can actually decode this codec
        if (!this.canFFmpegDecode(originalCodec)) {
          logger.warn(
            'conversion',
            `Detected ${originalCodec} codec, but FFmpeg.wasm cannot decode it (no decoder support). Skipping FFmpeg conversion - use WebCodecs path instead.`
          );
          throw new Error(
            `${originalCodec} codec is not supported by FFmpeg.wasm. This video requires hardware-accelerated decoding via WebCodecs.`
          );
        }

        logger.info(
          'conversion',
          `Detected ${originalCodec}, proactively transcoding to H.264 before WebP conversion`
        );

        // Build a temporary base command for transcoding
        const tempBaseCmd: string[] = [];
        const transcodeSuccess = await this.transcodeToH264(
          inputFileName,
          'webp',
          tempBaseCmd,
          originalCodec
        );

        if (transcodeSuccess) {
          wasTranscoded = true;
          actualInputFileName = FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE;
          logger.info(
            'conversion',
            'Proactive transcode succeeded, using H.264 intermediate for WebP conversion'
          );
        } else {
          logger.warn(
            'conversion',
            'Proactive transcode failed, continuing with original file (reactive fallback may catch it)'
          );
        }
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START);

      if (this.cancellationRequested) {
        throw new Error('Conversion cancelled by user');
      }

      const scaleFilter = getScaleFilter(quality, scale);

      // Try main conversion with fallback on failure
      try {
        // Start heartbeat to prevent watchdog timeout during scale filter processing
        const estimatedDuration = 30; // Conservative estimate in seconds
        const heartbeat = this.startProgressHeartbeat(
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END,
          estimatedDuration
        );

        // Use single-threaded mode when scaling to avoid ffmpeg.wasm threading issues
        const webpThreadArgs = getThreadingArgs(scaleFilter ? 'scale-filter' : 'simple');
        const webpFilterArgs = scaleFilter
          ? `fps=${settings.fps},${scaleFilter}`
          : `fps=${settings.fps}`;
        // Optimize WebP settings for faster encoding
        const webpCmd = [
          ...webpThreadArgs,
          '-i',
          actualInputFileName,
          '-vf',
          webpFilterArgs,
          '-c:v',
          'libwebp',
          '-lossless',
          '0',
          '-quality',
          settings.quality.toString(),
          '-preset',
          settings.preset,
          '-compression_level',
          Math.max(3, Math.min(settings.compressionLevel, 5)).toString(), // Cap at 5 for speed
          '-method',
          Math.min(settings.method, 4).toString(), // Limit method for faster encoding
          '-deadline',
          'realtime', // Use realtime preset for faster encoding
          '-loop',
          '0',
          outputFileName,
        ];
        logger.debug('ffmpeg', 'WebP conversion command', { cmd: webpCmd.join(' ') });

        performanceTracker.startPhase('webp-encode');
        logger.performance('Starting WebP encoding');

        try {
          await withTimeout(
            ffmpeg.exec(webpCmd),
            TIMEOUT_CONVERSION,
            `WebP conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
            () => this.terminateFFmpeg()
          );
        } finally {
          this.stopProgressHeartbeat(heartbeat);
        }

        performanceTracker.endPhase('webp-encode');
        logger.performance('WebP encoding complete');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';

        // If error is due to cancellation or termination, don't attempt fallback
        if (
          errorMessage.includes('cancelled by user') ||
          (this.cancellationRequested && errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }

        // Otherwise, attempt fallback conversion
        logger.warn('conversion', 'WebP conversion failed, using fallback', {
          error: errorMessage,
        });
        this.updateStatus('Using fallback conversion...');

        // Reinitialize if needed
        if (!this.ffmpeg || !this.loaded) {
          await this.initialize();
          await this.ensureInputFile(file);
        }

        this.emitProgress(50);

        await this.convertToWebPDirect(
          actualInputFileName,
          outputFileName,
          settings,
          scaleFilter,
          file
        );
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END);

      // VALIDATE OUTPUT before reading
      const validation = await this.validateOutputFile(outputFileName, 'webp');

      if (!validation.valid) {
        logger.warn('conversion', 'WebP output validation failed', {
          reason: validation.reason,
        });

        // Check if this needs transcoding (AV1, HEVC, VP9)
        const transcodeCheck = this.needsTranscoding(metadataForConversion);

        if (transcodeCheck.needed && !this.cancellationRequested) {
          // Check if FFmpeg can actually decode this codec
          if (!this.canFFmpegDecode(transcodeCheck.codec)) {
            logger.error(
              'conversion',
              `${transcodeCheck.codec} codec detected but FFmpeg.wasm cannot decode it. Conversion impossible.`
            );
            throw new Error(
              `${transcodeCheck.codec} codec is not supported by FFmpeg.wasm. Please use WebCodecs path or convert the video to H.264 first.`
            );
          }

          logger.info(
            'conversion',
            `Detected ${transcodeCheck.codec} codec, attempting retry strategies`
          );

          // TIER 2: Retry with AV1-tuned decoder flags
          await this.safeDelete(outputFileName);
          this.emitProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START);

          // Reconstruct conversion command for retry
          const scaleFilter = getScaleFilter(quality, scale);
          const webpFilterArgs = scaleFilter
            ? `fps=${settings.fps},${scaleFilter}`
            : `fps=${settings.fps}`;
          const baseCmd = [
            '-i',
            inputFileName,
            '-vf',
            webpFilterArgs,
            '-c:v',
            'libwebp',
            '-lossless',
            '0',
            '-quality',
            settings.quality.toString(),
            '-preset',
            settings.preset,
            '-compression_level',
            settings.compressionLevel.toString(),
            '-method',
            settings.method.toString(),
            '-qmin',
            '1',
            '-qmax',
            '100',
            '-loop',
            '0',
            outputFileName,
          ];

          const retrySuccess = await this.retryWithAV1DecoderTuning(
            inputFileName,
            outputFileName,
            baseCmd
          );

          if (retrySuccess) {
            const retryValidation = await this.validateOutputFile(outputFileName, 'webp');
            if (retryValidation.valid) {
              logger.info('conversion', 'AV1 decoder retry produced valid output');
              // Continue to read file below
            } else {
              // TIER 3: Transcode codec→H.264→WebP
              logger.info(
                'conversion',
                `Retry failed, attempting ${transcodeCheck.codec} transcode`
              );
              await this.safeDelete(outputFileName);

              const transcodeSuccess = await this.transcodeToH264(
                inputFileName,
                'webp',
                baseCmd,
                transcodeCheck.codec
              );

              if (!transcodeSuccess) {
                throw new Error(
                  `${transcodeCheck.codec} codec is not supported in this browser. ` +
                    'Please convert your video to H.264 (MP4) format using: ' +
                    'ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4 ' +
                    'then upload the converted file.'
                );
              }

              // Final validation
              const finalValidation = await this.validateOutputFile(outputFileName, 'webp');
              if (!finalValidation.valid) {
                throw new Error(
                  `WebP conversion produced invalid output: ${finalValidation.reason}`
                );
              }
            }
          } else {
            // Retry failed, try transcode
            logger.info(
              'conversion',
              `Decoder retry failed, attempting ${transcodeCheck.codec} transcode`
            );
            await this.safeDelete(outputFileName);

            const transcodeSuccess = await this.transcodeToH264(
              inputFileName,
              'webp',
              baseCmd,
              transcodeCheck.codec
            );

            if (!transcodeSuccess) {
              throw new Error(
                `${transcodeCheck.codec} codec is not supported in this browser. ` +
                  'Please convert your video to H.264 (MP4) format using: ' +
                  'ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4 ' +
                  'then upload the converted file.'
              );
            }

            // Final validation
            const finalValidation = await this.validateOutputFile(outputFileName, 'webp');
            if (!finalValidation.valid) {
              throw new Error(`WebP conversion produced invalid output: ${finalValidation.reason}`);
            }
          }
        } else {
          // No problematic codec detected or conversion cancelled - throw validation error
          throw new Error(
            `WebP conversion produced invalid output: ${validation.reason}. ` +
              'This may indicate a corrupted video file or unsupported codec (AV1, HEVC, VP9). ' +
              'If using an unsupported codec, please convert to H.264: ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4'
          );
        }
      }

      const data = await this.safeReadFile(outputFileName);

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE);

      const duration = Date.now() - conversionStartTime;
      logger.info('conversion', 'WebP conversion complete', {
        duration: `${(duration / 1000).toFixed(2)}s`,
        outputSize: data.length,
      });

      performanceTracker.saveToSessionStorage();
      logger.performance('Performance report saved to sessionStorage');

      await this.handleConversionCleanup(outputFileName);

      const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/webp' });
      // Attach transcoding metadata for UI display
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic metadata attachment to Blob for UI
      (blob as any).wasTranscoded = wasTranscoded;
      if (wasTranscoded) {
        // biome-ignore lint/suspicious/noExplicitAny: Dynamic metadata attachment to Blob for UI
        (blob as any).originalCodec = originalCodec;
      }
      return blob;
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
      if (ffmpegLogHandler) {
        ffmpeg.off('log', ffmpegLogHandler);
        ffmpegLogHandler = null;
      }
      this.stopWatchdog();
    }
  }

  /**
   * WebP fallback conversion using simpler settings
   * Used when main conversion fails - uses lossless mode with fast compression
   */
  private async convertToWebPDirect(
    inputFileName: string,
    outputFileName: string,
    settings: { fps: number },
    scaleFilter: string | null,
    file?: File,
    startProgress = 50
  ): Promise<void> {
    if (!this.ffmpeg || !this.loaded) {
      if (!file) {
        throw new Error(
          'Cannot reinitialize FFmpeg without original file for direct conversion fallback'
        );
      }
      await this.initialize();
      await this.ensureInputFile(file);
    }

    this.updateStatus('Using fallback WebP conversion...');
    logger.info('conversion', 'Using WebP direct conversion fallback', {
      fps: settings.fps,
      hasScaleFilter: !!scaleFilter,
    });

    const ffmpeg = this.getFFmpeg();
    // Use simple threading for fallback
    const webpThreadArgs = getThreadingArgs('simple');
    const webpFilterArgs = scaleFilter
      ? `fps=${settings.fps},${scaleFilter}`
      : `fps=${settings.fps}`;

    // Add heartbeat for fallback conversion
    const heartbeat = this.startProgressHeartbeat(
      startProgress,
      FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END,
      20
    );

    performanceTracker.startPhase('webp-fallback');
    logger.performance('Starting WebP direct fallback conversion');

    try {
      await withTimeout(
        ffmpeg.exec([
          ...webpThreadArgs,
          '-i',
          inputFileName,
          '-vf',
          webpFilterArgs,
          '-c:v',
          'libwebp',
          '-lossless',
          '0', // Use lossy for faster encoding
          '-quality',
          '75', // Good quality balance
          '-preset',
          'default',
          '-compression_level',
          '3', // Fast compression
          '-deadline',
          'realtime', // Fast encoding deadline
          '-loop',
          '0',
          outputFileName,
        ]),
        TIMEOUT_CONVERSION,
        `Direct WebP conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
        () => this.terminateFFmpeg()
      );
    } finally {
      this.stopProgressHeartbeat(heartbeat);
      performanceTracker.endPhase('webp-fallback');
      logger.performance('WebP direct fallback conversion complete');
    }
  }

  private async convertToGIFDirect(
    inputFileName: string,
    outputFileName: string,
    settings: { fps: number },
    scaleFilter: string | null,
    file?: File,
    startProgress = 50
  ): Promise<void> {
    if (!this.ffmpeg || !this.loaded) {
      if (!file) {
        throw new Error(
          'Cannot reinitialize FFmpeg without original file for direct conversion fallback'
        );
      }
      await this.initialize();
      await this.ensureInputFile(file);
    }

    this.updateStatus('Converting to GIF directly (no palette optimization)...');
    logger.info('conversion', 'Using GIF direct conversion fallback', {
      fps: settings.fps,
      hasScaleFilter: !!scaleFilter,
    });

    const ffmpeg = this.getFFmpeg();
    const directGifThreadArgs = getThreadingArgs('simple');
    const directGifFilterArgs = scaleFilter
      ? `fps=${settings.fps},${scaleFilter}`
      : `fps=${settings.fps}`;

    // Add heartbeat for fallback conversion
    const heartbeat = this.startProgressHeartbeat(
      startProgress,
      FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END,
      20
    );

    performanceTracker.startPhase('gif-fallback');
    logger.performance('Starting GIF direct fallback conversion');

    try {
      await withTimeout(
        ffmpeg.exec([
          ...directGifThreadArgs,
          '-i',
          inputFileName,
          '-vf',
          directGifFilterArgs,
          outputFileName,
        ]),
        TIMEOUT_CONVERSION,
        `Direct GIF conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
        () => this.terminateFFmpeg()
      );
    } finally {
      this.stopProgressHeartbeat(heartbeat);
      performanceTracker.endPhase('gif-fallback');
      logger.performance('GIF direct fallback conversion complete');
    }
  }

  setProgressCallback(callback: ((progress: number) => void) | null): void {
    this.progressCallback = callback;
  }

  setStatusCallback(callback: ((message: string) => void) | null): void {
    this.statusCallback = callback;
  }

  beginExternalConversion(metadata?: VideoMetadata, quality?: ConversionQuality): void {
    this.cancellationRequested = false;
    this.startWatchdog(metadata, quality);
    this.resetFFmpegLogBuffer();
  }

  endExternalConversion(): void {
    this.stopWatchdog();
  }

  reportProgress(progress: number, isHeartbeat = false): void {
    this.emitProgress(progress, isHeartbeat);
  }

  reportStatus(message: string): void {
    this.updateStatus(message);
  }

  isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }

  async writeVirtualFile(fileName: string, data: Uint8Array | string): Promise<void> {
    await this.safeWriteFile(fileName, data);
  }

  async deleteVirtualFiles(fileNames: string[]): Promise<void> {
    await Promise.all(fileNames.map((file) => this.safeDelete(file)));
  }

  cancelConversion(): void {
    if (!this.isConverting) {
      return;
    }
    this.cancellationRequested = true;
    this.updateStatus('Cancelling conversion...');
    this.terminateFFmpeg();
  }

  async clearCachedInput(): Promise<void> {
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
      this.inputCacheTimer = null;
    }
    this.cachedInputKey = null;
    await this.safeDelete(FFMPEG_INTERNALS.INPUT_FILE_NAME);
  }

  private updateStatus(message: string): void {
    if (this.statusCallback) {
      this.statusCallback(message);
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getRecentFFmpegLogs(): string[] {
    return [...this.ffmpegLogBuffer];
  }

  private startProgressHeartbeat(
    startProgress: number,
    endProgress: number,
    estimatedDurationSeconds: number
  ): ReturnType<typeof setInterval> {
    const startTime = Date.now();
    const progressRange = endProgress - startProgress;

    logger.debug(
      'progress',
      `Starting heartbeat: ${startProgress}% -> ${endProgress}% (estimated ${estimatedDurationSeconds}s)`
    );

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const estimatedCompletion = Math.min(
        elapsedSeconds /
          (estimatedDurationSeconds * FFMPEG_INTERNALS.HEARTBEAT_DURATION_MULTIPLIER),
        FFMPEG_INTERNALS.HEARTBEAT_MAX_COMPLETION
      );

      const interpolatedProgress = startProgress + progressRange * estimatedCompletion;
      const roundedProgress = Math.floor(interpolatedProgress);

      logger.debug(
        'progress',
        `Heartbeat update: ${roundedProgress}% (elapsed: ${elapsedSeconds.toFixed(1)}s, source: heartbeat)`
      );
      this.emitProgress(roundedProgress, true);
    }, FFMPEG_INTERNALS.HEARTBEAT_INTERVAL_MS);

    // Track the interval for cleanup
    this.activeHeartbeats.add(interval);
    return interval;
  }

  private stopProgressHeartbeat(intervalId: ReturnType<typeof setInterval> | null): void {
    if (intervalId) {
      clearInterval(intervalId);
      this.activeHeartbeats.delete(intervalId); // Untrack the interval
      logger.debug('progress', 'Heartbeat stopped');
    }
  }

  private startWatchdog(metadata?: VideoMetadata, quality?: ConversionQuality): void {
    this.lastProgressTime = Date.now();
    this.isConverting = true;
    this.lastProgressEmitTime = 0;
    this.lastProgressValue = -1;

    // Calculate adaptive timeout based on video characteristics
    this.currentWatchdogTimeout = calculateAdaptiveWatchdogTimeout(
      FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS,
      {
        resolution: metadata ? { width: metadata.width, height: metadata.height } : undefined,
        duration: metadata?.duration,
        quality,
      }
    );

    logger.debug('watchdog', 'Watchdog started', {
      baseTimeout: `${FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS / 1000}s`,
      adaptiveTimeout: `${this.currentWatchdogTimeout / 1000}s`,
      resolution: metadata ? `${metadata.width}x${metadata.height}` : 'unknown',
      duration: metadata?.duration ? `${metadata.duration.toFixed(1)}s` : 'unknown',
      quality: quality || 'unknown',
    });

    this.watchdogTimer = setInterval(() => {
      const timeSinceProgress = Date.now() - this.lastProgressTime;
      logger.debug(
        'watchdog',
        `Watchdog check: ${(timeSinceProgress / 1000).toFixed(1)}s since last progress (timeout: ${this.currentWatchdogTimeout / 1000}s)`
      );

      if (timeSinceProgress > this.currentWatchdogTimeout) {
        logger.error(
          'watchdog',
          `Conversion stalled - no progress for ${(this.currentWatchdogTimeout / 1000).toFixed(1)}s`,
          {
            lastProgress: this.lastProgressValue,
            timeSinceProgress: `${(timeSinceProgress / 1000).toFixed(1)}s`,
            timeout: `${(this.currentWatchdogTimeout / 1000).toFixed(1)}s`,
          }
        );
        this.updateStatus('Conversion stalled - terminating...');
        this.terminateFFmpeg();
      }
    }, FFMPEG_INTERNALS.WATCHDOG_CHECK_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.isConverting = false;
  }

  /**
   * Centralized cleanup of all tracked resources
   * Ensures no memory leaks from intervals, timeouts, or blob URLs
   */
  private cleanupResources(): void {
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

    // Clear input cache timer
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
      this.inputCacheTimer = null;
    }

    // Clear known files tracking
    this.knownFiles.clear();

    logger.debug('general', 'All resources cleaned up');
  }

  private scheduleIdleTrim(): void {
    requestIdle(
      () => {
        if (this.isConverting) {
          return;
        }
        if (isMemoryCritical()) {
          this.terminate();
        }
      },
      { timeout: 3000 }
    );
  }

  /**
   * Clean up temporary files in FFmpeg virtual filesystem before termination
   * Prevents orphaned temp files and potential memory leaks
   */
  private async cleanupTempFiles(): Promise<void> {
    if (!this.ffmpeg || !this.loaded) {
      return;
    }

    const tempFiles = [
      FFMPEG_INTERNALS.INPUT_FILE_NAME, // input.mp4
      FFMPEG_INTERNALS.PALETTE_FILE_NAME, // GIF palette file
      'output.gif', // GIF output
      'output.webp', // WebP output
      FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE, // H.264 intermediate
    ];

    logger.debug('conversion', 'Cleaning up temp files before termination', { files: tempFiles });

    // Attempt to delete each temp file, ignoring errors
    for (const file of tempFiles) {
      try {
        await this.safeDelete(file);
      } catch (error) {
        // Ignore errors during cleanup - file may not exist or FFmpeg may already be terminated
        logger.debug('conversion', `Failed to delete temp file: ${file}`, { error });
      }
    }
  }

  private terminateFFmpeg(): void {
    this.isTerminating = true;

    // Clean up all resources first
    this.cleanupResources();

    // Attempt to clean up temp files before termination (async, but don't wait)
    // This is a best-effort cleanup to prevent memory leaks
    if (this.ffmpeg && this.loaded) {
      this.cleanupTempFiles().catch((error) => {
        logger.debug('conversion', 'Temp file cleanup failed during termination', { error });
      });
    }

    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (error) {
        console.error('[FFmpeg Service] Error during termination:', error);
      }
      this.ffmpeg = null;
      this.loaded = false;
    }

    this.cachedInputKey = null;
    this.cancellationRequested = false;
    this.stopProgressHeartbeat(this.heartbeatInterval);
    this.heartbeatInterval = null;

    // Small delay to ensure FFmpeg worker is fully terminated
    setTimeout(() => {
      this.isTerminating = false;
    }, FFMPEG_INTERNALS.TERMINATION_SETTLE_MS);
  }

  terminate(): void {
    this.isTerminating = true;

    // Clean up all resources first
    this.cleanupResources();

    // Attempt to clean up temp files before termination (async, but don't wait)
    // This is a best-effort cleanup to prevent memory leaks
    if (this.ffmpeg && this.loaded) {
      this.cleanupTempFiles().catch((error) => {
        logger.debug('conversion', 'Temp file cleanup failed during termination', { error });
      });
    }

    if (this.ffmpeg) {
      this.ffmpeg.terminate();
      this.loaded = false;
      this.ffmpeg = null;
    }

    this.stopProgressHeartbeat(this.heartbeatInterval);
    this.heartbeatInterval = null;
    this.cachedInputKey = null;
    this.cancellationRequested = false;

    setTimeout(() => {
      this.isTerminating = false;
    }, FFMPEG_INTERNALS.TERMINATION_SETTLE_MS);
  }

  private getFileCacheKey(file: File): string {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  private setInputCache(key: string, ttlMs: number = FFMPEG_INTERNALS.INPUT_CACHE_TTL_MS): void {
    this.cachedInputKey = key;
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
    }
    this.inputCacheTimer = setTimeout(() => {
      void this.clearCachedInput();
    }, ttlMs);
  }

  private async ensureInputFile(file: File): Promise<void> {
    const key = this.getFileCacheKey(file);

    // Check if file is already cached in FFmpeg filesystem
    if (this.cachedInputKey === key) {
      const exists = await this.safeFileExists(FFMPEG_INTERNALS.INPUT_FILE_NAME);
      if (exists) {
        logger.debug('conversion', 'Using cached input file', { key });
        return;
      }
    }

    // Prepare new input file
    await this.safeDelete(FFMPEG_INTERNALS.INPUT_FILE_NAME);

    try {
      const data = await fetchFile(file);
      await this.safeWriteFile(FFMPEG_INTERNALS.INPUT_FILE_NAME, data);
      this.setInputCache(key);
      logger.debug('conversion', 'Input file prepared', { key, size: file.size });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('conversion', 'Failed to prepare input file', { error: message });
      throw new Error(`Failed to prepare input file: ${message}`);
    }
  }
}

export const ffmpegService = new FFmpegService();
