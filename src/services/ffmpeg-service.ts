import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { ConversionOptions, VideoMetadata } from '../types/conversion-types';
import {
  FFMPEG_CORE_URL,
  QUALITY_PRESETS,
  TIMEOUT_CONVERSION,
  TIMEOUT_FFMPEG_INIT,
  TIMEOUT_VIDEO_ANALYSIS,
} from '../utils/constants';
import { isMemoryCritical, logMemoryUsage } from '../utils/memory-monitor';
import { isOPFSSupported, logOPFSStatus } from '../utils/opfs-support';
import { withTimeout } from '../utils/with-timeout';

/**
 * Get optimal thread count based on CPU cores.
 * Uses up to 4 threads for better performance while avoiding memory issues.
 * Note: filter_complex operations should use single thread to avoid hangs (GitHub issue #883)
 */
function getOptimalThreadCount(): number {
  const cores = navigator.hardwareConcurrency || 2;
  // Limit to 4 threads max to avoid excessive memory usage in browser
  return Math.min(cores, 4);
}

/**
 * Get thread arguments for FFmpeg based on operation type.
 * Filter complex operations use single thread to prevent hangs.
 */
function getThreadArgs(useFilterComplex: boolean): string[] {
  if (useFilterComplex) {
    // Filter complex is prone to hanging with multithreading
    return ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
  }
  const threads = getOptimalThreadCount();
  return ['-threads', threads.toString()];
}

/**
 * Some filter graphs (e.g., palettegen) are known to hang with multithreading in ffmpeg.wasm
 * Use single-threaded filter execution for stability.
 */
function getFilterGraphSafeArgs(): string[] {
  return ['-threads', '1', '-filter_threads', '1'];
}

class FFmpegService {
  private ffmpeg: FFmpeg | null = null;
  private loaded = false;
  private progressCallback: ((progress: number) => void) | null = null;
  private statusCallback: ((message: string) => void) | null = null;
  private useOPFS = false;

  // Watchdog timer properties for detecting hung conversions
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressTime = 0;
  private isConverting = false;

  async initialize(onProgress?: (progress: number) => void): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.ffmpeg = new FFmpeg();

    this.ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
    });

    this.ffmpeg.on('progress', ({ progress }) => {
      const progressPercent = Math.round(progress * 100);
      const normalizedProgress = Number.isFinite(progressPercent)
        ? Math.min(100, Math.max(0, progressPercent))
        : 0;
      console.log('[FFmpeg Service] Progress event:', {
        progress,
        progressPercent: normalizedProgress,
        hasOnProgress: !!onProgress,
        hasProgressCallback: !!this.progressCallback,
      });

      // Update watchdog timer if conversion is in progress
      if (this.isConverting) {
        this.updateWatchdogProgress(normalizedProgress);
      }

      if (onProgress) {
        console.log('[FFmpeg Service] Calling onProgress with:', normalizedProgress);
        onProgress(normalizedProgress);
      }
      // Also call the global progress callback if set
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Calling progressCallback with:', normalizedProgress);
        this.progressCallback(normalizedProgress);
      }
    });

    // Don't store initialization callback - it's for loading FFmpeg only
    console.log('[FFmpeg Service] Progress handler registered');

    // Check OPFS support for better performance with large files
    this.useOPFS = isOPFSSupported();
    if (this.useOPFS) {
      console.log('[FFmpeg Service] OPFS is supported - enabling disk-based file operations');
      await logOPFSStatus();
    } else {
      console.warn('[FFmpeg Service] OPFS not supported - using memory-based file system (MEMFS)');
    }

    const baseURL = FFMPEG_CORE_URL;

    try {
      await withTimeout(
        this.ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
        }),
        TIMEOUT_FFMPEG_INIT,
        `FFmpeg initialization timed out after ${TIMEOUT_FFMPEG_INIT / 1000} seconds. Please check your internet connection and try again.`
      );

      this.loaded = true;

      if (this.useOPFS) {
        console.log(
          '[FFmpeg Service] Initialized with OPFS support for improved large file handling'
        );
      }
    } catch (error) {
      console.error('FFmpeg initialization failed:', error);
      throw error;
    }
  }

  async getVideoMetadata(file: File): Promise<VideoMetadata> {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }

    const inputFileName = 'input.mp4';
    await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));

    const metadata: VideoMetadata = {
      width: 0,
      height: 0,
      duration: 0,
      codec: 'unknown',
      framerate: 0,
      bitrate: 0,
    };

    this.ffmpeg.on('log', ({ message }) => {
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
    });

    try {
      await withTimeout(
        this.ffmpeg.exec(['-i', inputFileName]),
        TIMEOUT_VIDEO_ANALYSIS,
        `Video analysis timed out after ${TIMEOUT_VIDEO_ANALYSIS / 1000} seconds. The file may be corrupted or in an unsupported format.`
      );
    } catch (error) {
      // FFmpeg returns error when just probing, but we captured the metadata from logs
      // Only throw if it's a timeout error
      if (error instanceof Error && error.message.includes('timed out')) {
        await this.ffmpeg.deleteFile(inputFileName);
        throw error;
      }
    }

    await this.ffmpeg.deleteFile(inputFileName);

    return metadata;
  }

  async convertToGIF(file: File, options: ConversionOptions): Promise<Blob> {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }

    console.log('[FFmpeg Service] convertToGIF started:', {
      quality: options.quality,
      scale: options.scale,
      hasProgressCallback: !!this.progressCallback,
    });

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.gif[quality];
    const inputFileName = 'input.mp4';
    const paletteFileName = 'palette.png';
    const outputFileName = 'output.gif';

    // Start watchdog timer to detect hung conversions
    this.startWatchdog();

    try {
      const startTime = Date.now();
      logMemoryUsage('GIF conversion - Before file write');
      await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));
      logMemoryUsage('GIF conversion - After file write');

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      console.log('[FFmpeg Service] Input file written', {
        fileSize: file.size,
        elapsedMs: Date.now() - startTime,
      });

      // Manually report progress: 10% after file write
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 10%');
        this.progressCallback(10);
      }
      this.updateWatchdogProgress(10);

      const scaleFilter = `scale=iw*${scale}:ih*${scale}:flags=lanczos`;

      // Try palette-based conversion first, fall back to direct conversion if it fails
      let usedPalette = true;

      try {
        // Palette-based conversion (two-pass for better quality/compression)
        this.updateStatus('Generating color palette...');
        console.log('[FFmpeg Service] Starting palette generation...', {
          settings,
        });

        const paletteStart = Date.now();
        try {
          // Optimize palette generation using fast stats_mode for lower quality presets
          const statsMode = quality === 'low' ? 'fast' : 'full';
          const paletteThreadArgs = getFilterGraphSafeArgs(); // palettegen can hang with multithreading
          await withTimeout(
            this.ffmpeg!.exec([
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
          console.log('[FFmpeg Service] Palette generated', {
            elapsedMs: Date.now() - paletteStart,
          });
        } catch (paletteError) {
          console.error('[FFmpeg Service] Palette generation failed', {
            elapsedMs: Date.now() - paletteStart,
            error: paletteError instanceof Error ? { message: paletteError.message } : paletteError,
          });
          throw paletteError;
        }

        // Manually report progress: 40% after palette generation
        if (this.progressCallback) {
          console.log('[FFmpeg Service] Manual progress update: 40%');
          this.progressCallback(40);
        }
        this.updateWatchdogProgress(40);

        this.updateStatus('Converting to GIF with palette...');
        console.log('[FFmpeg Service] Starting GIF conversion with palette...');

        const gifStart = Date.now();
        try {
          // Apply dithering based on quality for better visual output
          const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
          const filterComplexThreadArgs = getThreadArgs(true); // Uses filter_complex, single thread
          await withTimeout(
            this.ffmpeg!.exec([
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
          console.log('[FFmpeg Service] GIF conversion completed with palette', {
            elapsedMs: Date.now() - gifStart,
          });
        } catch (gifError) {
          console.error('[FFmpeg Service] GIF conversion failed', {
            elapsedMs: Date.now() - gifStart,
            error: gifError instanceof Error ? { message: gifError.message } : gifError,
          });
          throw gifError;
        }
      } catch (paletteConversionError) {
        // Palette-based conversion failed, fall back to direct conversion
        console.warn(
          '[FFmpeg Service] Palette-based conversion failed, falling back to direct conversion:',
          paletteConversionError
        );
        usedPalette = false;

        // Clean up palette file if it exists
        try {
          if (this.ffmpeg) {
            await this.ffmpeg.deleteFile(paletteFileName);
          }
        } catch {}

        // Check if FFmpeg was terminated, if so reinitialize it for fallback
        if (!this.ffmpeg || !this.loaded) {
          console.log(
            '[FFmpeg Service] FFmpeg was terminated during palette generation, reinitializing for fallback...'
          );
          try {
            await this.initialize();
            // Re-write input file since FFmpeg was reset
            const rewriteStart = Date.now();
            await this.ffmpeg!.writeFile(inputFileName, await fetchFile(file));
            console.log('[FFmpeg Service] Input file re-written after reinitialization', {
              elapsedMs: Date.now() - rewriteStart,
            });
          } catch (reinitError) {
            console.error(
              '[FFmpeg Service] Failed to reinitialize FFmpeg for fallback:',
              reinitError
            );
            throw new Error('FFmpeg reinitialization failed during fallback conversion');
          }
        }

        // Progress update before fallback
        if (this.progressCallback) {
          console.log('[FFmpeg Service] Manual progress update: 50% (fallback)');
          this.progressCallback(50);
        }
        this.updateWatchdogProgress(50);

        // Use direct conversion without palette
        await this.convertToGIFDirect(inputFileName, outputFileName, settings, scaleFilter, file);
      }

      // Manually report progress: 90% after conversion
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 90%');
        this.progressCallback(90);
      }
      this.updateWatchdogProgress(90);

      console.log(
        '[FFmpeg Service] GIF conversion completed using:',
        usedPalette ? 'palette optimization' : 'direct conversion'
      );

      const data = await this.ffmpeg.readFile(outputFileName);
      console.log('[FFmpeg Service] Output file read, size:', (data as Uint8Array).length);

      // Manually report progress: 100% after file read
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 100%');
        this.progressCallback(100);
      }
      this.updateWatchdogProgress(100);

      await this.ffmpeg.deleteFile(inputFileName);
      await this.ffmpeg.deleteFile(paletteFileName);
      await this.ffmpeg.deleteFile(outputFileName);
      logMemoryUsage('GIF conversion - After cleanup');

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/gif' });
    } catch (error) {
      // Clean up files on error
      try {
        await this.ffmpeg.deleteFile(inputFileName);
      } catch {}
      try {
        await this.ffmpeg.deleteFile(paletteFileName);
      } catch {}
      try {
        await this.ffmpeg.deleteFile(outputFileName);
      } catch {}
      throw error;
    } finally {
      // Always stop watchdog timer when conversion ends (success or failure)
      this.stopWatchdog();
    }
  }

  async convertToWebP(file: File, options: ConversionOptions): Promise<Blob> {
    if (!this.ffmpeg || !this.loaded) {
      throw new Error('FFmpeg not initialized');
    }

    console.log('[FFmpeg Service] convertToWebP started:', {
      quality: options.quality,
      scale: options.scale,
      hasProgressCallback: !!this.progressCallback,
    });

    const { quality, scale } = options;
    const settings = QUALITY_PRESETS.webp[quality];
    const inputFileName = 'input.mp4';
    const outputFileName = 'output.webp';

    // Start watchdog timer to detect hung conversions
    this.startWatchdog();

    try {
      const startTime = Date.now();
      logMemoryUsage('WebP conversion - Before file write');
      await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));
      logMemoryUsage('WebP conversion - After file write');

      if (isMemoryCritical()) {
        console.warn('[FFmpeg Service] Critical memory usage detected - conversion may fail');
      }

      console.log('[FFmpeg Service] Input file written', {
        fileSize: file.size,
        elapsedMs: Date.now() - startTime,
      });

      // Manually report progress: 20% after file write
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 20%');
        this.progressCallback(20);
      }
      this.updateWatchdogProgress(20);

      const scaleFilter = `scale=iw*${scale}:ih*${scale}:flags=lanczos`;

      console.log('[FFmpeg Service] Starting WebP conversion...', {
        settings,
        scaleFilter,
      });
      const conversionStart = Date.now();
      try {
        const webpThreadArgs = getThreadArgs(false); // No filter_complex, can use multiple threads
        await withTimeout(
          this.ffmpeg.exec([
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
        console.log('[FFmpeg Service] WebP conversion completed', {
          elapsedMs: Date.now() - conversionStart,
        });
      } catch (error) {
        const elapsedMs = Date.now() - conversionStart;
        console.error('[FFmpeg Service] WebP conversion failed', {
          elapsedMs,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        });
        throw error;
      }

      // Manually report progress: 90% after conversion
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 90%');
        this.progressCallback(90);
      }
      this.updateWatchdogProgress(90);

      const data = await this.ffmpeg.readFile(outputFileName);
      console.log('[FFmpeg Service] Output file read, size:', (data as Uint8Array).length);
      logMemoryUsage('WebP conversion - After file read');

      // Manually report progress: 100% after file read
      if (this.progressCallback) {
        console.log('[FFmpeg Service] Manual progress update: 100%');
        this.progressCallback(100);
      }
      this.updateWatchdogProgress(100);

      await this.ffmpeg.deleteFile(inputFileName);
      await this.ffmpeg.deleteFile(outputFileName);
      logMemoryUsage('WebP conversion - After cleanup');

      return new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/webp' });
    } catch (error) {
      // Clean up files on error
      try {
        await this.ffmpeg.deleteFile(inputFileName);
      } catch {}
      try {
        await this.ffmpeg.deleteFile(outputFileName);
      } catch {}
      throw error;
    } finally {
      // Always stop watchdog timer when conversion ends (success or failure)
      this.stopWatchdog();
    }
  }

  /**
   * Direct GIF conversion without palette optimization (fallback method)
   * Used when palette generation fails or hangs
   * Reinitializes FFmpeg instance if it was terminated during palette generation
   */
  private async convertToGIFDirect(
    inputFileName: string,
    outputFileName: string,
    settings: { fps: number },
    scaleFilter: string,
    file?: File
  ): Promise<void> {
    console.log('[FFmpeg Service] Using direct GIF conversion (no palette optimization)');

    // Check if FFmpeg needs reinitialization after timeout/termination
    if (!this.ffmpeg || !this.loaded) {
      if (!file) {
        throw new Error(
          'Cannot reinitialize FFmpeg without original file for direct conversion fallback'
        );
      }
      console.log(
        '[FFmpeg Service] FFmpeg was terminated, reinitializing for direct conversion...'
      );
      try {
        await this.initialize();
        const rewriteStart = Date.now();
        await this.ffmpeg!.writeFile(inputFileName, await fetchFile(file));
        console.log('[FFmpeg Service] Input file re-written after reinitialization', {
          elapsedMs: Date.now() - rewriteStart,
        });
      } catch (reinitError) {
        console.error(
          '[FFmpeg Service] Failed to reinitialize FFmpeg for direct conversion:',
          reinitError
        );
        throw reinitError;
      }
    }

    this.updateStatus('Converting to GIF directly (no palette optimization)...');

    const directGifThreadArgs = getThreadArgs(false); // Simple filter, can use multiple threads
    await withTimeout(
      this.ffmpeg!.exec([
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

    console.log('[FFmpeg Service] Direct GIF conversion completed');
  }

  setProgressCallback(callback: ((progress: number) => void) | null): void {
    console.log('[FFmpeg Service] setProgressCallback called:', { hasCallback: !!callback });
    this.progressCallback = callback;
  }

  setStatusCallback(callback: ((message: string) => void) | null): void {
    console.log('[FFmpeg Service] setStatusCallback called:', { hasCallback: !!callback });
    this.statusCallback = callback;
  }

  /**
   * Update conversion status message
   */
  private updateStatus(message: string): void {
    console.log('[FFmpeg Service] Status update:', message);
    if (this.statusCallback) {
      this.statusCallback(message);
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  isUsingOPFS(): boolean {
    return this.useOPFS;
  }

  /**
   * Start watchdog timer to detect hung FFmpeg processes
   * Checks every 10 seconds if progress has been made in the last 90 seconds
   * Known issue: filter_complex with multithreading can hang (GitHub issue #883)
   */
  private startWatchdog(): void {
    this.lastProgressTime = Date.now();
    this.isConverting = true;

    console.log('[FFmpeg Watchdog] Started monitoring with 90s timeout threshold');

    // Check every 10 seconds
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const timeSinceProgress = now - this.lastProgressTime;
      const secondsElapsed = Math.round(timeSinceProgress / 1000);

      console.log('[FFmpeg Watchdog] Check - time since last progress:', secondsElapsed, 's');

      // If no progress for 90 seconds, FFmpeg is hung
      // This timeout addresses common issues:
      // - WebP encoding can be very slow for certain codecs
      // - filter_complex operations may hang with multithreading
      // - Memory pressure can slow processing significantly
      if (timeSinceProgress > 90000) {
        console.error(
          '[FFmpeg Watchdog] No progress for 90s - FFmpeg appears hung (common with WebP/filter_complex), terminating...'
        );
        this.terminateFFmpeg();
      }
    }, 10000);
  }

  /**
   * Stop watchdog timer
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      console.log('[FFmpeg Watchdog] Stopped monitoring');
    }
    this.isConverting = false;
  }

  /**
   * Update watchdog progress tracker
   */
  private updateWatchdogProgress(progress: number): void {
    this.lastProgressTime = Date.now();
    console.log('[FFmpeg Watchdog] Progress updated:', progress, '%');
  }

  /**
   * Terminate hung FFmpeg instance and prepare for reinitialization
   */
  private terminateFFmpeg(): void {
    console.log('[FFmpeg Service] Terminating hung FFmpeg instance');
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch (e) {
        console.error('[FFmpeg Service] Error during termination:', e);
      }
      this.ffmpeg = null;
      this.loaded = false;
    }
    this.stopWatchdog();
  }

  terminate(): void {
    this.stopWatchdog(); // Stop watchdog when manually terminating
    if (this.ffmpeg) {
      this.ffmpeg.terminate();
      this.loaded = false;
      this.ffmpeg = null;
    }
  }
}

export const ffmpegService = new FFmpegService();
