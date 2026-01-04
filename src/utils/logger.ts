type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogCategory =
  | 'ffmpeg'
  | 'conversion'
  | 'progress'
  | 'watchdog'
  | 'general'
  | 'performance'
  | 'prefetch'
  | 'worker-pool';

/**
 * Logger utility for structured logging throughout the application
 * Filters log levels based on environment (dev vs production)
 */
class Logger {
  private isDev = import.meta.env.DEV;

  private formatTimestamp(): string {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Internal log method
   * @param level - Log level (DEBUG, INFO, WARN, ERROR)
   * @param category - Log category for filtering
   * @param message - Log message
   * @param context - Optional context data to log
   */
  private log(level: LogLevel, category: LogCategory, message: string, context?: unknown): void {
    // Filter DEBUG/INFO in production, except for performance logs
    if (!this.isDev && (level === 'DEBUG' || level === 'INFO') && category !== 'performance') {
      return;
    }

    const timestamp = this.formatTimestamp();
    const prefix = `[${timestamp}] [${category}]`;

    const consoleMethod =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'INFO' ? 'info' : 'log';

    if (context !== undefined) {
      console[consoleMethod](`${prefix} ${message}`, context);
    } else {
      console[consoleMethod](`${prefix} ${message}`);
    }
  }

  /**
   * Log a debug message (filtered in production)
   * @param category - Log category
   * @param message - Message to log
   * @param context - Optional context data
   */
  debug(category: LogCategory, message: string, context?: unknown): void {
    this.log('DEBUG', category, message, context);
  }

  /**
   * Log an info message (filtered in production except for performance logs)
   * @param category - Log category
   * @param message - Message to log
   * @param context - Optional context data
   */
  info(category: LogCategory, message: string, context?: unknown): void {
    this.log('INFO', category, message, context);
  }

  /**
   * Log a warning message
   * @param category - Log category
   * @param message - Message to log
   * @param context - Optional context data
   */
  warn(category: LogCategory, message: string, context?: unknown): void {
    this.log('WARN', category, message, context);
  }

  /**
   * Log an error message (always shown)
   * @param category - Log category
   * @param message - Message to log
   * @param context - Optional context data
   */
  error(category: LogCategory, message: string, context?: unknown): void {
    this.log('ERROR', category, message, context);
  }

  /**
   * Log a performance metric (always shown in all environments)
   * @param message - Message to log
   * @param context - Optional context data
   */
  performance(message: string, context?: unknown): void {
    this.log('INFO', 'performance', message, context);
  }
}

/**
 * Global logger instance for application-wide logging
 */
export const logger = new Logger();
