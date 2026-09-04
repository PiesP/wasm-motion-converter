// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import { isWorkerRequest, isWorkerResponse } from '@services/conversion-worker/guards';
import { MAX_CODEC_DESCRIPTION_BYTES } from '@utils/constants';

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
      maxOutputBytes: 1024,
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

  it('accepts a bounded binary codec description', () => {
    const config = { ...validStart.config, description: new ArrayBuffer(32) };
    expect(isWorkerRequest({ ...validStart, config })).toBe(true);
  });

  it('rejects text or oversized codec descriptions', () => {
    expect(
      isWorkerRequest({ ...validStart, config: { ...validStart.config, description: '00' } })
    ).toBe(false);
    expect(
      isWorkerRequest({
        ...validStart,
        config: {
          ...validStart.config,
          description: new ArrayBuffer(MAX_CODEC_DESCRIPTION_BYTES + 1),
        },
      })
    ).toBe(false);
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

  it('rejects start with missing maxOutputBytes in options', () => {
    const { maxOutputBytes: _, ...withoutMaxOutputBytes } = validStart.options;
    expect(isWorkerRequest({ ...validStart, options: withoutMaxOutputBytes })).toBe(false);
  });

  it('rejects start with non-positive maxOutputBytes in options', () => {
    expect(
      isWorkerRequest({
        ...validStart,
        options: { ...validStart.options, maxOutputBytes: 0 },
      })
    ).toBe(false);
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

  const validProfile = {
    schemaVersion: 2,
    totalDurationMs: 5000,
    heapStartMB: 0,
    heapEndMB: 0,
    heapPeakMB: 0,
    stages: [
      {
        stage: 'demuxing',
        startMs: 0,
        endMs: 10,
        durationMs: 10,
        heapStartMB: 0,
        heapEndMB: 0,
        heapPeakMB: 0,
        framesProcessed: 30,
        fps: 3000,
      },
    ],
    stageWallTimePct: { demuxing: 0.2, transcoding: 0, assembling: 0 },
    dominantStage: 'demuxing',
    summary: '[5000ms total]',
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
    category: 'general',
    message: 'Worker initialized',
  };

  it('accepts valid progress message', () => {
    expect(isWorkerResponse(validProgress)).toBe(true);
  });

  it('accepts valid complete message', () => {
    expect(isWorkerResponse(validComplete)).toBe(true);
  });

  it('accepts a complete message with a valid profile', () => {
    expect(isWorkerResponse({ ...validComplete, profile: validProfile })).toBe(true);
  });

  it('accepts valid error message', () => {
    expect(isWorkerResponse(validError)).toBe(true);
  });

  it('accepts valid log message', () => {
    expect(isWorkerResponse(validLog)).toBe(true);
  });

  it('rejects unbounded or unknown worker log fields', () => {
    expect(isWorkerResponse({ ...validLog, level: 'INFO' })).toBe(false);
    expect(isWorkerResponse({ ...validLog, category: 'network' })).toBe(false);
    expect(isWorkerResponse({ ...validLog, requestId: 'x'.repeat(65) })).toBe(false);
    expect(isWorkerResponse({ ...validLog, message: '' })).toBe(false);
    expect(isWorkerResponse({ ...validLog, message: 'x'.repeat(513) })).toBe(false);
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

  it('rejects a malformed profile at the Worker boundary', () => {
    expect(
      isWorkerResponse({
        ...validComplete,
        profile: { ...validProfile, totalDurationMs: Number.NaN },
      })
    ).toBe(false);
    expect(
      isWorkerResponse({
        ...validComplete,
        profile: { ...validProfile, stages: [{ stage: 'unknown' }] },
      })
    ).toBe(false);
    expect(
      isWorkerResponse({
        ...validComplete,
        profile: { ...validProfile, schemaVersion: 1 },
      })
    ).toBe(false);
    expect(
      isWorkerResponse({
        ...validComplete,
        profile: { ...validProfile, dominantStage: 'decoding' },
      })
    ).toBe(false);
  });

  it('rejects error without message', () => {
    const { message: _, ...withoutMsg } = validError;
    expect(isWorkerResponse(withoutMsg)).toBe(false);
  });

  it('rejects error with empty code', () => {
    expect(isWorkerResponse({ ...validError, code: '' })).toBe(false);
  });
});
