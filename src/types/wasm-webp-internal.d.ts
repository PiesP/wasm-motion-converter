// Type declaration for wasm-webp's internal Emscripten factory module.
// wasm-webp does not expose this path in its public types,
// so we provide our own minimal declaration.
declare module 'wasm-webp/dist/esm/webp-wasm.js' {
  interface WasmWebpModule {
    encodeRGB(rgb: Uint8Array, width: number, height: number, quality: number): Uint8Array | null;
    encodeRGBA(rgba: Uint8Array, width: number, height: number, quality: number): Uint8Array | null;
    encode(
      data: Uint8Array,
      width: number,
      height: number,
      hasAlpha: boolean,
      config: { lossless: number; quality: number }
    ): Uint8Array | null;
  }

  /**
   * Emscripten MODULARIZE factory function.
   * Each call returns a Promise that resolves to a new WASM module
   * instance with its own linear memory.
   */
  const ModuleFactory: () => Promise<WasmWebpModule>;
  export default ModuleFactory;
}
