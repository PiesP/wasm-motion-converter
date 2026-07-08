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
