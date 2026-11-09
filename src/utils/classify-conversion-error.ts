// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Error Classification Utility
 *
 * Classifies producer-owned error codes first, then untyped error messages,
 * metadata, and settings to provide context-aware recovery guidance.
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
import type { ErrorCode } from '@t/conversion-types';
import type { TranslationKeys } from '@t/i18n-types';
// ---------------------------------------------------------------------------
// Error code type — re-exported from conversion-types.ts for convenience.
// The canonical definition lives in conversion-types.ts (ErrorContext.code).
// ---------------------------------------------------------------------------
import { MAX_TOTAL_PIXEL_COUNT } from '@utils/constants';

// ---------------------------------------------------------------------------
// Error classification rule system
// ---------------------------------------------------------------------------

type TFunction = <K extends keyof TranslationKeys>(key: K) => TranslationKeys[K];

type ErrorRule = {
  /** Human-readable name for debugging */
  name: string;
  /** Error type assigned when this rule matches */
  type: ConversionErrorType;
  /** Structured error code for programmatic handling */
  code: ErrorCode;
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
  // -- Cancellation -------------------------------------------------------
  {
    name: 'abort-error-cancelled',
    type: 'general',
    code: 'CANCELLED',
    pattern: /abort(?:error|ed)/i,
    condition: (msg) => !/memory|oom|wasm\s.*memory|stack\s*overflow/i.test(msg),
    suggestion: 'The conversion was cancelled. You can try again with different settings.',
  },

  // -- Memory -------------------------------------------------------------
  {
    name: 'output-limit',
    type: 'memory',
    code: 'OUT_OF_MEMORY',
    pattern: /(?:output\s+(?:frame|byte)|input\s+packet)\s+limit\s+exceeded/i,
    suggestion:
      'The encoded output exceeded the browser safety limit. Try a shorter video, reducing quality, or scaling down the resolution.',
  },
  {
    name: 'out-of-memory',
    type: 'memory',
    code: 'OUT_OF_MEMORY',
    pattern: /out\s*of\s*memory|oom|memory\s*(limit|exhausted|issue)|stack\s*overflow/i,
    suggestion:
      'Your browser ran out of memory. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
  },
  {
    name: 'memory-abort',
    type: 'memory',
    code: 'OUT_OF_MEMORY',
    pattern: /\babort\b|aborted|wasm\s.*\bmemory\b/i,
    condition: (msg) => /memory|oom|stack\s*overflow|wasm/i.test(msg) && !/cancelled/i.test(msg),
    suggestion:
      'Your browser ran out of memory or encountered a memory issue. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
  },

  // -- Timeout ------------------------------------------------------------
  {
    name: 'conversion-timeout',
    type: 'timeout',
    code: 'TIMEOUT',
    phase: 'timeout',
    pattern: /timed?\s*out|timeout/i,
    suggestion:
      'The conversion timed out — it took too long. Try a shorter video, reduce quality to "low", or scale down the resolution.',
  },
  {
    name: 'watchdog-stall',
    type: 'timeout',
    code: 'TIMEOUT',
    phase: 'watchdog_timeout',
    pattern: /stall|watchdog|no\s*progress/i,
    suggestion:
      'The conversion stalled — no progress was detected. Try a shorter video or reduce quality/scale.',
  },
  {
    name: 'conversion-timeout',
    type: 'timeout',
    code: 'TIMEOUT',
    pattern: /took\s*too\s*long/i,
    suggestion:
      'The conversion took too long. Try a shorter video, reduce quality to "low", or scale down the resolution.',
  },

  // -- Worker / threading -------------------------------------------------
  {
    name: 'worker-init-failure',
    type: 'general',
    code: 'UNKNOWN',
    phase: 'worker_init_failure',
    pattern: /failed\s*to\s*initiali[sz]e|comlink|worker\s*(init|thread|failed)/i,
    suggestion: 'Worker initialization failed. Reload the page and try again.',
  },
  {
    name: 'shared-array-buffer',
    type: 'general',
    code: 'UNKNOWN',
    phase: 'worker_error',
    pattern: /sharedarraybuffer|coop|coep/i,
    suggestion:
      'SharedArrayBuffer is not available. Ensure the server sends COOP/COEP headers for multi-threaded WASM.',
  },

  // -- WebCodecs / hardware -----------------------------------------------
  {
    name: 'webcodecs-failure',
    type: 'codec',
    code: 'CODEC_NOT_SUPPORTED',
    phase: 'webcodecs_decode_failure',
    pattern: /webcodecs|hardware\s*accel|frame\s*callback|media\s*capabilit/i,
    suggestion:
      'Hardware decoding is not available for this codec in your browser. Try a different browser with AV1/WebCodecs support.',
  },

  // -- AV1-specific codec (before generic codec-error for priority) -----
  {
    name: 'av1-gif-failure',
    type: 'codec',
    code: 'CODEC_NOT_SUPPORTED',
    phase: 'av1_gif_conversion_failure',
    pattern: /av1/i,
    condition: (_msg, meta) => meta?.codec === 'av1',
    suggestion:
      'AV1 to GIF conversion is not supported. Use WebP format for AV1 videos, or convert to H.264 first.',
  },
  {
    name: 'av1-decode-failure',
    type: 'codec',
    code: 'CODEC_NOT_SUPPORTED',
    phase: 'av1_decode_failure',
    pattern: /av1|av01/i,
    condition: (_msg, meta) => meta?.codec === 'av1' || meta?.codec === 'av01',
    suggestion:
      'AV1 decoding failed. This browser may not support AV1. Try H.264/MP4 videos instead.',
  },

  // -- Generic codec / decode ---------------------------------------------
  {
    name: 'codec-error',
    type: 'codec',
    code: 'CODEC_NOT_SUPPORTED',
    phase: 'codec_error',
    pattern: /\bcodec\b|unsupported|not\s*found|function\s*not\s*implemented|\bdecod(?:er|e)\b/i,
    suggestion:
      'The video format or codec is not supported. Try converting the video to H.264/MP4 format first using another tool.',
  },

  // -- Format -------------------------------------------------------------
  {
    name: 'webp-format',
    type: 'format',
    code: 'ENCODER_ERROR',
    pattern: /\bwebp\b|libwebp/i,
    suggestion:
      'WebP conversion failed. Try using GIF format instead, or reduce the quality/scale settings.',
  },
  {
    name: 'encoder-error',
    type: 'format',
    code: 'ENCODER_ERROR',
    phase: 'encoder_error',
    pattern: /(?:encoding|encoder)\s+failed/i,
    suggestion:
      'The image encoder failed. Try reducing the quality or scale, or use a shorter video.',
  },
];

const KNOWN_CODE_RULE_NAMES: Partial<Record<ErrorCode, string>> = {
  CANCELLED: 'abort-error-cancelled',
  OUT_OF_MEMORY: 'out-of-memory',
  TIMEOUT: 'conversion-timeout',
  CODEC_NOT_SUPPORTED: 'codec-error',
  ENCODER_ERROR: 'encoder-error',
};

/** Only codes in the application's error vocabulary may override text classification. */
export function isKnownConversionErrorCode(value: string): value is ErrorCode {
  return (
    value === 'CANCELLED' ||
    value === 'OUT_OF_MEMORY' ||
    value === 'TIMEOUT' ||
    value === 'CODEC_NOT_SUPPORTED' ||
    value === 'DECODER_ERROR' ||
    value === 'ENCODER_ERROR' ||
    value === 'CORRUPT_OUTPUT'
  );
}

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
 * @param t - Translation function for localized suggestions
 * @param knownCode - A code retained from an application-owned error
 * @returns ErrorContext with error type, phase, and user-friendly suggestion
 */
export function classifyConversionError(
  errorMessage: string,
  metadata: VideoMetadata | null,
  conversionSettings?: ConversionSettings,
  t?: TFunction,
  knownCode?: ErrorCode
): ErrorContext {
  const msg = errorMessage.toLowerCase();
  const timestamp = performance.now();
  const baseContext = {
    timestamp,
    originalError: errorMessage,
    conversionSettings,
    phase: 'unknown' as string,
  };

  // Initialization is a document-lifetime failure, even when its original
  // cause mentions abort, memory, or a network timeout.
  if (errorMessage.startsWith('WebP initialization failed (')) {
    return {
      ...baseContext,
      type: 'general',
      code: 'ENCODER_ERROR',
      phase: 'wasm_webp_initialization',
      suggestion: t
        ? t('error.webpInitialization')
        : 'The WebP encoder could not start. Reload the page before trying WebP again.',
    };
  }

  // A known producer code survives harmless diagnostic wording changes.
  // Keep the more specific existing rule when its code agrees with the producer.
  const matchingRule = ERROR_RULES.find(
    (rule) => rule.pattern.test(msg) && (!rule.condition || rule.condition(msg, metadata))
  );
  const selectedRule =
    knownCode && knownCode !== 'UNKNOWN' && matchingRule?.code !== knownCode
      ? ERROR_RULES.find((rule) => rule.name === KNOWN_CODE_RULE_NAMES[knownCode])
      : matchingRule;
  if (selectedRule) {
    const suggestion =
      typeof selectedRule.suggestion === 'function'
        ? selectedRule.suggestion(msg, metadata)
        : selectedRule.suggestion;
    return {
      type: selectedRule.type,
      code: selectedRule.code,
      ...baseContext,
      phase: selectedRule.phase ?? 'unknown',
      suggestion,
    };
  }

  if (knownCode === 'DECODER_ERROR' || knownCode === 'CORRUPT_OUTPUT') {
    return {
      ...baseContext,
      type: 'format',
      code: knownCode,
      suggestion:
        'The video or converted output could not be read. Try a different video file or format.',
    };
  }

  // Check for overly complex videos (high total pixel count)
  if (metadata && isVideoTooComplex(metadata)) {
    return {
      type: 'memory',
      code: 'OUT_OF_MEMORY',
      ...baseContext,
      suggestion:
        'The video is too complex to convert in your browser (very high total pixel count). Try reducing quality to "low", scale to 0.5, or choosing a shorter/lower resolution video.',
    };
  }

  // Default: general error
  return {
    type: 'general',
    code: 'UNKNOWN',
    ...baseContext,
    suggestion: t
      ? t('error.unknown')
      : 'An unexpected error occurred. Try: 1) Reducing quality to "low" or scale to 0.5, 2) Using a different video file, 3) Reloading the page, or 4) Closing other browser tabs.',
  };
}
