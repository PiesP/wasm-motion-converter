// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WASM WebP Module Singleton
 *
 * wasm-webp's encodeRGB() creates a new Emscripten MODULARIZE WASM instance
 * on every call (webp-wasm.js -> Module() factory).  Each instantiation
 * allocates fresh WASM linear memory (~16MB+), initializes the runtime,
 * and runs preRun/postRun hooks.  For a 300-frame video this means
 * 300 WASM instantiations, causing unnecessary GC pressure and
 * per-frame module-init overhead.
 *
 * This module wraps the factory in a lazy singleton: Module() is called
 * once and the same instance is reused for every encode.  Callers
 * MUST copy the returned bitstream before calling encode again -
 * the Uint8Array is a view into the shared WASM memory and will be
 * invalidated by the next encode.
 *
 * IMPORTANT: This imports the internal webp-wasm.js factory directly
 * (not wasm-webp's public API) because the public encodeRGB() wraps
 * the factory internally and creates a new instance on every call.
 */

interface WasmWebpInstance {
  encodeRGB(rgb: Uint8Array, width: number, height: number, quality: number): Uint8Array | null;
}

let cachedModule: WasmWebpInstance | null = null;
let initPromise: Promise<WasmWebpInstance> | null = null;

async function getModule(): Promise<WasmWebpInstance> {
  if (cachedModule) return cachedModule;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamic import reaches into wasm-webp's internal Emscripten module.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod: { default: () => Promise<WasmWebpInstance> } = await import(
      'wasm-webp/dist/esm/webp-wasm.js'
    );
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error('wasm-webp default export is not a factory function');
    }
    cachedModule = await factory();
    return cachedModule;
  })();

  return initPromise;
}

/**
 * Encode an RGB frame to WebP using the cached WASM module.
 *
 * IMPORTANT: The returned Uint8Array is a view into the shared WASM
 * memory buffer.  The caller MUST copy the data (or extract the VP8
 * bitstream) before the next call, because the next encode will
 * overwrite the same memory region.
 */
export async function encodeRGBReuse(
  rgb: Uint8Array,
  width: number,
  height: number,
  quality = 100
): Promise<Uint8Array | null> {
  const module = await getModule();
  const q = Math.min(100, Math.max(0, quality));
  return module.encodeRGB(rgb, width, height, q);
}

/**
 * Release the cached WASM module and free its linear memory (~16MB+).
 * Call after conversion completes to reduce idle memory usage.
 */
export function releaseWasmModule(): void {
  cachedModule = null;
  initPromise = null;
}
