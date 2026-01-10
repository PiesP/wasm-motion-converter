/**
 * Session cache utilities for performance optimization caching
 *
 * Provides type-safe wrappers around sessionStorage for caching
 * conversion strategy decisions across conversions within a session.
 */

// ============================================================================
// Storage Helpers (기존 패턴 확장)
// ============================================================================

export function readSessionNumber(key: string): number {
  try {
    if (typeof sessionStorage === 'undefined') {
      return 0;
    }
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return 0;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0; // Fallback for privacy mode
  }
}

export function writeSessionNumber(key: string, value: number): void {
  try {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures (privacy modes)
  }
}

export function readSessionString(key: string): string | null {
  try {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSessionString(key: string, value: string): void {
  try {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage failures
  }
}

// ============================================================================
// Capture Mode Caching
// ============================================================================

export type CaptureMode = 'seek' | 'frame-callback' | 'track' | 'demuxer';

/**
 * Get cached successful capture mode for a codec
 */
export function getCachedCaptureMode(codec: string): CaptureMode | null {
  const normalizedCodec = codec.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `dropconvert:capture:success:${normalizedCodec}`;
  const value = readSessionString(key);

  if (value === 'seek' || value === 'frame-callback' || value === 'track' || value === 'demuxer') {
    return value;
  }

  return null;
}

/**
 * Cache successful capture mode for a codec
 */
export function cacheCaptureMode(codec: string, mode: CaptureMode): void {
  const normalizedCodec = codec.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `dropconvert:capture:success:${normalizedCodec}`;
  writeSessionString(key, mode);
}

// ============================================================================
// VFS Batch Size Caching
// ============================================================================

export function getCachedVFSBatchSize(): number | null {
  const value = readSessionNumber('dropconvert:vfs:batchSize');
  return value > 0 ? value : null;
}

export function cacheVFSBatchSize(batchSize: number): void {
  writeSessionNumber('dropconvert:vfs:batchSize', batchSize);
}

// ============================================================================
// WebP Chunk Size Caching
// ============================================================================

export function getCachedWebPChunkSize(): number | null {
  const value = readSessionNumber('dropconvert:webp:chunkSize');
  return value > 0 ? value : null;
}

export function cacheWebPChunkSize(chunkSize: number): void {
  writeSessionNumber('dropconvert:webp:chunkSize', chunkSize);
}

// ============================================================================
// Capture Performance Caching (avg ms/frame by mode)
// ============================================================================

/**
 * Performance metrics for a specific capture mode
 */
export interface CapturePerformance {
  /** The capture mode that was used */
  mode: CaptureMode;
  /** Average time per frame in milliseconds */
  avgMsPerFrame: number;
  /** Number of frames in the sample */
  sampleSize: number;
  /** Timestamp when this performance was recorded */
  timestamp: number;
}

/**
 * Get cached performance metrics for a codec
 *
 * Returns null if cache is missing, invalid, or stale (>5 minutes old)
 */
export function getCachedCapturePerformance(codec: string): CapturePerformance | null {
  const normalizedCodec = codec.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `dropconvert:capture:perf:${normalizedCodec}`;
  const json = readSessionString(key);

  if (!json) {
    return null;
  }

  try {
    const perf = JSON.parse(json) as CapturePerformance;

    // Validate performance data
    if (!perf.mode || !perf.avgMsPerFrame || !perf.sampleSize || !perf.timestamp) {
      return null;
    }

    // Invalidate if stale (>5 minutes old) or invalid
    if (Date.now() - perf.timestamp > 300_000 || perf.avgMsPerFrame <= 0) {
      return null;
    }

    return perf;
  } catch {
    // Invalid JSON or parsing error
    return null;
  }
}

/**
 * Cache performance metrics for a codec
 */
export function cacheCapturePerformance(
  codec: string,
  mode: CaptureMode,
  totalMs: number,
  frameCount: number
): void {
  const normalizedCodec = codec.toLowerCase().replace(/[^a-z0-9]/g, '');
  const avgMsPerFrame = frameCount > 0 ? totalMs / frameCount : 0;

  const perf: CapturePerformance = {
    mode,
    avgMsPerFrame,
    sampleSize: frameCount,
    timestamp: Date.now(),
  };

  const key = `dropconvert:capture:perf:${normalizedCodec}`;
  writeSessionString(key, JSON.stringify(perf));
}
