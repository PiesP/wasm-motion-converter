import { loadFromCDN } from '../../../utils/cdn-loader';
import { getErrorMessage } from '../../../utils/error-utils';
import { logger } from '../../../utils/logger';
import type {
  DemuxerAdapter,
  DemuxerMetadata,
  EncodedVideoChunk,
  VideoDecoderConfig,
} from './demuxer-adapter';

/**
 * MP4Box-based demuxer for MP4/MOV containers
 *
 * Extracts encoded samples directly from MP4/MOV files without HTMLVideoElement seeking.
 * Uses mp4box.js library loaded from CDN with multi-CDN fallback.
 *
 * Supported containers: MP4, MOV, M4V (ISOBMFF family)
 * Supported codecs: H.264, H.265/HEVC, AV1, VP9 (in MP4)
 */

type MP4BoxFileInstance = object & {
  appendBuffer: (buffer: ArrayBuffer & { fileStart: number }) => void;
  flush: () => void;
  start: () => void;
  stop: () => void;
  setExtractionOptions: (trackId: number, user: unknown, options: Record<string, unknown>) => void;
  onReady?: (info: MP4BoxInfo) => void;
  onError?: (error: Error) => void;
  onSamples?: (trackId: number, user: unknown, samples: MP4BoxSample[]) => void;
};

type MP4BoxInfo = {
  duration: number;
  timescale: number;
  videoTracks?: MP4BoxTrack[];
  brands?: string[];
};

type MP4BoxTrack = {
  id: number;
  codec: string;
  fourCC?: string;
  codec_string?: string;
  video: { width: number; height: number };
  nb_samples: number;
  movie_duration: number;
  movie_timescale: number;
  timescale: number;
  avcC?: Uint8Array | ArrayBuffer | number[];
  hvcC?: Uint8Array | ArrayBuffer | number[];
  av1C?: Uint8Array | ArrayBuffer | number[];
  vp09?: Uint8Array | ArrayBuffer | number[];
  codec_private_data?: Uint8Array | ArrayBuffer | number[];
};

type MP4BoxSample = {
  data: ArrayBuffer | Uint8Array;
  cts: number;
  duration: number;
  is_sync: boolean;
};

type MP4BoxModule = {
  createFile: () => MP4BoxFileInstance;
  default?: { createFile: () => MP4BoxFileInstance };
};

export class MP4BoxDemuxer implements DemuxerAdapter {
  private mp4boxFile: MP4BoxFileInstance | null = null;
  private videoTrack: MP4BoxTrack | null = null;
  private initialized = false;

  /**
   * Initialize demuxer and extract codec information from MP4/MOV file
   *
   * Parses MP4Box container structure, extracts first video track,
   * and returns decoder configuration needed for WebCodecs initialization.
   *
   * @param file - MP4/MOV file to demux
   * @returns VideoDecoderConfig with codec, dimensions, and optional description
   * @throws Error if file is invalid, no video track found, or parser timeout
   */
  async initialize(file: File): Promise<VideoDecoderConfig> {
    try {
      const MP4Box = await this.loadMP4Box();
      this.mp4boxFile = (MP4Box as MP4BoxModule).createFile();

      const mp4boxFile = this.mp4boxFile;
      if (!mp4boxFile) {
        throw new Error('MP4Box file not initialized');
      }

      const infoPromise = new Promise<MP4BoxInfo>((resolve, reject) => {
        mp4boxFile.onReady = (info: MP4BoxInfo) => {
          logger.info('demuxer', 'MP4Box parsed container', {
            duration: info.duration,
            timescale: info.timescale,
            videoTracks: info.videoTracks?.length ?? 0,
            brands: info.brands,
          });

          const videoTrack = info.videoTracks?.[0];
          if (!videoTrack) {
            reject(new Error('No video track found in MP4'));
            return;
          }

          this.videoTrack = videoTrack;
          resolve(info);
        };

        mp4boxFile.onError = (error: Error) => {
          logger.error('demuxer', 'MP4Box error', {
            error: getErrorMessage(error),
          });
          reject(error);
        };

        setTimeout(() => {
          if (!this.videoTrack) {
            reject(new Error('MP4Box initialization timeout'));
          }
        }, 10000);
      });

      const arrayBuffer = await file.arrayBuffer();
      const bufferWithFileStart = arrayBuffer as ArrayBuffer & { fileStart: number };
      bufferWithFileStart.fileStart = 0;

      mp4boxFile.appendBuffer(bufferWithFileStart);
      mp4boxFile.flush();

      await infoPromise;

      const videoTrack = this.videoTrack;
      if (!videoTrack) {
        throw new Error('Video track not initialized');
      }

      const config = this.extractDecoderConfig(videoTrack);
      this.initialized = true;

      logger.info('demuxer', 'MP4BoxDemuxer initialized', {
        codec: config.codec,
        width: config.codedWidth,
        height: config.codedHeight,
        hasDescription: !!config.description,
      });

      return config;
    } catch (error) {
      logger.error('demuxer', 'Failed to initialize MP4BoxDemuxer', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Extract encoded video samples for WebCodecs frame processing
   *
   * Returns an async generator that yields encoded samples at the target FPS.
   * Samples are extracted with appropriate stride to downsample from source FPS
   * to target FPS (e.g., 30 FPS source → 15 FPS target = every 2nd sample).
   *
   * Uses AsyncGenerator to stream samples incrementally instead of buffering
   * in memory, preventing exhaustion on large video files.
   *
   * @param targetFps - Target frames per second for sampling
   * @param maxFrames - Optional maximum frame count to extract
   * @returns AsyncGenerator yielding encoded video chunks (key and delta frames)
   * @throws Error if demuxer not initialized or sample extraction fails
   */
  async *extractSamples(
    targetFps: number,
    maxFrames?: number
  ): AsyncGenerator<EncodedVideoChunk, void, unknown> {
    if (!this.initialized || !this.videoTrack) {
      throw new Error('Demuxer not initialized');
    }

    try {
      const sampleQueue: MP4BoxSample[] = [];
      let samplesReceived = false;
      const mp4boxFile = this.mp4boxFile;
      const videoTrack = this.videoTrack;

      if (!mp4boxFile || !videoTrack) {
        throw new Error('Demuxer not initialized');
      }

      const samplePromise = new Promise<void>((resolve, reject) => {
        mp4boxFile.onSamples = (trackId: number, _user: unknown, samples: MP4BoxSample[]) => {
          logger.info('demuxer', 'Received samples from MP4Box', {
            trackId,
            sampleCount: samples.length,
          });
          sampleQueue.push(...samples);
          samplesReceived = true;
          resolve();
        };

        setTimeout(() => {
          if (!samplesReceived) {
            reject(new Error('Sample extraction timeout'));
          }
        }, 60000);
      });

      mp4boxFile.setExtractionOptions(videoTrack.id, null, {
        nbSamples: maxFrames ?? Number.POSITIVE_INFINITY,
      });

      mp4boxFile.start();
      await samplePromise;
      mp4boxFile.stop();

      const sourceFps =
        videoTrack.nb_samples / (videoTrack.movie_duration / videoTrack.movie_timescale);
      const sampleStride = Math.max(1, Math.round(sourceFps / targetFps));

      logger.info('demuxer', 'Extracting samples', {
        totalSamples: sampleQueue.length,
        sourceFps: sourceFps.toFixed(2),
        targetFps,
        sampleStride,
        estimatedOutputFrames: Math.ceil(sampleQueue.length / sampleStride),
      });

      let frameIndex = 0;
      for (
        let i = 0;
        i < sampleQueue.length && (!maxFrames || frameIndex < maxFrames);
        i += sampleStride
      ) {
        const sample = sampleQueue[i];
        if (!sample) {
          break;
        }

        const timestampMicros = Math.round((sample.cts / videoTrack.timescale) * 1_000_000);
        const durationMicros = Math.round((sample.duration / videoTrack.timescale) * 1_000_000);

        yield {
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: timestampMicros,
          duration: durationMicros,
          data: new Uint8Array(sample.data),
        };

        frameIndex++;
      }

      logger.info('demuxer', 'Sample extraction completed', {
        yieldedFrames: frameIndex,
      });
    } catch (error) {
      logger.error('demuxer', 'Sample extraction failed', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve video metadata (duration, framerate, sample count)
   *
   * Must be called after initialize(). Returns metadata extracted
   * during container parsing.
   *
   * @returns DemuxerMetadata with duration, framerate, sample count
   * @throws Error if demuxer not initialized
   */
  getMetadata(): DemuxerMetadata {
    if (!this.initialized || !this.videoTrack) {
      throw new Error('Demuxer not initialized');
    }

    const duration = this.videoTrack.movie_duration / this.videoTrack.movie_timescale;
    const framerate =
      this.videoTrack.nb_samples /
      (this.videoTrack.movie_duration / this.videoTrack.movie_timescale);

    return {
      duration,
      framerate,
      sampleCount: this.videoTrack.nb_samples,
    };
  }

  /**
   * Clean up demuxer resources and release references
   *
   * Should be called when demuxer is no longer needed. Stops MP4Box parsing,
   * flushes internal buffers, and clears state.
   */
  destroy(): void {
    if (this.mp4boxFile) {
      try {
        const mp4boxFile = this.mp4boxFile;
        mp4boxFile.stop();
        mp4boxFile.flush();
      } catch (error) {
        logger.warn('demuxer', 'Error during MP4Box cleanup', {
          error: getErrorMessage(error),
        });
      }
      this.mp4boxFile = null;
    }
    this.videoTrack = null;
    this.initialized = false;
  }

  /**
   * Extract VideoDecoder configuration from MP4Box track information
   *
   * Combines codec string and initialization data to create a configuration
   * object compatible with WebCodecs VideoDecoder.
   *
   * @param track - MP4Box track containing codec and video properties
   * @returns VideoDecoderConfig with codec, dimensions, and optional description
   * @internal Private method, use initialize() instead
   */
  private extractDecoderConfig(track: MP4BoxTrack): VideoDecoderConfig {
    const codec = this.buildCodecString(track);
    const description = this.extractCodecDescription(track);

    return {
      codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description,
    };
  }

  /**
   * Build full codec string from MP4Box track information
   *
   * Attempts to construct detailed codec string with profile/level information.
   * Examples: 'avc1.64001f' (H.264 High@L3.1), 'hvc1.1.6.L93.B0' (HEVC)
   *
   * Falls back to FourCC code if detailed string unavailable. Some codecs may need
   * additional parsing of box structures for complete information.
   *
   * @param track - MP4Box track with codec information
   * @returns Codec string suitable for WebCodecs VideoDecoder
   * @throws Error if codec string cannot be determined
   * @internal Private method
   */
  private buildCodecString(track: MP4BoxTrack): string {
    const fourCC = track.codec || track.fourCC;

    if (track.codec_string) {
      return track.codec_string;
    }

    if (fourCC) {
      logger.warn('demuxer', 'Using FourCC as codec string', {
        fourCC,
        message: 'Detailed codec string unavailable - may cause VideoDecoder issues',
      });
      return fourCC;
    }

    throw new Error('Unable to determine codec string from track');
  }

  /**
   * Extract codec-specific initialization data (EXTRADATA)
   *
   * Locates and extracts the codec description box needed for WebCodecs:
   * - H.264: avcC box (SPS/PPS sequences)
   * - HEVC: hvcC box
   * - AV1: av1C box
   * - VP9: vp09 box (optional)
   *
   * Handles multiple source formats (Uint8Array, ArrayBuffer, number[]).
   *
   * @param track - MP4Box track with codec boxes
   * @returns Codec description data, or undefined if not found
   * @internal Private method
   */
  private extractCodecDescription(track: MP4BoxTrack): Uint8Array | undefined {
    const descriptionSources = [
      track.avcC,
      track.hvcC,
      track.av1C,
      track.vp09,
      track.codec_private_data,
    ];

    for (const source of descriptionSources) {
      if (source) {
        if (source instanceof Uint8Array) {
          return source;
        }
        if (source instanceof ArrayBuffer) {
          return new Uint8Array(source);
        }
        if (Array.isArray(source)) {
          return new Uint8Array(source);
        }
      }
    }

    logger.warn('demuxer', 'No codec description found', {
      codec: track.codec || track.fourCC,
      message: 'VideoDecoder may fail without codec-specific initialization data',
    });

    return undefined;
  }

  /**
   * Load mp4box.js library from CDN with multi-CDN fallback
   *
   * Attempts to load mp4box.js from multiple CDN sources (esm.sh, jsdelivr, unpkg)
   * with automatic fallback. Uses loadFromCDN utility for robust loading with
   * timeout protection and detailed logging.
   *
   * @returns MP4BoxModule with createFile() factory function
   * @throws Error if all CDN sources fail
   * @internal Private method, called during initialize()
   */
  private async loadMP4Box(): Promise<MP4BoxModule> {
    return loadFromCDN<MP4BoxModule>('mp4box.js', [
      'https://esm.sh/mp4box@0.5.2',
      'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm',
      'https://unpkg.com/mp4box@0.5.2/+esm',
    ]);
  }
}
