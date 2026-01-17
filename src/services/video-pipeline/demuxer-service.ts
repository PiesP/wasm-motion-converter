/**
 * Demuxer Service
 *
 * Maps container formats to demuxers that can produce WebCodecs EncodedVideoChunk objects.
 */

import { createSingleton } from '@services/shared/singleton-service';
import type {
  EncodedVideoChunk as DemuxedEncodedVideoChunk,
  DemuxerAdapter,
} from '@services/webcodecs/demuxer/demuxer-adapter-service';
import { MP4BoxDemuxer } from '@services/webcodecs/demuxer/mp4box-demuxer-service';
import { WebMDemuxer } from '@services/webcodecs/demuxer/webm-demuxer-service';
import type { ContainerFormat, VideoDemuxer, VideoTrackInfo } from '@t/video-pipeline-types';
import { detectContainerFormat, isDemuxableContainer } from '@utils/container-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const DEFAULT_TARGET_FPS = 30;
const DEFAULT_MAX_FRAMES = 900;

type DemuxerName = 'mp4box' | 'web-demuxer';

type DemuxerConfig = {
  name: DemuxerName;
  adapter: DemuxerAdapter;
};

class DemuxerWrapper implements VideoDemuxer {
  readonly name: DemuxerName;

  private adapter: DemuxerAdapter;
  private initialized = false;
  private trackInfo: VideoTrackInfo | null = null;

  constructor(params: DemuxerConfig) {
    this.name = params.name;
    this.adapter = params.adapter;
  }

  async initialize(file: File): Promise<void> {
    if (this.initialized) {
      return;
    }

    const decoderConfig = await this.adapter.initialize(file);
    const metadata = this.adapter.getMetadata();

    const derivedFrameRate =
      metadata.framerate ??
      (metadata.sampleCount > 0 && metadata.duration > 0
        ? metadata.sampleCount / metadata.duration
        : 0);

    this.trackInfo = {
      codec: decoderConfig.codec,
      width: decoderConfig.codedWidth,
      height: decoderConfig.codedHeight,
      duration: metadata.duration,
      frameRate: derivedFrameRate,
    };

    this.initialized = true;
  }

  getTrackInfo(): VideoTrackInfo {
    if (!this.trackInfo) {
      throw new Error('Demuxer not initialized (track info unavailable)');
    }

    return this.trackInfo;
  }

  async extractChunks(file: File): Promise<EncodedVideoChunk[]> {
    this.ensureEncodedChunkSupport();
    await this.initialize(file);

    const chunks: EncodedVideoChunk[] = [];

    try {
      for await (const sample of this.adapter.extractSamples(
        DEFAULT_TARGET_FPS,
        DEFAULT_MAX_FRAMES
      )) {
        chunks.push(this.toWebCodecsChunk(sample));
      }

      return chunks;
    } catch (error) {
      logger.error('demuxer', 'Failed to extract chunks', {
        demuxer: this.name,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  destroy(): void {
    try {
      this.adapter.destroy();
    } catch (error) {
      logger.warn('demuxer', 'Demuxer cleanup failed (non-critical)', {
        demuxer: this.name,
        error: getErrorMessage(error),
      });
    }
  }

  private ensureEncodedChunkSupport(): void {
    if (typeof EncodedVideoChunk === 'undefined') {
      throw new Error('WebCodecs EncodedVideoChunk is not available in this browser.');
    }
  }

  private toWebCodecsChunk(sample: DemuxedEncodedVideoChunk): EncodedVideoChunk {
    return new EncodedVideoChunk({
      type: sample.type,
      timestamp: sample.timestamp,
      duration: sample.duration,
      data: sample.data,
    });
  }
}

class DemuxerService {
  getDemuxerForFile(file: File): VideoDemuxer {
    const container = detectContainerFormat(file);

    if (!isDemuxableContainer(container)) {
      throw new Error(`No demuxer available for container: ${container}`);
    }

    return this.createDemuxer(container);
  }

  private createDemuxer(container: ContainerFormat): VideoDemuxer {
    switch (container) {
      case 'mp4':
      case 'mov':
      case 'm4v':
        return new DemuxerWrapper({
          name: 'mp4box',
          adapter: new MP4BoxDemuxer(),
        });
      case 'webm':
      case 'mkv':
        return new DemuxerWrapper({
          name: 'web-demuxer',
          adapter: new WebMDemuxer(),
        });
      default:
        return this.handleUnsupportedContainer(container);
    }
  }

  private handleUnsupportedContainer(container: ContainerFormat): never {
    throw new Error(`No demuxer available for container: ${container}`);
  }
}

export const demuxerService = createSingleton('DemuxerService', () => new DemuxerService());
