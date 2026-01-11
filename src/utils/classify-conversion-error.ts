/**
 * Conversion Error Classification Utility
 *
 * Analyzes conversion error messages to determine root cause and provide
 * context-aware suggestions. Classifies errors into categories (timeout,
 * memory, format, codec, general) based on error messages, video metadata,
 * conversion settings, and FFmpeg logs.
 */

// Types
import type { ConversionSettings, ErrorContext, VideoMetadata } from '@t/conversion-types';

/**
 * Maximum total pixel count threshold for browser conversion
 *
 * Videos exceeding this threshold (width × height × framerate × duration)
 * are likely to cause memory issues in the browser.
 */
const MAX_TOTAL_PIXEL_COUNT = 500_000_000;

/**
 * Classify a conversion error and provide helpful suggestions
 *
 * Analyzes error messages to determine the root cause and suggest remediation.
 * Uses pattern matching on error messages, video metadata, conversion settings,
 * and FFmpeg logs to provide context-aware error classification.
 *
 * @param errorMessage - The error message from the conversion process
 * @param metadata - Video metadata for context-aware classification
 * @param conversionSettings - The settings used for conversion (optional)
 * @param ffmpegLogs - FFmpeg log output for detailed error analysis (optional)
 * @returns ErrorContext with error type, phase, and user-friendly suggestion
 *
 * @example
 * const context = classifyConversionError(
 *   'Conversion timed out after 90s',
 *   { width: 1920, height: 1080, duration: 600, codec: 'h264', framerate: 30, bitrate: 5000000 },
 *   { format: 'gif', quality: 'high', scale: 1.0 },
 *   ['[info] Processing...', '[error] Timeout']
 * );
 * // Returns: { type: 'timeout', suggestion: '...', phase: 'ffmpeg_timeout', ... }
 */
export function classifyConversionError(
  errorMessage: string,
  metadata: VideoMetadata | null,
  conversionSettings?: ConversionSettings,
  ffmpegLogs?: string[]
): ErrorContext {
  const message = errorMessage.toLowerCase();
  const timestamp = Date.now();
  const baseContext = {
    timestamp,
    originalError: errorMessage,
    conversionSettings,
    ffmpegLogs,
    phase: 'unknown',
  };

  // Timeout errors
  if (message.includes('timed out') || message.includes('90s') || message.includes('hung')) {
    const isWatchdogTimeout = message.includes('stalled');
    return {
      type: 'timeout',
      ...baseContext,
      phase: isWatchdogTimeout ? 'watchdog_timeout' : 'ffmpeg_timeout',
      suggestion: isWatchdogTimeout
        ? 'The conversion appeared to stall without progress updates. This may indicate a complex video file. Try reducing the quality to "low" or scale to 0.5.'
        : 'The conversion took too long. Try reducing the quality setting to "low" or the scale to 0.5, or choose a shorter video.',
    };
  }

  // Memory errors
  if (
    message.includes('memory') ||
    message.includes('out of memory') ||
    message.includes('abort') ||
    message.includes('stack overflow')
  ) {
    return {
      type: 'memory',
      ...baseContext,
      suggestion:
        'Your browser ran out of memory or encountered a memory issue. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
    };
  }

  // WebCodecs hardware acceleration errors
  if (
    message.includes('webcodecs') ||
    message.includes('hardware acceleration') ||
    message.includes('frame callback') ||
    message.includes('media capabilities')
  ) {
    return {
      type: 'codec',
      ...baseContext,
      phase: 'webcodecs_decode_failure',
      suggestion:
        'Hardware decoding is not available for this codec in your browser. The converter will fall back to the FFmpeg path or you can try a different browser with AV1 support.',
    };
  }

  // Codec and decoder errors
  if (
    message.includes('codec') ||
    message.includes('unsupported') ||
    message.includes('not found') ||
    message.includes('function not implemented') ||
    message.includes('decoder') ||
    message.includes('decode')
  ) {
    // Detect specific codec failures
    const isAv1Issue =
      metadata?.codec?.toLowerCase().includes('av1') ||
      metadata?.codec?.toLowerCase().includes('av01') ||
      message.includes('av1') ||
      message.includes('av01') ||
      ffmpegLogs?.some((log) => log.toLowerCase().includes('av1')) ||
      ffmpegLogs?.some((log) => log.toLowerCase().includes('av01'));

    const isGifConversionWithAv1 =
      isAv1Issue &&
      (message.includes('gif') || ffmpegLogs?.some((log) => log.toLowerCase().includes('gif')));

    if (isGifConversionWithAv1) {
      return {
        type: 'codec',
        ...baseContext,
        phase: 'av1_gif_conversion_failure',
        suggestion:
          'Converting AV1 video to GIF encountered a compatibility issue. The converter will automatically fall back to WebCodecs-based GIF generation, which may take longer but will work.',
      };
    }

    return {
      type: 'codec',
      ...baseContext,
      phase: isAv1Issue ? 'av1_decode_failure' : 'codec_error',
      suggestion: isAv1Issue
        ? 'AV1 video codec requires WebCodecs support. The converter will automatically use this method. If it fails, try reducing quality to "low" or scaling down the video.'
        : 'The video format or codec is not supported. Try converting the video to H.264/MP4 format first using another tool.',
    };
  }

  // WebP format errors
  if (message.includes('webp') || message.includes('libwebp')) {
    return {
      type: 'format',
      ...baseContext,
      suggestion:
        'WebP conversion failed. Try using GIF format instead, or reduce the quality/scale settings.',
    };
  }

  // AVIF format errors
  if (message.includes('avif')) {
    return {
      type: 'format',
      ...baseContext,
      suggestion:
        'AVIF conversion failed. Try using WebP or GIF instead, or reduce the quality/scale settings.',
    };
  }

  // Worker and cross-origin isolation errors
  if (
    message.includes('worker') ||
    message.includes('thread') ||
    message.includes('cors') ||
    message.includes('cross-origin') ||
    message.includes('sharedarraybuffer')
  ) {
    return {
      type: 'general',
      ...baseContext,
      suggestion:
        'Worker or cross-origin isolation issue. Ensure your server has proper COOP/COEP headers configured. Try refreshing the page or using a different browser.',
    };
  }

  // Check for overly complex videos (high total pixel count)
  if (metadata) {
    const totalPixels = metadata.width * metadata.height * metadata.framerate * metadata.duration;
    if (totalPixels > MAX_TOTAL_PIXEL_COUNT) {
      return {
        type: 'memory',
        ...baseContext,
        suggestion:
          'The video is too complex to convert in your browser (very high total pixel count). Try reducing quality to "low", scale to 0.5, or choosing a shorter/lower resolution video.',
      };
    }
  }

  // Default: general error
  return {
    type: 'general',
    ...baseContext,
    suggestion:
      'An unexpected error occurred. Try: 1) Reducing quality to "low" or scale to 0.5, 2) Using a different video file, 3) Reloading the page, or 4) Closing other browser tabs.',
  };
}
