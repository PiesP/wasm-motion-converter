// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { logger } from '@utils/logger';
import {
  WORKER_LOG_MAX_EVENTS,
  WORKER_LOG_MAX_MESSAGE_CHARS,
  type WorkerLogCategory,
  type WorkerLogLevel,
  type WorkerResponse,
} from './types';

/** Create a bounded, request-owned diagnostic relay for one conversion. */
export function createWorkerLogRelay(
  postMessage: (message: WorkerResponse) => void,
  requestId: string
): (
  level: WorkerLogLevel,
  category: WorkerLogCategory,
  message: string,
  localContext?: unknown
) => void {
  let relayedEvents = 0;

  return (level, category, message, localContext) => {
    logger[level](category, message, localContext);
    if (relayedEvents >= WORKER_LOG_MAX_EVENTS || message.length === 0) return;

    const boundedMessage =
      message.length <= WORKER_LOG_MAX_MESSAGE_CHARS
        ? message
        : `${message.slice(0, WORKER_LOG_MAX_MESSAGE_CHARS - 1)}…`;
    relayedEvents++;
    postMessage({ type: 'log', requestId, level, category, message: boundedMessage });
  };
}
