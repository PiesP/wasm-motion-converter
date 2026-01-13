/**
 * Video Pipeline Service (facade)
 *
 * High-level facade that:
 * - ensures capability probing is completed before pipeline decisions
 * - selects demuxer + pipeline type
 * - emits structured logs required by the pipeline spec
 */

import type {
  ContainerFormat,
  PipelineType,
  ExtendedCapabilities,
  VideoDemuxer,
  VideoTrackInfo,
} from '@t/video-pipeline-types';
import type { VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { detectContainerFormat, isDemuxableContainer } from '@utils/container-utils';

import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { demuxerService } from '@services/video-pipeline/demuxer-service';
import { encodeService, type EncodePlan } from '@services/video-pipeline/encode-service';
import { selectPipeline } from '@services/video-pipeline/pipeline-selector';
import { createSingleton } from '@services/shared/singleton-service';

interface PipelinePlan {
  caps: ExtendedCapabilities;
  container: ContainerFormat;
  demuxer: { name: VideoDemuxer['name'] } | null;
  track: VideoTrackInfo | null;
  decodePath: PipelineType;
  encodePlan: EncodePlan;
}

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
  async planPipeline(params: {
    file: File;
    format: 'gif' | 'webp';
    abortSignal?: AbortSignal;
    metadata?: VideoMetadata;
  }): Promise<PipelinePlan> {
    const throwIfAborted = () => {
      if (params.abortSignal?.aborted) {
        throw new Error('Pipeline planning cancelled');
      }
    };

    throwIfAborted();
    const container = detectContainerFormat(params.file);

    // MUST be detected before any processing starts.
    const caps = await extendedCapabilityService.detectCapabilities();

    throwIfAborted();

    logger.info('conversion', '[VideoCaps]', caps);

    // Forced full pipeline containers
    if (container === 'avi' || container === 'wmv') {
      logger.info('conversion', '[Demuxer] ffmpeg', { container });
      logger.info('conversion', '[DecodePath] ffmpeg-wasm-full', { container });
      const encodePlan: EncodePlan = 'ffmpeg';
      logger.info('conversion', '[EncodePlan]', { encodePlan });

      return {
        caps,
        container,
        demuxer: null,
        track: null,
        decodePath: 'ffmpeg-wasm-full',
        encodePlan,
      };
    }

    // Non-demuxable containers (including unknown) fall back to FFmpeg.
    if (!isDemuxableContainer(container)) {
      logger.info('conversion', '[Demuxer] ffmpeg', { container });
      logger.info('conversion', '[DecodePath] ffmpeg-wasm-full', { container });
      const encodePlan: EncodePlan = 'ffmpeg';
      logger.info('conversion', '[EncodePlan]', { encodePlan });

      return {
        caps,
        container,
        demuxer: null,
        track: null,
        decodePath: 'ffmpeg-wasm-full',
        encodePlan,
      };
    }

    // When we already have reliable metadata, avoid initializing demuxers during
    // planning. This keeps CPU conversions from depending on mp4box/web-demuxer
    // CDN availability and reduces duplicated container parsing.
    const metadata = params.metadata;
    const hasUsableMetadata =
      metadata !== undefined && metadata.codec.trim().length > 0 && metadata.codec !== 'unknown';

    if (hasUsableMetadata && metadata) {
      const trackFromMetadata: VideoTrackInfo = {
        codec: metadata.codec,
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        frameRate: metadata.framerate,
      };

      const demuxerName = getDemuxerNameForContainer(container);
      if (demuxerName) {
        logger.info('conversion', '[Demuxer]', {
          name: demuxerName,
          source: 'metadata',
        });
      }
      logger.info('conversion', '[Codec]', {
        codec: trackFromMetadata.codec,
        source: 'metadata',
      });

      const decodePath = selectPipeline(caps, trackFromMetadata, container);
      logger.info('conversion', '[DecodePath]', { decodePath });

      const encodePlan = encodeService.selectEncodePlan({
        format: params.format,
        codec: trackFromMetadata.codec,
      });
      logger.info('conversion', '[EncodePlan]', { encodePlan });

      return {
        caps,
        container,
        demuxer: demuxerName ? { name: demuxerName } : null,
        track: trackFromMetadata,
        decodePath,
        encodePlan,
      };
    }

    let demuxer: VideoDemuxer | null = null;

    try {
      throwIfAborted();
      demuxer = demuxerService.getDemuxerForFile(params.file);

      throwIfAborted();
      await demuxer.initialize(params.file);

      throwIfAborted();
      const track = demuxer.getTrackInfo();

      logger.info('conversion', '[Demuxer]', { name: demuxer.name });
      logger.info('conversion', '[Codec]', { codec: track.codec });

      const decodePath = selectPipeline(caps, track, container);

      logger.info('conversion', '[DecodePath]', { decodePath });
      const encodePlan = encodeService.selectEncodePlan({
        format: params.format,
        codec: track.codec,
      });
      logger.info('conversion', '[EncodePlan]', { encodePlan });

      return {
        caps,
        container,
        demuxer: { name: demuxer.name },
        track,
        decodePath,
        encodePlan,
      };
    } catch (error) {
      if (params.abortSignal?.aborted) {
        // Avoid error-level noise for user cancellation.
        try {
          demuxer?.destroy();
        } catch (cleanupError) {
          logger.debug('demuxer', 'Demuxer cleanup failed after cancellation (non-critical)', {
            error: getErrorMessage(cleanupError),
          });
        }

        throw error;
      }

      logger.error('conversion', 'video.pipeline planning failed', {
        container,
        error: getErrorMessage(error),
      });

      // Ensure cleanup if a demuxer was created.
      try {
        demuxer?.destroy();
      } catch (cleanupError) {
        logger.warn('demuxer', 'Demuxer cleanup failed after planning error (non-critical)', {
          error: getErrorMessage(cleanupError),
        });
      }

      throw error;
    }
  }
}

export const videoPipelineService = createSingleton(
  'VideoPipelineService',
  () => new VideoPipelineService()
);
