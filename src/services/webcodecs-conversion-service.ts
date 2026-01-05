import type { ConversionOptions, VideoMetadata } from '../types/conversion-types';
import { COMPLEX_CODECS, QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '../utils/constants';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { getAvailableMemory, isMemoryCritical } from '../utils/memory-monitor';
import { getOptimalFPS } from '../utils/quality-optimizer';
import type { EncoderWorkerAPI } from '../workers/types';
import { ffmpegService } from './ffmpeg-service';
import { ModernGifService } from './modern-gif-service';
import {
  type WebCodecsCaptureMode,
  WebCodecsDecoderService,
  type WebCodecsFrameFormat,
} from './webcodecs-decoder';
import { isWebCodecsCodecSupported, isWebCodecsDecodeSupported } from './webcodecs-support';
import { getOptimalPoolSize, WorkerPool } from './worker-pool';

const isComplexCodec = (codec?: string): boolean => {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = codec.toLowerCase();
  return COMPLEX_CODECS.some((entry) => normalized.includes(entry));
};

class WebCodecsConversionService {
  private gifWorkerPool: WorkerPool<EncoderWorkerAPI> | null = null;

  constructor() {
    // Lazy initialize worker pools with dynamic sizing
    if (typeof window !== 'undefined') {
      const hwConcurrency = navigator.hardwareConcurrency || 4;
      const availableMem = getAvailableMemory();

      // Calculate optimal pool sizes based on hardware and memory
      const optimalGifWorkers = getOptimalPoolSize('gif', hwConcurrency, availableMem);

      logger.info('worker-pool', 'Dynamic worker pool sizing', {
        hardwareConcurrency: hwConcurrency,
        availableMemory: `${Math.round(availableMem / 1024 / 1024)}MB`,
        gifWorkers: optimalGifWorkers,
      });

      this.gifWorkerPool = new WorkerPool(
        new URL('../workers/gif-encoder.worker.ts', import.meta.url),
        { lazyInit: true, maxWorkers: optimalGifWorkers }
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

  private shouldUseH264Intermediate(
    metadata: VideoMetadata | undefined,
    format: 'gif' | 'webp' | 'avif'
  ): boolean {
    if (format === 'avif') {
      return false;
    }
    if (!isComplexCodec(metadata?.codec)) {
      return false;
    }
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return false;
    }
    return true;
  }

  private async convertViaH264Intermediate(params: {
    decoder: WebCodecsDecoderService;
    file: File;
    format: 'gif' | 'webp' | 'avif';
    options: ConversionOptions;
    targetFps: number;
    scale: number;
    metadata?: VideoMetadata;
    reportDecodeProgress: (current: number, total: number) => void;
  }): Promise<Blob | null> {
    const { decoder, file, format, options, targetFps, scale, metadata, reportDecodeProgress } =
      params;

    if (!this.shouldUseH264Intermediate(metadata, format)) {
      return null;
    }

    logger.info('conversion', 'Attempting H.264 intermediate fallback', {
      codec: metadata?.codec,
      format,
    });

    const frameFiles: string[] = [];

    try {
      ffmpegService.reportStatus('Extracting frames via WebCodecs...');

      // For complex codecs, bypass H.264 intermediate entirely
      // Extract PNG frames directly and write to FFmpeg VFS
      const startTime = Date.now();

      const decodeResult = await decoder.decodeToFrames({
        file,
        targetFps,
        scale,
        frameFormat: 'png',
        frameQuality: 0.95,
        framePrefix: 'frame_',
        frameDigits: 6,
        frameStartNumber: 0,
        maxFrames: undefined,
        captureMode: 'auto',
        onFrame: async (frame) => {
          // Write PNG frame data to FFmpeg VFS
          if (frame.data && frame.data.byteLength > 0) {
            await ffmpegService.writeVirtualFile(frame.name, frame.data);
            frameFiles.push(frame.name);
          }
        },
        onProgress: reportDecodeProgress,
        shouldCancel: () => ffmpegService.isCancellationRequested(),
      });

      const elapsed = Date.now() - startTime;
      logger.info('conversion', 'Frame extraction complete', {
        frameCount: decodeResult.frameCount,
        duration: decodeResult.duration,
        elapsed: `${elapsed}ms`,
      });

      ffmpegService.reportStatus(`Converting frames to ${format.toUpperCase()}...`);

      const outputBlob =
        format === 'gif'
          ? await ffmpegService.encodeFrameSequence({
              format: 'gif',
              options,
              frameCount: frameFiles.length,
              fps: targetFps,
              durationSeconds: decodeResult.duration,
              frameFiles,
            })
          : await ffmpegService.encodeFrameSequence({
              format: 'webp',
              options,
              frameCount: frameFiles.length,
              fps: targetFps,
              durationSeconds: decodeResult.duration,
              frameFiles,
            });

      // biome-ignore lint/suspicious/noExplicitAny: Attach metadata for UI display
      if (!(outputBlob as any).wasTranscoded) {
        // biome-ignore lint/suspicious/noExplicitAny: Attach metadata for UI display
        (outputBlob as any).wasTranscoded = true;
      }

      return outputBlob;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes('cancelled by user') ||
        (ffmpegService.isCancellationRequested() &&
          errorMessage.includes('called FFmpeg.terminate()'))
      ) {
        throw error;
      }

      // Clean up temporary frame files
      if (frameFiles.length > 0) {
        try {
          await ffmpegService.deleteVirtualFiles(frameFiles);
        } catch (cleanupError) {
          logger.warn('conversion', 'Failed to clean up frame files', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      // Log detailed error information for debugging
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';
      const detailedError = {
        error: errorMessage,
        codec: metadata?.codec,
        format,
        framesWritten: frameFiles.length,
        stack: errorStack?.substring(0, 500), // Truncate stack for readability
      };
      logger.error('conversion', 'H.264 intermediate fallback failed', detailedError);
      // Also log to console for debugging in browser dev tools
      if (typeof console !== 'undefined' && console.error) {
        console.error('[H.264 intermediate] Error:', errorMessage);
        if (errorStack) {
          console.error('[H.264 intermediate] Stack:', errorStack.substring(0, 500));
        }
      }
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
    let lastValidEncodedFrame: Uint8Array | null = null;

    // Determine if we need RGBA frames (for modern-gif or static WebP/AVIF)
    const needsRGBA = useModernGif || format === 'webp' || format === 'avif';
    const frameFormat: WebCodecsFrameFormat = needsRGBA
      ? 'rgba'
      : FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT;

    // Calculate optimal FPS based on source video FPS and quality preset
    const presetFps = 'fps' in settings ? settings.fps : 15;
    const targetFps =
      metadata?.framerate && metadata.framerate > 0
        ? getOptimalFPS(metadata.framerate, quality, format)
        : presetFps;

    if (metadata?.framerate && targetFps !== presetFps) {
      logger.info('conversion', 'Using adaptive FPS', {
        sourceFPS: metadata.framerate,
        presetFPS: presetFps,
        optimalFPS: targetFps,
        quality,
        format,
      });
    }

    const maxFrames = format === 'webp' || format === 'avif' ? 1 : undefined;

    // Determine if FFmpeg is needed for initial frame handling
    const needsFFmpeg = format === 'gif' && !useModernGif;

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;
    const reportDecodeProgress = (current: number, total: number) => {
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
    };

    ffmpegService.beginExternalConversion(metadata, quality);

    // PRIORITY: Use H.264 intermediate for complex codecs (AV1, VP9, HEVC)
    // This ensures stable conversion for codecs with WebCodecs compatibility issues
    if (this.shouldUseH264Intermediate(metadata, format)) {
      logger.info('conversion', 'Using H.264 intermediate path for complex codec', {
        codec: metadata?.codec,
        format,
        reason: 'stability',
      });

      try {
        const h264Result = await this.convertViaH264Intermediate({
          decoder,
          file,
          format,
          options,
          targetFps,
          scale,
          metadata,
          reportDecodeProgress,
        });

        if (h264Result) {
          return h264Result;
        }

        // If H.264 intermediate fails, fall through to direct WebCodecs path
        logger.warn('conversion', 'H.264 intermediate path failed, trying direct WebCodecs', {
          codec: metadata?.codec,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('cancelled by user') ||
          (ffmpegService.isCancellationRequested() &&
            errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }

        logger.warn('conversion', 'H.264 intermediate path error, trying direct WebCodecs', {
          error: errorMessage,
          codec: metadata?.codec,
        });
      }
    }

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
              if (format === 'webp' || format === 'avif') {
                if (capturedFrames.length === 0) {
                  if (!frame.imageData) {
                    throw new Error('WebCodecs did not provide raw frame data.');
                  }
                  capturedFrames.push(frame.imageData);
                }
                // Ignore subsequent frames for static image formats
                return;
              }

              // Validate frame data exists and is not empty
              if (!frame.data || frame.data.byteLength === 0) {
                if (!lastValidEncodedFrame) {
                  logger.error('conversion', 'WebCodecs produced empty frame with no fallback', {
                    frameName: frame.name,
                    frameIndex: frame.index,
                  });
                  throw new Error(
                    'WebCodecs produced empty frame data at the start of the sequence. ' +
                      'This indicates codec incompatibility. Falling back to FFmpeg.'
                  );
                }

                // Reuse the last valid encoded frame to avoid writing 0-byte frames
                const reusedFrame = new Uint8Array(lastValidEncodedFrame);
                logger.warn(
                  'conversion',
                  'WebCodecs produced empty frame data, reusing last frame',
                  {
                    frameName: frame.name,
                    frameIndex: frame.index,
                    dataSize: frame.data?.byteLength ?? 0,
                  }
                );
                await ffmpegService.writeVirtualFile(frame.name, reusedFrame);
                frameFiles.push(frame.name);
                return;
              }

              const encodedFrame = new Uint8Array(frame.data);
              lastValidEncodedFrame = encodedFrame;
              await ffmpegService.writeVirtualFile(frame.name, encodedFrame);
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
        capturedFramesCount: capturedFrames.length,
        frameFilesCount: frameFiles.length,
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

        // H.264 intermediate path already attempted at the start of convert()
        // Skip redundant retry and go directly to FFmpeg frame re-extraction
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
        let lastValidFallbackFrame: Uint8Array | null = null;

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
            captureMode: 'auto',
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              if (!frame.data || frame.data.byteLength === 0) {
                if (!lastValidFallbackFrame) {
                  throw new Error('WebCodecs did not provide encoded frame data.');
                }

                const reusedFrame = new Uint8Array(lastValidFallbackFrame);
                logger.warn(
                  'conversion',
                  'WebCodecs produced empty fallback frame data, reusing last frame',
                  {
                    frameName: frame.name,
                    frameIndex: frame.index,
                  }
                );
                await ffmpegService.writeVirtualFile(frame.name, reusedFrame);
                fallbackFrameFiles.push(frame.name);
                return;
              }

              const encodedFrame = new Uint8Array(frame.data);
              lastValidFallbackFrame = encodedFrame;
              await ffmpegService.writeVirtualFile(frame.name, encodedFrame);
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
      } else if (format === 'webp') {
        // Use FFmpeg for WebP encoding
        logger.info('conversion', 'Using FFmpeg for WebP encoding');
        outputBlob = await encodeWithFFmpegFallback('WebP encoding via FFmpeg');
      } else if (format === 'avif') {
        // Use FFmpeg for AVIF encoding
        logger.info('conversion', 'Using FFmpeg for AVIF encoding');
        outputBlob = await encodeWithFFmpegFallback('AVIF encoding via FFmpeg');
      } else {
        // Fallback to FFmpeg for animated WebP or unsupported formats
        logger.info('conversion', 'Using FFmpeg frame sequence encoding', {
          format,
          frameFilesCount: frameFiles.length,
          capturedFramesCount: capturedFrames.length,
          hasFirstCapturedFrame: !!capturedFrames[0],
        });
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
      if (capturedFrames.length > 0 && (useModernGif || format === 'webp' || format === 'avif')) {
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
    this.gifWorkerPool = null;
  }
}

export const webcodecsConversionService = new WebCodecsConversionService();
