// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Protocol helpers for serializing/deserializing worker messages.
 *
 * Handles:
 * - Transferable extraction for worker postMessage
 * - Hex encoding/decoding for Annex B codec descriptions
 * - VideoDecoderConfig restoration from serialized form
 */

import type { SerializedDecoderConfig, WorkerRequest } from './types.js';

// ─── Transferable helpers ────────────────────────────────────────────────

/**
 * Extracts all Transferables from a 'start' request.
 * The inputBuffer is the primary transferable — it's moved (not copied) to the worker.
 */
export function extractTransferables(request: WorkerRequest): Transferable[] {
  if (request.type === 'start') {
    // Check if description exists (it's a DataView/ArrayBuffer for Annex B codecs)
    const description = extractDescriptionFromConfig(request.config);
    const transferables: Transferable[] = [request.inputBuffer];
    if (description) {
      transferables.push(description);
    }
    return transferables;
  }
  return [];
}

/**
 * Extracts the description buffer from config, if present.
 * For Annex-B codecs (e.g. H.264), the description contains the SPS/PPS.
 * We need to transfer it separately since it's part of the decoder config
 * but was extracted before serialization.
 */
export function extractDescriptionFromConfig(config: SerializedDecoderConfig): ArrayBuffer | null {
  if (!config.description) return null;
  // description is a hex-encoded string of the original DataView bytes
  return hexToArrayBuffer(config.description);
}

// ─── Hex helpers for DataView description ────────────────────────────────

/** Encode a DataView/ArrayBuffer to a hex string for structured clone compatibility */
export function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a hex string back to an ArrayBuffer */
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string: odd length (${hex.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hexadecimal characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16) as number;
  }
  return bytes.buffer;
}

// ─── VideoDecoderConfig restoration ──────────────────────────────────

/**
 * Restores VideoDecoderConfig from SerializedDecoderConfig.
 */
export function restoreVideoDecoderConfig(serialized: SerializedDecoderConfig): VideoDecoderConfig {
  const config: Record<string, unknown> = {
    codec: serialized.codec,
    codedWidth: serialized.codedWidth,
    codedHeight: serialized.codedHeight,
  };
  if (serialized.hardwareAcceleration) {
    config.hardwareAcceleration = serialized.hardwareAcceleration;
  }
  // description is non-null ArrayBuffer if present (safe for AllowSharedBufferSource)
  if (serialized.description) {
    const descBuf: ArrayBuffer = hexToArrayBuffer(serialized.description);
    config.description = descBuf as ArrayBuffer;
  }
  // displayAspectWidth/Height are non-standard (mediabunny extension)
  if (serialized.displayAspectWidth && serialized.displayAspectHeight) {
    const extended = config as unknown as {
      displayAspectWidth?: number;
      displayAspectHeight?: number;
    };
    extended.displayAspectWidth = serialized.displayAspectWidth;
    extended.displayAspectHeight = serialized.displayAspectHeight;
  }
  return config as unknown as VideoDecoderConfig;
}
