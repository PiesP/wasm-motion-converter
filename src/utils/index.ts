// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

export type { ErrorCode } from '@t/conversion-types';
// Barrel export for all utility modules
export { isCancellationError } from './cancellation-context';
export { classifyConversionError } from './classify-conversion-error';
export {
  BYTES_PER_KB,
  BYTES_PER_MB,
  DEFAULT_FPS,
  GIF_LZW_RATIO,
  GIF_MAX_BUFFER_BYTES,
  GIF_TARGET_FPS,
  MAX_FILE_SIZE,
  MAX_TOTAL_PIXEL_COUNT,
  MEMORY_CRITICAL_RATIO,
  MEMORY_CRITICAL_THRESHOLD,
  MEMORY_DEFAULT_AVAILABLE_MB,
  MEMORY_WARNING_RATIO,
  STALL_DETECTION_TIMEOUT_MS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_VIDEO_MIMES,
  VP8_DEFAULT_BITRATE,
  WEBP_MAX_DURATION_MS,
  WEBP_MAX_FRAMES,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_LIMIT_MB,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
  WORKER_PIPELINE_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
} from './constants';
export { debounce } from './debounce';
export { focusElement, focusRetryButton } from './dom-utils';
export { getErrorMessage } from './error-utils';
export {
  estimateGifOutputSize,
  estimateOutputSize,
  estimateWebpOutputSize,
  type OutputSizeEstimate,
} from './estimate-output-size';
export { createETACalculator } from './eta-calculator';
export { validateVideoDuration, validateVideoFile } from './file-validation';
export { createId, formatBytes, formatDurationSeconds } from './format-utils';
export {
  detectInitialLocale,
  detectUserLocale,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
  updateDocumentLang,
} from './intl-utils';
export { logger } from './logger';
export { createMediaBunnyInput } from './mediabunny-utils';
export { checkMemoryForConversion, getMemoryUsageMB, isMemoryCritical } from './memory-monitor';
export { createThrottledProgress } from './throttled-progress';
export { isInTuple } from './type-utils';
