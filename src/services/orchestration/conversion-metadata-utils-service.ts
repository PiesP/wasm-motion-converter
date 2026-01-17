import { ffmpegService } from '@services/ffmpeg-service';
import type { VideoMetadata } from '@t/conversion-types';
import type { VideoTrackInfo } from '@t/video-pipeline-types';
import { isAv1Codec, isH264Codec, isHevcCodec, normalizeCodecString } from '@utils/codec-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const CODEC_VP9 = 'vp9';
const CODEC_VP8 = 'vp8';
const CODEC_UNKNOWN = 'unknown';

export const ensureFFmpegInitialized = async (): Promise<void> => {
  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }
};

export const normalizeCodecForMetadata = (codec: string): string => {
  const normalized = normalizeCodecString(codec);
  if (isAv1Codec(normalized)) return 'av1';
  if (isH264Codec(normalized)) return 'h264';
  if (isHevcCodec(normalized)) return 'hevc';
  if (normalized.includes('vp09') || normalized.includes('vp9')) return CODEC_VP9;
  if (normalized.includes('vp08') || normalized.includes('vp8')) return CODEC_VP8;
  return normalized.length > 0 ? normalized : CODEC_UNKNOWN;
};

export const buildLightweightMetadataFromTrack = (track: VideoTrackInfo): VideoMetadata => {
  const codec = normalizeCodecForMetadata(track.codec);

  return {
    width: track.width,
    height: track.height,
    duration: Number.isFinite(track.duration) ? track.duration : 0,
    codec,
    framerate: Number.isFinite(track.frameRate) ? track.frameRate : 0,
    bitrate: 0,
  };
};

export const resolveMetadata = async (
  file: File,
  metadata?: VideoMetadata
): Promise<VideoMetadata | undefined> => {
  if (metadata?.codec && metadata.codec !== 'unknown') {
    return metadata;
  }

  try {
    await ensureFFmpegInitialized();
    const probed = await ffmpegService.getVideoMetadata(file);

    const codec = probed?.codec?.toLowerCase();
    if (codec === 'av1' || codec === 'vp9' || codec === 'hevc') {
      if (!probed || !probed.duration || probed.duration === 0) {
        throw new Error(
          `Failed to extract metadata for ${codec.toUpperCase()} codec. ` +
            'This codec requires complete metadata for processing. ' +
            'The file may be corrupted or in an unsupported format.'
        );
      }
      logger.info('conversion', 'Mandatory metadata extracted for complex codec', {
        codec: probed.codec,
        duration: probed.duration,
        resolution: `${probed.width}x${probed.height}`,
      });
    }

    return probed;
  } catch (error) {
    const errorMsg = getErrorMessage(error);

    if (errorMsg.includes('Failed to extract metadata')) {
      throw error;
    }

    logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
      error: errorMsg,
    });
    return metadata;
  }
};
