/**
 * Structured logging utility for application-wide logging
 *
 * This module provides a centralized Logger class for consistent, structured logging
 * throughout the application. Supports multiple log levels (DEBUG, INFO, WARN, ERROR)
 * and categories for filtering and organizing logs.
 *
 * **Features**:
 * - **Environment-aware filtering**: DEBUG/INFO filtered in production (except performance logs)
 * - **Timestamp prefixes**: All logs prefixed with HH:MM:SS [category] format
 * - **Context support**: Optional context objects logged as additional JSON data
 * - **Category filtering**: Multiple categories for organizing logs by subsystem
 * - **Performance tracking**: Always logged in all environments for monitoring
 *
 * **Log levels**:\n * - DEBUG: Development-only detailed information (filtered in production)\n * - INFO: Important state changes and events (filtered in production except performance)\n * - WARN: Warning conditions and fallback paths (always shown)\n * - ERROR: Error conditions requiring attention (always shown)\n *
 * **Categories**: See the `LogCategory` union type below.\n *
 * **Usage pattern**:\n * ```\n * import { logger } from '@utils/logger';\n * logger.info('conversion', 'Starting conversion', { format, quality, fileSize });\n * logger.error('ffmpeg', 'Failed to initialize', { error });\n * logger.performance('Frame decoded', { durationMs: 25, frameNumber: 42 });\n * ```\n */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Maximum number of characters allowed for inline context in a single log line.
 *
 * Keeping context inline (instead of as a separate console argument) avoids noisy
 * `Object` suffixes and makes logs easier to copy/paste from DevTools.
 */
const MAX_INLINE_CONTEXT_CHARS = 2000;

function trimStackForInlineLog(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }

  const lines = stack.split('\n').map((line) => line.trim());
  if (lines.length <= 3) {
    return lines.join(' | ');
  }
  return `${lines.slice(0, 3).join(' | ')} | …`;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === 'bigint') {
      return v.toString();
    }

    if (v instanceof Error) {
      return {
        name: v.name,
        message: v.message,
        stack: trimStackForInlineLog(v.stack),
      };
    }

    if (v instanceof Map) {
      return { type: 'Map', entries: Array.from(v.entries()) };
    }

    if (v instanceof Set) {
      return { type: 'Set', values: Array.from(v.values()) };
    }

    if (v instanceof ArrayBuffer) {
      return { type: 'ArrayBuffer', byteLength: v.byteLength };
    }

    if (v instanceof Uint8Array) {
      return { type: 'Uint8Array', length: v.length };
    }

    if (v instanceof Date) {
      return v.toISOString();
    }

    if (typeof v === 'object' && v !== null) {
      const obj = v as object;
      if (seen.has(obj)) {
        return '[Circular]';
      }
      seen.add(obj);
    }

    return v;
  };

  try {
    const json = JSON.stringify(value, replacer);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Log category type union
 *
 * Categorizes logs by subsystem for filtering and organization:
 * - **ffmpeg**: FFmpeg service initialization, operations, errors
 * - **conversion**: Conversion process events and state transitions
 * - **progress**: Progress updates and frame/chunk processing
 * - **watchdog**: Timeout and stall detection monitoring
 * - **general**: General application events not fitting other categories
 * - **performance**: Performance metrics and timing (always logged in all environments)
 * - **prefetch**: Prefetching and resource loading
 * - **worker-pool**: Web Worker pool management and task distribution
 * - **demuxer**: Demuxer library loading, container parsing, sample extraction
 * - **encoders**: Encoder factory and initialization
 * - **encoder-factory**: Encoder factory operations and selection
 * - **gif-encoder**: GIF encoder operations
 * - **mp4-encoder**: MP4 encoder operations
 * - **webp-encoder**: WebP encoder operations
 */
type LogCategory =
  | 'ffmpeg'
  | 'conversion'
  | 'progress'
  | 'watchdog'
  | 'general'
  | 'performance'
  | 'prefetch'
  | 'worker-pool'
  | 'demuxer'
  | 'encoders'
  | 'encoder-factory'
  | 'gif-encoder'
  | 'mp4-encoder'
  | 'webp-encoder'
  | 'webav-mp4';

/**
 * Structured logger for application-wide logging with filtering and categorization
 *
 * The Logger class provides environment-aware logging with the following features:
 * - **Filtering**: DEBUG and INFO logs filtered out in production (except performance logs)
 * - **Timestamping**: All logs prefixed with HH:MM:SS timestamp
 * - **Categorization**: Logs tagged with subsystem category for filtering
 * - **Context support**: Optional context objects logged as JSON for debugging
 * - **Consistent formatting**: All logs follow `[HH:MM:SS] [category] message` pattern
 *
 * **Filtering rules**:
 * - Development: All levels logged (DEBUG, INFO, WARN, ERROR)
 * - Production: Only WARN, ERROR, and performance INFO shown
 * - Performance logs always shown regardless of level/environment (for monitoring)
 *
 * **Constructor**: Detects environment from `import.meta.env.DEV` (Vite built-in)
 */
class Logger {
  private isDev = import.meta.env.DEV;

  // Current conversion progress (0-100). When set, it can be appended to log prefixes
  // to make long-running conversions easier to follow in the console.
  private conversionProgress: number | null = null;
  private conversionProgressUpdatedAtMs = 0;
  private static readonly CONVERSION_PROGRESS_STALE_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Update the active conversion progress for log prefix decoration.
   *
   * Note: This is intentionally best-effort and UI-agnostic. It is used only
   * to annotate log output while a conversion is running.
   */
  setConversionProgress(progress: number): void {
    if (!Number.isFinite(progress)) {
      return;
    }

    const clamped = Math.min(100, Math.max(0, progress));
    const rounded = Math.round(clamped);

    // Treat 100% as completion and clear so post-conversion logs don't keep the prefix.
    if (rounded >= 100) {
      this.clearConversionProgress();
      return;
    }

    this.conversionProgress = rounded;
    this.conversionProgressUpdatedAtMs = Date.now();
  }

  /**
   * Clear any active conversion progress prefix decoration.
   */
  clearConversionProgress(): void {
    this.conversionProgress = null;
    this.conversionProgressUpdatedAtMs = 0;
  }

  private getConversionProgressForPrefix(category: LogCategory): number | null {
    // Avoid redundant duplication: progress logs already include a percent in the message.
    if (category === 'progress') {
      return null;
    }

    if (this.conversionProgress === null) {
      return null;
    }

    // Guard against sticky progress if a conversion aborts unexpectedly.
    const ageMs = Date.now() - this.conversionProgressUpdatedAtMs;
    if (ageMs > Logger.CONVERSION_PROGRESS_STALE_MS) {
      this.clearConversionProgress();
      return null;
    }

    return this.conversionProgress;
  }

  /**
   * Format current time as HH:MM:SS timestamp
   *
   * Used to prefix all log messages with consistent timestamp format.
   * Pads hours, minutes, and seconds to 2 digits.
   *
   * @returns Formatted timestamp string (e.g., "14:35:42")
   *
   * @example
   * formatTimestamp(); // "14:35:42"
   */
  private formatTimestamp(): string {
    const now = new Date();
    // Pad hours, minutes, seconds to 2 digits (e.g., 9 → "09")
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Internal log method for all logging operations
   *
   * Handles filtering, formatting, and routing to appropriate console method.
   * **Filtering logic**:
   * - Development: All levels logged
   * - Production: DEBUG/INFO filtered (except performance category which always logs)
   * - This ensures minimal console output in production while preserving monitoring data
   *
   * **Formatting**: All logs prefixed with `[HH:MM:SS] [category]` before message.
   * **Console method selection**: Based on level (ERROR→error, WARN→warn, INFO→info, DEBUG→log)
   * **Context handling**: Optional context logged as additional JSON argument
   *
   * @param level - Log level (DEBUG, INFO, WARN, ERROR)
   * @param category - Log category for filtering and organization
   * @param message - Main log message
   * @param context - Optional context object or value logged as JSON
   *
   * @example
   * log('INFO', 'conversion', 'Starting conversion', { format: 'gif', quality: 'high' });
   * // Output: [14:35:42] [conversion] Starting conversion { format: 'gif', quality: 'high' }
   */
  private log(level: LogLevel, category: LogCategory, message: string, context?: unknown): void {
    // FILTER: In production, skip DEBUG/INFO logs except for performance category
    // This reduces noise while preserving critical performance monitoring data
    if (!this.isDev && (level === 'DEBUG' || level === 'INFO') && category !== 'performance') {
      return; // Silent skip - log discarded without output
    }

    // FORMAT: Construct prefix with timestamp and category
    const timestamp = this.formatTimestamp();
    const conversionProgress = this.getConversionProgressForPrefix(category);
    const prefix =
      conversionProgress === null
        ? `[${timestamp}] [${category}]`
        : `[${timestamp}] [${category}] [${conversionProgress}%]`;

    // SELECT console method based on log level
    // Maps log levels to appropriate console functions for proper styling/grouping
    const consoleMethod =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'INFO' ? 'info' : 'log';

    // OUTPUT: Log message with optional inline context
    // Keeping context inline avoids noisy `Object` suffixes and makes log capture readable.
    if (context !== undefined) {
      const rawContext = safeJsonStringify(context);
      const inlineContext =
        rawContext.length > MAX_INLINE_CONTEXT_CHARS
          ? `${rawContext.slice(0, MAX_INLINE_CONTEXT_CHARS)}…(truncated)`
          : rawContext;

      console[consoleMethod](`${prefix} ${message} ${inlineContext}`);
      return;
    }

    console[consoleMethod](`${prefix} ${message}`);
  }

  /**
   * Log a debug message (development-only, filtered in production)
   *
   * Debug logs are intended for detailed development-time diagnostics
   * and are automatically filtered out in production builds. Useful for
   * tracing execution flow, variable values, and internal state.
   *
   * @param category - Log category for filtering and organization
   * @param message - Debug message to log
   * @param context - Optional context object or data for debugging
   *
   * @example
   * logger.debug('conversion', 'Frame decoded', { frameNumber: 42, durationMs: 25 });
   * // Dev output: [14:35:42] [conversion] Frame decoded { frameNumber: 42, durationMs: 25 }
   * // Prod output: (silently filtered out)
   */
  debug(category: LogCategory, message: string, context?: unknown): void {
    this.log('DEBUG', category, message, context);
  }

  /**
   * Log an info message (filtered in production except for performance logs)
   *
   * Info logs record important application events and state changes.
   * In production, most INFO logs are filtered (except performance category)
   * to reduce console noise while maintaining monitoring visibility.
   *
   * **Performance exception**: Logs with category='performance' are ALWAYS shown
   * regardless of environment, enabling real-time performance monitoring.
   *
   * @param category - Log category for filtering and organization
   * @param message - Info message to log
   * @param context - Optional context object (e.g., settings, metrics)
   *
   * @example
   * logger.info('conversion', 'Starting conversion', { format: 'gif', quality: 'high', duration: 5000 });
   * // Dev output: [14:35:42] [conversion] Starting conversion { format: 'gif', quality: 'high', duration: 5000 }
   * // Prod output: (filtered unless performance category)
   *
   * @example
   * logger.info('performance', 'Conversion completed', { durationMs: 3500, outputSize: 2500000 });
   * // Dev & Prod output: [14:35:42] [performance] Conversion completed { durationMs: 3500, outputSize: 2500000 }
   */
  info(category: LogCategory, message: string, context?: unknown): void {
    this.log('INFO', category, message, context);
  }

  /**
   * Log a warning message (always shown in all environments)
   *
   * Warning logs record exceptional conditions that don't prevent operation
   * but require user or developer attention. Examples include fallback paths,
   * resource constraints, or performance degradation.
   *
   * WARN level is always shown in both development and production to ensure
   * important conditions are visible without operator action.
   *
   * @param category - Log category for filtering and organization
   * @param message - Warning message to log
   * @param context - Optional context object (e.g., reason, metrics, fallback info)
   *
   * @example
   * logger.warn('conversion', 'Fallback to FFmpeg path', { reason: 'WebCodecs unsupported', duration: 10000 });
   * // Output: [14:35:42] [conversion] Fallback to FFmpeg path { reason: 'WebCodecs unsupported', duration: 10000 }
   */
  warn(category: LogCategory, message: string, context?: unknown): void {
    this.log('WARN', category, message, context);
  }

  /**
   * Log an error message (always shown in all environments)
   *
   * Error logs record failures, exceptions, and conditions that prevent
   * operation completion. Critical for debugging failures and understanding
   * system behavior under error conditions.
   *
   * ERROR level is always shown in both development and production to ensure
   * failures are visible without operator action. Errors include stack traces
   * and full context when available.
   *
   * @param category - Log category for filtering and organization
   * @param message - Error message describing the failure
   * @param context - Error object (includes stack trace), message string, or context data
   *
   * @example
   * logger.error('conversion', 'FFmpeg encoding failed', new Error('Output file not writable'));
   * // Output: [14:35:42] [conversion] FFmpeg encoding failed
   * //         Error: Output file not writable
   * //         at encodeGif (file.ts:123:456)
   *
   * @example
   * logger.error('ffmpeg', 'Worker initialization failed', { reason: 'SharedArrayBuffer unavailable', fallback: true });
   * // Output: [14:35:42] [ffmpeg] Worker initialization failed { reason: 'SharedArrayBuffer unavailable', fallback: true }
   */
  error(category: LogCategory, message: string, context?: unknown): void {
    this.log('ERROR', category, message, context);
  }

  /**
   * Log a performance metric (always shown in all environments)
   *
   * Performance logs record timing and metric data for monitoring system
   * performance and optimization. These logs are ALWAYS shown in both
   * development and production environments regardless of log level filtering.
   *
   * Unlike other INFO logs which are filtered in production, performance logs
   * are preserved to enable real-time performance monitoring and capacity planning.
   * Typical metrics include conversion duration, frame count, output size, memory usage.
   *
   * @param message - Performance metric description (e.g., 'Conversion completed')
   * @param context - Metric data object with timing/size/resource measurements
   *
   * @example
   * logger.performance('Conversion completed', { durationMs: 3500, outputSize: 2500000, frameCount: 150 });
   * // Dev & Prod output: [14:35:42] [performance] Conversion completed { durationMs: 3500, outputSize: 2500000, frameCount: 150 }
   *
   * @example
   * logger.performance('Frame decoded', { frameNumber: 42, durationMs: 25, memory: 256 });
   * // Dev & Prod output: [14:35:42] [performance] Frame decoded { frameNumber: 42, durationMs: 25, memory: 256 }
   */
  performance(message: string, context?: unknown): void {
    this.log('INFO', 'performance', message, context);
  }
}

/**
 * Global logger instance for application-wide logging
 */
export const logger = new Logger();
