// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

export type { ErrorCode } from '@t/conversion-types';
// Barrel export for all utility modules
export { isCancellationError } from './cancellation-context';
export { classifyConversionError } from './classify-conversion-error';
export {
  DEFAULT_FPS,
  GIF_TARGET_FPS,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_LIMIT_MB,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
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
