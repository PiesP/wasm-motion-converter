import type { DemuxerAdapter } from './demuxer-adapter';
import { MP4BoxDemuxer } from './mp4box-demuxer';
import { WebMDemuxer } from './webm-demuxer';
import type { VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * Container format types
 */
export type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'unknown';

/**
 * Detect container format from file extension
 *
 * @param file - Video file to analyze
 * @returns Detected container format
 */
export function detectContainer(file: File): ContainerFormat {
  const extension = file.name.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'mp4':
    case 'm4v':
      return 'mp4';
    case 'mov':
      return 'mov';
    case 'webm':
      return 'webm';
    case 'mkv':
      return 'mkv';
    default:
      return 'unknown';
  }
}

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
  const container = detectContainer(file);
  if (container === 'unknown') {
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
    const normalizedCodec = metadata.codec.toLowerCase();

    // WebCodecs-supported codecs
    const webCodecsCodecs = [
      'av1',
      'av01',
      'hevc',
      'hvc1',
      'hev1',
      'vp9',
      'vp09',
      'vp8',
      'vp08',
      'h264',
      'avc1',
      'avc',
    ];

    const isWebCodecsCodec = webCodecsCodecs.some((c) => normalizedCodec.includes(c));

    if (!isWebCodecsCodec) {
      logger.info('demuxer', 'Codec not supported by WebCodecs VideoDecoder', {
        codec: metadata.codec,
      });
      return false;
    }
  }

  logger.info('demuxer', 'Demuxer path is eligible', {
    container,
    codec: metadata?.codec ?? 'unknown',
  });

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

  const container = detectContainer(file);

  try {
    switch (container) {
      case 'mp4':
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
