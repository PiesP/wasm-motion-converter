/**
 * WebP jsquash Encoder Worker
 *
 * Encodes single frames to WebP using @jsquash/webp (libwebp WASM).
 * This provides a reliable WebP encoding fallback when native canvas WebP
 * encoding is unavailable or inconsistent.
 */

import encodeWebP, { init as initWebP } from '@jsquash/webp/encode.js';
import { logger } from '@utils/logger';
import * as Comlink from 'comlink';

// Force Vite/Rollup to emit jsquash encoder WASM files as assets.
// Without this, the Emscripten glue may attempt to fetch a non-existent
// relative URL (often returning index.html), causing a WebAssembly magic-word error.
import webpEncWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpEncSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';

type JsquashWebPEncodeOptions = {
  quality: number;
  method: number;
  lossless?: boolean;
};

let initPromise: Promise<void> | null = null;

async function ensureJsquashInitialized(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    logger.debug('webp-encoder', 'Initializing jsquash WebP encoder WASM', {
      webpEncWasmUrl,
      webpEncSimdWasmUrl,
    });

    // Force Emscripten to fetch the correct URL for whichever variant jsquash selects.
    // (SIMD-capable browsers load webp_enc_simd.wasm; others load webp_enc.wasm)
    await initWebP({
      locateFile: (path: string) => {
        if (path.endsWith('webp_enc_simd.wasm')) {
          return webpEncSimdWasmUrl;
        }

        if (path.endsWith('webp_enc.wasm')) {
          return webpEncWasmUrl;
        }

        return path;
      },
    });
  })();

  return initPromise;
}

const api = {
  async encodeFrame(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    options: JsquashWebPEncodeOptions
  ): Promise<ArrayBuffer> {
    try {
      if (!imageData || !imageData.data || imageData.width <= 0 || imageData.height <= 0) {
        throw new Error('Invalid image data for jsquash WebP encoding');
      }

      await ensureJsquashInitialized();

      const quality = Math.max(0, Math.min(100, Math.round(options.quality)));
      const method = Math.max(0, Math.min(6, Math.round(options.method)));

      // Ensure the backing buffer is an ArrayBuffer (not SharedArrayBuffer) for ImageData typing/runtime.
      const img = new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width,
        imageData.height
      );

      const result = await encodeWebP(img, {
        quality,
        method,
        // jsquash typings model lossless as numeric (0/1)
        lossless: options.lossless ? 1 : 0,
      });

      const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      logger.debug('webp-encoder', 'Frame encoded (jsquash)', {
        width: imageData.width,
        height: imageData.height,
        quality,
        method,
        size: buffer.byteLength,
      });

      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('webp-encoder', 'Frame encoding failed (jsquash)', {
        error: message,
        width: imageData?.width,
        height: imageData?.height,
      });
      throw new Error(`jsquash WebP frame encoding failed: ${message}`);
    }
  },

  terminate(): void {
    logger.debug('webp-encoder', 'Worker terminating (jsquash)');
    self.close();
  },
};

Comlink.expose(api);
