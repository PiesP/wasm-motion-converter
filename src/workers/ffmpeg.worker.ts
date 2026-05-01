/**
 * FFmpeg Worker (stub — intentionally unimplemented)
 *
 * The main-thread FFmpegPipeline is used for all FFmpeg operations.
 * This worker exists as a placeholder for a future off-main-thread
 * FFmpeg path and MUST NOT be used until fully implemented.
 *
 * If this worker is accidentally referenced, it will:
 *  1. Log a console warning once.
 *  2. Respond to every message with a clear NotImplementedError.
 *
 * Message schema: see `@t/video-pipeline-types`.
 */

import type { WorkerRequest, WorkerResponse } from '@t/video-pipeline-types';

let warningPosted = false;

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

const postNotImplemented = (requestId: string): void => {
  if (!warningPosted) {
    warningPosted = true;
    console.warn(
      '[ffmpeg.worker] This worker is a stub and must not be used. ' +
      'All FFmpeg operations should go through the main-thread FFmpegPipeline. ' +
      'If you intended to use a worker-based FFmpeg path, implement this worker first.'
    );
  }

  postError(requestId, {
    message:
      'ffmpeg.worker.ts is a stub and is not implemented. ' +
      'Use the main-thread FFmpegPipeline instead.',
    name: 'NotImplementedError',
  });
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'probe':
      case 'decode':
      case 'encode': {
        postNotImplemented(message.payload.requestId);
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
