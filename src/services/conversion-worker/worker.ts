// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Web Worker entry point for off-main-thread video conversion.
 *
 * This file is the actual Worker script that runs in the Worker thread.
 * It listens for 'start' and 'abort' messages, creates the pipeline,
 * and forwards progress/complete/error responses back to the main thread.
 */

import { getErrorMessage, isCancellationError } from '@piesp/browser-core/error';
import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import {
  OwnedDemuxAbiError,
  OwnedDemuxConversionError,
  OwnedDemuxLoadError,
  OwnedDemuxParseError,
  OwnedDemuxResourceError,
} from '@services/owned-demux-core';

import { classifyWorkerError } from './classify-worker-error';
import { isWorkerRequest } from './guards';
import { runWorkerPipeline } from './pipeline-worker';
import type { OwnedDemuxFailureKind, WorkerResponse } from './types';

function ownedDemuxFailureKind(error: unknown): OwnedDemuxFailureKind | undefined {
  if (error instanceof OwnedDemuxLoadError) return 'load';
  if (error instanceof OwnedDemuxAbiError) return 'abi';
  if (error instanceof OwnedDemuxResourceError) return 'resource';
  if (error instanceof OwnedDemuxParseError) return 'parse';
  if (error instanceof OwnedDemuxConversionError) return 'conversion';
  return undefined;
}

// The pipeline owns realm-wide buffer and canvas resources until it settles.
let activeConversion: { requestId: string; controller: AbortController } | undefined;

// ─── Message handler ────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<unknown>) => {
  // Defense-in-depth: validate the message source.
  // Same-origin Workers have event.origin === '' and event.source === null
  // (the worker receives messages via its own MessagePort, not a cross-origin
  // postMessage). A non-null event.source would indicate a cross-context
  // message (e.g., from a different window or iframe), which we reject.
  // The old check (event.origin !== '' && event.origin !== self.location.origin)
  // was ineffective because same-origin workers always have empty origin,
  // making the first condition always false and the check always pass.
  if (event.source !== null && event.source !== self) {
    return;
  }

  // Runtime guard: narrow the untrusted payload before accessing request fields.
  // A recognizable start request receives an immediate protocol error so the
  // caller does not wait for the proxy timeout when numeric fields are invalid.
  if (!isWorkerRequest(event.data)) {
    const requestId = getInvalidStartRequestId(event.data);
    if (requestId !== null && requestId !== activeConversion?.requestId) {
      self.postMessage({
        type: 'error',
        requestId,
        message: 'Invalid conversion worker request',
        code: 'INVALID_REQUEST',
      } satisfies WorkerResponse);
    }
    return;
  }

  const request = event.data;

  switch (request.type) {
    case 'start': {
      const { requestId, config, options, duration, framerate, indexSnapshot } = request;
      if (activeConversion) {
        // A second terminal response for this ID would be attributed to its owner.
        if (requestId === activeConversion.requestId) return;
        self.postMessage({
          type: 'error',
          requestId,
          message: 'Conversion worker is busy',
          code: 'BUSY',
        } satisfies WorkerResponse);
        return;
      }
      const input = request.inputBlob ?? request.inputBuffer;
      const pipelineStart = performance.now();

      const abortController = new AbortController();
      activeConversion = { requestId, controller: abortController };

      // Prepare postMessage helper with response encoding
      const respond = (msg: WorkerResponse, transferables?: Transferable[]) => {
        if (abortController.signal.aborted && msg.type !== 'error') return;
        self.postMessage(msg, transferables ?? []);
      };

      try {
        const { outputBuffer, profile } = await runWorkerPipeline(
          input,
          options,
          respond,
          requestId,
          abortController.signal,
          config,
          duration,
          framerate,
          indexSnapshot
        );
        abortController.signal.throwIfAborted();

        const durationMs = Math.round(performance.now() - pipelineStart);

        // Send completion with transferred output buffer
        respond(
          {
            type: 'complete',
            requestId,
            outputBuffer,
            durationMs,
            ...(profile ? { profile } : {}),
          },
          [outputBuffer]
        );
      } catch (err) {
        const message = getErrorMessage(err);
        const cancelled = abortController.signal.aborted || isCancellationError(err);
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        // Cancellation and actual timeouts are terminal even if another error is present.
        const demuxFailureKind = cancelled || timedOut ? undefined : ownedDemuxFailureKind(err);
        const code = cancelled
          ? 'CANCELLED'
          : timedOut
            ? 'TIMEOUT'
            : err instanceof ConversionMemoryLimitError
              ? err.code
              : demuxFailureKind === 'resource'
                ? 'OUT_OF_MEMORY'
                : demuxFailureKind !== undefined
                  ? 'DECODER_ERROR'
                  : classifyWorkerError(message);

        respond({
          type: 'error',
          requestId,
          message,
          code,
          ...(demuxFailureKind ? { demuxFailureKind } : {}),
        });
      } finally {
        activeConversion = undefined;
      }
      break;
    }

    case 'abort': {
      if (activeConversion?.requestId === request.requestId) activeConversion.controller.abort();
      break;
    }

    default: {
      // Exhaustive check — all request types should be handled above
      const _exhaustiveCheck: never = request;
      void _exhaustiveCheck;
      break;
    }
  }
};

// Instance-scoped readiness is a control event, separate from request logs.
self.postMessage({ type: 'ready', requestId: '' } satisfies WorkerResponse);
self.postMessage({
  type: 'log',
  requestId: '',
  level: 'info',
  category: 'general',
  message: 'Worker initialized',
} satisfies WorkerResponse);

function getInvalidStartRequestId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'start' &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0
    ? candidate.requestId
    : null;
}
