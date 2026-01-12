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
  VideoCapabilities,
  VideoDemuxer,
  VideoTrackInfo,
} from "@t/video-pipeline-types";
import { getErrorMessage } from "@utils/error-utils";
import { logger } from "@utils/logger";
import {
  detectContainerFormat,
  isDemuxableContainer,
} from "@utils/container-utils";

import { capabilityService } from "@services/video-pipeline/capability-service";
import { demuxerService } from "@services/video-pipeline/demuxer-service";
import {
  encodeService,
  type EncodePath,
} from "@services/video-pipeline/encode-service";
import { selectPipeline } from "@services/video-pipeline/pipeline-selector";
import { createSingleton } from "@services/shared/singleton-service";

interface PipelinePlan {
  caps: VideoCapabilities;
  container: ContainerFormat;
  demuxer: { name: VideoDemuxer["name"] } | null;
  track: VideoTrackInfo | null;
  decodePath: PipelineType;
  encodePath: EncodePath;
}

class VideoPipelineService {
  /**
   * Plan a pipeline for a file.
   *
   * This does not perform conversion yet; it only probes container/track
   * information and selects the intended pipeline.
   */
  async planPipeline(params: {
    file: File;
    format: "gif" | "webp";
  }): Promise<PipelinePlan> {
    const container = detectContainerFormat(params.file);

    // MUST be detected before any processing starts.
    const caps = await capabilityService.detectCapabilities();

    logger.info("conversion", "[VideoCaps]", caps);

    const encodePath = encodeService.selectEncodePath({
      format: params.format,
    });

    // Forced full pipeline containers
    if (container === "avi" || container === "wmv") {
      logger.info("conversion", "[Demuxer] ffmpeg", { container });
      logger.info("conversion", "[DecodePath] ffmpeg-wasm-full", { container });
      logger.info("conversion", "[EncodePath]", { encodePath });

      return {
        caps,
        container,
        demuxer: null,
        track: null,
        decodePath: "ffmpeg-wasm-full",
        encodePath,
      };
    }

    // Non-demuxable containers (including unknown) fall back to FFmpeg.
    if (!isDemuxableContainer(container)) {
      logger.info("conversion", "[Demuxer] ffmpeg", { container });
      logger.info("conversion", "[DecodePath] ffmpeg-wasm-full", { container });
      logger.info("conversion", "[EncodePath]", { encodePath });

      return {
        caps,
        container,
        demuxer: null,
        track: null,
        decodePath: "ffmpeg-wasm-full",
        encodePath,
      };
    }

    let demuxer: VideoDemuxer | null = null;

    try {
      demuxer = demuxerService.getDemuxerForFile(params.file);
      await demuxer.initialize(params.file);
      const track = demuxer.getTrackInfo();

      logger.info("conversion", "[Demuxer]", { name: demuxer.name });
      logger.info("conversion", "[Codec]", { codec: track.codec });

      const decodePath = selectPipeline(caps, track, container);

      logger.info("conversion", "[DecodePath]", { decodePath });
      logger.info("conversion", "[EncodePath]", { encodePath });

      return {
        caps,
        container,
        demuxer: { name: demuxer.name },
        track,
        decodePath,
        encodePath,
      };
    } catch (error) {
      logger.error("conversion", "video.pipeline planning failed", {
        container,
        error: getErrorMessage(error),
      });

      // Ensure cleanup if a demuxer was created.
      try {
        demuxer?.destroy();
      } catch (cleanupError) {
        logger.warn(
          "demuxer",
          "Demuxer cleanup failed after planning error (non-critical)",
          {
            error: getErrorMessage(cleanupError),
          }
        );
      }

      throw error;
    }
  }
}

export const videoPipelineService = createSingleton(
  "VideoPipelineService",
  () => new VideoPipelineService()
);
