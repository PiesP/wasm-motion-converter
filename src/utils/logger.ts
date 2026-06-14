// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Structured logging utility with environment-aware filtering.
 *
 * - Development: all levels logged
 * - Production: only WARN, ERROR, and performance INFO shown
 * - Format: [HH:MM:SS] [category] message [context]
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type LogCategory =
  | 'ffmpeg'
  | 'conversion'
  | 'progress'
  | 'watchdog'
  | 'general'
  | 'performance'
  | 'prefetch'
  | 'cdn'
  | 'demuxer'
  | 'encoders';

type LogEntry = {
  timestampMs: number;
  timestampIso: string;
  time: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  conversionProgress: number | null;
  contextJson?: string;
  line: string;
};

const MAX_INLINE_CONTEXT_CHARS = 2000;
const MAX_RECENT_LOG_LINES = 750;
const MAX_FFMPEG_LOG_LINES = 200;
const CONVERSION_PROGRESS_STALE_MS = 10 * 60 * 1000;

/**
 * Categories considered important for log buffer eviction priority.
 * When the main buffer is full, non-important entries (ffmpeg) are evicted first.
 */
const IMPORTANT_CATEGORIES: ReadonlySet<LogCategory> = new Set([
  'conversion',
  'demuxer',
  'progress',
  'watchdog',
  'general',
  'encoders',
  'performance',
]);

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (v instanceof Map) return { type: 'Map', entries: Array.from(v.entries()) };
    if (v instanceof Set) return { type: 'Set', values: Array.from(v.values()) };
    if (v instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: v.byteLength };
    if (v instanceof Uint8Array) return { type: 'Uint8Array', length: v.length };
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]';
      seen.add(v as object);
    }
    return v;
  };
  try {
    return JSON.stringify(value, replacer) ?? String(value);
  } catch {
    return String(value);
  }
}

class Logger {
  private isDev = import.meta.env.DEV;
  private recentLines: string[] = [];
  private recentEntries: LogEntry[] = [];
  private ffmpegRecentLines: string[] = [];
  private ffmpegRecentEntries: LogEntry[] = [];
  private conversionProgress: number | null = null;
  private conversionProgressUpdatedAtMs = 0;

  setConversionProgress(progress: number): void {
    if (!Number.isFinite(progress)) return;
    const rounded = Math.min(100, Math.max(0, Math.round(progress)));
    if (rounded >= 100) {
      this.clearConversionProgress();
      return;
    }
    this.conversionProgress = rounded;
    this.conversionProgressUpdatedAtMs = performance.now();
  }

  clearConversionProgress(): void {
    this.conversionProgress = null;
    this.conversionProgressUpdatedAtMs = 0;
  }

  private getProgressForPrefix(category: LogCategory): number | null {
    if (category === 'progress' || this.conversionProgress === null) return null;
    if (performance.now() - this.conversionProgressUpdatedAtMs > CONVERSION_PROGRESS_STALE_MS) {
      this.clearConversionProgress();
      return null;
    }
    return this.conversionProgress;
  }

  private log(level: LogLevel, category: LogCategory, message: string, context?: unknown): void {
    if (!this.isDev && (level === 'DEBUG' || level === 'INFO') && category !== 'performance') {
      return;
    }

    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const progress = this.getProgressForPrefix(category);
    const prefix =
      progress === null ? `[${ts}] [${category}]` : `[${ts}] [${category}] [${progress}%]`;

    const { line, contextJson } = (() => {
      if (context === undefined) {
        return { line: `${prefix} ${message}`, contextJson: undefined };
      }
      const raw = safeJsonStringify(context);
      const inline =
        raw.length > MAX_INLINE_CONTEXT_CHARS
          ? `${raw.slice(0, MAX_INLINE_CONTEXT_CHARS)}…(truncated)`
          : raw;
      return { line: `${prefix} ${message} ${inline}`, contextJson: raw };
    })();

    const entry: LogEntry = {
      timestampMs: now.getTime(),
      timestampIso: now.toISOString(),
      time: ts,
      level,
      category,
      message,
      conversionProgress: progress,
      contextJson,
      line,
    };

    const method =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'INFO' ? 'info' : 'log';
    console[method](line);

    this.recentLines.push(line);
    if (this.recentLines.length > MAX_RECENT_LOG_LINES) {
      // Priority eviction: prefer to evict non-important (ffmpeg) entries first
      const evictIdx = this.recentEntries.findIndex((e) => !IMPORTANT_CATEGORIES.has(e.category));
      if (evictIdx !== -1) {
        this.recentLines.splice(evictIdx, 1);
        this.recentEntries.splice(evictIdx, 1);
        // No size reduction needed — we removed one, added one
      } else {
        // All entries are important; evict oldest
        this.recentLines.shift();
      }
    }
    this.recentEntries.push(entry);
    if (this.recentEntries.length > MAX_RECENT_LOG_LINES) {
      // Priority eviction: prefer to evict non-important (ffmpeg) entries first
      const evictIdx = this.recentEntries.findIndex((e) => !IMPORTANT_CATEGORIES.has(e.category));
      if (evictIdx !== -1) {
        this.recentEntries.splice(evictIdx, 1);
      } else {
        this.recentEntries.shift();
      }
    }
  }

  getRecentLogs(): string[] {
    return [...this.recentLines];
  }
  getRecentEntries(): LogEntry[] {
    return [...this.recentEntries];
  }

  /**
   * Store a raw FFmpeg stderr/stdout line in a separate ring buffer
   * to prevent verbose FFmpeg output from evicting important application logs.
   *
   * Max 200 lines; oldest FFmpeg lines are evicted when full.
   */
  addFfmpegLog(level: LogLevel, message: string, type?: string, context?: unknown): void {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const ffType = type ? `[${type}] ` : '';
    const line = `[${ts}] [ffmpeg] ${ffType}${message}`;

    const entry: LogEntry = {
      timestampMs: now.getTime(),
      timestampIso: now.toISOString(),
      time: ts,
      level,
      category: 'ffmpeg',
      message,
      conversionProgress: null,
      contextJson: context !== undefined ? safeJsonStringify(context) : undefined,
      line,
    };

    this.ffmpegRecentLines.push(line);
    if (this.ffmpegRecentLines.length > MAX_FFMPEG_LOG_LINES) {
      this.ffmpegRecentLines.shift();
    }
    this.ffmpegRecentEntries.push(entry);
    if (this.ffmpegRecentEntries.length > MAX_FFMPEG_LOG_LINES) {
      this.ffmpegRecentEntries.shift();
    }
  }

  getFfmpegLogs(): string[] {
    return [...this.ffmpegRecentLines];
  }
  getFfmpegEntries(): LogEntry[] {
    return [...this.ffmpegRecentEntries];
  }

  clearRecentLogs(): void {
    this.recentLines = [];
    this.recentEntries = [];
    this.ffmpegRecentLines = [];
    this.ffmpegRecentEntries = [];
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
  performance(message: string, context?: unknown): void {
    this.log('INFO', 'performance', message, context);
  }
}

export const logger = new Logger();
