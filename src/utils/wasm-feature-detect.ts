// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebAssembly feature detection for performance optimization.
 *
 * Detects SIMD and other WASM features to guide FFmpeg core selection
 * and log performance-relevant environment info.
 */

/**
 * Detect WebAssembly SIMD support.
 *
 * Uses the WebAssembly feature detection API when available,
 * with a fallback to compiling a small SIMD test module.
 *
 * @returns true if SIMD is supported
 */
export async function detectWasmSimd(): Promise<boolean> {
  // Use the feature detection API if available (modern browsers)
  if (typeof WebAssembly.validate === 'function') {
    // SIMD proposal: v128 type + i8x16.shuffle instruction
    // This is a minimal SIMD-enabled module (empty function with v128 param)
    const simdTest = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d, // magic "\0asm"
      0x01,
      0x00,
      0x00,
      0x00, // version 1
      0x01,
      0x05,
      0x01,
      0x60,
      0x01,
      0x7b,
      0x00, // type section: (func (param v128))
      0x03,
      0x02,
      0x01,
      0x00, // func section: 1 func, type 0
      0x0a,
      0x07,
      0x01,
      0x05,
      0x00,
      0xfd,
      0x0f,
      0x0b, // code section: nop + i8x16.shuffle + end
    ]);
    try {
      return WebAssembly.validate(simdTest);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Get a summary of WASM capabilities for logging.
 */
export async function getWasmCapabilities(): Promise<{
  simd: boolean;
  threads: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}> {
  const simd = await detectWasmSimd();
  const threads = typeof SharedArrayBuffer !== 'undefined';
  const sharedArrayBuffer = threads;
  const isCrossOriginIsolated =
    typeof (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      'boolean' &&
    (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated === true;

  return { simd, threads, sharedArrayBuffer, crossOriginIsolated: isCrossOriginIsolated };
}
