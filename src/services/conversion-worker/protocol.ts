// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Protocol helpers for serializing/deserializing worker messages.
 *
 * Handles:
 * - encodeRequest / decodeResponse helpers with Transferable extraction
 * - Chunked ArrayBuffer serialization for EncodedVideoChunk
 * (EncodedVideoChunk cannot be structured-cloned, so we use copyTo() pattern)
 */

import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

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
  return hexToArrayBuffer(config.description); // eslint-disable-line
}

// ─── Hex helpers for DataView description ────────────────────────────────

/** Encode a DataView/ArrayBuffer to a hex string for structured clone compatibility */
export function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += bytes[i]!.toString(16).padStart(2, '0');
  }
  return result;
}

/** Decode a hex string back to an ArrayBuffer */
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16) as number;
  }
  return bytes.buffer;
}

// ─── Request encoding/decoding ──────────────────────────────────────────

/**
 * Prepare a WorkerRequest for posting.
 * Returns the message and the list of Transferables to pass to postMessage.
 */
export function encodeRequest(request: WorkerRequest): {
  message: WorkerRequest;
  transferables: Transferable[];
} {
  const transferables = extractTransferables(request);
  return { message: request, transferables };
}

/**
 * Prepare a WorkerResponse for posting back to the main thread.
 * The outputBuffer (on 'complete') is transferred, not copied.
 */
export function encodeResponse(response: WorkerResponse): {
  message: WorkerResponse;
  transferables: Transferable[];
} {
  if (response.type === 'complete') {
    return { message: response, transferables: [response.outputBuffer] };
  }
  return { message: response, transferables: [] };
}

// ─── EncodedVideoChunk serialization ────────────────────────────────────

/**
 /** Serializable representation of an EncodedVideoChunk.
  * EncodedVideoChunk cannot be structured-cloned, so we serialize
  * the data and metadata, then recreate it on the worker side.
  */
export interface SerializedEncodedVideoChunk {
  /** Chunk data as ArrayBuffer (will be transferred) */
  data: ArrayBuffer;
  type: 'key' | 'delta';
  /** Timestamp in microseconds (chunk.timestamp) */
  timestamp: number;
  /** Duration in microseconds, if known (chunk.duration ?? null) */
  duration: number | null;
}

/**
 * Serializes an EncodedVideoChunk for transfer to a worker.
 * Copies chunk data into a new ArrayBuffer, then wraps it back
 * as an EncodedVideoChunk with the original metadata.
 */
export function serializeEncodedVideoChunk(chunk: EncodedVideoChunk): SerializedEncodedVideoChunk {
  // Copy chunk data — chunk.data lives in WebCodecs internal memory
  // that cannot be transferred. We extract bytes via copyTo().
  const buffer = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(buffer);

  return {
    data: buffer,
    type: chunk.type,
    timestamp: chunk.timestamp,
    duration: chunk.duration ?? null,
  };
}

/**
 * Recreates an EncodedVideoChunk from serialized data.
 * Use this in the worker to restore chunks after message receipt.
 */
export function recreateEncodedVideoChunk(
  serialized: SerializedEncodedVideoChunk
): EncodedVideoChunk {
  const options: EncodedVideoChunkInit = {
    data: serialized.data,
    type: serialized.type as EncodedVideoChunkType,
    timestamp: serialized.timestamp,
    ...(serialized.duration !== null ? { duration: serialized.duration } : {}),
  };
  return new EncodedVideoChunk(options);
}

// ─── DemuxResult serialization ───────────────────────────────────────────

/** Serializable DemuxResult for worker transfer */
export interface SerializedDemuxConfig extends SerializedDecoderConfig {
  /** Optional base64-encoded decoder description (for Annex B codecs) */
  decoderDescription?: string;
}

/**
 * Restores VideoDecoderConfig from SerializedDecoderConfig.
 */
export function restoreVideoDecoderConfig(serialized: SerializedDecoderConfig): VideoDecoderConfig {
  const config: VideoDecoderConfig = {
    codec: serialized.codec,
    codedWidth: serialized.codedWidth,
    codedHeight: serialized.codedHeight,
    ...(serialized.hardwareAcceleration
      ? {
          hardwareAcceleration:
            serialized.hardwareAcceleration as VideoDecoderConfig['hardwareAcceleration'],
        }
      : {}),
  };
  // description is non-null ArrayBuffer if present (safe for AllowSharedBufferSource)
  if (serialized.description) {
    const descBuf: ArrayBuffer = hexToArrayBuffer(serialized.description);
    (config as VideoDecoderConfig & { description: ArrayBuffer }).description = descBuf;
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
  return config;
}

// ─── ConversionOptions from Serialized form ─────────────────────────────

/**
 * Restores full conversion options from the worker request.
 * Maps the SerializedConversionOptions back to request fields.
 */
export function restoreConversionOptions(options: SerializedConversionOptions): {
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;
  trimStart: number;
  trimEnd: number;
  forceDecimation: number;
  smartFrameSkip: 'off' | 'low' | 'medium' | 'high';
} {
  return {
    format: options.format,
    quality: options.quality,
    scale: options.scale,
    trimStart: options.trimStart,
    trimEnd: options.trimEnd,
    forceDecimation: 1, // fps is already baked into decimation, no need for separate
    smartFrameSkip: 'off',
  };
}
