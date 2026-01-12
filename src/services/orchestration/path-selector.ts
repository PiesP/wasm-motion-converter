/**
 * Path Selector (deprecated)
 *
 * Routing has been consolidated into:
 * - `conversion-orchestrator.ts` (public entry)
 * - `@services/video-pipeline/*` (caps + demuxer + pure selector)
 *
 * This module is retained for backward compatibility only.
 */

import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from "@t/conversion-types";
import { getErrorMessage } from "@utils/error-utils";
import { logger } from "@utils/logger";
import { ffmpegService } from "@services/ffmpeg-service";
import { convertVideo } from "./conversion-orchestrator";
import type { ConversionStrategy } from "./strategy-resolver";

/**
 * Path selection parameters
 */
export interface PathSelectionParams {
  file: File;
  format: ConversionFormat;
  options: ConversionOptions;
  metadata?: VideoMetadata;
  strategy: ConversionStrategy;
  webCodecsAvailable: boolean;
}

/**
 * Select optimal conversion path based on codec and format
 *
 * Smart path selection that routes conversion based on codec capabilities,
 * format constraints, and WebCodecs availability. Implements a priority-based
 * decision tree to optimize for performance and compatibility.
 *
 * Priority order:
 * 1. Codec requirements (WebCodecs-only codecs like AV1)
 * 2. Format constraints (GIF prefers direct FFmpeg for performance)
 * 3. WebCodecs-first for other formats when available
 * 4. FFmpeg fallback for all remaining cases
 *
 * @param params Path selection parameters
 * @returns Converted video blob
 * @throws Error if conversion fails on all paths
 */
export async function selectConversionPath(
  params: PathSelectionParams
): Promise<ConversionOutputBlob> {
  // Preserve the signature for older call sites but delegate routing to the orchestrator.
  // Strategy and `webCodecsAvailable` are no longer used.
  void params.strategy;
  void params.webCodecsAvailable;

  const result = await convertVideo({
    file: params.file,
    format: params.format,
    options: params.options,
    metadata: params.metadata,
  });

  return result.blob;
}

/**
 * Resolve video metadata
 *
 * If metadata is incomplete or missing codec information, probes the file
 * using FFmpeg to obtain complete metadata.
 *
 * @param file Video file to analyze
 * @param metadata Optional existing metadata
 * @returns Resolved metadata or undefined if probe fails
 */
export async function resolveMetadata(
  file: File,
  metadata?: VideoMetadata
): Promise<VideoMetadata | undefined> {
  try {
    if (metadata?.codec && metadata.codec !== "unknown") {
      return metadata;
    }

    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }
    return await ffmpegService.getVideoMetadata(file);
  } catch (error) {
    logger.warn(
      "conversion",
      "Metadata probe failed, continuing without codec",
      {
        error: getErrorMessage(error),
      }
    );
    return metadata;
  }
}
