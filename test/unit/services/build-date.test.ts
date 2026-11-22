import { afterEach, expect, it, vi } from 'vite-plus/test';

import { loadBuildDate } from '../../../src/build-date';
import { parseBuildDate } from '../../../src/utils/build-date';

const source = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const origin = 'https://example.test';

afterEach(() => vi.unstubAllGlobals());

it('accepts only a real UTC calendar date with the requested build identity and exact schema', () => {
  expect(parseBuildDate({ sourceSha: source, date: '2024-02-29' }, source)).toBe('2024-02-29');
  expect(parseBuildDate({ sourceSha: null, date: '2024-02-29' }, null)).toBe('2024-02-29');
  for (const metadata of [
    { sourceSha: source, date: '2025-02-29' },
    { sourceSha: source, date: '2024-13-01' },
    { sourceSha: source, date: '2024-02-29T00:00:00Z' },
    { sourceSha: source, date: '2024-02-29', extra: 1 },
    { sourceSha: newer, date: '2024-02-29' },
    { sourceSha: null, date: '2024-02-29' },
    [],
    null,
  ])
    expect(parseBuildDate(metadata, source)).toBeNull();
});

it('cancels a rejected metadata response without reading or displaying its contents', async () => {
  vi.stubGlobal('location', { href: origin + '/' });
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const response = new Response(body, {
    headers: { 'content-type': 'application/json', 'content-length': '99999' },
  });
  Object.defineProperty(response, 'url', { value: origin + '/build-date.json' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  expect(await loadBuildDate(null)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it('refreshes a rebuilt source and reuses only a previously observed matching date offline', async () => {
  vi.stubGlobal('location', { href: origin + '/' });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const send = (sourceSha: string | null, date: string) => {
    const response = Response.json({ sourceSha, date });
    Object.defineProperty(response, 'url', { value: origin + '/build-date.json' });
    fetcher.mockResolvedValueOnce(response);
  };
  send(source, '2026-11-22');
  expect(await loadBuildDate(source)).toBe('2026-11-22');
  send(source, '2026-11-23');
  expect(await loadBuildDate(source)).toBe('2026-11-23');
  send(newer, '2026-11-24');
  expect(await loadBuildDate(source)).toBe('2026-11-23');
  fetcher.mockRejectedValue(new TypeError('offline'));
  expect(await loadBuildDate(source)).toBe('2026-11-23');
  expect(await loadBuildDate(newer)).toBeNull();
  expect(await loadBuildDate(null)).toBeNull();
});
