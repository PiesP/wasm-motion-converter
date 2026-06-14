// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { ModernGifOptions } from '@services/modern-gif-service';
import { encodeModernGif } from '@services/modern-gif-service';
import type { SerializableImageData } from '@t/worker-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import { expose } from '@utils/worker-rpc';

// Readiness handshake
//
// The main thread may create a worker and immediately call into a Worker RPC-wrapped
// API proxy. If the worker is still loading Worker RPC (dynamic import), it may not
// have attached its message handler yet. In that case, the first RPC message can
// be dropped and the call can hang indefinitely.
//
// To prevent that, the main thread pings `__dropconvertWorkerPing` and waits for
// a `__dropconvertWorkerPong` / `__dropconvertWorkerReady` signal before sending
// any Comlink messages.
let dropconvertWorkerReady = false;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as unknown as {
    __dropconvertWorkerPing?: boolean;
  } | null;
  if (data?.__dropconvertWorkerPing) {
    self.postMessage({
      __dropconvertWorkerPong: dropconvertWorkerReady,
      __dropconvertWorkerNotReady: !dropconvertWorkerReady,
    });
  }
});

/**
 * GIF encoder worker API exposed via Worker RPC
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

      const ProgressThrottleMs = 250;
      let lastForwardedAt = 0;
      let lastForwardedCurrent = -1;

      // Report progress directly via self.postMessage.
      // The main thread can optionally listen for these messages.
      const reportProgress = (current: number, total: number) => {
        const now = performance.now();
        const isTerminal = current >= total;
        if (
          current === lastForwardedCurrent ||
          (!isTerminal && now - lastForwardedAt < ProgressThrottleMs)
        ) {
          return;
        }
        lastForwardedAt = now;
        lastForwardedCurrent = current;
        try {
          self.postMessage({ __gifProgress: true, current, total });
        } catch {
          // Non-fatal: progress reporting should never crash encoding.
        }
      };

      // Convert serializable frames to ImageData
      const imageDataFrames = frameArray.map((frame, index) => {
        if (!frame || frame.width <= 0 || frame.height <= 0) {
          throw new Error(`Invalid frame at index ${index}: invalid dimensions`);
        }

        // Create a copy of the data to ensure it's a regular ArrayBuffer, not SharedArrayBuffer
        const data = new Uint8ClampedArray(frame.data) as Uint8ClampedArray<ArrayBuffer>;
        return new ImageData(data, frame.width, frame.height);
      });

      logger.info('general', 'ImageData frames created, starting modern-gif encode', {
        frameCount: imageDataFrames.length,
        firstFrameDataLength: imageDataFrames[0]?.data?.length,
      });

      const result = await encodeModernGif(imageDataFrames, {
        ...options,
        onProgress: reportProgress,
      });

      logger.info('general', 'GIF encoding completed', {
        frameCount: frameArray.length,
        outputSize: result.size,
      });

      return result;
    } catch (error) {
      const message = getErrorMessage(error);
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

void (async () => {
  expose(api);

  dropconvertWorkerReady = true;
  self.postMessage({ __dropconvertWorkerReady: true });
})();
