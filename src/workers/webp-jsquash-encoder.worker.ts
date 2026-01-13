/**
 * WebP jsquash Encoder Worker
 *
 * Encodes single frames to WebP using @jsquash/webp (libwebp WASM).
 * This provides a reliable WebP encoding fallback when native canvas WebP
 * encoding is unavailable or inconsistent.
 *
 * NOTE: To keep the worker bundle free of vendor code, both Comlink and jsquash
 * are loaded from CDN (esm.sh) at runtime.
 */

import { logger } from '@utils/logger';
import { esmShAssetUrl, esmShModuleUrl } from 'virtual:cdn-deps';

type ComlinkModule = typeof import('comlink');
type JsquashWebPModule = typeof import('@jsquash/webp/encode.js');

let cachedComlink: ComlinkModule | null = null;
let cachedJsquash: JsquashWebPModule | null = null;

async function loadComlink(): Promise<ComlinkModule> {
  if (cachedComlink) {
    return cachedComlink;
  }

  const url = esmShModuleUrl('comlink');
  cachedComlink = (await import(/* @vite-ignore */ url)) as unknown as ComlinkModule;
  return cachedComlink;
}

async function loadJsquash(): Promise<JsquashWebPModule> {
  if (cachedJsquash) {
    return cachedJsquash;
  }

  const url = esmShModuleUrl('@jsquash/webp', '/encode.js');
  cachedJsquash = (await import(/* @vite-ignore */ url)) as unknown as JsquashWebPModule;
  return cachedJsquash;
}

// Resolve WASM assets directly from CDN (no Vite-emitted assets).
const webpEncWasmUrl = esmShAssetUrl('@jsquash/webp', '/codec/enc/webp_enc.wasm');
const webpEncSimdWasmUrl = esmShAssetUrl('@jsquash/webp', '/codec/enc/webp_enc_simd.wasm');

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

    const jsquash = await loadJsquash();

    if (typeof jsquash.init !== 'function') {
      throw new Error('jsquash WebP module loaded but init() export is missing');
    }

    // Force Emscripten to fetch the correct URL for whichever variant jsquash selects.
    // (SIMD-capable browsers load webp_enc_simd.wasm; others load webp_enc.wasm)
    await jsquash.init({
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

      const jsquash = await loadJsquash();
      const encodeWebP = jsquash.default;
      if (typeof encodeWebP !== 'function') {
        throw new Error('jsquash WebP module loaded but default export is not a function');
      }

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

void (async () => {
  const Comlink = await loadComlink();
  Comlink.expose(api);
})();
