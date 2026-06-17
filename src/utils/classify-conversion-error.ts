// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Conversion Error Classification Utility
 *
 * Analyzes conversion error messages to determine root cause and provide
 * context-aware suggestions. Classifies errors into categories (memory, format, codec, general) based on error messages, video metadata, and conversion settings.
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

import { MAX_TOTAL_PIXEL_COUNT } from '@utils/constants';

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
   * Optional extra condition. Receives the lowercased message and metadata.
   */
  condition?: (msg: string, meta: VideoMetadata | null) => boolean;
  /** User-facing suggestion (string or factory) */
  suggestion: string | ((msg: string, meta: VideoMetadata | null) => string);
};

/**
 * Ordered list of error-classification rules.
 * Rules are evaluated top-to-bottom; first match wins.
 */
const ERROR_RULES: readonly ErrorRule[] = [
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

  // -- WebCodecs / hardware -----------------------------------------------
  {
    name: 'webcodecs-failure',
    type: 'codec',
    phase: 'webcodecs_decode_failure',
    pattern: /webcodecs|hardware\s*accel|frame\s*callback|media\s*capabilit/i,
    suggestion:
      'Hardware decoding is not available for this codec in your browser. Try a different browser with AV1/WebCodecs support.',
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
 * @returns ErrorContext with error type, phase, and user-friendly suggestion
 */
export function classifyConversionError(
  errorMessage: string,
  metadata: VideoMetadata | null,
  conversionSettings?: ConversionSettings
): ErrorContext {
  const msg = errorMessage.toLowerCase();
  const timestamp = performance.now();
  const baseContext = {
    timestamp,
    originalError: errorMessage,
    conversionSettings,
    phase: 'unknown',
  };

  for (const rule of ERROR_RULES) {
    if (!rule.pattern.test(msg)) {
      continue;
    }

    if (rule.condition && !rule.condition(msg, metadata)) {
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
