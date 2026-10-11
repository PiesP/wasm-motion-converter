// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeDeploymentUpdates } from '../../../src/deployment-update';

const localSha = 'a'.repeat(40);
const remoteSha = 'b'.repeat(40);
const metadataUrl = 'http://localhost:3000/deployment-state.json';
const cleanups: Array<() => void> = [];
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;

function metadata(sourceSha = localSha, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  options: { status?: number; contentType?: string; url?: string; redirected?: boolean; contentLength?: string; body?: string } = {}
): Response {
  const body = options.body ?? JSON.stringify(value);
  const headers = new Headers({ 'content-type': options.contentType ?? 'application/json; charset=utf-8' });
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);
  const result = new Response(body, { status: options.status ?? 200, headers });
  Object.defineProperties(result, {
    url: { value: options.url ?? metadataUrl },
    redirected: { value: options.redirected ?? false },
  });
  return result;
}

function observe(sourceSha: string | null = localSha, onUpdate = vi.fn()): ReturnType<typeof vi.fn> {
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
  vi.stubGlobal('location', { href: 'http://localhost:3000/' });
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
    expect(fetchMock).toHaveBeenCalledWith(new URL(metadataUrl), expect.objectContaining({
      cache: 'no-cache', redirect: 'error', mode: 'same-origin', signal: expect.any(AbortSignal),
    }));
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

  it.each([null, '', 'INVALID', 'A'.repeat(40)])('makes no request for unknown source %j', (sourceSha) => {
    observe(sourceSha);
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['file:///tmp/app.html', 'data:text/html,app', 'http://example.test/app'])('rejects unsafe origin %s', (href) => {
    vi.stubGlobal('location', { href });
    observe();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks an HTTPS application origin without using a cross-origin endpoint', async () => {
    vi.stubGlobal('location', { href: 'https://drop.test/?entry=one' });
    fetchMock.mockResolvedValue(response(metadata(), { url: 'https://drop.test/deployment-state.json' }));
    observe();
    await settle();
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL('https://drop.test/deployment-state.json'));
  });

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
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }));
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

  it('does not report a late response after the whole-operation timeout', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const callback = observe();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    resolveFetch(response(metadata(remoteSha)));
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it('treats a synchronous fetch failure as unknown', async () => {
    fetchMock.mockImplementation(() => { throw new Error('offline'); });
    const callback = observe();
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });

  it('times out while a metadata body is stalled after valid headers', async () => {
    vi.useFakeTimers();
    const stalled = response(metadata(remoteSha));
    Object.defineProperty(stalled, 'body', {
      value: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":1,'));
      } }),
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
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
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
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
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
