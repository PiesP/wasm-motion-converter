/**
 * FFmpeg Service Type Definitions
 * Organizes complex FFmpeg state into logical groups for better maintainability and testing
 */

/**
 * Watchdog state - monitors FFmpeg progress and detects stalls
 */
export interface WatchdogState {
  timer: ReturnType<typeof setInterval> | null;
  lastProgressTime: number;
  lastLogTime: number;
  timeout: number;
  logSilenceStrikes: number;
}

/**
 * Conversion state - tracks active conversion and prevents concurrent operations
 */
export interface ConversionState {
  isConverting: boolean;
  lock: boolean;
  cancellationRequested: boolean;
  isTerminating: boolean;
}

/**
 * Progress tracking state - manages progress reporting and debouncing
 */
export interface ProgressTrackingState {
  callback: ((progress: number) => void) | null;
  lastEmitTime: number;
  lastValue: number;
}

/**
 * Status callback state - manages status message reporting
 */
export interface StatusCallbackState {
  callback: ((message: string) => void) | null;
}

/**
 * Initialization state - tracks FFmpeg loading process
 */
export interface InitializationState {
  promise: Promise<void> | null;
  progressCallbacks: Set<(progress: number) => void>;
  statusCallbacks: Set<(message: string) => void>;
}

/**
 * Cache state - manages input file caching
 */
export interface CacheState {
  inputKey: string | null;
  cacheTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Prefetch state - manages core asset prefetching
 */
export interface PrefetchState {
  promise: Promise<void> | null;
}

/**
 * Log buffer state - manages FFmpeg log collection
 */
export interface LogBufferState {
  logs: string[];
  silenceInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Heartbeat state - manages activity monitoring
 */
export interface HeartbeatState {
  interval: ReturnType<typeof setInterval> | null;
}

/**
 * Environment state - tracks environment logging
 */
export interface EnvironmentState {
  hasLogged: boolean;
}

/**
 * Resource tracking state - tracks active resources for cleanup
 */
export interface ResourceTrackingState {
  activeHeartbeats: Set<ReturnType<typeof setInterval>>;
  knownFiles: Set<string>;
}

/**
 * FFmpeg Service Configuration - allows dependency injection for testing
 */
export interface FFmpegConfig {
  coreBaseUrls?: string[];
  watchdogTimeoutMs?: number;
  progressThrottleMs?: number;
}
