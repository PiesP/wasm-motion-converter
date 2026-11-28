// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createGifPartFileSink } from '@services/gif-part-file-sink';
import { expect, it, vi } from 'vite-plus/test';

const bytes = Uint8Array.from(
  atob('R0lGODlhAQABAIABAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAICRAEAOw=='),
  (character) => character.charCodeAt(0)
).buffer;
const part = { index: 1, startCs: 0, endCs: 50, frameCount: 1, bytes };
const partFilename = 'part-0001_0-50cs_2222222222224222.gif';
const manifestFilename = 'parts_4444444444444444.json';

function seedNames(): void {
  vi.spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
    .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
    .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');
}

async function withFolder(
  run: (folder: FileSystemDirectoryHandle) => Promise<void>
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(crypto.randomUUID(), { create: true });
  try {
    await run(folder);
  } finally {
    vi.restoreAllMocks();
    await root.removeEntry(folder.name, { recursive: true });
  }
}

it('saves exact GIF parts with a relative presentation index', async () => {
  await withFolder(async (folder) => {
    seedNames();
    const sink = createGifPartFileSink(folder);
    const { signal } = new AbortController();
    await sink.save(part, signal);
    await sink.save({ ...part, index: 2, startCs: 50, endCs: 100 }, signal);
    await sink.finish(signal);
    const result = await folder.getDirectoryHandle(sink.folderName);
    const first = await (await result.getFileHandle(partFilename)).getFile();
    expect(await first.arrayBuffer()).toEqual(bytes);
    const manifest = await (await result.getFileHandle(manifestFilename)).getFile();
    expect(JSON.parse(await manifest.text())).toEqual({
      version: 1,
      timelineUnit: 'centiseconds',
      parts: [
        {
          index: 1,
          startCs: 0,
          endCs: 50,
          frameCount: 1,
          filename: partFilename,
          bytes: bytes.byteLength,
        },
        {
          index: 2,
          startCs: 50,
          endCs: 100,
          frameCount: 1,
          filename: 'part-0002_50-100cs_3333333333334333.gif',
          bytes: bytes.byteLength,
        },
      ],
    });
  });
});

it('removes an uncommitted file when Stop precedes close', async () => {
  await withFolder(async (folder) => {
    seedNames();
    const sink = createGifPartFileSink(folder);
    const stop = new AbortController();
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeWrite = FileSystemWritableFileStream.prototype.write;
    vi.spyOn(FileSystemWritableFileStream.prototype, 'write').mockImplementation(async function (
      this: FileSystemWritableFileStream,
      data
    ) {
      await nativeWrite.call(this, data);
      written.resolve();
      await release.promise;
    });
    const saving = sink.save(part, stop.signal);
    const settlement = expect(saving).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await written.promise;
      stop.abort();
      expect(sink.count).toBe(0);
    } finally {
      release.resolve();
      await settlement;
    }
    await sink.removeEmptyFolder();
    await expect(folder.getDirectoryHandle(sink.folderName)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

it('preserves the file when native close wins a racing Stop', async () => {
  await withFolder(async (folder) => {
    seedNames();
    const sink = createGifPartFileSink(folder);
    const stop = new AbortController();
    const closed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeClose = FileSystemWritableFileStream.prototype.close;
    vi.spyOn(FileSystemWritableFileStream.prototype, 'close').mockImplementation(async function (
      this: FileSystemWritableFileStream
    ) {
      await nativeClose.call(this);
      closed.resolve();
      await release.promise;
    });
    const saving = sink.save(part, stop.signal);
    try {
      await closed.promise;
      stop.abort();
    } finally {
      release.resolve();
      await saving;
    }
    expect(sink.count).toBe(1);
    await sink.removeEmptyFolder();
    const result = await folder.getDirectoryHandle(sink.folderName);
    const first = await (await result.getFileHandle(partFilename)).getFile();
    expect(await first.arrayBuffer()).toEqual(bytes);
    await expect(result.getFileHandle(manifestFilename)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

it('keeps data from a file created between absence check and acquisition', async () => {
  await withFolder(async (folder) => {
    seedNames();
    const sink = createGifPartFileSink(folder);
    const originalGet = FileSystemDirectoryHandle.prototype.getFileHandle;
    vi.spyOn(FileSystemDirectoryHandle.prototype, 'getFileHandle').mockImplementation(
      async function (this: FileSystemDirectoryHandle, name, options) {
        const handle = await originalGet.call(this, name, options);
        if (name === partFilename && options?.create) {
          const foreign = await handle.createWritable();
          await foreign.write('another writer');
          await foreign.close();
        }
        return handle;
      }
    );
    await expect(sink.save(part, new AbortController().signal)).rejects.toThrow(
      'already contains data'
    );
    expect(sink.count).toBe(0);
    const result = await folder.getDirectoryHandle(sink.folderName);
    const first = await (await result.getFileHandle(partFilename)).getFile();
    expect(await first.text()).toBe('another writer');
  });
});
