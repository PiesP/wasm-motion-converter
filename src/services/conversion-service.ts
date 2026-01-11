import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from '@t/conversion-types';
import { getCodecCapability, requiresWebCodecs } from '@utils/codec-capabilities';
import { logger } from '@utils/logger';
import { ffmpegService } from './ffmpeg-service';
import { resolveMetadata, selectConversionPath } from './orchestration/path-selector';
import { getConversionStrategy } from './orchestration/strategy-resolver';
import { isWebCodecsDecodeSupported } from './webcodecs-support-service';

/**
 * Codec value indicating unknown or undetected codec
 */
const UNKNOWN_CODEC = 'unknown';

/**
 * Convert video file to specified format
 *
 * Main entry point for video conversion. Handles metadata resolution,
 * FFmpeg initialization, strategy application, and optimal path selection
 * based on codec capabilities and format requirements.
 *
 * Features:
 * - Parallel FFmpeg initialization and metadata resolution
 * - Automatic strategy overrides for scale and quality
 * - Codec-aware routing to WebCodecs or FFmpeg paths
 * - Comprehensive logging for debugging and monitoring
 *
 * @param file - Input video file
 * @param format - Target format (gif or webp)
 * @param options - Conversion options (quality, scale, duration)
 * @param metadata - Optional pre-resolved video metadata
 * @returns Converted video blob
 *
 * @example
 * const blob = await convertVideo(
 *   videoFile,
 *   'gif',
 *   { quality: 'high', scale: 1.0 },
 *   videoMetadata
 * );
 */
export async function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  metadata?: VideoMetadata
): Promise<ConversionOutputBlob> {
  // Initialize FFmpeg in parallel with metadata resolution for 1-3s speedup
  const ffmpegInitPromise = ffmpegService.isLoaded()
    ? Promise.resolve()
    : ffmpegService.initialize();

  // Resolve metadata (may use FFmpeg if needed)
  const resolvedMetadata = await resolveMetadata(file, metadata);

  // Ensure FFmpeg is ready before proceeding
  await ffmpegInitPromise;

  const routingStartTime = performance.now();

  const strategy = getConversionStrategy({ file, format, metadata: resolvedMetadata });

  let effectiveOptions: ConversionOptions = { ...options };

  if (strategy.scaleOverride && strategy.scaleOverride !== effectiveOptions.scale) {
    logger.info('conversion', 'Applying strategy scale override', {
      from: effectiveOptions.scale,
      to: strategy.scaleOverride,
      reasons: strategy.reasons,
    });
    effectiveOptions = { ...effectiveOptions, scale: strategy.scaleOverride };
  }

  if (strategy.recommendedQuality && strategy.recommendedQuality !== effectiveOptions.quality) {
    logger.info('conversion', 'Applying strategy quality override', {
      from: effectiveOptions.quality,
      to: strategy.recommendedQuality,
      reasons: strategy.reasons,
    });
    effectiveOptions = { ...effectiveOptions, quality: strategy.recommendedQuality };
  }

  // Codec-aware routing: Route to optimal conversion path based on codec capabilities
  const codec = resolvedMetadata?.codec;
  const codecCapability = getCodecCapability(codec);
  const webCodecsAvailable = isWebCodecsDecodeSupported();

  logger.info('conversion', 'Codec-aware routing decision', {
    codec,
    codecCapability,
    webCodecsAvailable,
    format,
    strategyReasons: strategy.reasons,
  });

  // Log routing performance (always visible in production via performance category)
  const routingDuration = performance.now() - routingStartTime;
  const normalizedCodec = codec || UNKNOWN_CODEC;
  const selectedPath = requiresWebCodecs(codec)
    ? format === 'gif'
      ? 'webcodecs+ffmpeg-hybrid'
      : 'webcodecs'
    : strategy.forceFFmpeg
      ? 'ffmpeg'
      : webCodecsAvailable
        ? 'webcodecs-first'
        : 'ffmpeg';

  logger.performance('Codec routing decision completed', {
    durationMs: Math.round(routingDuration),
    selectedPath,
    codec: normalizedCodec,
    codecCapability,
    format,
  });

  return selectConversionPath({
    file,
    format,
    options: effectiveOptions,
    metadata: resolvedMetadata,
    strategy,
    webCodecsAvailable,
  });
}
