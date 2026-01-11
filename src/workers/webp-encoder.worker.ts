import * as Comlink from 'comlink';
import { logger } from '@utils/logger';

/**
 * WebP encoder worker API interface
 *
 * @remarks
 * WebP encoding is currently handled via FFmpeg in the main conversion service.
 * This worker interface is retained for potential future use with alternative
 * WebP encoders (e.g., libwebp-wasm or other optimized implementations).
 *
 * @example
 * const worker = Comlink.wrap<WebPEncoderWorkerAPI>(new Worker(...));
 * // Currently throws as encoding is handled in main service
 */
interface WebPEncoderWorkerAPI {
  /**
   * Encode frames to WebP format
   *
   * @remarks
   * This method is not yet implemented. WebP encoding is currently handled
   * by the FFmpeg service in the main thread for stability and compatibility.
   *
   * @returns Promise that rejects with informative error message
   * @throws {Error} Always throws as feature is not implemented
   *
   * @see {@link https://github.com/GoogleChromeLabs/libwebp-wasm} libwebp-wasm
   */
  encode(): Promise<Blob>;

  /**
   * Terminate the worker and clean up resources
   *
   * @remarks
   * Stops the worker execution and closes the worker context.
   * Must be called when the worker is no longer needed to prevent
   * memory leaks and free up thread resources.
   */
  terminate(): void;
}

/**
 * WebP encoder worker API implementation
 *
 * @remarks
 * Currently a placeholder that delegates to FFmpeg in the main service.
 * The worker infrastructure is preserved for future enhancement when
 * alternative WebP encoders become available or needed.
 */
const api: WebPEncoderWorkerAPI = {
  async encode(): Promise<Blob> {
    const errorMessage = 'WebP encoding is currently handled via FFmpeg in the main service';

    logger.info('general', 'WebP encoder worker received encode request', {
      note: 'Feature not yet implemented in worker',
    });

    const error = new Error(errorMessage);
    logger.error('general', 'WebP encoding requested but not available in worker', {
      error: errorMessage,
    });

    throw error;
  },

  terminate(): void {
    logger.info('general', 'WebP encoder worker terminating');
    self.close();
  },
};

// Expose API via Comlink for main thread communication
Comlink.expose(api);
