import type { ConversionOptions, VideoMetadata } from '../types/conversion-types';
import { COMPLEX_CODECS, QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '../utils/constants';
import { getErrorMessage } from '../utils/error-utils';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { getAvailableMemory, isMemoryCritical } from '../utils/memory-monitor';
import { getOptimalFPS } from '../utils/quality-optimizer';
import { muxAnimatedWebP } from '../utils/webp-muxer';
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

const WEBP_ANIMATION_MAX_FRAMES = 240;
const WEBP_ANIMATION_MAX_DURATION_SECONDS = 10;
const MIN_WEBP_FRAME_DURATION_MS = 8;
const MAX_WEBP_DURATION_24BIT = 0xffffff; // 24-bit duration ceiling per WebP spec
const WEBP_BACKGROUND_COLOR = { r: 0, g: 0, b: 0, a: 0 } as const;

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

  private getMaxWebPFrames(targetFps: number, durationSeconds?: number): number {
    const cappedDuration = Math.max(
      1,
      Math.min(
        durationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS,
        WEBP_ANIMATION_MAX_DURATION_SECONDS
      )
    );
    const estimatedFrames = Math.ceil(cappedDuration * Math.max(1, targetFps));
    return Math.max(1, Math.min(estimatedFrames, WEBP_ANIMATION_MAX_FRAMES));
  }

  private createWebPFrameEncoder(qualityRatio: number): (frame: ImageData) => Promise<Uint8Array> {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

    return async (frame: ImageData): Promise<Uint8Array> => {
      if (!canvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(frame.width, frame.height);
          context = canvas.getContext('2d');
        } else {
          const createdCanvas = document.createElement('canvas');
          createdCanvas.width = frame.width;
          createdCanvas.height = frame.height;
          canvas = createdCanvas;
          context = createdCanvas.getContext('2d');
        }
      }

      if (!canvas || !context) {
        throw new Error('Canvas context unavailable for WebP frame encoding.');
      }

      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }

      context.putImageData(frame, 0, 0);

      const quality = Math.min(1, Math.max(0, qualityRatio));
      const blob =
        'convertToBlob' in canvas
          ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality })
          : await new Promise<Blob>((resolve, reject) => {
              (canvas as HTMLCanvasElement).toBlob(
                (result) => {
                  if (result && result.size > 0) {
                    resolve(result);
                    return;
                  }
                  reject(new Error('Failed to encode WebP frame via toBlob.'));
                },
                'image/webp',
                quality
              );
            });

      if (!blob || blob.size === 0) {
        throw new Error('WebP frame encoding produced an empty blob.');
      }

      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    };
  }

  private async validateWebPBlob(blob: Blob): Promise<{ valid: boolean; reason?: string }> {
    if (blob.size < FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_WEBP_SIZE_BYTES) {
      return {
        valid: false,
        reason: `WebP output too small (${blob.size} bytes)`,
      };
    }

    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const riffSignature = String.fromCharCode(...header.slice(0, 4));
    const webpSignature = String.fromCharCode(...header.slice(8, 12));
    if (riffSignature !== 'RIFF' || webpSignature !== 'WEBP') {
      return {
        valid: false,
        reason: 'Invalid WebP file signature',
      };
    }

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        bitmap.close();
      } catch (error) {
        return {
          valid: false,
          reason: `WebP decode failed: ${getErrorMessage(error)}`,
        };
      }
    }

    return { valid: true };
  }

  private buildWebPFrameDurations(timestamps: number[], fps: number, frameCount: number): number[] {
    const defaultDuration = Math.max(
      MIN_WEBP_FRAME_DURATION_MS,
      Math.round(1000 / Math.max(1, fps))
    );
    if (frameCount <= 1 || timestamps.length <= 1) {
      return Array.from({ length: Math.max(1, frameCount) }, () => defaultDuration);
    }

    const durations: number[] = [];
    for (let i = 0; i < frameCount; i += 1) {
      const currentTimestamp: number =
        typeof timestamps[i] === 'number' && Number.isFinite(timestamps[i])
          ? (timestamps[i] as number)
          : i > 0 && typeof timestamps[i - 1] === 'number'
            ? (timestamps[i - 1] as number)
            : 0;
      const nextTimestamp = timestamps[i + 1];
      if (typeof nextTimestamp === 'number' && Number.isFinite(nextTimestamp)) {
        const deltaMs = Math.max(
          MIN_WEBP_FRAME_DURATION_MS,
          Math.round((nextTimestamp - currentTimestamp) * 1000)
        );
        durations.push(Math.min(MAX_WEBP_DURATION_24BIT, deltaMs));
      } else {
        durations.push(defaultDuration);
      }
    }

    // Ensure the last frame has a duration
    if (durations.length < frameCount) {
      durations.push(defaultDuration);
    }

    return durations.slice(0, frameCount);
  }

  private async muxWebPFrames(params: {
    encodedFrames: Uint8Array[];
    timestamps: number[];
    width: number;
    height: number;
    fps: number;
    onProgress?: (current: number, total: number) => void;
    shouldCancel?: () => boolean;
  }): Promise<Blob | null> {
    const { encodedFrames, timestamps, width, height, fps, onProgress, shouldCancel } = params;

    if (!encodedFrames.length) {
      return null;
    }

    const durations = this.buildWebPFrameDurations(timestamps, fps, encodedFrames.length);

    if (encodedFrames.length === 1) {
      onProgress?.(1, 1);
      const frame = encodedFrames[0];
      if (!frame) {
        return null;
      }

      const buffer = frame.slice().buffer;
      return new Blob([buffer], { type: 'image/webp' });
    }

    const framesForMux = encodedFrames.map((frame, index) => {
      if (!frame) {
        throw new Error('Missing encoded frame for WebP muxing.');
      }

      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      onProgress?.(index + 1, encodedFrames.length);

      const buffer = frame.slice().buffer as ArrayBuffer;
      const duration =
        durations[index] ?? durations[durations.length - 1] ?? MIN_WEBP_FRAME_DURATION_MS;

      return { data: buffer, duration };
    });

    const muxed = await muxAnimatedWebP(framesForMux, {
      width,
      height,
      loopCount: 0,
      backgroundColor: WEBP_BACKGROUND_COLOR,
      hasAlpha: true,
    });

    onProgress?.(encodedFrames.length, encodedFrames.length);

    return new Blob([muxed], { type: 'image/webp' });
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
    format: 'gif' | 'webp',
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
      const errorMessage = getErrorMessage(error);
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

  private shouldUseWebCodecsPath(metadata: VideoMetadata | undefined): boolean {
    if (!isComplexCodec(metadata?.codec)) {
      return false;
    }
    if (typeof VideoFrame === 'undefined') {
      return false;
    }
    return true;
  }

  private async convertViaWebCodecsFrames(params: {
    decoder: WebCodecsDecoderService;
    file: File;
    format: 'gif' | 'webp';
    options: ConversionOptions;
    targetFps: number;
    scale: number;
    metadata?: VideoMetadata;
    reportDecodeProgress: (current: number, total: number) => void;
    capturedFrames?: ImageData[];
  }): Promise<Blob | null> {
    const {
      decoder,
      file,
      format,
      options,
      targetFps,
      scale,
      metadata,
      reportDecodeProgress,
      capturedFrames,
    } = params;
    if (!this.shouldUseWebCodecsPath(metadata)) {
      return null;
    }

    // GIF: Skip WebCodecs path, use FFmpeg direct instead
    // WebCodecs frame extraction for GIF has VFS write stability issues
    if (format === 'gif') {
      logger.info('conversion', 'GIF format with complex codec: skipping WebCodecs path', {
        codec: metadata?.codec,
        reason: 'Use FFmpeg direct path instead',
      });
      return null;
    }

    logger.info('conversion', 'Using WebCodecs direct frame extraction path', {
      codec: metadata?.codec,
      format,
    });

    const frameFiles: string[] = [];
    const framesToWrite: Array<{ name: string; data: Uint8Array }> = [];
    const maxFrames = this.getMaxWebPFrames(targetFps, metadata?.duration);

    try {
      ffmpegService.reportStatus('Extracting frames via WebCodecs...');

      // Direct WebCodecs → PNG pipeline for complex codecs
      // Use FFmpeg frame-sequence encoding for stable WebP output
      const startTime = Date.now();

      const frameFormat = 'png';

      const decodeResult = await decoder.decodeToFrames({
        file,
        targetFps,
        scale,
        frameFormat,
        frameQuality: 0.95,
        framePrefix: 'frame_',
        frameDigits: 6,
        frameStartNumber: 0,
        maxFrames,
        captureMode: 'auto',
        onFrame: async (frame) => {
          // Collect frames for batch VFS write (3-5x faster than sequential)
          if (frame.data && frame.data.byteLength > 0) {
            // Validate frame data before queuing
            if (frame.data.byteLength < 100) {
              logger.warn('conversion', `Suspicious small frame from WebCodecs: ${frame.name}`, {
                byteLength: frame.data.byteLength,
              });
            }
            framesToWrite.push({ name: frame.name, data: frame.data });
          } else {
            logger.error('conversion', `Rejected 0-byte frame from WebCodecs: ${frame.name}`, {
              hasData: !!frame.data,
              byteLength: frame.data?.byteLength ?? 0,
            });
          }
        },
        onProgress: reportDecodeProgress,
        shouldCancel: () => ffmpegService.isCancellationRequested(),
      });

      // Batch write frames to VFS in parallel for 3-5x speedup
      if (framesToWrite.length > 0) {
        const WRITE_BATCH_SIZE = 50; // Write 50 frames per batch
        logger.info('conversion', 'Batch writing frames to VFS', {
          totalFrames: framesToWrite.length,
          batchSize: WRITE_BATCH_SIZE,
        });

        for (let i = 0; i < framesToWrite.length; i += WRITE_BATCH_SIZE) {
          const batch = framesToWrite.slice(
            i,
            Math.min(i + WRITE_BATCH_SIZE, framesToWrite.length)
          );

          // Write batch in parallel
          await Promise.all(
            batch.map(async (frame) => {
              await ffmpegService.writeVirtualFile(frame.name, frame.data);
              frameFiles.push(frame.name);
            })
          );
        }

        logger.info('conversion', 'VFS write complete', {
          framesWritten: frameFiles.length,
        });
      }

      const elapsed = Date.now() - startTime;
      logger.info('conversion', 'Frame extraction complete', {
        frameCount: decodeResult.frameCount,
        duration: decodeResult.duration,
        elapsed: `${elapsed}ms`,
        format,
        capturedFramesCount: capturedFrames?.length ?? 0,
      });

      ffmpegService.reportStatus(`Converting frames to ${format.toUpperCase()}...`);

      const outputBlob = await ffmpegService.encodeFrameSequence({
        format: 'webp', // format is guaranteed to be 'webp' here after GIF check
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
      const errorMessage = getErrorMessage(error);
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
      logger.error('conversion', 'WebCodecs direct path failed', detailedError);
      // Also log to console for debugging in browser dev tools
      if (typeof console !== 'undefined' && console.error) {
        console.error('[WebCodecs direct] Error:', errorMessage);
        if (errorStack) {
          console.error('[WebCodecs direct] Stack:', errorStack.substring(0, 500));
        }
      }
      return null;
    }
  }

  async convert(
    file: File,
    format: 'gif' | 'webp',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob> {
    const { quality, scale } = options;
    const settings =
      format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];
    const useModernGif = format === 'gif' && ModernGifService.isSupported();

    // GIF format: Always prefer FFmpeg direct path for better performance
    // WebCodecs frame extraction + FFmpeg GIF encoding is 3x slower than direct FFmpeg encoding
    // and has reliability issues with FFmpeg GIF options (e.g., fps_mode parsing errors)
    if (format === 'gif' && !useModernGif) {
      logger.info(
        'conversion',
        'GIF format detected: using direct FFmpeg path for optimal performance',
        {
          fileSize: file.size,
          format,
        }
      );
      await ffmpegService.initialize();
      return ffmpegService.convertToGIF(file, options, metadata);
    }

    const decoder = new WebCodecsDecoderService();
    const frameFiles: string[] = [];
    const capturedFrames: ImageData[] = [];
    const webpCapturedFrames: ImageData[] = []; // Collect WebP frames for batch encoding
    const webpEncodedFrames: Uint8Array[] = [];
    const webpFrameTimestamps: number[] = [];
    const webpQualityRatio = format === 'webp' ? QUALITY_PRESETS.webp[quality].quality / 100 : null;
    let lastValidEncodedFrame: Uint8Array | null = null;

    // Determine if we need RGBA frames (for modern-gif or static WebP)
    const needsRGBA = useModernGif || format === 'webp';
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

    // Determine if FFmpeg is needed for initial frame handling
    const needsFFmpeg = format === 'gif' && !useModernGif;

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;
    const reportDecodeProgress = (current: number, total: number) => {
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
    };

    ffmpegService.beginExternalConversion(metadata, quality);

    let externalEnded = false;
    const endConversion = () => {
      if (externalEnded) {
        return;
      }
      ffmpegService.endExternalConversion();
      externalEnded = true;
    };

    // PRIORITY: Use direct WebCodecs path for complex codecs (AV1, VP9, HEVC)
    // This extracts PNG frames directly without H.264 intermediate transcoding
    try {
      if (this.shouldUseWebCodecsPath(metadata)) {
        logger.info('conversion', 'Using WebCodecs direct path for complex codec', {
          codec: metadata?.codec,
          format,
          reason: 'direct frame extraction',
        });

        try {
          const webCodecsResult = await this.convertViaWebCodecsFrames({
            decoder,
            file,
            format,
            options,
            targetFps,
            scale,
            metadata,
            reportDecodeProgress,
            capturedFrames,
          });

          if (webCodecsResult) {
            endConversion();
            return webCodecsResult;
          }

          // If WebCodecs path fails, fall through to direct FFmpeg path
          logger.warn('conversion', 'WebCodecs direct path failed, trying FFmpeg fallback', {
            codec: metadata?.codec,
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
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

      if (needsFFmpeg && !ffmpegService.isLoaded()) {
        logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
        await ffmpegService.initialize();
      }

      ffmpegService.reportStatus('Decoding with WebCodecs...');
      ffmpegService.reportProgress(decodeStart);

      const captureModes: WebCodecsCaptureMode[] = ['auto', 'seek'];
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
            maxFrames:
              format === 'webp' ? this.getMaxWebPFrames(targetFps, metadata?.duration) : undefined,
            captureMode,
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              if (format === 'webp') {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                // Collect frames for batch encoding (parallelized later)
                webpCapturedFrames.push(frame.imageData);
                webpFrameTimestamps.push(frame.timestamp);
                return;
              }

              if (useModernGif) {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                capturedFrames.push(frame.imageData);
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
          const errorMessage = getErrorMessage(error);
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
        webpEncodedFrames: webpEncodedFrames.length,
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
          // Convert ImageData to serializable format for worker transfer
          // ImageData objects cannot be cloned by postMessage - must transfer underlying buffer
          const serializableFrames = capturedFrames.map((frame) => ({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            colorSpace: frame.colorSpace,
          }));

          outputBlob = await this.gifWorkerPool.execute(async (worker) => {
            return await worker.encode(serializableFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
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
          const errorMessage = getErrorMessage(error);
          outputBlob = await encodeWithFFmpegFallback(errorMessage);
        }
      } else if (format === 'webp') {
        logger.info('conversion', 'Using WebP muxer path with parallel frame encoding');

        // Batch encode WebP frames in parallel for 3-4x speedup
        if (webpCapturedFrames.length > 0 && webpQualityRatio !== null) {
          const CHUNK_SIZE = 10; // Encode 10 frames per batch for optimal parallelization
          const totalFrames = webpCapturedFrames.length;

          logger.info('conversion', 'Parallel WebP frame encoding', {
            totalFrames,
            chunkSize: CHUNK_SIZE,
            estimatedBatches: Math.ceil(totalFrames / CHUNK_SIZE),
          });

          // Create encoder function for parallel execution
          const encodeFrame = this.createWebPFrameEncoder(webpQualityRatio);

          // Process frames in batches
          for (let i = 0; i < totalFrames; i += CHUNK_SIZE) {
            const chunk = webpCapturedFrames.slice(i, Math.min(i + CHUNK_SIZE, totalFrames));

            // Encode chunk in parallel using Promise.all
            const encodedChunk = await Promise.all(
              chunk.map((frameData) => encodeFrame(frameData))
            );

            webpEncodedFrames.push(...encodedChunk);

            // Report encoding progress
            reportEncodeProgress(webpEncodedFrames.length, totalFrames);
          }

          logger.info('conversion', 'Parallel encoding complete', {
            encodedFrames: webpEncodedFrames.length,
          });
        }

        let fallbackReason = 'WebP muxer output failed';

        const muxedWebP = await (async (): Promise<Blob | null> => {
          try {
            const result = await this.muxWebPFrames({
              encodedFrames: webpEncodedFrames,
              timestamps: webpFrameTimestamps,
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });

            if (!result) {
              fallbackReason = 'WebP muxer produced no output';
              logger.warn('conversion', 'WebP muxer produced no output, using FFmpeg fallback', {
                frameCount: decodeResult.frameCount,
              });
              return null;
            }

            const validation = await this.validateWebPBlob(result);
            if (!validation.valid) {
              fallbackReason = validation.reason ?? 'WebP muxer output failed validation';
              logger.warn('conversion', 'WebP muxer output failed validation, using fallback', {
                reason: validation.reason,
                frameCount: webpEncodedFrames.length,
              });
              return null;
            }

            return result;
          } catch (error) {
            const errorMessage = getErrorMessage(error);

            if (
              errorMessage.includes('cancelled by user') ||
              (ffmpegService.isCancellationRequested() &&
                errorMessage.includes('called FFmpeg.terminate()'))
            ) {
              throw error;
            }

            fallbackReason = errorMessage;
            logger.warn('conversion', 'WebP muxer path failed, using FFmpeg fallback', {
              error: errorMessage,
              frameCount: webpEncodedFrames.length,
            });
            return null;
          }
        })();

        outputBlob = muxedWebP ?? (await encodeWithFFmpegFallback(fallbackReason));

        webpEncodedFrames.length = 0;
        webpFrameTimestamps.length = 0;
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
      endConversion();
    }
  }

  cleanup(): void {
    this.gifWorkerPool?.terminate();
    this.gifWorkerPool = null;
  }
}

export const webcodecsConversionService = new WebCodecsConversionService();
