// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { observeDeploymentUpdates } from '../../../src/deployment-update';

const localSha = 'a'.repeat(40);
const remoteSha = 'b'.repeat(40);
const metadataUrl = new URL('/deployment-state.json', location.origin).href;
const cleanups: Array<() => void> = [];
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;

function metadata(
  sourceSha = localSha,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceDirty: false,
    sourceSha,
    treeSha: 'c'.repeat(40),
    coreSha: 'd'.repeat(40),
    version: '0.2.3',
    ...overrides,
  };
}

function response(
  value: unknown = metadata(),
  options: {
    status?: number;
    contentType?: string;
    url?: string;
    redirected?: boolean;
    contentLength?: string;
    body?: string;
  } = {}
): Response {
  const body = options.body ?? JSON.stringify(value);
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json; charset=utf-8',
  });
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);
  const result = new Response(body, { status: options.status ?? 200, headers });
  Object.defineProperties(result, {
    url: { value: options.url ?? metadataUrl },
    redirected: { value: options.redirected ?? false },
  });
  return result;
}

function openResponse(options: Parameters<typeof response>[1] = {}): {
  result: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const result = response(metadata(remoteSha), options);
  Object.defineProperty(result, 'body', {
    value: new ReadableStream<Uint8Array>({ cancel }),
  });
  return { result, cancel };
}

function observe(
  sourceSha: string | null = localSha,
  onUpdate = vi.fn()
): ReturnType<typeof vi.fn> {
  cleanups.push(observeDeploymentUpdates({ sourceSha, onUpdate }));
  return onUpdate;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function pageEvent(type: 'pageshow' | 'pagehide', persisted: boolean): void {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fetchMock = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deployment update observer', () => {
  it('checks a known first install immediately, compares only source SHA, and reports an advanced source once', async () => {
    const callback = vi.fn();
    fetchMock.mockResolvedValue(response(metadata(remoteSha, { version: '0.2.3' })));
    observe(localSha, callback);
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(metadataUrl),
      expect.objectContaining({
        cache: 'no-cache',
        redirect: 'error',
        mode: 'same-origin',
        signal: expect.any(AbortSignal),
      })
    );
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never infers a baseline from the first response and ignores version changes at the same source', async () => {
    fetchMock.mockResolvedValue(response(metadata(localSha, { version: '99.0.0' })));
    const callback = observe();
    await settle();
    expect(callback).not.toHaveBeenCalled();
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([null, '', 'INVALID', 'A'.repeat(40)])(
    'makes no request for unknown source %j',
    (sourceSha) => {
      observe(sourceSha);
      window.dispatchEvent(new Event('online'));
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('waits for visible and online states, without background polling', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const callback = observe();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('coalesces event bursts and uses an attempt-start cooldown', async () => {
    let resolveFirst!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
    );
    observe();
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      pageEvent('pageshow', false);
    }
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst(response());
    await settle();
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    response(metadata(remoteSha), { status: 404 }),
    response(metadata(remoteSha), { contentType: 'text/html' }),
    response(metadata(remoteSha), { redirected: true }),
    response(metadata(remoteSha), { url: 'https://elsewhere.test/deployment-state.json' }),
    response(metadata(remoteSha), { contentLength: '65537' }),
    response(metadata(remoteSha), { contentLength: 'invalid' }),
    response(metadata(remoteSha), { body: '<html>fallback</html>' }),
    response(metadata(remoteSha, { sourceDirty: true })),
    response(metadata(remoteSha, { treeSha: 'BAD' })),
    response(metadata(remoteSha, { version: 'x'.repeat(65) })),
    response(metadata(remoteSha), { body: ' '.repeat(65_537) }),
  ])('treats unusable metadata as unknown', async (unusable) => {
    fetchMock.mockResolvedValue(unusable);
    const callback = observe();
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404 },
    { contentType: 'text/html' },
    { redirected: true },
    { url: 'https://elsewhere.test/deployment-state.json' },
    { contentLength: '65537' },
    { contentLength: 'malformed' },
  ])(
    'releases an open response rejected by headers (%j), then permits a valid check',
    async (options) => {
      const rejected = openResponse(options);
      fetchMock
        .mockResolvedValueOnce(rejected.result)
        .mockResolvedValueOnce(response(metadata(remoteSha)));
      const callback = observe();
      const firstSignal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
      await settle();
      expect(firstSignal.aborted).toBe(true);
      expect(rejected.cancel).toHaveBeenCalledTimes(1);
      expect(callback).not.toHaveBeenCalled();

      now = 60_000;
      window.dispatchEvent(new Event('online'));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  );

  it('aborts a request when the body exceeds the byte limit', async () => {
    fetchMock.mockResolvedValue(response(metadata(remoteSha), { body: ' '.repeat(65_537) }));
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await settle();
    expect(signal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('aborts a request with malformed JSON and permits the next valid check', async () => {
    fetchMock
      .mockResolvedValueOnce(response(metadata(remoteSha), { body: '{' }))
      .mockResolvedValueOnce(response(metadata(remoteSha)));
    const callback = observe();
    const firstSignal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await settle();
    expect(firstSignal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('aborts a request when reading the body fails', async () => {
    const unreadable = response(metadata(remoteSha));
    Object.defineProperty(unreadable, 'body', {
      value: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('read failed');
        },
      }),
    });
    fetchMock.mockResolvedValue(unreadable);
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await settle();
    expect(signal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('releases a late response from suspended A without aborting active B', async () => {
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveA = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveB = resolve;
          })
      );
    const callback = observe();
    const signalA = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    pageEvent('pagehide', true);
    expect(signalA.aborted).toBe(true);
    now = 60_000;
    pageEvent('pageshow', true);
    const signalB = fetchMock.mock.calls[1]?.[1].signal as AbortSignal;
    const late = openResponse({ contentType: 'text/html' });
    resolveA(late.result);
    await settle();
    expect(late.cancel).toHaveBeenCalledTimes(1);
    expect(signalB.aborted).toBe(false);
    now = 120_000;
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveB(response(metadata(remoteSha)));
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps B deadline after suspended A settles late', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let resolveA!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveA = resolve;
          })
      )
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    const callback = observe();
    pageEvent('pagehide', true);
    now = 60_000;
    pageEvent('pageshow', true);
    const signalB = fetchMock.mock.calls[1]?.[1].signal as AbortSignal;
    resolveA(response(metadata(remoteSha)));
    await settle();
    expect(signalB.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signalB.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signalB.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not report a late response after the whole-operation timeout', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    resolveFetch(response(metadata(remoteSha)));
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it('treats a synchronous fetch failure as unknown', async () => {
    fetchMock.mockImplementation(() => {
      throw new Error('offline');
    });
    const callback = observe();
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it('times out while a metadata body is stalled after valid headers', async () => {
    vi.useFakeTimers();
    const stalled = response(metadata(remoteSha));
    Object.defineProperty(stalled, 'body', {
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"schemaVersion":1,'));
        },
      }),
    });
    fetchMock.mockResolvedValue(stalled);
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores late completion after cleanup and removes event ownership', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    cleanups.pop()?.();
    expect(signal.aborted).toBe(true);
    resolveFetch(response(metadata(remoteSha)));
    await settle();
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    expect(callback).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('suspends on BFCache pagehide, resumes once after cooldown, and ignores the old response', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    pageEvent('pagehide', true);
    expect(signal.aborted).toBe(true);
    pageEvent('pageshow', true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 60_000;
    pageEvent('pageshow', true);
    pageEvent('pageshow', true);
    resolveFetch(response(metadata(remoteSha)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it('disposes on final pagehide and keeps repeated owners independent', async () => {
    const first = observe();
    const second = observe();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    cleanups.shift()?.();
    now = 60_000;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pageEvent('pagehide', false);
    now = 120_000;
    window.dispatchEvent(new Event('online'));
    pageEvent('pageshow', false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
