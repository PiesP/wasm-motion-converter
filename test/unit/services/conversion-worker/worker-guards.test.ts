// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import { isWorkerRequest, isWorkerResponse } from '@services/conversion-worker/guards';

describe('isWorkerRequest', () => {
  const validStart = {
    type: 'start',
    requestId: 'req-123',
    inputBuffer: new ArrayBuffer(4),
    config: {
      codec: 'h264',
      codedWidth: 1920,
      codedHeight: 1080,
    },
    options: {
      format: 'webp',
      quality: 'high',
      fps: 30,
      scale: 1.0,
      trimStart: 0,
      trimEnd: 0,
      maxFrames: 500,
    },
  };

  const validAbort = {
    type: 'abort',
    requestId: 'req-456',
  };

  it('accepts valid start message', () => {
    expect(isWorkerRequest(validStart)).toBe(true);
  });

  it('accepts valid abort message', () => {
    expect(isWorkerRequest(validAbort)).toBe(true);
  });

  it('accepts start message with optional duration/framerate', () => {
    const start = { ...validStart, duration: 10, framerate: 30 };
    expect(isWorkerRequest(start)).toBe(true);
  });

  it('rejects null', () => {
    expect(isWorkerRequest(null)).toBe(false);
  });

  it('rejects array', () => {
    expect(isWorkerRequest([validStart])).toBe(false);
  });

  it('rejects primitive (string)', () => {
    expect(isWorkerRequest('start')).toBe(false);
  });

  it('rejects primitive (number)', () => {
    expect(isWorkerRequest(42)).toBe(false);
  });

  it('rejects unknown discriminant', () => {
    expect(isWorkerRequest({ type: 'unknown', requestId: 'x' })).toBe(false);
  });

  it('rejects start without requestId', () => {
    const { requestId: _, ...withoutId } = validStart;
    expect(isWorkerRequest(withoutId)).toBe(false);
  });

  it('rejects start with empty requestId', () => {
    expect(isWorkerRequest({ ...validStart, requestId: '' })).toBe(false);
  });

  it('rejects start without inputBuffer', () => {
    const { inputBuffer: _, ...withoutBuf } = validStart;
    expect(isWorkerRequest(withoutBuf)).toBe(false);
  });

  it('rejects start with non-ArrayBuffer inputBuffer', () => {
    expect(isWorkerRequest({ ...validStart, inputBuffer: 'not-a-buffer' })).toBe(false);
  });

  it('rejects start with missing config', () => {
    const { config: _, ...withoutConfig } = validStart;
    expect(isWorkerRequest(withoutConfig)).toBe(false);
  });

  it('rejects start with invalid config (no codec)', () => {
    const { codec: _, ...configNoCodec } = validStart.config;
    expect(isWorkerRequest({ ...validStart, config: configNoCodec })).toBe(false);
  });

  it('rejects start with NaN codedWidth in config', () => {
    expect(isWorkerRequest({ ...validStart, config: { ...validStart.config, codedWidth: NaN } })).toBe(false);
  });

  it('rejects start with zero codedHeight in config', () => {
    expect(isWorkerRequest({ ...validStart, config: { ...validStart.config, codedHeight: 0 } })).toBe(false);
  });

  it('rejects start with NaN fps in options', () => {
    expect(isWorkerRequest({ ...validStart, options: { ...validStart.options, fps: NaN } })).toBe(false);
  });

  it('rejects start with Infinity scale in options', () => {
    expect(isWorkerRequest({ ...validStart, options: { ...validStart.options, scale: Infinity } })).toBe(false);
  });

  it('rejects start with negative maxFrames in options', () => {
    expect(isWorkerRequest({ ...validStart, options: { ...validStart.options, maxFrames: -1 } })).toBe(false);
  });

  it('rejects start with NaN duration', () => {
    expect(isWorkerRequest({ ...validStart, duration: NaN })).toBe(false);
  });

  it('rejects abort with missing requestId', () => {
    expect(isWorkerRequest({ type: 'abort' })).toBe(false);
  });
});

describe('isWorkerResponse', () => {
  const validProgress = {
    type: 'progress',
    requestId: 'req-123',
    phase: 'encoding',
    percent: 50,
    fps: 24,
    memoryMB: 256,
    etaSeconds: 10,
  };

  const validComplete = {
    type: 'complete',
    requestId: 'req-123',
    outputBuffer: new ArrayBuffer(4),
    durationMs: 5000,
  };

  const validError = {
    type: 'error',
    requestId: 'req-123',
    message: 'Something went wrong',
    code: 'DECODE_ERROR',
  };

  const validLog = {
    type: 'log',
    requestId: '',
    level: 'info',
    message: 'Worker initialized',
  };

  it('accepts valid progress message', () => {
    expect(isWorkerResponse(validProgress)).toBe(true);
  });

  it('accepts valid complete message', () => {
    expect(isWorkerResponse(validComplete)).toBe(true);
  });

  it('accepts valid error message', () => {
    expect(isWorkerResponse(validError)).toBe(true);
  });

  it('accepts valid log message', () => {
    expect(isWorkerResponse(validLog)).toBe(true);
  });

  it('rejects null', () => {
    expect(isWorkerResponse(null)).toBe(false);
  });

  it('rejects array', () => {
    expect(isWorkerResponse([validProgress])).toBe(false);
  });

  it('rejects primitive', () => {
    expect(isWorkerResponse('complete')).toBe(false);
  });

  it('rejects unknown discriminant', () => {
    expect(isWorkerResponse({ type: 'unknown' })).toBe(false);
  });

  it('rejects progress without requestId', () => {
    const { requestId: _, ...withoutId } = validProgress;
    expect(isWorkerResponse(withoutId)).toBe(false);
  });

  it('rejects progress with NaN percent', () => {
    expect(isWorkerResponse({ ...validProgress, percent: NaN })).toBe(false);
  });

  it('rejects progress with Infinity fps', () => {
    expect(isWorkerResponse({ ...validProgress, fps: Infinity })).toBe(false);
  });

  it('rejects complete without outputBuffer', () => {
    const { outputBuffer: _, ...withoutBuf } = validComplete;
    expect(isWorkerResponse(withoutBuf)).toBe(false);
  });

  it('rejects complete with non-ArrayBuffer outputBuffer', () => {
    expect(isWorkerResponse({ ...validComplete, outputBuffer: 'not-a-buffer' })).toBe(false);
  });

  it('rejects error without message', () => {
    const { message: _, ...withoutMsg } = validError;
    expect(isWorkerResponse(withoutMsg)).toBe(false);
  });

  it('rejects error with empty code', () => {
    expect(isWorkerResponse({ ...validError, code: '' })).toBe(false);
  });
});
