// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@services/conversion-worker/pipeline-worker', () => ({
  runWorkerPipeline: vi.fn(),
}));

interface WorkerScopeStub {
  onmessage: ((event: MessageEvent) => Promise<void> | void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('conversion worker message security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('preserves an owned memory refusal code at the Worker entry', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    vi.mocked(runWorkerPipeline).mockRejectedValueOnce(
      new ConversionMemoryLimitError('Diagnostic wording changed')
    );
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      source: null,
      data: {
        type: 'start',
        requestId: 'memory-request',
        inputBlob: new Blob(['video']),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith(
      {
        type: 'error',
        requestId: 'memory-request',
        code: 'OUT_OF_MEMORY',
        message: 'Diagnostic wording changed',
      },
      []
    );
  });

  it.each([
    ['OwnedDemuxLoadError', 'load', 'DECODER_ERROR'],
    ['OwnedDemuxAbiError', 'abi', 'DECODER_ERROR'],
    ['OwnedDemuxResourceError', 'resource', 'OUT_OF_MEMORY'],
    ['OwnedDemuxParseError', 'parse', 'DECODER_ERROR'],
    ['OwnedDemuxConversionError', 'conversion', 'DECODER_ERROR'],
  ] as const)('preserves typed %s across the Worker response', async (className, kind, code) => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    const demuxCore = await import('@services/owned-demux-core');
    vi.mocked(runWorkerPipeline).mockRejectedValueOnce(
      new demuxCore[className]('Opaque timeout abort marker')
    );
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      source: null,
      data: {
        type: 'start',
        requestId: 'typed-demux',
        inputBlob: new Blob(['video']),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith(
      {
        type: 'error',
        requestId: 'typed-demux',
        message: 'Opaque timeout abort marker',
        code,
        demuxFailureKind: kind,
      },
      []
    );
  });

  it.each(['memory', 'parse'] as const)(
    'gives an active cancellation priority over a %s failure',
    async (failure) => {
      const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
      vi.stubGlobal('self', workerScope);
      const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
      const { OwnedDemuxParseError } = await import('@services/owned-demux-core');
      const { ConversionMemoryLimitError: CurrentMemoryLimitError } =
        await import('@services/conversion-memory-limit-error');
      let rejectPipeline!: (error: Error) => void;
      vi.mocked(runWorkerPipeline).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPipeline = reject;
          })
      );
      await import('@services/conversion-worker/worker');
      workerScope.postMessage.mockClear();

      const start = workerScope.onmessage?.({
        source: null,
        data: {
          type: 'start',
          requestId: 'cancel-first',
          inputBlob: new Blob(['video']),
          config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
          options: {
            format: 'gif',
            fps: 30,
            maxFrames: 1,
            maxOutputBytes: 1024,
            quality: 'medium',
            scale: 1,
            trimEnd: 0,
            trimStart: 0,
          },
        },
      } as unknown as MessageEvent);
      await workerScope.onmessage?.({
        source: null,
        data: { type: 'abort', requestId: 'cancel-first' },
      } as unknown as MessageEvent);
      rejectPipeline(
        failure === 'memory'
          ? new CurrentMemoryLimitError('Budget exhausted')
          : new OwnedDemuxParseError('Malformed media')
      );
      await start;

      expect(workerScope.postMessage).toHaveBeenCalledWith(
        {
          type: 'error',
          requestId: 'cancel-first',
          message: expect.any(String),
          code: 'CANCELLED',
        },
        []
      );
    }
  );

  it('gives an actual TimeoutError name its terminal category without a demux kind', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    vi.mocked(runWorkerPipeline).mockRejectedValueOnce(
      new DOMException('Deadline expired', 'TimeoutError')
    );
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      source: null,
      data: {
        type: 'start',
        requestId: 'actual-timeout',
        inputBlob: new Blob(['video']),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith(
      {
        type: 'error',
        requestId: 'actual-timeout',
        message: 'Deadline expired',
        code: 'TIMEOUT',
      },
      []
    );
  });

  it('keeps a non-demux codec failure on the existing Worker category', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    vi.mocked(runWorkerPipeline).mockRejectedValueOnce(new Error('codec unsupported'));
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      source: null,
      data: {
        type: 'start',
        requestId: 'ordinary-codec',
        inputBlob: new Blob(['video']),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith(
      {
        type: 'error',
        requestId: 'ordinary-codec',
        message: 'codec unsupported',
        code: 'CODEC_NOT_SUPPORTED',
      },
      []
    );
  });

  it('emits the validated readiness control event from the actual Worker entry', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    await import('@services/conversion-worker/worker');

    expect(workerScope.postMessage.mock.calls[0]?.[0]).toEqual({ type: 'ready', requestId: '' });
    expect(workerScope.postMessage.mock.calls[1]?.[0]).toMatchObject({
      type: 'log',
      requestId: '',
      message: 'Worker initialized',
    });
  });

  it('rejects a recognizable malformed start request immediately', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);

    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      data: {
        type: 'start',
        requestId: 'request-1',
        inputBuffer: new ArrayBuffer(0),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: Number.POSITIVE_INFINITY,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
      source: null,
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: 'error',
      requestId: 'request-1',
      message: 'Invalid conversion worker request',
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects unsupported conversion choices before starting the pipeline', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    for (const [field, value] of [
      ['format', 'avif'],
      ['quality', 'ultra'],
      ['smartFrameSkip', 'turbo'],
      ['smartFrameSkip', 123],
    ] as const) {
      vi.mocked(runWorkerPipeline).mockClear();
      workerScope.postMessage.mockClear();
      await workerScope.onmessage?.({
        data: {
          type: 'start',
          requestId: 'invalid-choice',
          inputBuffer: new ArrayBuffer(0),
          config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
          options: {
            format: 'gif',
            quality: 'medium',
            fps: 30,
            scale: 1,
            trimStart: 0,
            trimEnd: 0,
            maxFrames: 1,
            maxOutputBytes: 1024,
            [field]: value,
          },
        },
        source: null,
      } as unknown as MessageEvent);
      expect(runWorkerPipeline).not.toHaveBeenCalled();
      expect(workerScope.postMessage).toHaveBeenCalledWith({
        type: 'error',
        requestId: 'invalid-choice',
        message: 'Invalid conversion worker request',
        code: 'INVALID_REQUEST',
      });
    }
  });

  it('continues to ignore payloads that cannot be correlated to a request', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);

    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();
    await workerScope.onmessage?.({ data: null, source: null } as unknown as MessageEvent);

    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });

  it.each(['fulfills', 'rejects'] as const)(
    'keeps the cancelled request exclusive until the pipeline %s, then accepts a new request',
    async (settlement) => {
      const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
      vi.stubGlobal('self', workerScope);
      const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof runWorkerPipeline>>>();
      const outputBuffer = new ArrayBuffer(10);
      const pipeline = vi.mocked(runWorkerPipeline);
      pipeline
        .mockReset()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ outputBuffer });
      await import('@services/conversion-worker/worker');
      workerScope.postMessage.mockClear();

      const input = new Blob(['video']);
      const request = {
        type: 'start',
        requestId: 'blob-request',
        inputBlob: input,
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'webp',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      };
      const send = (data: unknown) => workerScope.onmessage!(new MessageEvent('message', { data }));
      const start = send(request);

      const invocation = pipeline.mock.calls[0]!;
      expect(invocation[0]).toBe(input);
      await send(request);
      await send({ type: 'start', requestId: request.requestId }); // Malformed duplicate.
      await send({ type: 'abort', requestId: 'unrelated' });
      expect(invocation[4]?.aborted).toBe(false);
      expect(workerScope.postMessage).not.toHaveBeenCalled();
      expect(pipeline).toHaveBeenCalledTimes(1);

      await send({ type: 'abort', requestId: request.requestId });
      expect(invocation[4]?.aborted).toBe(true);
      invocation[2]({
        type: 'log',
        requestId: request.requestId,
        level: 'info',
        category: 'general',
        message: 'Late pipeline callback',
      });
      await send({ ...request, requestId: 'overlap' });
      await send(request);
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(workerScope.postMessage.mock.calls).toEqual([
        [
          {
            type: 'error',
            requestId: 'overlap',
            message: 'Conversion worker is busy',
            code: 'BUSY',
          },
        ],
      ]);

      if (settlement === 'fulfills') {
        pending.resolve({ outputBuffer: new ArrayBuffer(1) });
      } else {
        pending.reject(new Error('Late pipeline failure'));
      }
      await start;
      expect(workerScope.postMessage).toHaveBeenCalledTimes(2);
      expect(workerScope.postMessage).toHaveBeenLastCalledWith(
        {
          type: 'error',
          requestId: request.requestId,
          message: expect.any(String),
          code: 'CANCELLED',
        },
        []
      );

      await send({ ...request, requestId: 'recovery' });
      expect(pipeline).toHaveBeenCalledTimes(2);
      expect(workerScope.postMessage).toHaveBeenCalledTimes(3);
      expect(workerScope.postMessage).toHaveBeenLastCalledWith(
        { type: 'complete', requestId: 'recovery', outputBuffer, durationMs: expect.any(Number) },
        [outputBuffer]
      );
    }
  );
});
