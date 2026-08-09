// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

export interface EnvironmentCapabilitySource {
  VideoDecoder?: unknown;
  VideoFrame?: unknown;
  WebAssembly?: unknown;
  SharedArrayBuffer?: unknown;
  crossOriginIsolated?: unknown;
}

export interface EnvironmentCapabilities {
  hasWebCodecs: boolean;
  hasWebAssembly: boolean;
  hasSharedArrayBuffer: boolean;
  isCrossOriginIsolated: boolean;
  isSupported: boolean;
}

/**
 * Assess APIs required by the current conversion pipeline.
 *
 * SharedArrayBuffer and cross-origin isolation are reported for diagnostics,
 * but the bundled encoders do not use WASM threads, so they are not blockers.
 */
export function assessEnvironmentCapabilities(
  source: EnvironmentCapabilitySource = globalThis
): EnvironmentCapabilities {
  const hasWebCodecs =
    typeof source.VideoDecoder === 'function' && typeof source.VideoFrame === 'function';
  const hasWebAssembly = typeof source.WebAssembly === 'object' && source.WebAssembly !== null;
  const hasSharedArrayBuffer = typeof source.SharedArrayBuffer === 'function';
  const isCrossOriginIsolated = source.crossOriginIsolated === true;

  return {
    hasWebCodecs,
    hasWebAssembly,
    hasSharedArrayBuffer,
    isCrossOriginIsolated,
    isSupported: hasWebCodecs && hasWebAssembly,
  };
}
