// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { BYTES_PER_MB, GIF_MAX_OUTPUT_BYTES, GIF_MAX_OUTPUT_FRAMES } from '@utils/constants';

import { validateOutput } from './error-recovery';
import type { GifOutputPart } from './gif-encoder-service';

const CHUNKS = 'chunks';
const CHUNK_BYTES = BYTES_PER_MB;
// Experiment ceiling for staged output (including the manifest), independent of live memory.
const MAX_STAGED_BYTES = 512 * BYTES_PER_MB;

type StoredFile = { filename: string; bytes: number };
type StoredPart = Omit<GifOutputPart, 'bytes'> & StoredFile;

export type GifPartIndexedDbSink = {
  readonly count: number;
  save(part: GifOutputPart, signal: AbortSignal): Promise<void>;
  finish(signal: AbortSignal): Promise<void>;
  files(): readonly StoredFile[];
  read(filename: string, signal: AbortSignal): Promise<Blob>;
  dispose(): Promise<void>;
};

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let created = false;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      request.result.createObjectStore(CHUNKS);
      created = true;
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!created) {
        database.close();
        reject(new Error('The staged GIF database already exists'));
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Staged GIF database deletion is blocked'));
  });
}

function transact<Value>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  requestFor: (store: IDBObjectStore) => IDBRequest<Value>,
  signal?: AbortSignal
): Promise<Value> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const transaction = database.transaction(CHUNKS, mode);
    const request = requestFor(transaction.objectStore(CHUNKS));
    const cancel = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may have already committed and queued its completion event.
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    transaction.oncomplete = () => {
      signal?.removeEventListener('abort', cancel);
      resolve(request.result);
    };
    transaction.onabort = () => {
      signal?.removeEventListener('abort', cancel);
      reject(
        signal?.aborted
          ? signal.reason
          : (transaction.error ?? new DOMException('Staged GIF transaction aborted', 'AbortError'))
      );
    };
  });
}

export async function createGifPartIndexedDbSink(): Promise<GifPartIndexedDbSink> {
  const scope = crypto.randomUUID();
  const databaseName = `dropconvert-gif-${scope}`;
  const token = scope.replaceAll('-', '').slice(0, 16);
  const database = await openDatabase(databaseName);
  const lifetime = new AbortController();
  const parts: StoredPart[] = [];
  let manifest: StoredFile | undefined;
  let storedBytes = 0;
  let active: Promise<unknown> | undefined;
  let deletion: Promise<void> | undefined;
  let cleanupFailed = false;

  async function run<Value>(
    signal: AbortSignal,
    operation: (operationSignal: AbortSignal) => Promise<Value>
  ): Promise<Value> {
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    operationSignal.throwIfAborted();
    if (active) throw new Error('A staged GIF operation is already active');
    const pending = Promise.resolve().then(() => operation(operationSignal));
    active = pending;
    try {
      return await pending;
    } finally {
      active = undefined;
    }
  }

  async function writeFile(
    filename: string,
    bytes: ArrayBuffer,
    signal: AbortSignal
  ): Promise<void> {
    if (cleanupFailed) throw new Error('Incomplete staged GIF output must be discarded');
    const length = bytes.byteLength;
    if (length > MAX_STAGED_BYTES - storedBytes) {
      throw new DOMException('Staged GIF output exceeds the storage limit', 'QuotaExceededError');
    }
    let committedChunks = 0;
    try {
      for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
        signal.throwIfAborted();
        const chunk = bytes.slice(offset, offset + CHUNK_BYTES);
        if (chunk.byteLength !== Math.min(CHUNK_BYTES, length - offset)) {
          throw new Error('Staged GIF output changed during storage');
        }
        await transact(
          database,
          'readwrite',
          (store) => store.add(chunk, [filename, committedChunks]),
          signal
        );
        committedChunks++;
      }
    } catch (error) {
      if (committedChunks > 0) {
        try {
          const keys = IDBKeyRange.bound([filename, 0], [filename, committedChunks - 1]);
          await transact(database, 'readwrite', (store) => store.delete(keys));
        } catch (cleanupError) {
          cleanupFailed = true;
          throw new AggregateError(
            [error, cleanupError],
            'Unable to clean up incomplete staged GIF output'
          );
        }
      }
      throw error;
    }
    // The final transaction is the publication point, including when Stop races its completion.
    storedBytes += length;
  }

  function dispose(): Promise<void> {
    if (deletion) return deletion;
    lifetime.abort();
    deletion = (async () => {
      if (active) await active.catch(() => undefined);
      database.close();
      window.removeEventListener('pagehide', onPageHide);
      await deleteDatabase(databaseName);
      parts.length = 0;
      manifest = undefined;
    })().catch((error: unknown) => {
      deletion = undefined;
      throw error;
    });
    return deletion;
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) void dispose().catch(() => undefined);
  }

  window.addEventListener('pagehide', onPageHide);
  return {
    get count() {
      return parts.length;
    },
    save(part, signal) {
      return run(signal, async (operationSignal) => {
        if (manifest) throw new Error('The staged GIF output is finalized');
        if (part.index !== parts.length + 1 || parts.length >= GIF_MAX_OUTPUT_FRAMES) {
          throw new Error('Invalid staged GIF part index');
        }
        const { bytes, ...receipt } = part;
        const length = bytes.byteLength;
        const view = new Uint8Array(bytes);
        if (
          length > GIF_MAX_OUTPUT_BYTES ||
          !validateOutput(view.subarray(0, 16), 'gif') ||
          view.at(-1) !== 0x3b
        ) {
          throw new Error('Conversion produced an invalid GIF part');
        }
        const ordinal = String(part.index).padStart(4, '0');
        const filename = `part-${ordinal}_${part.startCs}-${part.endCs}cs_${token}.gif`;
        await writeFile(filename, bytes, operationSignal);
        parts.push({ ...receipt, filename, bytes: length });
      });
    },
    finish(signal) {
      return run(signal, async (operationSignal) => {
        if (manifest) return;
        if (parts.length === 0) throw new Error('Conversion produced no GIF parts');
        const filename = `parts_${token}.json`;
        const json = JSON.stringify({ version: 1, timelineUnit: 'centiseconds', parts }, null, 2);
        const bytes = new TextEncoder().encode(json + '\n').buffer;
        await writeFile(filename, bytes, operationSignal);
        manifest = { filename, bytes: bytes.byteLength };
      });
    },
    files() {
      const files = manifest ? [...parts, manifest] : parts;
      return files.map(({ filename, bytes }) => ({ filename, bytes }));
    },
    read(filename, signal) {
      return run(signal, async (operationSignal) => {
        const isManifest = manifest?.filename === filename;
        const file = isManifest ? manifest : parts.find((part) => part.filename === filename);
        if (!file) throw new Error('Staged GIF output file is unavailable');
        const chunks: ArrayBuffer[] = [];
        for (let offset = 0; offset < file.bytes; offset += CHUNK_BYTES) {
          const chunk = await transact<unknown>(
            database,
            'readonly',
            (store) => store.get([filename, chunks.length]),
            operationSignal
          );
          if (
            !(chunk instanceof ArrayBuffer) ||
            chunk.byteLength !== Math.min(CHUNK_BYTES, file.bytes - offset)
          ) {
            throw new Error('Staged GIF output is incomplete');
          }
          chunks.push(chunk);
        }
        operationSignal.throwIfAborted();
        return new Blob(chunks, { type: isManifest ? 'application/json' : 'image/gif' });
      });
    },
    dispose,
  };
}
