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

import { isRecord } from '@piesp/browser-core/util';
import { isBoundedCodecDescription } from '@services/codec-description';
import type { WorkerRequest, WorkerResponse } from './types';
import { WORKER_LOG_MAX_MESSAGE_CHARS, WORKER_LOG_MAX_REQUEST_ID_CHARS } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const PROFILE_STAGES = ['demuxing', 'transcoding', 'finalizing'] as const;
const WORKER_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const WORKER_LOG_CATEGORIES = ['conversion', 'general', 'demuxer', 'encoders', 'decoders'] as const;

function isProfileStage(value: unknown): value is (typeof PROFILE_STAGES)[number] {
  return typeof value === 'string' && PROFILE_STAGES.some((stage) => stage === value);
}

function isWorkerLogLevel(value: unknown): boolean {
  return typeof value === 'string' && WORKER_LOG_LEVELS.some((level) => level === value);
}

function isWorkerLogCategory(value: unknown): boolean {
  return typeof value === 'string' && WORKER_LOG_CATEGORIES.some((category) => category === value);
}

function isValidStageMetrics(value: unknown): boolean {
  if (!isRecord(value) || !isProfileStage(value.stage)) return false;
  const commonValid = [
    value.startMs,
    value.endMs,
    value.durationMs,
    value.heapStartMB,
    value.heapEndMB,
    value.heapPeakMB,
  ].every(isFiniteNonNegative);
  if (!commonValid) return false;
  if (value.stage === 'demuxing') {
    return [value.framesProcessed, value.fps].every(isFiniteNonNegative);
  }
  if (value.stage === 'transcoding') {
    return (
      value.mode === 'streaming-decode-encode' &&
      value.attribution === 'combined' &&
      [
        value.decodedFrames,
        value.encodedFrames,
        value.decodeFps,
        value.encodeFps,
        value.outputBytes,
        value.throughputMBps,
      ].every(isFiniteNonNegative)
    );
  }
  return true;
}

/** Validate a profiler report crossing the Worker boundary. */
function isValidProfileReport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!isFiniteNonNegative(value.totalDurationMs)) return false;
  if (!isFiniteNonNegative(value.heapStartMB)) return false;
  if (!isFiniteNonNegative(value.heapEndMB)) return false;
  if (!isFiniteNonNegative(value.heapPeakMB)) return false;
  if (
    !Array.isArray(value.stages) ||
    value.stages.length > PROFILE_STAGES.length ||
    !value.stages.every(isValidStageMetrics)
  ) {
    return false;
  }
  const stageNames = value.stages.map((stage) => (stage as Record<string, unknown>).stage);
  if (new Set(stageNames).size !== stageNames.length) return false;
  const stageWallTimePct = value.stageWallTimePct;
  if (!isRecord(stageWallTimePct)) return false;
  if (!PROFILE_STAGES.every((stage) => isFiniteNonNegative(stageWallTimePct[stage]))) {
    return false;
  }
  return (
    (value.dominantStage === null || isProfileStage(value.dominantStage)) &&
    typeof value.summary === 'string'
  );
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
    config.codedHeight > 0 &&
    isBoundedCodecDescription(config.description)
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
    typeof options.maxFrames === 'number' &&
    Number.isFinite(options.maxFrames) &&
    options.maxFrames > 0 &&
    typeof options.maxOutputBytes === 'number' &&
    Number.isFinite(options.maxOutputBytes) &&
    options.maxOutputBytes > 0
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
      if (value.profile !== undefined && !isValidProfileReport(value.profile)) return false;
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
      if (
        typeof value.requestId !== 'string' ||
        value.requestId.length > WORKER_LOG_MAX_REQUEST_ID_CHARS
      ) {
        return false;
      }
      if (!isWorkerLogLevel(value.level)) return false;
      if (!isWorkerLogCategory(value.category)) return false;
      if (!isNonEmptyString(value.message) || value.message.length > WORKER_LOG_MAX_MESSAGE_CHARS) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}
