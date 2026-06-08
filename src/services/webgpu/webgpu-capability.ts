// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebGPU capability detection.
 *
 * WebGPU enables GPU-accelerated compute shaders for tasks like
 * palette generation and dithering. This module provides a cached
 * capability check for feature-gating WebGPU-dependent code paths.
 *
 * Current browser support (2026): Chrome 113+, Edge 113+, Opera 99+
 * Limited/None: Firefox (nightly flag), Safari (Technology Preview)
 */

interface WebGPUCapability {
  supported: boolean;
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  } | null;
}

let cachedCapability: WebGPUCapability | null = null;

/**
 * Detect WebGPU support. Result is cached for the page lifetime.
 *
 * The first call requests a GPUAdapter; subsequent calls return
 * the cached result without additional GPU interaction.
 */
export async function detectWebGPU(): Promise<WebGPUCapability> {
  if (cachedCapability) return cachedCapability;

  if (!('gpu' in navigator)) {
    cachedCapability = { supported: false, adapterInfo: null };
    return cachedCapability;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      cachedCapability = { supported: false, adapterInfo: null };
      return cachedCapability;
    }

    cachedCapability = {
      supported: true,
      adapterInfo: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
    };
    return cachedCapability;
  } catch {
    cachedCapability = { supported: false, adapterInfo: null };
    return cachedCapability;
  }
}

/**
 * Synchronous check — returns true only if a prior detectWebGPU() call
 * confirmed support. Does not trigger adapter request.
 */
export function isWebGPUSupported(): boolean {
  return cachedCapability?.supported === true;
}
