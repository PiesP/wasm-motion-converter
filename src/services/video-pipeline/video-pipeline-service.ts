/**
 * Video Pipeline Service (facade)
 *
 * High-level facade that:
 * - ensures capability probing is completed before pipeline decisions
 * - selects demuxer + pipeline type
 * - emits structured logs required by the pipeline spec
 */

import { createSingleton } from '@services/shared/singleton-service';
import { demuxerService } from '@services/video-pipeline/demuxer-service';
import { type EncodePlan, encodeService } from '@services/video-pipeline/encode-service';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { selectPipeline } from '@services/video-pipeline/pipeline-selector-service';
import type { VideoMetadata } from '@t/conversion-types';
import type {
  ContainerFormat,
  ExtendedCapabilities,
  PipelineType,
  VideoDemuxer,
  VideoTrackInfo,
} from '@t/video-pipeline-types';
import { detectContainerFormat, isDemuxableContainer } from '@utils/container-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

interface PipelinePlan {
  caps: ExtendedCapabilities;
  container: ContainerFormat;
  demuxer: { name: VideoDemuxer['name'] } | null;
  track: VideoTrackInfo | null;
  decodePath: PipelineType;
  encodePlan: EncodePlan;
}

type PlanParams = {
  file: File;
  format: 'gif' | 'webp';
  abortSignal?: AbortSignal;
  metadata?: VideoMetadata;
};

const FORCED_FFMPEG_CONTAINERS: ContainerFormat[] = ['avi', 'wmv'];

const logEncodePlan = (encodePlan: EncodePlan): void => {
  logger.info('conversion', '[EncodePlan]', {
    encodePlan,
    note: 'Planning label only; runtime encoder may differ',
  });
};

const getDemuxerNameForContainer = (container: ContainerFormat): VideoDemuxer['name'] | null => {
  switch (container) {
    case 'mp4':
    case 'mov':
    case 'm4v':
      return 'mp4box';
    case 'webm':
    case 'mkv':
      return 'web-demuxer';
    default:
      return null;
  }
};

class VideoPipelineService {
  /**
   * Plan a pipeline for a file.
   *
   * This does not perform conversion yet; it only probes container/track
   * information and selects the intended pipeline.
   */
  async planPipeline(params: PlanParams): Promise<PipelinePlan> {
    const throwIfAborted = (): void => {
      if (params.abortSignal?.aborted) {
        throw new Error('Pipeline planning cancelled');
      }
    };

    throwIfAborted();
    const container = detectContainerFormat(params.file);

    const caps = await extendedCapabilityService.detectCapabilities();

    throwIfAborted();

    logger.info('conversion', '[VideoCaps]', caps);

    if (this.shouldUseFfmpegOnly(container)) {
      return this.buildFfmpegPlan(caps, container);
    }

    if (!isDemuxableContainer(container)) {
      return this.buildFfmpegPlan(caps, container);
    }

    const metadata = params.metadata;
    const trackFromMetadata = this.getTrackFromMetadata(metadata);
    if (trackFromMetadata) {
      return this.buildMetadataPlan({
        caps,
        container,
        track: trackFromMetadata,
        format: params.format,
      });
    }

    return this.buildDemuxerPlan({
      caps,
      container,
      format: params.format,
      file: params.file,
      abortSignal: params.abortSignal,
    });
  }

  private shouldUseFfmpegOnly(container: ContainerFormat): boolean {
    return FORCED_FFMPEG_CONTAINERS.includes(container);
  }

  private buildFfmpegPlan(caps: ExtendedCapabilities, container: ContainerFormat): PipelinePlan {
    logger.info('conversion', '[Demuxer] ffmpeg', { container });
    logger.info('conversion', '[DecodePath] ffmpeg-wasm-full', { container });

    const encodePlan: EncodePlan = 'ffmpeg';
    logEncodePlan(encodePlan);

    return {
      caps,
      container,
      demuxer: null,
      track: null,
      decodePath: 'ffmpeg-wasm-full',
      encodePlan,
    };
  }

  private getTrackFromMetadata(metadata?: VideoMetadata): VideoTrackInfo | null {
    if (!metadata) {
      return null;
    }

    const hasCodec = metadata.codec.trim().length > 0 && metadata.codec !== 'unknown';
    if (!hasCodec) {
      return null;
    }

    return {
      codec: metadata.codec,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      frameRate: metadata.framerate,
    };
  }

  private buildMetadataPlan(params: {
    caps: ExtendedCapabilities;
    container: ContainerFormat;
    track: VideoTrackInfo;
    format: 'gif' | 'webp';
  }): PipelinePlan {
    const { caps, container, track, format } = params;
    const demuxerName = getDemuxerNameForContainer(container);

    if (demuxerName) {
      logger.info('conversion', '[Demuxer]', {
        name: demuxerName,
        source: 'metadata',
      });
    }
    logger.info('conversion', '[Codec]', {
      codec: track.codec,
      source: 'metadata',
    });

    const decodePath = selectPipeline(caps, track, container);
    logger.info('conversion', '[DecodePath]', { decodePath });

    const encodePlan = encodeService.selectEncodePlan({
      format,
      codec: track.codec,
    });
    logEncodePlan(encodePlan);

    return {
      caps,
      container,
      demuxer: demuxerName ? { name: demuxerName } : null,
      track,
      decodePath,
      encodePlan,
    };
  }

  private async buildDemuxerPlan(params: {
    caps: ExtendedCapabilities;
    container: ContainerFormat;
    format: 'gif' | 'webp';
    file: File;
    abortSignal?: AbortSignal;
  }): Promise<PipelinePlan> {
    const { caps, container, format, file, abortSignal } = params;
    let demuxer: VideoDemuxer | null = null;

    const throwIfAborted = (): void => {
      if (abortSignal?.aborted) {
        throw new Error('Pipeline planning cancelled');
      }
    };

    try {
      throwIfAborted();
      demuxer = demuxerService.getDemuxerForFile(file);

      throwIfAborted();
      await demuxer.initialize(file);

      throwIfAborted();
      const track = demuxer.getTrackInfo();

      logger.info('conversion', '[Demuxer]', { name: demuxer.name });
      logger.info('conversion', '[Codec]', { codec: track.codec });

      const decodePath = selectPipeline(caps, track, container);
      logger.info('conversion', '[DecodePath]', { decodePath });

      const encodePlan = encodeService.selectEncodePlan({
        format,
        codec: track.codec,
      });
      logEncodePlan(encodePlan);

      return {
        caps,
        container,
        demuxer: { name: demuxer.name },
        track,
        decodePath,
        encodePlan,
      };
    } catch (error) {
      if (abortSignal?.aborted) {
        this.destroyDemuxerSafely(
          demuxer,
          'Demuxer cleanup failed after cancellation (non-critical)'
        );
        throw error;
      }

      logger.error('conversion', 'video.pipeline planning failed', {
        container,
        error: getErrorMessage(error),
      });

      this.destroyDemuxerSafely(
        demuxer,
        'Demuxer cleanup failed after planning error (non-critical)'
      );
      throw error;
    }
  }

  private destroyDemuxerSafely(demuxer: VideoDemuxer | null, message: string): void {
    try {
      demuxer?.destroy();
    } catch (cleanupError) {
      logger.warn('demuxer', message, {
        error: getErrorMessage(cleanupError),
      });
    }
  }
}

export const videoPipelineService = createSingleton(
  'VideoPipelineService',
  () => new VideoPipelineService()
);
