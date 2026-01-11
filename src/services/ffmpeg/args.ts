/**
 * Generate FFmpeg arguments for progress logging.
 * Enables progress reporting and detailed info-level logging.
 * Returns a pre-allocated array to prevent stack overflow from repeated spread operations.
 */
const PROGRESS_LOGGING_ARGS: readonly string[] = Object.freeze([
  '-progress',
  '-',
  '-loglevel',
  'info',
]);

export const getProgressLoggingArgs = (): readonly string[] => PROGRESS_LOGGING_ARGS;
