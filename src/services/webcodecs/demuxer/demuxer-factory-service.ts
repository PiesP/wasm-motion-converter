import type { VideoMetadata } from '@t/conversion-types';
import type { ContainerFormat } from '@t/video-pipeline-types';
import {
  getCodecCandidates,
  isAv1Codec,
  isH264Codec,
  isHevcCodec,
  normalizeCodecString,
} from '@utils/codec-utils';
import { detectContainerFormat } from '@utils/container-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import type { DemuxerAdapter } from './demuxer-adapter-service';
import { MP4BoxDemuxer } from './mp4box-demuxer-service';
import { WebMDemuxer } from './webm-demuxer-service';

type DemuxerEligibilityLogState = {
  key: string;
  lastLoggedAtMs: number;
};

const DEMUXER_ELIGIBILITY_LOG_THROTTLE_MS = 5_000;
const demuxerEligibilityLogStateByFile = new WeakMap<File, DemuxerEligibilityLogState>();

const shouldLogDemuxerEligibility = (params: {
  file: File;
  container: ContainerFormat;
  codec: string;
}): boolean => {
  const { file, container, codec } = params;
  const now = performance.now();
  const key = `${container}|${codec}`;
  const existing = demuxerEligibilityLogStateByFile.get(file);

  // Log at least once per (file, container, codec) and re-log periodically.
  if (
    !existing ||
    existing.key !== key ||
    now - existing.lastLoggedAtMs > DEMUXER_ELIGIBILITY_LOG_THROTTLE_MS
  ) {
    demuxerEligibilityLogStateByFile.set(file, { key, lastLoggedAtMs: now });
    return true;
  }

  return false;
};

const isAnyVideoDecoderConfigSupported = async (params: {
  codecCandidates: string[];
  codedWidth: number;
  codedHeight: number;
}): Promise<boolean> => {
  const { codecCandidates, codedWidth, codedHeight } = params;

  if (typeof VideoDecoder === 'undefined') {
    return false;
  }

  for (const codec of codecCandidates) {
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth,
        codedHeight,
        hardwareAcceleration: 'prefer-hardware',
      });

      if (result.supported) {
        return true;
      }
    } catch (error) {
      // Non-fatal: some browsers throw for unknown/invalid codec strings.
      logger.debug('demuxer', 'VideoDecoder.isConfigSupported failed (non-critical)', {
        codec,
        error: getErrorMessage(error),
      });
    }
  }

  return false;
};

/**
 * Container format types
 *
 * Re-exported for callers that import `ContainerFormat` from this module.
 * Canonical definition lives in `@t/video-pipeline-types`.
 */
export type { ContainerFormat } from '@t/video-pipeline-types';

/**
 * Check if demuxer path can be used for this file
 *
 * Requirements:
 * 1. Container must be supported (MP4/MOV/WebM/MKV)
 * 2. WebCodecs VideoDecoder must be available
 * 3. Codec must be WebCodecs-compatible
 *
 * @param file - Video file to check
 * @param metadata - Optional video metadata (codec information)
 * @returns true if demuxer can be used
 */
export function canUseDemuxer(file: File, metadata?: VideoMetadata): boolean {
  // 1. Container must be supported
  const container = detectContainerFormat(file);
  if (container === 'unknown' || container === 'avi' || container === 'wmv') {
    logger.info('demuxer', 'Container format not supported for demuxer', {
      fileName: file.name,
      container,
    });
    return false;
  }

  // 2. VideoDecoder must be available
  if (typeof VideoDecoder === 'undefined') {
    logger.info('demuxer', 'VideoDecoder API not available', {
      message: 'Browser does not support WebCodecs',
    });
    return false;
  }

  // 3. Codec must be WebCodecs-compatible
  if (metadata?.codec && metadata.codec !== 'unknown') {
    const normalizedCodec = normalizeCodecString(metadata.codec);

    const isWebCodecsCodec =
      isAv1Codec(normalizedCodec) ||
      isHevcCodec(normalizedCodec) ||
      isH264Codec(normalizedCodec) ||
      normalizedCodec.includes('vp09') ||
      normalizedCodec.includes('vp9') ||
      normalizedCodec.includes('vp08') ||
      normalizedCodec.includes('vp8');

    if (!isWebCodecsCodec) {
      logger.info('demuxer', 'Codec not eligible for demuxer prefilter', {
        codec: metadata.codec,
        normalizedCodec,
        note: 'This is a heuristic filter (not a VideoDecoder.isConfigSupported result).',
      });
      return false;
    }
  }

  // canUseDemuxer() is called from multiple layers (eligibility check, decoder, factory).
  // Keep eligibility visibility in dev logs without spamming info-level output.
  const codec = metadata?.codec ?? 'unknown';
  if (shouldLogDemuxerEligibility({ file, container, codec })) {
    logger.debug('demuxer', 'Demuxer path is eligible', {
      container,
      codec,
    });
  }

  return true;
}

/**
 * Create appropriate demuxer for file
 *
 * Selects demuxer based on container format:
 * - MP4/MOV → MP4BoxDemuxer
 * - WebM/MKV → WebMDemuxer
 *
 * @param file - Video file to demux
 * @param metadata - Optional video metadata
 * @returns DemuxerAdapter instance or null if not eligible
 */
export async function createDemuxer(
  file: File,
  metadata?: VideoMetadata
): Promise<DemuxerAdapter | null> {
  if (!canUseDemuxer(file, metadata)) {
    return null;
  }

  const container = detectContainerFormat(file);

  // Optional: additional (more accurate) gating based on VideoDecoder.isConfigSupported.
  // This reduces unnecessary demuxer attempts and avoids confusing logs when the codec
  // family is recognized but the concrete decoder config is unsupported on this device.
  if (metadata?.codec && metadata.codec !== 'unknown' && typeof VideoDecoder !== 'undefined') {
    const codedWidth = metadata.width || 640;
    const codedHeight = metadata.height || 360;
    const codecCandidates = getCodecCandidates(metadata.codec);

    if (codecCandidates.length > 0) {
      const supported = await isAnyVideoDecoderConfigSupported({
        codecCandidates,
        codedWidth,
        codedHeight,
      });

      if (!supported) {
        logger.info('demuxer', 'VideoDecoder.isConfigSupported indicates unsupported codec', {
          codec: metadata.codec,
          normalizedCodec: normalizeCodecString(metadata.codec),
          codecCandidates,
          codedWidth,
          codedHeight,
        });
        return null;
      }
    }
  }

  try {
    switch (container) {
      case 'mp4':
      case 'm4v':
      case 'mov':
        logger.info('demuxer', 'Creating MP4Box demuxer', {
          container,
          codec: metadata?.codec,
          fileName: file.name,
        });
        return new MP4BoxDemuxer();

      case 'webm':
      case 'mkv':
        logger.info('demuxer', 'Creating WebM demuxer', {
          container,
          codec: metadata?.codec,
          fileName: file.name,
        });
        return new WebMDemuxer();

      default:
        logger.warn('demuxer', 'No demuxer available for container', {
          container,
        });
        return null;
    }
  } catch (error) {
    logger.warn('demuxer', 'Failed to create demuxer, falling back', {
      error: getErrorMessage(error),
      container,
      codec: metadata?.codec,
    });
    return null;
  }
}
