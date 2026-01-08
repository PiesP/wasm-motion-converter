/**
 * Generate FFmpeg arguments for progress logging.
 * Enables progress reporting and detailed info-level logging.
 */
export const getProgressLoggingArgs = (): string[] => ['-progress', '-', '-loglevel', 'info'];
