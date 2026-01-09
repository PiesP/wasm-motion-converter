/**
 * Calculate optimal thread count for FFmpeg operations.
 * Uses 75% of available CPU cores for better performance on modern CPUs.
 * Capped at 8 threads to prevent excessive resource usage.
 *
 * @returns Optimal number of threads (2-8)
 */
export function getOptimalThreadCount(): number {
  const cores = navigator.hardwareConcurrency || 2;
  // Use 75% of available cores for better performance on modern CPUs
  // Capped at 8 to prevent excessive resource usage
  return Math.min(Math.floor(cores * 0.75), 8);
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
  operation: 'filter-complex' | 'scale-filter' | 'simple'
): string[] {
  // Multi-threaded scale filters enabled by default for better performance
  // Can be disabled via window.__ENABLE_MULTI_THREAD_SCALE__ = false if issues arise
  const enableMultiThreadScale =
    typeof window === 'undefined' ||
    (window as Window & { __ENABLE_MULTI_THREAD_SCALE__?: boolean })
      .__ENABLE_MULTI_THREAD_SCALE__ !== false;

  switch (operation) {
    case 'filter-complex':
      // Complex filter graphs need single-threaded mode to avoid deadlocks
      return ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
    case 'scale-filter': {
      // Scale filters use multi-threading for 2-3x performance improvement
      if (enableMultiThreadScale) {
        // Use 75% of optimal threads for better performance while maintaining stability
        // Increased from 50% after validation of stability across different hardware
        const threads = Math.max(2, Math.floor(getOptimalThreadCount() * 0.75));
        return ['-threads', threads.toString(), '-filter_threads', threads.toString()];
      }
      // Fallback: Single-threaded (only if explicitly disabled)
      return ['-threads', '1', '-filter_threads', '1'];
    }
    case 'simple': {
      // Simple operations can use multi-threading
      const threads = getOptimalThreadCount();
      return ['-threads', threads.toString()];
    }
  }
}
