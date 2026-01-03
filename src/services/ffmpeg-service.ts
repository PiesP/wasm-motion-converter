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
import { isMemoryCritical } from '../utils/memory-monitor';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';

const INPUT_FILE_NAME = 'input.mp4';
const INPUT_CACHE_TTL_MS = 120_000;
const PROGRESS_THROTTLE_MS = 220;
const INPUT_CACHE_POST_CONVERT_MS = 60_000;
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
  return Math.min(cores, 4);
}

function getThreadArgs(useFilterComplex: boolean): string[] {
  if (useFilterComplex) {
    return ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
  }
  const threads = getOptimalThreadCount();
  return ['-threads', threads.toString()];
}

function getFilterGraphSafeArgs(): string[] {
  return ['-threads', '1', '-filter_threads', '1'];
}

function getScaleFilter(quality: ConversionQuality, scale: number): string {
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

  private getFFmpeg(): FFmpeg {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }
    return this.ffmpeg;
  }

  private emitProgress(progress: number): void {
    if (this.isConverting) {
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

    if (timeDelta < PROGRESS_THROTTLE_MS && progressDelta < 1) {
      return false;
    }

    this.lastProgressEmitTime = now;
    this.lastProgressValue = progress;
    return true;
  }

  private async safeDelete(fileName: string): Promise<void> {
    if (!this.ffmpeg) {
      return;
    }
    try {
      await this.ffmpeg.deleteFile(fileName);
      logger.debug('conversion', `Deleted ${fileName}`);
    } catch (error) {
      // Silent failure - file might not exist
      logger.debug('conversion', `Could not delete ${fileName} (non-critical)`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

    // Wait for any ongoing termination to complete
    while (this.isTerminating) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

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

      reportProgress(Math.max(downloadProgress, 90));
      if (onStatus) {
        onStatus('Initializing FFmpeg runtime...');
      }

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
    const inputFileName = INPUT_FILE_NAME;

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
    const inputFileName = INPUT_FILE_NAME;
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

    const ffmpegLogHandler = ({ type, message }: { type: string; message: string }) => {
      logger.debug('ffmpeg', `[${type}] ${message}`);
      this.ffmpegLogBuffer.push(`[${type}] ${message}`);
      if (this.ffmpegLogBuffer.length > 100) {
        this.ffmpegLogBuffer.shift();
      }
      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
      }
    };

    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      this.emitProgress(10);

      const scaleFilter = getScaleFilter(quality, scale);

      try {
        this.updateStatus('Generating color palette...');
        const paletteThreadArgs = getFilterGraphSafeArgs();
        const paletteCmd = [
          ...paletteThreadArgs,
          '-i',
          inputFileName,
          '-vf',
          `fps=${settings.fps},${scaleFilter},palettegen=max_colors=${settings.colors}`,
          '-update',
          '1', // Tell FFmpeg this is a single image, not a sequence
          paletteFileName,
        ];
        logger.debug('ffmpeg', 'Palette generation command', { cmd: paletteCmd.join(' ') });

        // Start heartbeat for palette generation to prevent watchdog timeout
        const paletteHeartbeat = this.startProgressHeartbeat(10, 35, 30);

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

        logger.debug('conversion', 'Palette generation complete');
        this.emitProgress(40);

        if (this.cancellationRequested) {
          throw new Error('Conversion cancelled by user');
        }

        this.updateStatus('Converting to GIF with palette...');
        const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
        const filterComplexThreadArgs = getThreadArgs(true);
        const conversionCmd = [
          ...filterComplexThreadArgs,
          '-i',
          inputFileName,
          '-i',
          paletteFileName,
          '-filter_complex',
          `fps=${settings.fps},${scaleFilter}[x];[x][1:v]paletteuse=dither=${ditherMode}`,
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

      this.emitProgress(90);

      const data = await ffmpeg.readFile(outputFileName);

      this.emitProgress(100);

      const duration = Date.now() - conversionStartTime;
      logger.info('conversion', 'GIF conversion complete', {
        duration: `${(duration / 1000).toFixed(2)}s`,
        outputSize: data.length,
      });

      if (isMemoryCritical()) {
        await this.clearCachedInput();
      } else if (this.cachedInputKey) {
        this.setInputCache(this.cachedInputKey, INPUT_CACHE_POST_CONVERT_MS);
      }
      await this.safeDelete(paletteFileName);
      await this.safeDelete(outputFileName);

      this.scheduleIdleTrim();

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
    const inputFileName = INPUT_FILE_NAME;
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

    const ffmpegLogHandler = ({ type, message }: { type: string; message: string }) => {
      logger.debug('ffmpeg', `[${type}] ${message}`);
      this.ffmpegLogBuffer.push(`[${type}] ${message}`);
      if (this.ffmpegLogBuffer.length > 100) {
        this.ffmpegLogBuffer.shift();
      }
      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
      }
    };

    ffmpeg.on('log', ffmpegLogHandler);

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      this.emitProgress(20);

      if (this.cancellationRequested) {
        throw new Error('Conversion cancelled by user');
      }

      const scaleFilter = getScaleFilter(quality, scale);

      // Start heartbeat to prevent watchdog timeout during scale filter processing
      const estimatedDuration = 30; // Conservative estimate in seconds
      const heartbeat = this.startProgressHeartbeat(20, 85, estimatedDuration);

      const webpThreadArgs = getThreadArgs(false);
      const webpCmd = [
        ...webpThreadArgs,
        '-i',
        inputFileName,
        '-vf',
        `fps=${settings.fps},${scaleFilter}`,
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
        '-loop',
        '0',
        outputFileName,
      ];
      logger.debug('ffmpeg', 'WebP conversion command', { cmd: webpCmd.join(' ') });
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

      this.emitProgress(90);

      const data = await ffmpeg.readFile(outputFileName);

      this.emitProgress(100);

      const duration = Date.now() - conversionStartTime;
      logger.info('conversion', 'WebP conversion complete', {
        duration: `${(duration / 1000).toFixed(2)}s`,
        outputSize: data.length,
      });

      if (isMemoryCritical()) {
        await this.clearCachedInput();
      } else if (this.cachedInputKey) {
        this.setInputCache(this.cachedInputKey, INPUT_CACHE_POST_CONVERT_MS);
      }
      await this.safeDelete(outputFileName);

      this.scheduleIdleTrim();

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

  private async convertToGIFDirect(
    inputFileName: string,
    outputFileName: string,
    settings: { fps: number },
    scaleFilter: string,
    file?: File
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

    const ffmpeg = this.getFFmpeg();
    const directGifThreadArgs = getThreadArgs(false);
    await withTimeout(
      ffmpeg.exec([
        ...directGifThreadArgs,
        '-i',
        inputFileName,
        '-vf',
        `fps=${settings.fps},${scaleFilter}`,
        outputFileName,
      ]),
      TIMEOUT_CONVERSION,
      `Direct GIF conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
      () => this.terminateFFmpeg()
    );
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
    await this.safeDelete(INPUT_FILE_NAME);
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
    const HEARTBEAT_INTERVAL_MS = 5000;

    logger.debug(
      'progress',
      `Starting heartbeat: ${startProgress}% -> ${endProgress}% (estimated ${estimatedDurationSeconds}s)`
    );

    return setInterval(() => {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const estimatedCompletion = Math.min(elapsedSeconds / (estimatedDurationSeconds * 1.5), 0.95);

      const interpolatedProgress = startProgress + progressRange * estimatedCompletion;
      const roundedProgress = Math.floor(interpolatedProgress);

      logger.debug(
        'progress',
        `Heartbeat update: ${roundedProgress}% (elapsed: ${elapsedSeconds.toFixed(1)}s)`
      );
      this.emitProgress(roundedProgress);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopProgressHeartbeat(intervalId: ReturnType<typeof setInterval> | null): void {
    if (intervalId) {
      clearInterval(intervalId);
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

      if (timeSinceProgress > 90000) {
        logger.warn('watchdog', 'Conversion stalled - terminating', {
          timeSinceProgress: `${(timeSinceProgress / 1000).toFixed(1)}s`,
        });
        this.updateStatus('Conversion stalled - terminating...');
        this.terminateFFmpeg();
      }
    }, 10000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.isConverting = false;
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

    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (error) {
        console.error('[FFmpeg Service] Error during termination:', error);
      }
      this.ffmpeg = null;
      this.loaded = false;
    }
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
      this.inputCacheTimer = null;
    }
    this.cachedInputKey = null;
    this.cancellationRequested = false;
    this.stopWatchdog();
    this.stopProgressHeartbeat(this.heartbeatInterval);
    this.heartbeatInterval = null;

    // Small delay to ensure FFmpeg worker is fully terminated
    setTimeout(() => {
      this.isTerminating = false;
    }, 200);
  }

  terminate(): void {
    this.isTerminating = true;
    this.stopWatchdog();
    this.stopProgressHeartbeat(this.heartbeatInterval);
    this.heartbeatInterval = null;

    if (this.ffmpeg) {
      this.ffmpeg.terminate();
      this.loaded = false;
      this.ffmpeg = null;
    }
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
      this.inputCacheTimer = null;
    }
    this.cachedInputKey = null;
    this.cancellationRequested = false;

    setTimeout(() => {
      this.isTerminating = false;
    }, 200);
  }

  private getFileCacheKey(file: File): string {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  private setInputCache(key: string, ttlMs = INPUT_CACHE_TTL_MS): void {
    this.cachedInputKey = key;
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
    }
    this.inputCacheTimer = setTimeout(() => {
      void this.clearCachedInput();
    }, ttlMs);
  }

  private async ensureInputFile(file: File): Promise<void> {
    const ffmpeg = this.getFFmpeg();
    const key = this.getFileCacheKey(file);
    if (this.cachedInputKey === key) {
      return;
    }
    await this.safeDelete(INPUT_FILE_NAME);
    await ffmpeg.writeFile(INPUT_FILE_NAME, await fetchFile(file));
    this.setInputCache(key);
  }
}

export const ffmpegService = new FFmpegService();
