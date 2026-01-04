import type { ConversionOptions, VideoMetadata } from '../types/conversion-types';
import { QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '../utils/constants';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';
import { ffmpegService } from './ffmpeg-service';
import { ModernGifService } from './modern-gif-service';
import { SquooshWebPService } from './squoosh-webp-service';
import { WorkerPool } from './worker-pool';
import type { EncoderWorkerAPI } from '../workers/types';
import {
  type WebCodecsCaptureMode,
  WebCodecsDecoderService,
  type WebCodecsFrameFormat,
} from './webcodecs-decoder';
import { isWebCodecsCodecSupported, isWebCodecsDecodeSupported } from './webcodecs-support';

class WebCodecsConversionService {
  private gifWorkerPool: WorkerPool<EncoderWorkerAPI> | null = null;
  private webpWorkerPool: WorkerPool<EncoderWorkerAPI> | null = null;

  constructor() {
    // Lazy initialize worker pools
    if (typeof window !== 'undefined') {
      this.gifWorkerPool = new WorkerPool(
        new URL('../workers/gif-encoder.worker.ts', import.meta.url),
        { lazyInit: true, maxWorkers: 4 }
      );

      this.webpWorkerPool = new WorkerPool(
        new URL('../workers/webp-encoder.worker.ts', import.meta.url),
        { lazyInit: true, maxWorkers: 2 }
      );
    }
  }

  async canConvert(file: File, metadata?: VideoMetadata): Promise<boolean> {
    if (!metadata?.codec || metadata.codec === 'unknown') {
      return false;
    }

    if (!isWebCodecsDecodeSupported()) {
      return false;
    }

    if (isMemoryCritical()) {
      logger.warn('conversion', 'Skipping WebCodecs decode due to critical memory usage');
      return false;
    }

    const normalizedCodec = metadata.codec.toLowerCase();
    const isCandidate = WEBCODECS_ACCELERATED.some((codec) => normalizedCodec.includes(codec));
    if (!isCandidate) {
      return false;
    }

    return isWebCodecsCodecSupported(normalizedCodec, file.type, metadata);
  }

  async maybeConvert(
    file: File,
    format: 'gif' | 'webp' | 'avif',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob | null> {
    const useWebCodecs = await this.canConvert(file, metadata);
    if (!useWebCodecs) {
      return null;
    }

    try {
      return await this.convert(file, format, options, metadata);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes('cancelled by user') ||
        (ffmpegService.isCancellationRequested() &&
          errorMessage.includes('called FFmpeg.terminate()'))
      ) {
        throw error;
      }

      logger.warn('conversion', 'WebCodecs path failed, falling back to FFmpeg', {
        error: errorMessage,
      });
      return null;
    }
  }

  async convert(
    file: File,
    format: 'gif' | 'webp' | 'avif',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob> {
    const { quality, scale } = options;
    const settings =
      format === 'gif'
        ? QUALITY_PRESETS.gif[quality]
        : format === 'webp'
          ? QUALITY_PRESETS.webp[quality]
          : QUALITY_PRESETS.avif[quality];
    const useModernGif = format === 'gif' && ModernGifService.isSupported();
    const decoder = new WebCodecsDecoderService();
    const frameFiles: string[] = [];
    const capturedFrames: ImageData[] = [];

    // Determine if we need RGBA frames (for modern-gif or @jsquash/webp static)
    // For animated WebP and AVIF, we'll check later
    const needsRGBA = useModernGif || format === 'webp' || format === 'avif';
    const frameFormat: WebCodecsFrameFormat = needsRGBA
      ? 'rgba'
      : FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT;

    // AVIF doesn't have fps in presets, use a default
    const targetFps = 'fps' in settings ? settings.fps : 15;
    const maxFrames = format === 'webp' || format === 'avif' ? 1 : undefined;

    // Determine if FFmpeg is needed
    // Note: We'll check isAnimated after frame capture
    const needsFFmpeg = !useModernGif;

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;
    const reportDecodeProgress = (current: number, total: number) => {
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
    };

    ffmpegService.beginExternalConversion(metadata, quality);

    try {
      if (needsFFmpeg && !ffmpegService.isLoaded()) {
        logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
        await ffmpegService.initialize();
      }

      ffmpegService.reportStatus('Decoding with WebCodecs...');
      ffmpegService.reportProgress(decodeStart);

      const captureModes: WebCodecsCaptureMode[] =
        format === 'webp' || format === 'avif'
          ? ['seek', 'frame-callback', 'auto']
          : ['auto', 'seek'];
      let captureModeUsed: WebCodecsCaptureMode | null = null;
      let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>> | null =
        null;

      for (const captureMode of captureModes) {
        try {
          if (captureMode === 'seek') {
            ffmpegService.reportStatus('Retrying WebCodecs decode...');
            ffmpegService.reportProgress(decodeStart);
          }

          decodeResult = await decoder.decodeToFrames({
            file,
            targetFps,
            scale,
            frameFormat,
            frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
            framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
            frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
            frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
            maxFrames,
            captureMode,
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              if (useModernGif) {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                capturedFrames.push(frame.imageData);
                return;
              }

              // For WebP and AVIF: capture first frame only (static image)
              if ((format === 'webp' || format === 'avif') && capturedFrames.length === 0) {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                capturedFrames.push(frame.imageData);
                return;
              }

              if (!frame.data) {
                throw new Error('WebCodecs did not provide encoded frame data.');
              }
              await ffmpegService.writeVirtualFile(frame.name, frame.data);
              frameFiles.push(frame.name);
            },
          });

          captureModeUsed = captureMode;
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes('cancelled by user') ||
            (ffmpegService.isCancellationRequested() &&
              errorMessage.includes('called FFmpeg.terminate()'))
          ) {
            throw error;
          }

          logger.warn('conversion', 'WebCodecs frame capture failed', {
            error: errorMessage,
            mode: captureMode,
          });
          if (frameFiles.length > 0) {
            await ffmpegService.deleteVirtualFiles(frameFiles);
            frameFiles.length = 0;
          }
          capturedFrames.length = 0;

          if (captureMode === 'seek') {
            throw error;
          }
        }
      }

      if (!decodeResult || !decodeResult.frameCount) {
        throw new Error('WebCodecs decode produced no frames.');
      }

      logger.info('conversion', 'WebCodecs frame capture complete', {
        captureMode: captureModeUsed,
        frameCount: decodeResult.frameCount,
        width: decodeResult.width,
        height: decodeResult.height,
        fps: decodeResult.fps,
        duration: decodeResult.duration,
        frameFormat,
      });

      ffmpegService.reportProgress(decodeEnd);
      ffmpegService.reportStatus(`Encoding ${format.toUpperCase()}...`);

      const reportEncodeProgress = (current: number, total: number) => {
        const progress =
          FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START +
          ((FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END -
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START) *
            current) /
            Math.max(1, total);
        ffmpegService.reportProgress(Math.round(progress));
      };

      const encodeWithFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
        if (format === 'avif') {
          throw new Error(errorMessage);
        }

        logger.warn('conversion', 'WebCodecs encoder failed, retrying with FFmpeg frames', {
          error: errorMessage,
        });

        if (!ffmpegService.isLoaded()) {
          await ffmpegService.initialize();
        }

        if (frameFiles.length > 0) {
          await ffmpegService.deleteVirtualFiles(frameFiles);
          frameFiles.length = 0;
        }

        capturedFrames.length = 0;

        ffmpegService.reportStatus(`Retrying ${format.toUpperCase()} encode with FFmpeg...`);
        ffmpegService.reportProgress(decodeStart);

        const fallbackFrameFiles: string[] = [];
        let fallbackResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;

        try {
          fallbackResult = await decoder.decodeToFrames({
            file,
            targetFps,
            scale,
            frameFormat: FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT,
            frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
            framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
            frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
            frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
            captureMode: 'seek',
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              if (!frame.data) {
                throw new Error('WebCodecs did not provide encoded frame data.');
              }
              await ffmpegService.writeVirtualFile(frame.name, frame.data);
              fallbackFrameFiles.push(frame.name);
            },
          });
        } catch (fallbackError) {
          if (fallbackFrameFiles.length > 0) {
            await ffmpegService.deleteVirtualFiles(fallbackFrameFiles);
          }
          throw fallbackError;
        }

        return await ffmpegService.encodeFrameSequence({
          format: format as 'gif' | 'webp',
          options,
          frameCount: fallbackResult.frameCount,
          fps: targetFps,
          durationSeconds: metadata?.duration ?? fallbackResult.duration,
          frameFiles: fallbackFrameFiles,
        });
      };

      let outputBlob: Blob;

      if (useModernGif && this.gifWorkerPool) {
        // Use worker pool for GIF encoding
        try {
          outputBlob = await this.gifWorkerPool.execute(async (worker) => {
            return await worker.encode(capturedFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('conversion', 'GIF worker encoding failed, retrying on main thread', {
            error: errorMessage,
          });
          try {
            outputBlob = await ModernGifService.encode(capturedFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            outputBlob = await encodeWithFFmpegFallback(fallbackMessage);
          }
        }
      } else if (
        format === 'webp' &&
        capturedFrames.length > 0 &&
        capturedFrames[0] &&
        this.webpWorkerPool
      ) {
        // Use worker pool for static WebP encoding
        const firstFrame = capturedFrames[0];
        try {
          outputBlob = await this.webpWorkerPool.execute(async (worker) => {
            return await worker.encode([firstFrame], {
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('conversion', 'WebP worker encoding failed, retrying on main thread', {
            error: errorMessage,
          });
          try {
            outputBlob = await SquooshWebPService.encode(firstFrame, {
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            outputBlob = await encodeWithFFmpegFallback(fallbackMessage);
          }
        }
      } else if (useModernGif) {
        // Fallback to main thread if workers unavailable
        try {
          outputBlob = await ModernGifService.encode(capturedFrames, {
            width: decodeResult.width,
            height: decodeResult.height,
            fps: targetFps,
            quality,
            onProgress: reportEncodeProgress,
            shouldCancel: () => ffmpegService.isCancellationRequested(),
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          outputBlob = await encodeWithFFmpegFallback(errorMessage);
        }
      } else if (format === 'webp' && capturedFrames.length > 0 && capturedFrames[0]) {
        // Fallback to main thread for WebP
        try {
          outputBlob = await SquooshWebPService.encode(capturedFrames[0], {
            quality,
            onProgress: reportEncodeProgress,
            shouldCancel: () => ffmpegService.isCancellationRequested(),
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          outputBlob = await encodeWithFFmpegFallback(errorMessage);
        }
      } else {
        // Fallback to FFmpeg for animated WebP, AVIF, or unsupported formats
        outputBlob = await ffmpegService.encodeFrameSequence({
          format: format as 'gif' | 'webp',
          options,
          frameCount: decodeResult.frameCount,
          fps: targetFps,
          durationSeconds: metadata?.duration ?? decodeResult.duration,
          frameFiles,
        });
      }

      const completionProgress =
        format === 'gif'
          ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
          : format === 'webp'
            ? FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE
            : format === 'avif'
              ? FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE
              : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
      ffmpegService.reportProgress(completionProgress);

      // Cleanup captured frames for non-FFmpeg encoders
      if (capturedFrames.length > 0 && (useModernGif || format === 'webp')) {
        capturedFrames.length = 0;
      }

      return outputBlob;
    } catch (error) {
      if (frameFiles.length > 0) {
        await ffmpegService.deleteVirtualFiles(frameFiles);
      }
      throw error;
    } finally {
      ffmpegService.endExternalConversion();
    }
  }

  cleanup(): void {
    this.gifWorkerPool?.terminate();
    this.webpWorkerPool?.terminate();
    this.gifWorkerPool = null;
    this.webpWorkerPool = null;
  }
}

export const webcodecsConversionService = new WebCodecsConversionService();
