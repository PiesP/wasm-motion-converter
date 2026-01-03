import type { ConversionSettings, ErrorContext, VideoMetadata } from '../types/conversion-types';

/**
 * Classify a conversion error and provide helpful suggestions
 * Analyzes error messages to determine the root cause and suggest remediation
 * @param errorMessage - The error message from the conversion process
 * @param metadata - Video metadata for context-aware classification
 * @param conversionSettings - The settings used for conversion for context
 * @param ffmpegLogs - Optional FFmpeg logs for detailed error analysis
 * @returns ErrorContext with error type, phase, and user-friendly suggestion
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

  if (
    message.includes('codec') ||
    message.includes('unsupported') ||
    message.includes('not found')
  ) {
    return {
      type: 'codec',
      ...baseContext,
      suggestion:
        'The video format or codec is not supported. Try converting the video to H.264/MP4 format first using another tool.',
    };
  }

  if (message.includes('webp') || message.includes('libwebp')) {
    return {
      type: 'format',
      ...baseContext,
      suggestion:
        'WebP conversion failed. Try using GIF format instead, or reduce the quality/scale settings.',
    };
  }

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

  if (metadata) {
    const totalPixels = metadata.width * metadata.height * metadata.framerate * metadata.duration;
    if (totalPixels > 500_000_000) {
      return {
        type: 'memory',
        ...baseContext,
        suggestion:
          'The video is too complex to convert in your browser (very high total pixel count). Try reducing quality to "low", scale to 0.5, or choosing a shorter/lower resolution video.',
      };
    }
  }

  return {
    type: 'general',
    ...baseContext,
    suggestion:
      'An unexpected error occurred. Try: 1) Reducing quality to "low" or scale to 0.5, 2) Using a different video file, 3) Reloading the page, or 4) Closing other browser tabs.',
  };
}
