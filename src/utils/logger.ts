type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogCategory = 'ffmpeg' | 'conversion' | 'progress' | 'watchdog' | 'general';

class Logger {
  private isDev = import.meta.env.DEV;

  private formatTimestamp(): string {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  private log(level: LogLevel, category: LogCategory, message: string, context?: unknown): void {
    // Filter DEBUG/INFO in production
    if (!this.isDev && (level === 'DEBUG' || level === 'INFO')) {
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

  debug(category: LogCategory, message: string, context?: unknown): void {
    this.log('DEBUG', category, message, context);
  }

  info(category: LogCategory, message: string, context?: unknown): void {
    this.log('INFO', category, message, context);
  }

  warn(category: LogCategory, message: string, context?: unknown): void {
    this.log('WARN', category, message, context);
  }

  error(category: LogCategory, message: string, context?: unknown): void {
    this.log('ERROR', category, message, context);
  }
}

export const logger = new Logger();
