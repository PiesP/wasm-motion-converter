// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Runtime guards for WorkerRequest and WorkerResponse message types.
 *
 * These validate messages at the Worker boundary before they are cast to
 * TypeScript types. Without these guards, malformed messages (null, arrays,
 * primitives, NaN/Infinity values, missing required fields) would pass
 * through the type cast and cause unexpected behavior or crashes.
 */

import type { WorkerRequest, WorkerResponse } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate SerializedDecoderConfig fields from unknown record */
function isValidDecoderConfig(config: unknown): config is Record<string, unknown> {
  if (!isRecord(config)) return false;
  return (
    isNonEmptyString(config.codec) &&
    typeof config.codedWidth === 'number' &&
    Number.isFinite(config.codedWidth) &&
    config.codedWidth > 0 &&
    typeof config.codedHeight === 'number' &&
    Number.isFinite(config.codedHeight) &&
    config.codedHeight > 0
  );
}

/** Validate SerializedConversionOptions fields from unknown record */
function isValidConversionOptions(options: unknown): options is Record<string, unknown> {
  if (!isRecord(options)) return false;
  return (
    isNonEmptyString(options.format) &&
    isNonEmptyString(options.quality) &&
    typeof options.fps === 'number' &&
    Number.isFinite(options.fps) &&
    options.fps > 0 &&
    typeof options.scale === 'number' &&
    Number.isFinite(options.scale) &&
    options.scale > 0 &&
    isFiniteNonNegative(options.trimStart) &&
    isFiniteNonNegative(options.trimEnd) &&
    isFiniteNonNegative(options.maxFrames)
  );
}

// ── Public guards ─────────────────────────────────────────────────────────

/**
 * Validate an incoming message to the conversion worker as a WorkerRequest.
 * Rejects null, arrays, primitives, unknown discriminants, and messages
 * missing required fields.
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case 'start': {
      if (!isNonEmptyString(value.requestId)) return false;
      if (!(value.inputBuffer instanceof ArrayBuffer)) return false;
      if (!isValidDecoderConfig(value.config)) return false;
      if (!isValidConversionOptions(value.options)) return false;
      // Optional pre-computed metadata
      if (value.duration !== undefined && !isFiniteNonNegative(value.duration)) return false;
      if (value.framerate !== undefined && !isFiniteNumber(value.framerate)) return false;
      return true;
    }
    case 'abort': {
      return isNonEmptyString(value.requestId);
    }
    default:
      return false;
  }
}

/**
 * Validate an outgoing message from the conversion worker as a WorkerResponse.
 * Rejects null, arrays, primitives, unknown discriminants, and messages
 * missing required fields.
 */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case 'progress': {
      if (!isNonEmptyString(value.requestId)) return false;
      if (!isNonEmptyString(value.phase)) return false;
      if (!isFiniteNumber(value.percent)) return false;
      if (!isFiniteNonNegative(value.fps)) return false;
      if (typeof value.memoryMB !== 'number') return false;
      if (!isFiniteNumber(value.etaSeconds)) return false;
      return true;
    }
    case 'complete': {
      if (!isNonEmptyString(value.requestId)) return false;
      if (!(value.outputBuffer instanceof ArrayBuffer)) return false;
      if (!isFiniteNonNegative(value.durationMs)) return false;
      return true;
    }
    case 'error': {
      if (!isNonEmptyString(value.requestId)) return false;
      if (!isNonEmptyString(value.message)) return false;
      if (!isNonEmptyString(value.code)) return false;
      return true;
    }
    case 'log': {
      // requestId can be empty string for worker init log
      if (typeof value.requestId !== 'string') return false;
      if (!isNonEmptyString(value.level)) return false;
      if (!isNonEmptyString(value.message)) return false;
      return true;
    }
    default:
      return false;
  }
}
