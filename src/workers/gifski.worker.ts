/**
 * Gifski Worker (stub)
 *
 * Placeholder worker for high-quality GIF encoding.
 *
 * Message schema: see `@t/video-pipeline-types`.
 */

import type { WorkerRequest, WorkerResponse } from '@t/video-pipeline-types';

const postError = (requestId: string, error: unknown): void => {
  const payload: WorkerResponse = {
    type: 'error',
    payload: {
      requestId,
      error: {
        message: error instanceof Error ? error.message : 'Unknown worker error',
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
    },
  };

  self.postMessage(payload);
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'probe':
      case 'decode':
      case 'encode': {
        const response: WorkerResponse = {
          type: 'error',
          payload: {
            requestId: message.payload.requestId,
            error: {
              message: 'gifski.worker.ts is not implemented yet.',
              name: 'NotImplementedError',
            },
          },
        };
        self.postMessage(response);
        return;
      }
      default: {
        postError('unknown', new Error('Unknown message type'));
      }
    }
  } catch (error) {
    postError(message.payload.requestId, error);
  }
};
