/**
 * Generate FFmpeg arguments for progress logging.
 * Enables progress reporting and detailed info-level logging.
 * Returns a pre-allocated array to prevent stack overflow from repeated spread operations.
 */
const PROGRESS_LOGGING_ARGS = ['-progress', '-', '-loglevel', 'info'] as const;

export const getProgressLoggingArgs = (): readonly string[] => PROGRESS_LOGGING_ARGS;
