import { buildRuntimeModuleUrls } from '@services/cdn/runtime-dep-urls-service';
import { loadFromCDN } from '@utils/cdn-loader';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import type {
  DemuxerAdapter,
  DemuxerMetadata,
  EncodedVideoChunk,
  VideoDecoderConfig,
} from './demuxer-adapter-service';

/**
 * Web-demuxer-based demuxer for WebM/MKV containers
 *
 * Extracts encoded samples directly from WebM/MKV files without HTMLVideoElement seeking.
 * Uses web-demuxer library loaded from CDN with multi-CDN fallback.
 *
 * Supported containers: WebM, MKV (Matroska/EBML family)
 * Supported codecs: VP8, VP9, AV1 (in WebM)
 */

type WebDemuxerInstance = object & {
  getVideoDecoderConfig: () => Promise<VideoDecoderConfig | null>;
  readVideoSample: (index: number) => Promise<WebDemuxerSample | null>;
  duration?: number;
  videoSampleCount?: number;
  close?: () => void;
};

type WebDemuxerSample = {
  type: string;
  timestamp?: number;
  duration?: number;
  data: ArrayBuffer | Uint8Array;
};

type WebDemuxerModule = {
  new (buffer: ArrayBuffer): WebDemuxerInstance;
  default?: new (buffer: ArrayBuffer) => WebDemuxerInstance;
  WebDemuxer?: new (buffer: ArrayBuffer) => WebDemuxerInstance;
};

export class WebMDemuxer implements DemuxerAdapter {
  private demuxer: WebDemuxerInstance | null = null;
  private initialized = false;
  private metadata: DemuxerMetadata | null = null;

  /**
   * Initialize demuxer and extract codec information from WebM/MKV file
   *
   * Parses WebM/MKV container using web-demuxer library, extracts video track
   * decoder configuration and metadata needed for WebCodecs playback.
   *
   * @param file - WebM/MKV file to demux
   * @returns VideoDecoderConfig with codec, dimensions, and optional description
   * @throws Error if file is invalid, no video track found, or decoder config unavailable
   */
  async initialize(file: File): Promise<VideoDecoderConfig> {
    try {
      const WebDemuxer = await this.loadWebDemuxer();
      const arrayBuffer = await file.arrayBuffer();

      const DemuxerConstructor = WebDemuxer as unknown as new (
        buffer: ArrayBuffer
      ) => WebDemuxerInstance;
      this.demuxer = new DemuxerConstructor(arrayBuffer);

      const config = await this.demuxer.getVideoDecoderConfig();

      if (!config) {
        throw new Error('No video track found in WebM/MKV');
      }

      const duration = this.demuxer.duration ?? 0;
      const sampleCount = this.demuxer.videoSampleCount ?? 0;

      this.metadata = {
        duration,
        sampleCount,
        framerate: sampleCount > 0 && duration > 0 ? sampleCount / duration : undefined,
      };

      this.initialized = true;

      logger.info('demuxer', 'WebMDemuxer initialized', {
        codec: config.codec,
        width: config.codedWidth,
        height: config.codedHeight,
        duration,
        sampleCount,
      });

      return config;
    } catch (error) {
      logger.error('demuxer', 'Failed to initialize WebMDemuxer', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Extract encoded video samples for WebCodecs frame processing
   *
   * Returns an async generator yielding encoded samples at target FPS.
   * Streams samples incrementally instead of buffering to prevent memory exhaustion
   * on large video files.
   *
   * Note: Do not stride-skip encoded samples for inter-frame codecs (VP9/AV1/etc.).
   * Downsample after decode by selecting decoded frames based on timestamps.
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
    if (!this.initialized || !this.demuxer || !this.metadata) {
      throw new Error('Demuxer not initialized');
    }

    try {
      const sourceFps = this.metadata.framerate ?? targetFps;

      // Derive a time cap from the requested output budget.
      const maxDurationSeconds = maxFrames ? maxFrames / targetFps : undefined;
      const maxDurationMicros = maxDurationSeconds
        ? Math.round(maxDurationSeconds * 1_000_000)
        : undefined;
      const durationSlackMicros = Math.round(1_000_000);

      logger.info('demuxer', 'Extracting WebM samples', {
        totalSamples: this.metadata.sampleCount,
        sourceFps: sourceFps.toFixed(2),
        targetFps,
        maxDurationSeconds: maxDurationSeconds?.toFixed(3) ?? 'full',
      });

      let yieldedSamples = 0;
      let sampleIndex = 0;
      let baseTimestampMicros: number | null = null;

      while (sampleIndex < this.metadata.sampleCount) {
        const sample = await this.demuxer.readVideoSample(sampleIndex);

        if (!sample) {
          break;
        }

        const timestamp = sample.timestamp ?? 0;
        if (baseTimestampMicros === null) {
          baseTimestampMicros = timestamp;
        }

        if (
          maxDurationMicros !== undefined &&
          timestamp > baseTimestampMicros + maxDurationMicros + durationSlackMicros
        ) {
          break;
        }

        yield {
          type: sample.type === 'key' ? 'key' : 'delta',
          timestamp,
          duration: sample.duration ?? 0,
          data: new Uint8Array(sample.data),
        };

        yieldedSamples++;

        sampleIndex++;
      }

      logger.info('demuxer', 'WebM sample extraction completed', {
        yieldedSamples,
      });
    } catch (error) {
      logger.error('demuxer', 'WebM sample extraction failed', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve video metadata (duration, framerate, sample count)
   *
   * Must be called after initialize(). Returns metadata extracted
   * during container initialization.
   *
   * @returns DemuxerMetadata with duration, framerate, sample count
   * @throws Error if demuxer not initialized
   */
  getMetadata(): DemuxerMetadata {
    if (!this.initialized || !this.metadata) {
      throw new Error('Demuxer not initialized');
    }

    return this.metadata;
  }

  /**
   * Clean up demuxer resources and release references
   *
   * Should be called when demuxer is no longer needed. Calls demuxer's close()
   * method if available and clears internal state.
   */
  destroy(): void {
    if (this.demuxer) {
      try {
        if (typeof this.demuxer.close === 'function') {
          this.demuxer.close();
        }
      } catch (error) {
        logger.warn('demuxer', 'Error during WebMDemuxer cleanup', {
          error: getErrorMessage(error),
        });
      }
      this.demuxer = null;
    }
    this.metadata = null;
    this.initialized = false;
  }

  /**
   * Load web-demuxer library from CDN with multi-CDN fallback
   *
   * Attempts to load web-demuxer from multiple CDN sources (esm.sh, jsdelivr, unpkg)
   * with automatic fallback. Uses loadFromCDN utility for robust loading with
   * timeout protection and detailed logging.
   *
   * @returns WebDemuxerModule (constructor function for WebDemuxer)
   * @throws Error if all CDN sources fail
   * @internal Private method, called during initialize()
   */
  private async loadWebDemuxer(): Promise<WebDemuxerModule> {
    return loadFromCDN<WebDemuxerModule>('web-demuxer', buildRuntimeModuleUrls('web-demuxer'));
  }
}
