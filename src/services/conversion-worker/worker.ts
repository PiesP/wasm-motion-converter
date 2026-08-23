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
import { classifyWorkerError } from './classify-worker-error';
import { isWorkerRequest } from './guards';
import { runWorkerPipeline } from './pipeline-worker';
import type { WorkerResponse } from './types';

// ─── AbortController registry ────────────────────────────────────────────

const activeControllers = new Map<string, AbortController>();

// ─── Message handler ────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
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

  // Runtime guard: validate message shape before casting to WorkerRequest.
  // A recognizable start request receives an immediate protocol error so the
  // caller does not wait for the proxy timeout when numeric fields are invalid.
  if (!isWorkerRequest(event.data)) {
    const requestId = getInvalidStartRequestId(event.data);
    if (requestId !== null) {
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
      const { requestId, inputBuffer, config, options, duration, framerate } = request;
      const pipelineStart = performance.now();

      // Create AbortController for this conversion
      const abortController = new AbortController();
      activeControllers.set(requestId, abortController);

      // Prepare postMessage helper with response encoding
      const respond = (msg: WorkerResponse, transferables?: Transferable[]) => {
        self.postMessage(msg, transferables ?? []);
      };

      try {
        const { outputBuffer, profile } = await runWorkerPipeline(
          inputBuffer,
          options,
          respond,
          requestId,
          abortController.signal,
          config,
          duration,
          framerate
        );

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
        // Classify error using the same compact rules as pipeline-worker.ts
        const code = isCancellationError(err) ? 'CANCELLED' : classifyWorkerError(message);

        respond({
          type: 'error',
          requestId,
          message,
          code,
        });
      } finally {
        activeControllers.delete(requestId);
      }
      break;
    }

    case 'abort': {
      const controller = activeControllers.get(request.requestId);
      if (controller) {
        controller.abort();
        activeControllers.delete(request.requestId);
      }
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

// Ready signal for the main thread
self.postMessage({ type: 'log', requestId: '', level: 'info', message: 'Worker initialized' });

function getInvalidStartRequestId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'start' &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0
    ? candidate.requestId
    : null;
}
