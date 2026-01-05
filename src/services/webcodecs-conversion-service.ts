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
import {
  getH264EncoderConfig,
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from './webcodecs-support';
import { getOptimalPoolSize, WorkerPool } from './worker-pool';

const H264_INTERMEDIATE_FILE_NAME = 'webcodecs_h264.h264';

const estimateH264Bitrate = (width: number, height: number, fps: number): number => {
  const pixelsPerSecond = Math.max(1, Math.round(width * height * fps));
  const bitrate = Math.round(pixelsPerSecond * 0.07);
  return Math.min(8_000_000, Math.max(1_000_000, bitrate));
};

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

  private async encodeToH264Intermediate(params: {
    decoder: WebCodecsDecoderService;
    file: File;
    targetFps: number;
    scale: number;
    reportProgress: (current: number, total: number) => void;
    shouldCancel: () => boolean;
  }): Promise<{ data: Uint8Array; metadata: VideoMetadata }> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error('VideoEncoder is not available in this browser.');
    }

    const { decoder, file, targetFps, scale, reportProgress, shouldCancel } = params;
    const chunks: Uint8Array[] = [];
    let encoder: VideoEncoder | undefined;
    let encoderConfig: VideoEncoderConfig | undefined;
    let encoderError: string | null = null;
    let frameIndex = 0;
    const keyFrameInterval = Math.max(1, Math.round(targetFps));

    const handleOutput = (chunk: EncodedVideoChunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
    };

    const handleError = (error: Error) => {
      encoderError = error instanceof Error ? error.message : String(error);
    };

    const ensureEncoder = async (width: number, height: number) => {
      if (encoder) {
        return;
      }

      const bitrate = estimateH264Bitrate(width, height, targetFps);
      const config = await getH264EncoderConfig({
        width,
        height,
        bitrate,
        framerate: targetFps,
      });

      if (!config) {
        throw new Error('H.264 encoder configuration is not supported.');
      }

      encoderConfig = config;
      encoder = new VideoEncoder({
        output: handleOutput,
        error: handleError,
      });
      encoder.configure(config);
      ffmpegService.reportStatus('Encoding H.264 intermediate...');
      ffmpegService.reportProgress(FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START);
    };

    let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>> | null = null;

    try {
      decodeResult = await decoder.decodeToFrames({
        file,
        targetFps,
        scale,
        frameFormat: 'rgba',
        frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
        framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
        frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
        frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
        captureMode: 'seek',
        shouldCancel,
        onProgress: reportProgress,
        onFrame: async (frame) => {
          if (shouldCancel()) {
            throw new Error('Conversion cancelled by user');
          }
          if (!frame.imageData) {
            throw new Error('WebCodecs did not provide raw frame data.');
          }

          await ensureEncoder(frame.imageData.width, frame.imageData.height);
          if (!encoder) {
            throw new Error('H.264 encoder failed to initialize.');
          }

          const timestamp = Math.round((frameIndex / targetFps) * 1_000_000);
          // Create VideoFrame from ImageData by extracting buffer
          const videoFrame = new VideoFrame(frame.imageData.data.buffer, {
            format: 'RGBA' as VideoPixelFormat,
            codedWidth: frame.imageData.width,
            codedHeight: frame.imageData.height,
            timestamp,
          });
          encoder.encode(videoFrame, { keyFrame: frameIndex % keyFrameInterval === 0 });
          videoFrame.close();
          frameIndex += 1;

          if (encoderError) {
            throw new Error(`H.264 encoder error: ${encoderError}`);
          }
        },
      });

      if (!encoder) {
        throw new Error('H.264 encoder was not initialized.');
      }

      const encoderToFlush = encoder;
      await encoderToFlush.flush();
    } finally {
      if (encoder) {
        try {
          encoder.close();
        } catch (error) {
          logger.warn('conversion', 'Failed to close H.264 encoder', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!decodeResult) {
      throw new Error('H.264 intermediate decode failed.');
    }

    if (encoderError) {
      throw new Error(`H.264 encoder error: ${encoderError}`);
    }

    const totalSize = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const data = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    ffmpegService.reportProgress(FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END);

    const bitrate =
      encoderConfig?.bitrate && typeof encoderConfig.bitrate === 'number'
        ? encoderConfig.bitrate
        : estimateH264Bitrate(decodeResult.width, decodeResult.height, targetFps);

    return {
      data,
      metadata: {
        width: decodeResult.width,
        height: decodeResult.height,
        duration: decodeResult.duration,
        codec: 'H.264',
        framerate: targetFps,
        bitrate,
      },
    };
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

    try {
      ffmpegService.reportStatus('Transcoding to H.264 for compatibility...');

      const h264Intermediate = await this.encodeToH264Intermediate({
        decoder,
        file,
        targetFps,
        scale,
        reportProgress: reportDecodeProgress,
        shouldCancel: () => ffmpegService.isCancellationRequested(),
      });

      // Use Uint8Array to ensure compatibility with BlobPart
      // Create a copy to ensure it's an ArrayBuffer, not SharedArrayBuffer
      const h264File = new File([h264Intermediate.data.slice()], H264_INTERMEDIATE_FILE_NAME, {
        type: 'video/h264',
      });

      ffmpegService.reportStatus(`Converting H.264 to ${format.toUpperCase()}...`);

      const outputBlob =
        format === 'gif'
          ? await ffmpegService.convertToGIF(h264File, options, h264Intermediate.metadata, {
              format: 'h264',
              framerate: h264Intermediate.metadata.framerate,
            })
          : await ffmpegService.convertToWebP(h264File, options, h264Intermediate.metadata, {
              format: 'h264',
              framerate: h264Intermediate.metadata.framerate,
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

      logger.warn('conversion', 'H.264 intermediate fallback failed', {
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
            captureMode: 'seek',
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
