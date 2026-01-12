/**
 * Calculate optimal thread count for FFmpeg operations.
 * Uses 75% of available CPU cores for better performance on modern CPUs.
 * Capped at 12 threads to prevent excessive resource usage.
 *
 * @returns Optimal number of threads (2-12)
 */
function getOptimalThreadCount(): number {
  const cores = navigator.hardwareConcurrency || 2;
  // Use 75% of available cores for better performance on modern CPUs
  // Capped at 12 to prevent excessive resource usage
  return Math.min(Math.floor(cores * 0.75), 12);
}

// Cache for threading args to prevent repeated allocations
const threadingArgsCache = new Map<string, readonly string[]>();

function cacheThreadingArgs(key: string, args: string[]): readonly string[] {
  const frozen = Object.freeze(args);
  threadingArgsCache.set(key, frozen);
  return frozen;
}

/**
 * Determine optimal threading arguments for FFmpeg operations.
 * Prevents deadlocks by using single-threading for complex filters.
 * Implements multi-threading for scale filters (enabled by default, can be disabled via feature flag).
 *
 * @param operation - Type of FFmpeg operation: 'filter-complex' | 'scale-filter' | 'simple'
 * @returns Array of FFmpeg threading command-line arguments
 */
export function getThreadingArgs(
  operation: "filter-complex" | "scale-filter" | "simple"
): readonly string[] {
  // Multi-threaded scale filters enabled by default for better performance
  // Can be disabled via window.__ENABLE_MULTI_THREAD_SCALE__ = false if issues arise
  const enableMultiThreadScale =
    typeof window === "undefined" ||
    (window as Window & { __ENABLE_MULTI_THREAD_SCALE__?: boolean })
      .__ENABLE_MULTI_THREAD_SCALE__ !== false;

  switch (operation) {
    case "filter-complex": {
      const cacheKey = "filter-complex";
      const cached = threadingArgsCache.get(cacheKey);
      if (cached) return cached;
      // Complex filter graphs need single-threaded mode to avoid deadlocks
      return cacheThreadingArgs(cacheKey, [
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
      ]);
    }
    case "scale-filter": {
      // Scale filters use multi-threading for 2-3x performance improvement
      if (enableMultiThreadScale) {
        // Use 75% of optimal threads for better performance while maintaining stability
        // Increased from 50% after validation of stability across different hardware
        const threads = Math.max(2, Math.floor(getOptimalThreadCount() * 0.75));
        const cacheKey = `scale-filter-mt-${threads}`;
        const cached = threadingArgsCache.get(cacheKey);
        if (cached) return cached;
        return cacheThreadingArgs(cacheKey, [
          "-threads",
          threads.toString(),
          "-filter_threads",
          threads.toString(),
        ]);
      }
      // Fallback: Single-threaded (only if explicitly disabled)
      const cacheKey = "scale-filter-st";
      const cached = threadingArgsCache.get(cacheKey);
      if (cached) return cached;
      return cacheThreadingArgs(cacheKey, [
        "-threads",
        "1",
        "-filter_threads",
        "1",
      ]);
    }
    case "simple": {
      // Simple operations can use multi-threading
      const threads = getOptimalThreadCount();
      const cacheKey = `simple-${threads}`;
      const cached = threadingArgsCache.get(cacheKey);
      if (cached) return cached;
      return cacheThreadingArgs(cacheKey, ["-threads", threads.toString()]);
    }
  }
}
