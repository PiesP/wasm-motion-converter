import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type {
  ConversionOptions,
  ConversionQuality,
  VideoMetadata,
} from '../types/conversion-types';
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
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';
import { performanceTracker } from '../utils/performance-tracker';
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
 */
function getThreadingArgs(operation: 'filter-complex' | 'scale-filter' | 'simple'): string[] {
  switch (operation) {
    case 'filter-complex':
      // Complex filter graphs need single-threaded mode to avoid deadlocks
      return ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
    case 'scale-filter':
      // Scale filters need single-threaded filter execution
      return ['-threads', '1', '-filter_threads', '1'];
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
  private cachedInputKey: string | null = null;
  private inputCacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cancellationRequested = false;
  private isTerminating = false;
  private prefetchPromise: Promise<void> | null = null;
  private ffmpegLogBuffer: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // Resource tracking for cleanup
  private activeHeartbeats: Set<ReturnType<typeof setInterval>> = new Set();
  private activeBlobUrls: Set<string> = new Set();
  private knownFiles: Set<string> = new Set();

  private getFFmpeg(): FFmpeg {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }
    return this.ffmpeg;
  }

  private emitProgress(progress: number, isHeartbeat = false): void {
    if (this.isConverting && !isHeartbeat) {
      this.lastProgressTime = Date.now();
    }
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  prefetchCoreAssets(): Promise<void> {
    if (this.loaded || !supportsCacheStorage()) {
      return Promise.resolve();
    }
    if (this.prefetchPromise) {
      return this.prefetchPromise;
    }

    const runPrefetch = async () => {
      let lastError: unknown;
      for (const baseURL of FFMPEG_CORE_BASE_URLS) {
        try {
          const urls = await Promise.all([
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            cacheAwareBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
          ]);
          urls.forEach((url) => URL.revokeObjectURL(url));
          return;
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError) {
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
   * Logs all FFmpeg output and maintains a buffer of recent logs
   */
  private createFFmpegLogHandler(): (event: { type: string; message: string }) => void {
    return ({ type, message }: { type: string; message: string }) => {
      logger.debug('ffmpeg', `[${type}] ${message}`);

      this.ffmpegLogBuffer.push(`[${type}] ${message}`);
      if (this.ffmpegLogBuffer.length > FFMPEG_INTERNALS.FFMPEG_LOG_BUFFER_SIZE) {
        this.ffmpegLogBuffer.shift();
      }

      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
      }
    };
  }

  /**
   * Handles cleanup after conversion completes or fails
   * Manages input cache and deletes temporary files
   */
  private async handleConversionCleanup(
    outputFileName: string,
    additionalFiles: string[] = []
  ): Promise<void> {
    const files = [outputFileName, ...additionalFiles];

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

    const logHandler = ({ message }: { message: string }) => {
      const resolutionMatch = message.match(/(\d{2,5})x(\d{2,5})/);
      if (resolutionMatch) {
        metadata.width = Number.parseInt(resolutionMatch[1] ?? '0', 10);
        metadata.height = Number.parseInt(resolutionMatch[2] ?? '0', 10);
      }

      const durationMatch = message.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = Number.parseInt(durationMatch[1] ?? '0', 10);
        const minutes = Number.parseInt(durationMatch[2] ?? '0', 10);
        const seconds = Number.parseFloat(durationMatch[3] ?? '0');
        metadata.duration = hours * 3600 + minutes * 60 + seconds;
      }

      const codecMatch = message.match(/Video: (\w+)/);
      if (codecMatch) {
        metadata.codec = codecMatch[1] ?? 'unknown';
      }

      const framerateMatch = message.match(/(\d+(?:\.\d+)?) fps/);
      if (framerateMatch) {
        metadata.framerate = Number.parseFloat(framerateMatch[1] ?? '0');
      }

      const bitrateMatch = message.match(/bitrate: (\d+) kb\/s/);
      if (bitrateMatch) {
        metadata.bitrate = Number.parseInt(bitrateMatch[1] ?? '0', 10) * 1000;
      }
    };

    ffmpeg.on('log', logHandler);

    try {
      await this.ensureInputFile(file);
      await withTimeout(
        ffmpeg.exec(['-hide_banner', '-i', inputFileName]),
        TIMEOUT_VIDEO_ANALYSIS,
        `Video analysis timed out after ${TIMEOUT_VIDEO_ANALYSIS / 1000} seconds. The file may be corrupted or in an unsupported format.`
      );
      return metadata;
    } catch (error) {
      await this.clearCachedInput();
      throw error;
    } finally {
      ffmpeg.off('log', logHandler);
    }
  }

  async convertToGIF(file: File, options: ConversionOptions): Promise<Blob> {
    const conversionStartTime = Date.now();

    // Check if FFmpeg needs reinitialization
    if (!this.loaded || !this.ffmpeg) {
      logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
      await this.initialize();
    }

    let ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.gif[quality];
    const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
    const paletteFileName = 'palette.png';
    const outputFileName = 'output.gif';

    logger.info('conversion', 'Starting GIF conversion', {
      quality,
      scale,
      fps: settings.fps,
      colors: settings.colors,
    });

    this.cancellationRequested = false;
    this.startWatchdog();

    const ffmpegLogHandler = this.createFFmpegLogHandler();
    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
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
          inputFileName,
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

        this.updateStatus('Converting to GIF with palette...');
        const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
        const filterComplexThreadArgs = getThreadingArgs('filter-complex');
        const conversionFilterChain = scaleFilter
          ? `fps=${settings.fps},${scaleFilter}[x];[x][1:v]paletteuse=dither=${ditherMode}`
          : `fps=${settings.fps}[x];[x][1:v]paletteuse=dither=${ditherMode}`;
        const conversionCmd = [
          ...filterComplexThreadArgs,
          '-i',
          inputFileName,
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
          errorMessage.includes('called FFmpeg.terminate()')
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

        await this.convertToGIFDirect(inputFileName, outputFileName, settings, scaleFilter, file);
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END);

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

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/gif' });
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(paletteFileName);
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
      ffmpeg.off('log', ffmpegLogHandler);
      this.stopWatchdog();
    }
  }

  async convertToWebP(file: File, options: ConversionOptions): Promise<Blob> {
    const conversionStartTime = Date.now();

    // Check if FFmpeg needs reinitialization
    if (!this.loaded || !this.ffmpeg) {
      logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
      await this.initialize();
    }

    const ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.webp[quality];
    const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
    const outputFileName = 'output.webp';

    logger.info('conversion', 'Starting WebP conversion', {
      quality,
      scale,
      fps: settings.fps,
      webpQuality: settings.quality,
      preset: settings.preset,
    });

    this.cancellationRequested = false;
    this.startWatchdog();

    const ffmpegLogHandler = this.createFFmpegLogHandler();
    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
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
        const webpCmd = [
          ...webpThreadArgs,
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
          errorMessage.includes('called FFmpeg.terminate()')
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

        await this.convertToWebPDirect(inputFileName, outputFileName, settings, scaleFilter, file);
      }

      this.emitProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END);

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

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/webp' });
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
      ffmpeg.off('log', ffmpegLogHandler);
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
          '1', // Fallback uses lossless for reliability
          '-compression_level',
          '3', // Fast compression
          '-preset',
          'default',
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

  private startWatchdog(): void {
    this.lastProgressTime = Date.now();
    this.isConverting = true;
    this.lastProgressEmitTime = 0;
    this.lastProgressValue = -1;

    logger.debug('watchdog', 'Watchdog started');

    this.watchdogTimer = setInterval(() => {
      const timeSinceProgress = Date.now() - this.lastProgressTime;
      logger.debug(
        'watchdog',
        `Watchdog check: ${(timeSinceProgress / 1000).toFixed(1)}s since last progress`
      );

      if (timeSinceProgress > FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS) {
        logger.error('watchdog', 'Conversion stalled - no actual progress for 90s', {
          lastProgress: this.lastProgressValue,
          timeSinceProgress: `${(timeSinceProgress / 1000).toFixed(1)}s`,
        });
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

    // Revoke all blob URLs (currently unused, reserved for future blob URL tracking)
    for (const url of this.activeBlobUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        logger.debug('general', 'Failed to revoke blob URL', { error });
      }
    }
    this.activeBlobUrls.clear();

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

  private terminateFFmpeg(): void {
    this.isTerminating = true;

    // Clean up all resources first
    this.cleanupResources();

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
