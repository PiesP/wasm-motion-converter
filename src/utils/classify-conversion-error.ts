// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Conversion Error Classification Utility
 *
 * Analyzes conversion error messages to determine root cause and provide
 * context-aware suggestions. Classifies errors into categories (timeout,
 * memory, format, codec, general) based on error messages, video metadata,
 * conversion settings, and FFmpeg logs.
 *
 * Uses a declarative rule-based system with regex patterns for maintainability.
 * Rules are evaluated in order; the first matching rule wins.
 */

// Types
import type {
  ConversionErrorType,
  ConversionSettings,
  ErrorContext,
  VideoMetadata,
} from '@t/conversion-types';

/**
 * Maximum total pixel count threshold for browser conversion
 *
 * Videos exceeding this threshold (width × height × framerate × duration)
 * are likely to cause memory issues in the browser.
 */
const MAX_TOTAL_PIXEL_COUNT = 500_000_000;

// ---------------------------------------------------------------------------
// Error classification rule system
// ---------------------------------------------------------------------------

type ErrorRule = {
  /** Human-readable name for debugging */
  name: string;
  /** Error type assigned when this rule matches */
  type: ConversionErrorType;
  /** Phase identifier (e.g., 'watchdog_timeout', 'codec_error') */
  phase?: string;
  /** Regex tested against the lowercased error message */
  pattern: RegExp;
  /**
   * Optional extra condition.
   * Receives the lowercased message, metadata, and ffmpeg logs.
   */
  condition?: (msg: string, meta: VideoMetadata | null, logs?: string[]) => boolean;
  /** User-facing suggestion (string or factory) */
  suggestion: string | ((msg: string, meta: VideoMetadata | null) => string);
};

/**
 * Ordered list of error-classification rules.
 * Rules are evaluated top-to-bottom; first match wins.
 */
const ERROR_RULES: readonly ErrorRule[] = [
  // -- Timeout / stalled --------------------------------------------------
  {
    name: 'watchdog-stall',
    type: 'timeout',
    phase: 'watchdog_timeout',
    pattern: /timed?\s*out|stalled|hung|unresponsive|progress\s*stop/i,
    condition: (msg) => /stalled|progress\s*stop/i.test(msg),
    suggestion:
      'The conversion appeared to stall without progress updates. This may indicate a complex video file. Try reducing the quality to "low" or scale to 0.5.',
  },
  {
    name: 'conversion-timeout',
    type: 'timeout',
    phase: 'ffmpeg_timeout',
    pattern: /timed?\s*out|took\s*too\s*long|timeout/i,
    suggestion:
      'The conversion took too long. Try reducing the quality setting to "low" or the scale to 0.5, or choose a shorter video.',
  },

  // -- Memory -------------------------------------------------------------
  {
    name: 'out-of-memory',
    type: 'memory',
    pattern: /out\s*of\s*memory|oom|memory\s*(limit|exhausted|issue)|stack\s*overflow/i,
    suggestion:
      'Your browser ran out of memory. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
  },
  {
    name: 'memory-abort',
    type: 'memory',
    pattern: /\babort\b|aborted|wasm\s.*\bmemory\b/i,
    condition: (msg) => !/cancelled by user|cancelled\s*by/i.test(msg),
    suggestion:
      'Your browser ran out of memory or encountered a memory issue. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
  },

  // -- Worker init failure ------------------------------------------------
  {
    name: 'worker-init-failure',
    type: 'general',
    phase: 'worker_init_failure',
    pattern: /failed\s*to\s*initiali[sz]e|did\s*not\s*become\s*ready|comlink/i,
    condition: (msg) => /\bworker\b/i.test(msg),
    suggestion:
      'A background encoder worker failed to start. Try reloading the page or using a different browser.',
  },

  // -- Worker / cross-origin ----------------------------------------------
  {
    name: 'worker-error',
    type: 'general',
    phase: 'worker_error',
    pattern: /\bworker\b|sharedarraybuffer|cross[-\s]origin|cors\b/i,
    suggestion:
      'Worker or cross-origin isolation issue. Ensure your server has proper COOP/COEP headers configured. Try refreshing the page or using a different browser.',
  },

  // -- WebCodecs / hardware -----------------------------------------------
  {
    name: 'webcodecs-failure',
    type: 'codec',
    phase: 'webcodecs_decode_failure',
    pattern: /webcodecs|hardware\s*accel|frame\s*callback|media\s*capabilit/i,
    suggestion:
      'Hardware decoding is not available for this codec in your browser. The converter will fall back to the FFmpeg path or you can try a different browser with AV1 support.',
  },

  // -- AV1 + GIF ----------------------------------------------------------
  {
    name: 'av1-gif-failure',
    type: 'codec',
    phase: 'av1_gif_conversion_failure',
    pattern: /\b(av1|av01)\b|codec.*not.*supported|unsupported.*codec|decoder.*not.*found/i,
    condition: (_msg, meta, logs) => {
      const codec = meta?.codec?.toLowerCase() ?? '';
      const isAv1 = /av1|av01/.test(codec);
      const logsMentionGif = logs?.some((l) => /\bgif\b/i.test(l)) ?? false;
      return isAv1 && logsMentionGif;
    },
    suggestion:
      'Converting AV1 video to GIF encountered a compatibility issue. The converter will automatically fall back to WebCodecs-based GIF generation, which may take longer but will work.',
  },

  // -- AV1 decode ---------------------------------------------------------
  {
    name: 'av1-decode-failure',
    type: 'codec',
    phase: 'av1_decode_failure',
    pattern: /\b(av1|av01)\b|codec.*not.*supported/i,
    condition: (_msg, meta) => {
      const codec = meta?.codec?.toLowerCase() ?? '';
      return /av1|av01/.test(codec);
    },
    suggestion:
      'AV1 video codec requires WebCodecs support. The converter will automatically use this method. If it fails, try reducing quality to "low" or scaling down the video.',
  },

  // -- Generic codec / decode ---------------------------------------------
  {
    name: 'codec-error',
    type: 'codec',
    phase: 'codec_error',
    pattern: /\bcodec\b|unsupported|not\s*found|function\s*not\s*implemented|\bdecod(?:er|e)\b/i,
    suggestion:
      'The video format or codec is not supported. Try converting the video to H.264/MP4 format first using another tool.',
  },

  // -- WebP ---------------------------------------------------------------
  {
    name: 'webp-format',
    type: 'format',
    pattern: /\bwebp\b|libwebp/i,
    suggestion:
      'WebP conversion failed. Try using GIF format instead, or reduce the quality/scale settings.',
  },

  // -- AVIF ---------------------------------------------------------------
  {
    name: 'avif-format',
    type: 'format',
    pattern: /\bavif\b/i,
    suggestion:
      'AVIF conversion failed. Try using WebP or GIF instead, or reduce the quality/scale settings.',
  },
];

/**
 * Check whether the video is too complex (high total pixel count).
 */
function isVideoTooComplex(metadata: VideoMetadata): boolean {
  return (
    metadata.width * metadata.height * metadata.framerate * metadata.duration >
    MAX_TOTAL_PIXEL_COUNT
  );
}

/**
 * Classify a conversion error and provide helpful suggestions
 *
 * Evaluates declarative rules in order; the first matching rule wins.
 * Falls back to a video-complexity check, then to a general error.
 *
 * @param errorMessage - The error message from the conversion process
 * @param metadata - Video metadata for context-aware classification
 * @param conversionSettings - The settings used for conversion (optional)
 * @param ffmpegLogs - FFmpeg log output for detailed error analysis (optional)
 * @returns ErrorContext with error type, phase, and user-friendly suggestion
 */
export function classifyConversionError(
  errorMessage: string,
  metadata: VideoMetadata | null,
  conversionSettings?: ConversionSettings,
  ffmpegLogs?: string[]
): ErrorContext {
  const msg = errorMessage.toLowerCase();
  const timestamp = performance.now();
  const baseContext = {
    timestamp,
    originalError: errorMessage,
    conversionSettings,
    ffmpegLogs,
    phase: 'unknown',
  };

  for (const rule of ERROR_RULES) {
    if (!rule.pattern.test(msg)) {
      continue;
    }

    if (rule.condition && !rule.condition(msg, metadata, ffmpegLogs)) {
      continue;
    }

    const suggestion =
      typeof rule.suggestion === 'function' ? rule.suggestion(msg, metadata) : rule.suggestion;

    return {
      type: rule.type,
      ...baseContext,
      phase: rule.phase ?? 'unknown',
      suggestion,
    };
  }

  // Check for overly complex videos (high total pixel count)
  if (metadata && isVideoTooComplex(metadata)) {
    return {
      type: 'memory',
      ...baseContext,
      suggestion:
        'The video is too complex to convert in your browser (very high total pixel count). Try reducing quality to "low", scale to 0.5, or choosing a shorter/lower resolution video.',
    };
  }

  // Default: general error
  return {
    type: 'general',
    ...baseContext,
    suggestion:
      'An unexpected error occurred. Try: 1) Reducing quality to "low" or scale to 0.5, 2) Using a different video file, 3) Reloading the page, or 4) Closing other browser tabs.',
  };
}
