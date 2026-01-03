import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type {
  ConversionOptions,
  ConversionQuality,
  VideoMetadata,
} from '../types/conversion-types';
import {
  FFMPEG_CORE_URL,
  QUALITY_PRESETS,
  TIMEOUT_CONVERSION,
  TIMEOUT_FFMPEG_INIT,
  TIMEOUT_VIDEO_ANALYSIS,
} from '../utils/constants';
import { isMemoryCritical } from '../utils/memory-monitor';
import { withTimeout } from '../utils/with-timeout';

const INPUT_FILE_NAME = 'input.mp4';
const INPUT_CACHE_TTL_MS = 120_000;
const PROGRESS_THROTTLE_MS = 150;

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
    } catch (error) {
      // Silent failure - file might not exist
      console.debug(`[FFmpeg Service] Could not delete ${fileName}:`, error);
    }
  }

  async initialize(onProgress?: (progress: number) => void): Promise<void> {
    if (this.loaded) {
      return;
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
        if (onProgress) {
          onProgress(normalizedProgress);
        }

        this.emitProgress(normalizedProgress);
      }
    });

    const baseURL = FFMPEG_CORE_URL;

    try {
      await withTimeout(
        ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
        }),
        TIMEOUT_FFMPEG_INIT,
        `FFmpeg initialization timed out after ${TIMEOUT_FFMPEG_INIT / 1000} seconds. Please check your internet connection and try again.`
      );

      this.loaded = true;
    } catch (error) {
      console.error('FFmpeg initialization failed:', error);
      throw error;
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
        ffmpeg.exec(['-i', inputFileName]),
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
    let ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.gif[quality];
    const inputFileName = INPUT_FILE_NAME;
    const paletteFileName = 'palette.png';
    const outputFileName = 'output.gif';

    this.cancellationRequested = false;
    this.startWatchdog();

    try {
      await this.ensureInputFile(file);

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      this.emitProgress(10);

      const scaleFilter = getScaleFilter(quality, scale);

      try {
        this.updateStatus('Generating color palette...');
        const statsMode = quality === 'low' ? 'fast' : 'full';
        const paletteThreadArgs = getFilterGraphSafeArgs();
        await withTimeout(
          ffmpeg.exec([
            ...paletteThreadArgs,
            '-i',
            inputFileName,
            '-vf',
            `fps=${settings.fps},${scaleFilter},palettegen=max_colors=${settings.colors}:stats_mode=${statsMode}`,
            paletteFileName,
          ]),
          TIMEOUT_CONVERSION,
          `GIF palette generation timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
          () => this.terminateFFmpeg()
        );

        this.emitProgress(40);

        if (this.cancellationRequested) {
          throw new Error('Conversion cancelled by user');
        }

        this.updateStatus('Converting to GIF with palette...');
        const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
        const filterComplexThreadArgs = getThreadArgs(true);
        await withTimeout(
          ffmpeg.exec([
            ...filterComplexThreadArgs,
            '-i',
            inputFileName,
            '-i',
            paletteFileName,
            '-filter_complex',
            `fps=${settings.fps},${scaleFilter}[x];[x][1:v]paletteuse=dither=${ditherMode}`,
            outputFileName,
          ]),
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

      await this.clearCachedInput();
      await this.safeDelete(paletteFileName);
      await this.safeDelete(outputFileName);

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/gif' });
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(paletteFileName);
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
      this.stopWatchdog();
    }
  }

  async convertToWebP(file: File, options: ConversionOptions): Promise<Blob> {
    const ffmpeg = this.getFFmpeg();

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.webp[quality];
    const inputFileName = INPUT_FILE_NAME;
    const outputFileName = 'output.webp';

    this.cancellationRequested = false;
    this.startWatchdog();

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

      const webpThreadArgs = getThreadArgs(false);
      await withTimeout(
        ffmpeg.exec([
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
        ]),
        TIMEOUT_CONVERSION,
        `WebP conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds. Try reducing the quality or scale settings.`,
        () => this.terminateFFmpeg()
      );

      this.emitProgress(90);

      const data = await ffmpeg.readFile(outputFileName);

      this.emitProgress(100);

      await this.clearCachedInput();
      await this.safeDelete(outputFileName);

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/webp' });
    } catch (error) {
      await this.clearCachedInput();
      await this.safeDelete(outputFileName);
      throw error;
    } finally {
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

  private startWatchdog(): void {
    this.lastProgressTime = Date.now();
    this.isConverting = true;
    this.lastProgressEmitTime = 0;
    this.lastProgressValue = -1;

    this.watchdogTimer = setInterval(() => {
      const timeSinceProgress = Date.now() - this.lastProgressTime;

      if (timeSinceProgress > 90000) {
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

    // Small delay to ensure FFmpeg worker is fully terminated
    setTimeout(() => {
      this.isTerminating = false;
    }, 200);
  }

  terminate(): void {
    this.isTerminating = true;
    this.stopWatchdog();

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

  private setInputCache(key: string): void {
    this.cachedInputKey = key;
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
    }
    this.inputCacheTimer = setTimeout(() => {
      void this.clearCachedInput();
    }, INPUT_CACHE_TTL_MS);
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
