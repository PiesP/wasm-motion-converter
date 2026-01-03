/**
 * FFmpeg.wasm health check and diagnostics utilities
 * Helps detect and handle common issues reported on GitHub and Stack Overflow
 */

export interface FFmpegHealthStatus {
  isHealthy: boolean;
  issues: string[];
  warnings: string[];
  recommendations: string[];
}

/**
 * Check environment and browser capabilities for ffmpeg.wasm
 */
export function checkFFmpegEnvironment(): FFmpegHealthStatus {
  const issues: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  // Check SharedArrayBuffer support
  if (typeof SharedArrayBuffer === 'undefined') {
    issues.push('SharedArrayBuffer is not available in this browser/environment');
    recommendations.push(
      'Enable cross-origin isolation headers (COOP/COEP) or use single-threaded FFmpeg core'
    );
  }

  // Check cross-origin isolation
  if (typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated) {
    warnings.push('Cross-origin isolation is not enabled');
    recommendations.push(
      'Configure COOP (Cross-Origin-Opener-Policy: same-origin) and COEP (Cross-Origin-Embedder-Policy: require-corp) headers for multithreading support'
    );
  }

  // Check available memory (rough estimate)
  const performanceWithMemory = performance as unknown as {
    memory?: {
      jsHeapSizeLimit?: number;
    };
  };
  if (typeof performance !== 'undefined' && performanceWithMemory.memory) {
    const memory = performanceWithMemory.memory;
    if (memory.jsHeapSizeLimit) {
      const heapLimitMB = memory.jsHeapSizeLimit / 1024 / 1024;
      if (heapLimitMB < 512) {
        warnings.push(`Low available memory: ${heapLimitMB.toFixed(0)}MB`);
        recommendations.push('Close other tabs to free up memory, or use lower quality settings');
      }
    }
  }

  // Check if Worker is available (needed for FFmpeg)
  if (typeof Worker === 'undefined') {
    issues.push('Web Workers are not supported');
    recommendations.push('Update your browser or use a different environment');
  }

  // Check fetch API
  if (typeof fetch === 'undefined') {
    issues.push('Fetch API is not available');
    recommendations.push('Use a modern browser with Fetch API support');
  }

  // Check Blob support
  if (typeof Blob === 'undefined') {
    issues.push('Blob API is not available');
    recommendations.push('Use a modern browser with Blob API support');
  }

  // Check for private/incognito mode (reduced storage quota)
  if (navigator.storage) {
    // Note: This is a heuristic check
    const navWithWebkit = navigator as unknown as { webkitTemporaryStorage?: unknown };
    const hasWebkitStorage = typeof navWithWebkit.webkitTemporaryStorage !== 'undefined';
    if (!hasWebkitStorage) {
      warnings.push('Possible private/incognito mode detected');
      recommendations.push('Private mode may have reduced storage and memory limits');
    }
  }

  return {
    isHealthy: issues.length === 0,
    issues,
    warnings,
    recommendations,
  };
}

/**
 * Detect potential memory issues based on video file size and metadata
 */
export function checkMemorySafety(
  fileSize: number,
  duration: number,
  width: number,
  height: number,
  framerate: number
): FFmpegHealthStatus {
  const warnings: string[] = [];
  const recommendations: string[] = [];

  // Estimate total pixels to be processed
  const totalPixels = width * height * framerate * duration;

  // Constants for safety thresholds
  const FILE_SIZE_WARNING_MB = 100;
  const FILE_SIZE_ERROR_MB = 500;
  const PIXEL_WARNING = 250_000_000; // 250M pixels
  const PIXEL_ERROR = 1_000_000_000; // 1B pixels

  const fileSizeMB = fileSize / 1024 / 1024;

  // File size checks
  if (fileSizeMB > FILE_SIZE_ERROR_MB) {
    return {
      isHealthy: false,
      issues: [`File size is too large: ${fileSizeMB.toFixed(0)}MB`],
      warnings,
      recommendations: [
        'Split the video into smaller clips',
        'Use lower quality settings',
        'Reduce resolution before uploading',
      ],
    };
  }

  if (fileSizeMB > FILE_SIZE_WARNING_MB) {
    warnings.push(`Large file size: ${fileSizeMB.toFixed(0)}MB`);
    recommendations.push('Consider using lower quality or scale settings');
  }

  // Pixel count checks
  if (totalPixels > PIXEL_ERROR) {
    return {
      isHealthy: false,
      issues: [`Video is too complex: ${(totalPixels / 1_000_000).toFixed(0)}M total pixels`],
      warnings,
      recommendations: [
        'Use lower resolution input',
        'Use lower quality preset',
        'Reduce framerate',
        'Use shorter video duration',
      ],
    };
  }

  if (totalPixels > PIXEL_WARNING) {
    warnings.push(`Video has many pixels: ${(totalPixels / 1_000_000).toFixed(0)}M total`);
    recommendations.push('Use lower quality or scale settings if conversion is slow');
  }

  // Frame count check
  const totalFrames = Math.ceil(duration * framerate);
  if (totalFrames > 10_000) {
    warnings.push(`High frame count: ${totalFrames} frames`);
    recommendations.push('Consider lowering framerate or video duration');
  }

  // High resolution check
  if (width >= 2560 || height >= 2560) {
    warnings.push(`Very high resolution: ${width}x${height}`);
    recommendations.push('Consider lowering resolution or using scale factor');
  }

  return {
    isHealthy: warnings.length === 0,
    issues: [],
    warnings,
    recommendations,
  };
}

/**
 * Detect if the error is due to memory/bounds issues
 */
export function isMemoryRelatedError(error: unknown): boolean {
  const errorStr = String(error).toLowerCase();
  return (
    errorStr.includes('memory access out of bounds') ||
    errorStr.includes('out of memory') ||
    errorStr.includes('memory exhausted') ||
    errorStr.includes('abort') ||
    errorStr.includes('null pointer') ||
    errorStr.includes('stack overflow')
  );
}

/**
 * Detect if error is due to timeout/hung process
 */
export function isTimeoutError(error: unknown): boolean {
  const errorStr = String(error).toLowerCase();
  return (
    errorStr.includes('timed out') ||
    errorStr.includes('90s') ||
    errorStr.includes('hung') ||
    errorStr.includes('terminate')
  );
}

/**
 * Detect if error is due to worker/threading issues
 */
export function isWorkerError(error: unknown): boolean {
  const errorStr = String(error).toLowerCase();
  return (
    errorStr.includes('worker') ||
    errorStr.includes('thread') ||
    errorStr.includes('shared array buffer') ||
    errorStr.includes('cors') ||
    errorStr.includes('cross-origin')
  );
}

/**
 * Suggest quality settings based on video characteristics
 */
export function suggestQualitySettings(
  width: number,
  height: number,
  duration: number
): {
  recommendedQuality: 'low' | 'medium' | 'high';
  recommendedScale: 0.5 | 0.75 | 1.0;
  reason: string;
} {
  const resolution = width * height;
  const durationMinutes = duration / 60;

  // Very high resolution or long duration
  if (resolution > 2_073_600 || durationMinutes > 10) {
    return {
      recommendedQuality: 'low',
      recommendedScale: 0.5,
      reason: 'High resolution or long duration video - use lower quality for browser processing',
    };
  }

  // High resolution or medium duration
  if (resolution > 921_600 || durationMinutes > 5) {
    return {
      recommendedQuality: 'low',
      recommendedScale: 0.75,
      reason: 'Medium-high complexity video - lower settings recommended',
    };
  }

  // Medium resolution
  if (resolution > 518_400) {
    return {
      recommendedQuality: 'medium',
      recommendedScale: 1.0,
      reason: 'Medium resolution video - medium quality suitable',
    };
  }

  // Low resolution - can use high quality
  return {
    recommendedQuality: 'high',
    recommendedScale: 1.0,
    reason: 'Low resolution video - can safely use high quality',
  };
}

/**
 * Get recovery suggestions based on error type
 */
export function getRecoverySuggestions(error: unknown): string[] {
  const suggestions: string[] = [];

  if (isMemoryRelatedError(error)) {
    suggestions.push('Reduce video quality setting to "low"');
    suggestions.push('Use scale factor 0.5 to reduce resolution');
    suggestions.push('Choose a shorter video duration');
    suggestions.push('Close other browser tabs to free memory');
  }

  if (isTimeoutError(error)) {
    suggestions.push('Reduce quality setting to "low"');
    suggestions.push('Lower the scale factor');
    suggestions.push('Use a shorter video');
    suggestions.push('Try GIF format which may be faster than WebP');
  }

  if (isWorkerError(error)) {
    suggestions.push('Ensure cross-origin isolation headers are properly configured');
    suggestions.push('Check COOP and COEP headers on the server');
    suggestions.push('Try refreshing the page');
    suggestions.push('Use a different browser');
  }

  if (suggestions.length === 0) {
    suggestions.push('Reload the page and try again');
    suggestions.push('Try with lower quality settings');
    suggestions.push('Try with a different video file');
  }

  return suggestions;
}
