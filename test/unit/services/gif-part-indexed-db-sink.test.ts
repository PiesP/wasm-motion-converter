// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createGifPartIndexedDbSink } from '@services/gif-part-indexed-db-sink';
import { BYTES_PER_MB } from '@utils/constants';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type ChunkKey = [filename: string, index: number];
type ChunkRange = { lower: ChunkKey; upper: ChunkKey };
type FakeRequest = { result?: unknown };

function memoryStorage() {
  const databases = new Map<string, Map<string, ArrayBuffer>>();
  const leases = new Set<string>();
  const writes: number[] = [];
  const reads: string[] = [];
  const window = new EventTarget();
  const storage = {
    beforePut: (_count: number): void | Promise<void> => undefined,
    blockDeletion: false,
    records: databases,
    writes,
    reads,
    window,
    databases: vi.fn(async () => [...databases.keys()].map((name) => ({ name }))),
    open: vi.fn((name: string) => {
      const records = databases.get(name) ?? new Map<string, ArrayBuffer>();
      const open = {
        result: {
          close: vi.fn(),
          createObjectStore: vi.fn(),
          transaction: (_store: string, _mode: string) => {
            let settled = false;
            const request: FakeRequest = {};
            const transaction = {
              oncomplete: () => {},
              onabort: () => {},
              error: undefined as unknown,
              abort() {
                if (settled) throw new DOMException('Transaction ended', 'InvalidStateError');
                settled = true;
                queueMicrotask(() => transaction.onabort());
              },
              objectStore() {
                return {
                  add(chunk: ArrayBuffer, key: ChunkKey) {
                    const clone = chunk.slice(0);
                    writes.push(clone.byteLength);
                    void commit(() => records.set(JSON.stringify(key), clone), writes.length);
                    return request;
                  },
                  get(key: ChunkKey) {
                    reads.push(key[0]);
                    void commit(() => records.get(JSON.stringify(key))?.slice(0));
                    return request;
                  },
                  delete({ lower, upper }: ChunkRange) {
                    void commit(() => {
                      for (let index = lower[1]; index <= upper[1]; index++) {
                        records.delete(JSON.stringify([lower[0], index]));
                      }
                    });
                    return request;
                  },
                };
              },
            };
            async function commit(operation: () => unknown, write?: number): Promise<void> {
              try {
                await (write === undefined ? undefined : storage.beforePut(write));
                if (settled) return;
                request.result = operation();
                settled = true;
                transaction.oncomplete();
              } catch (error) {
                if (settled) return;
                transaction.error = error;
                transaction.abort();
              }
            }
            return transaction;
          },
        },
        onupgradeneeded: (_event: { oldVersion: number }) => {},
        onsuccess: () => {},
      };
      queueMicrotask(() => {
        if (!databases.has(name)) {
          databases.set(name, records);
          open.onupgradeneeded({ oldVersion: 0 });
        }
        open.onsuccess();
      });
      return open;
    }),
    deleteDatabase: vi.fn((name: string) => {
      const request = { onblocked: () => {}, onsuccess: () => {} };
      queueMicrotask(() => {
        if (storage.blockDeletion) {
          request.onblocked();
          return;
        }
        databases.delete(name);
        request.onsuccess();
      });
      return request;
    }),
  };
  vi.stubGlobal('indexedDB', storage);
  vi.stubGlobal('navigator', {
    locks: {
      async request(
        name: string,
        optionsOrCallback:
          | { ifAvailable?: boolean }
          | ((lock: { name: string } | null) => Promise<void>),
        availableCallback?: (lock: { name: string } | null) => Promise<void>
      ) {
        const callback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : availableCallback!;
        if (leases.has(name)) return callback(null);
        leases.add(name);
        try {
          await callback({ name });
        } finally {
          leases.delete(name);
        }
      },
    },
  });
  vi.stubGlobal('IDBKeyRange', { bound: (lower: ChunkKey, upper: ChunkKey) => ({ lower, upper }) });
  vi.stubGlobal('window', window);
  return storage;
}

function gifPart(index: number, length: number) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode('GIF89a'));
  bytes[bytes.length - 1] = 0x3b;
  return { index, startCs: (index - 1) * 5, endCs: index * 5, frameCount: 1, bytes: bytes.buffer };
}

const signal = new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('staged GIF IndexedDB sink', () => {
  it('publishes chunked owned parts and reconstructs only the selected file and manifest', async () => {
    const storage = memoryStorage();
    const sink = await createGifPartIndexedDbSink();
    const { bytes, ...receipt } = gifPart(1, BYTES_PER_MB + 19);
    const writing = sink.save({ bytes, ...receipt }, signal);
    expect(sink.files()).toEqual([]);
    await writing;
    expect(storage.writes).toEqual([BYTES_PER_MB, 19]);
    const [file] = sink.files();
    expect(file).toEqual({
      filename: expect.stringMatching(/^part-0001_0-5cs_.*\.gif$/),
      bytes: bytes.byteLength,
    });
    const blob = await sink.read(file!.filename, signal);
    expect(blob.type).toBe('image/gif');
    expect(await blob.arrayBuffer()).toEqual(bytes);
    await sink.finish(signal);
    const manifest = sink.files()[1]!;
    const manifestBlob = await sink.read(manifest.filename, signal);
    expect(manifestBlob.type).toBe('application/json');
    expect(JSON.parse(await manifestBlob.text())).toEqual({
      version: 1,
      timelineUnit: 'centiseconds',
      parts: [{ ...file, ...receipt }],
    });
    expect(storage.reads).toEqual([file!.filename, file!.filename, manifest.filename]);
    expect(sink.count).toBe(1);
    await sink.dispose();
  });

  it.each(['stop', 'quota'])(
    'rolls back only the uncommitted part on %s and can retry',
    async (failure) => {
      const storage = memoryStorage();
      const sink = await createGifPartIndexedDbSink();
      await sink.save(gifPart(1, 30), signal);
      const before = sink.files();
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      storage.beforePut = (count) => {
        if (count !== 3) return;
        started.resolve();
        return blocked.promise;
      };
      const writing = sink.save(gifPart(2, BYTES_PER_MB + 30), controller.signal);
      const assertion = expect(writing).rejects.toMatchObject({
        name: failure === 'stop' ? 'AbortError' : 'QuotaExceededError',
      });
      await started.promise;
      expect(sink.files()).toEqual(before);
      if (failure === 'stop') {
        controller.abort();
        blocked.resolve();
      } else {
        blocked.reject(new DOMException('Browser storage quota exhausted', 'QuotaExceededError'));
      }
      await assertion;
      expect(sink.files()).toEqual(before);
      expect([...storage.records.values()][0]!.size).toBe(1);
      await sink.save(gifPart(2, 42), signal);
      expect(sink.count).toBe(2);
      await sink.dispose();
    }
  );

  it('charges exactly the staged byte cap before starting any new transactions', async () => {
    // Scale the units so testing the exact boundary does not stage 512 MiB on the unit-test host.
    const scaledMiB = 1024;
    const cap = 512 * scaledMiB;
    vi.resetModules();
    vi.doMock('@utils/constants', async (importOriginal) => {
      const constants = await importOriginal<typeof import('@utils/constants')>();
      return { ...constants, BYTES_PER_MB: scaledMiB };
    });
    const { createGifPartIndexedDbSink: createScaledSink } =
      await import('@services/gif-part-indexed-db-sink');
    vi.doUnmock('@utils/constants');
    const storage = memoryStorage();
    const sink = await createScaledSink();
    await sink.save(gifPart(1, cap / 2), signal);
    await expect(sink.save(gifPart(2, cap / 2 + 1), signal)).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect(storage.writes).toHaveLength(256);
    await sink.save(gifPart(2, cap / 2), signal);
    expect(storage.writes.reduce((total, size) => total + size, 0)).toBe(cap);
    await expect(sink.finish(signal)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(sink.files()).toHaveLength(2);
    await sink.dispose();
  });

  it('keeps cached pages and retries a blocked deletion of only its own database', async () => {
    const storage = memoryStorage();
    const sink = await createGifPartIndexedDbSink();
    const other = await createGifPartIndexedDbSink();
    const [name] = storage.open.mock.calls[0]!;
    const [otherName] = storage.open.mock.calls[1]!;
    const cachedPage = Object.assign(new Event('pagehide'), { persisted: true });
    storage.window.dispatchEvent(cachedPage);
    expect(storage.deleteDatabase).not.toHaveBeenCalled();
    storage.blockDeletion = true;
    await expect(sink.dispose()).rejects.toThrow('deletion is blocked');
    storage.blockDeletion = false;
    await sink.dispose();
    expect(storage.deleteDatabase.mock.calls).toEqual([[name], [name]]);
    expect([...storage.records.keys()]).toEqual([otherName]);
    storage.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    await other.dispose();
    expect(storage.deleteDatabase.mock.calls).toEqual([[name], [name], [otherName]]);
    expect(storage.records.size).toBe(0);
  });
});
