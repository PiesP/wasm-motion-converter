import * as Comlink from 'comlink';
import type { ModernGifOptions } from '@services/modern-gif-service';
import { encodeModernGif } from '@services/modern-gif-service';
import type { SerializableImageData } from '@t/worker-types';
import { logger } from '@utils/logger';

/**
 * GIF encoder worker API exposed via Comlink
 *
 * Encodes image frames into an animated GIF in a worker thread.
 * Offloads encoding to avoid blocking the main thread.
 *
 * @example
 * const worker = Comlink.wrap<typeof api>(new Worker('gif-encoder.worker.ts'));
 * const gifBlob = await worker.encode(frames, options);
 */
const api = {
  /**
   * Encode frames into an animated GIF
   *
   * Converts serializable frame data to ImageData and encodes using modern-gif.
   * Handles both single frames and frame arrays transparently.
   *
   * @param frames - Single frame or array of frames to encode
   * @param options - GIF encoding options (quality, delay, etc.)
   * @returns Blob containing encoded GIF data
   * @throws Error if frames are invalid or encoding fails
   *
   * @example
   * const gif = await encode(frameData, {
   *   quality: 10,
   *   delay: [100, 100]
   * });
   */
  async encode(
    frames: SerializableImageData | SerializableImageData[],
    options: ModernGifOptions
  ): Promise<Blob> {
    try {
      // Validate input
      if (!frames) {
        throw new Error('No frames provided for GIF encoding');
      }

      if (!options) {
        throw new Error('Encoding options are required');
      }

      const frameArray = Array.isArray(frames) ? frames : [frames];

      if (frameArray.length === 0) {
        throw new Error('At least one frame is required for GIF encoding');
      }

      logger.info('general', 'GIF encoding started', {
        frameCount: frameArray.length,
        width: frameArray[0]?.width,
        height: frameArray[0]?.height,
        quality: options.quality,
      });

      // Convert serializable frames to ImageData
      const imageDataFrames = frameArray.map((frame, index) => {
        if (!frame || frame.width <= 0 || frame.height <= 0) {
          throw new Error(`Invalid frame at index ${index}: invalid dimensions`);
        }

        // Create a copy of the data to ensure it's a regular ArrayBuffer, not SharedArrayBuffer
        const data = new Uint8ClampedArray(frame.data);
        return new ImageData(data, frame.width, frame.height, {
          colorSpace: frame.colorSpace,
        });
      });

      const result = await encodeModernGif(imageDataFrames, options);

      logger.info('general', 'GIF encoding completed', {
        frameCount: frameArray.length,
        outputSize: result.size,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('general', 'GIF encoding failed', {
        error: message,
        frameCount: Array.isArray(frames) ? frames.length : 1,
      });
      throw error;
    }
  },

  /**
   * Terminate the worker
   *
   * Gracefully shuts down the worker thread. Called automatically
   * when the main thread releases the worker reference.
   */
  terminate(): void {
    logger.info('general', 'GIF encoder worker terminating');
    self.close();
  },
};

Comlink.expose(api);
