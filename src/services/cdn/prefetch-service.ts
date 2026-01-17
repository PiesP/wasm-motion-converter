/**
 * CDN Prefetch Service
 *
 * Predictively prefetches FFmpeg core assets during idle time to improve
 * conversion start latency. Only prefetches on WiFi to avoid wasting
 * mobile data. Uses requestIdleCallback for non-blocking execution.
 *
 * Features:
 * - Idle time prefetching (triggered after 5s delay)
 * - Connection-aware (WiFi only)
 * - Event-driven preloading (e.g., on dropzone hover)
 * - Progress callbacks for optional UI feedback
 * - Cancellable prefetch operations
 */

import { shouldEnablePrefetch } from '@services/cdn/cdn-strategy-selector-service';
import { isPreloadComplete } from '@services/cdn/unified-preloader-service';
import { loadFFmpegAsset } from '@services/ffmpeg/core-assets-service';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * Prefetch status for tracking
 */
export type PrefetchStatus =
  | 'idle'
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Prefetch progress callback
 */
export type PrefetchProgressCallback = (progress: {
  status: PrefetchStatus;
  asset: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  error?: string;
}) => void;

/**
 * FFmpeg core assets to prefetch
 * Ordered by priority (most critical first)
 */
const FFMPEG_ASSETS = [
  {
    path: 'ffmpeg-core.wasm',
    mimeType: 'application/wasm',
    label: 'FFmpeg core WASM',
    priority: 0,
  },
  {
    path: 'ffmpeg-core.js',
    mimeType: 'text/javascript',
    label: 'FFmpeg core script',
    priority: 1,
  },
  {
    path: 'ffmpeg-core.worker.js',
    mimeType: 'text/javascript',
    label: 'FFmpeg worker',
    priority: 2,
  },
] as const;

const DEFAULT_PREFETCH_DELAY_MS = 5000;
const TRIGGER_PREFETCH_DELAY_MS = 1000;
const PREFETCH_IDLE_TIMEOUT_MS = 1000;

/**
 * Prefetch manager singleton
 */
class PrefetchManager {
  private status: PrefetchStatus = 'idle';
  private abortController: AbortController | null = null;
  private callbacks: Set<PrefetchProgressCallback> = new Set();
  private prefetchedAssets: Set<string> = new Set();
  private idleCallbackId: number | null = null;

  /**
   * Registers a progress callback
   *
   * @param callback - Progress callback function
   */
  public onProgress(callback: PrefetchProgressCallback): void {
    this.callbacks.add(callback);
  }

  /**
   * Unregisters a progress callback
   *
   * @param callback - Progress callback function
   */
  public offProgress(callback: PrefetchProgressCallback): void {
    this.callbacks.delete(callback);
  }

  /**
   * Emits progress to all registered callbacks
   */
  private emitProgress(progress: Parameters<PrefetchProgressCallback>[0]): void {
    this.callbacks.forEach((callback) => {
      try {
        callback(progress);
      } catch (error) {
        logger.warn('prefetch', 'Prefetch progress callback threw', {
          error: getErrorMessage(error),
        });
      }
    });
  }

  /**
   * Checks if prefetching is already complete
   */
  public isPrefetched(): boolean {
    return this.status === 'completed';
  }

  /**
   * Checks if prefetching is currently in progress
   */
  public isInProgress(): boolean {
    return this.status === 'in-progress';
  }

  /**
   * Gets current prefetch status
   */
  public getStatus(): PrefetchStatus {
    return this.status;
  }

  /**
   * Cancels ongoing prefetch operation
   */
  public cancel(): void {
    if (this.status !== 'in-progress') {
      return;
    }

    if (this.abortController) {
      this.abortController.abort();
    }

    if (this.idleCallbackId !== null) {
      cancelIdleCallback(this.idleCallbackId);
      this.idleCallbackId = null;
    }

    this.status = 'cancelled';
    this.emitProgress({ status: 'cancelled', asset: 'all' });
    logger.info('prefetch', 'Prefetch cancelled');
  }

  /**
   * Starts prefetching FFmpeg core assets
   *
   * @param options - Prefetch options
   * @param options.force - Force prefetch even if conditions aren't met
   * @param options.delay - Delay before starting (ms, default: 5000)
   * @returns Promise that resolves when prefetch completes or fails
   */
  public async start(options: { force?: boolean; delay?: number } = {}): Promise<void> {
    const { force = false, delay = DEFAULT_PREFETCH_DELAY_MS } = options;

    // Check if unified preloader has already completed
    if (isPreloadComplete()) {
      logger.debug('prefetch', 'Unified preloader already completed, skipping prefetch');
      this.status = 'completed';
      return;
    }

    // Check if already prefetched or in progress
    if (this.status === 'completed') {
      logger.debug('prefetch', 'FFmpeg already prefetched');
      return;
    }

    if (this.status === 'in-progress') {
      logger.debug('prefetch', 'Prefetch already in progress');
      return;
    }

    // Check connection type (skip on slow/mobile unless forced)
    if (!force && !shouldEnablePrefetch()) {
      logger.info('prefetch', 'Skipping prefetch due to connection strategy');
      this.status = 'idle';
      return;
    }

    this.status = 'pending';
    this.emitProgress({ status: 'pending', asset: 'all' });

    // Use requestIdleCallback for non-blocking execution
    return new Promise((resolve, reject) => {
      const startPrefetch = async () => {
        try {
          this.status = 'in-progress';
          this.abortController = new AbortController();

          logger.info('prefetch', 'Starting FFmpeg prefetch', {
            assetCount: FFMPEG_ASSETS.length,
            approxSizeMb: 30,
          });

          // Prefetch all assets in priority order
          for (const asset of FFMPEG_ASSETS) {
            if (this.abortController.signal.aborted) {
              throw new Error('Prefetch cancelled');
            }

            logger.debug('prefetch', 'Prefetching FFmpeg asset', {
              label: asset.label,
              path: asset.path,
            });
            this.emitProgress({
              status: 'in-progress',
              asset: asset.label,
            });

            // Use existing loadFFmpegAsset which handles CDN cascade
            await loadFFmpegAsset(asset.path, asset.mimeType, asset.label);

            this.prefetchedAssets.add(asset.path);
            logger.debug('prefetch', 'FFmpeg asset prefetched', {
              label: asset.label,
              path: asset.path,
            });
          }

          this.status = 'completed';
          this.emitProgress({ status: 'completed', asset: 'all' });
          logger.info('prefetch', 'All FFmpeg assets prefetched successfully');
          resolve();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          if (errorMsg.includes('cancelled')) {
            this.status = 'cancelled';
            this.emitProgress({ status: 'cancelled', asset: 'all' });
            logger.info('prefetch', 'Prefetch cancelled');
          } else {
            this.status = 'failed';
            this.emitProgress({
              status: 'failed',
              asset: 'all',
              error: errorMsg,
            });
            logger.error('prefetch', 'Prefetch failed', {
              error: getErrorMessage(error),
            });
          }

          reject(error);
        } finally {
          this.abortController = null;
        }
      };

      // Schedule with delay using requestIdleCallback
      if (delay > 0) {
        const timeoutId = setTimeout(() => {
          if (typeof requestIdleCallback !== 'undefined') {
            this.idleCallbackId = requestIdleCallback(
              () => {
                startPrefetch();
              },
              { timeout: PREFETCH_IDLE_TIMEOUT_MS }
            );
          } else {
            // Fallback for browsers without requestIdleCallback
            startPrefetch();
          }
        }, delay);

        // Allow cancellation during delay
        if (this.abortController) {
          this.abortController.signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
          });
        }
      } else {
        startPrefetch();
      }
    });
  }

  /**
   * Triggers event-driven prefetch (e.g., on user interaction)
   * Uses shorter delay and force flag
   *
   * @param event - Event name for logging
   */
  public async trigger(event: string): Promise<void> {
    logger.debug('prefetch', 'Prefetch triggered', { event });
    return this.start({ force: false, delay: TRIGGER_PREFETCH_DELAY_MS });
  }
}

/**
 * Global prefetch manager instance
 */
const prefetchManager = new PrefetchManager();

/**
 * Starts FFmpeg prefetch during idle time
 * Call this on app initialization
 *
 * @param options - Prefetch options
 */
/**
 * Checks if FFmpeg is already prefetched
 */
export function isPrefetched(): boolean {
  return prefetchManager.isPrefetched();
}
