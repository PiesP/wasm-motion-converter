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
