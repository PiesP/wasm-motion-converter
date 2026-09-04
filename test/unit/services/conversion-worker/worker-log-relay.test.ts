// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@utils/logger', () => ({ logger }));

import { createWorkerLogRelay } from '@services/conversion-worker/worker-log-relay';
import { WORKER_LOG_MAX_EVENTS, WORKER_LOG_MAX_MESSAGE_CHARS } from '@services/conversion-worker/types';

describe('createWorkerLogRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves local diagnostics while bounding relayed event count and message size', () => {
    const postMessage = vi.fn();
    const relay = createWorkerLogRelay(postMessage, 'request-1');

    relay('info', 'conversion', 'x'.repeat(WORKER_LOG_MAX_MESSAGE_CHARS + 10), {
      localOnly: true,
    });
    for (let index = 1; index <= WORKER_LOG_MAX_EVENTS; index++) {
      relay('info', 'conversion', `checkpoint-${index}`);
    }

    expect(logger.info).toHaveBeenCalledTimes(WORKER_LOG_MAX_EVENTS + 1);
    expect(postMessage).toHaveBeenCalledTimes(WORKER_LOG_MAX_EVENTS);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'request-1',
      level: 'info',
      category: 'conversion',
    });
    expect(postMessage.mock.calls[0]?.[0].message).toHaveLength(WORKER_LOG_MAX_MESSAGE_CHARS);
  });
});
