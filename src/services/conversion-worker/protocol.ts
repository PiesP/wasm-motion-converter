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

/** Decode a hex string back to an ArrayBuffer (reverse of arrayBufferToHex) */
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const len = Math.floor(hex.length / 2);
  const buffer = new ArrayBuffer(len);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buffer;
}
