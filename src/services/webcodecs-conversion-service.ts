import type { ConversionOptions, VideoMetadata } from '../types/conversion-types';
import { QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '../utils/constants';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';
import { ffmpegService } from './ffmpeg-service';
import { GifEncService } from './gifenc-service';
import {
  type WebCodecsCaptureMode,
  type WebCodecsFrameFormat,
  WebCodecsDecoderService,
} from './webcodecs-decoder';
import { isWebCodecsCodecSupported, isWebCodecsDecodeSupported } from './webcodecs-support';

class WebCodecsConversionService {
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
    format: 'gif' | 'webp',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<Blob> {
    const { quality, scale } = options;
    const settings =
      format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];
    const useGifEnc = format === 'gif' && GifEncService.isSupported();
    const needsFFmpeg = format === 'webp' || !useGifEnc;
    const targetFps = settings.fps;
    const decoder = new WebCodecsDecoderService();
    const frameFiles: string[] = [];
    const capturedFrames: ImageData[] = [];
    const frameFormat: WebCodecsFrameFormat = useGifEnc
      ? 'rgba'
      : FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT;

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;

    ffmpegService.beginExternalConversion(metadata, quality);

    try {
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
            captureMode,
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: (current, total) => {
              const progress =
                decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
              ffmpegService.reportProgress(Math.round(progress));
            },
            onFrame: async (frame) => {
              if (useGifEnc) {
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

      const outputBlob = useGifEnc
        ? await GifEncService.encode(capturedFrames, {
            width: decodeResult.width,
            height: decodeResult.height,
            fps: targetFps,
            colors: QUALITY_PRESETS.gif[quality].colors,
            onProgress: (current, total) => {
              const progress =
                FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START +
                ((FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END -
                  FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START) *
                  current) /
                  Math.max(1, total);
              ffmpegService.reportProgress(Math.round(progress));
            },
            shouldCancel: () => ffmpegService.isCancellationRequested(),
          })
        : await ffmpegService.encodeFrameSequence({
            format,
            options,
            frameCount: decodeResult.frameCount,
            fps: targetFps,
            durationSeconds: metadata?.duration ?? decodeResult.duration,
            frameFiles,
          });

      const completionProgress =
        format === 'gif'
          ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
          : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
      ffmpegService.reportProgress(completionProgress);

      if (useGifEnc) {
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
}

export const webcodecsConversionService = new WebCodecsConversionService();
