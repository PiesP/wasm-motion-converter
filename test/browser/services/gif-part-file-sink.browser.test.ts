// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createGifPartFileSink } from '@services/gif-part-file-sink';
import { expect, it, vi } from 'vite-plus/test';

const bytes = Uint8Array.from(
  atob('R0lGODlhAQABAIABAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAICRAEAOw=='),
  (character) => character.charCodeAt(0)
).buffer;
const part = { index: 1, startCs: 0, endCs: 50, frameCount: 1, bytes };
const partFilename = 'part-0001_0-50cs.gif';

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
    const sink = createGifPartFileSink(folder);
    const { signal } = new AbortController();
    await sink.save(part, signal);
    await sink.save({ ...part, index: 2, startCs: 50, endCs: 100 }, signal);
    await sink.finish(signal);
    const result = await folder.getDirectoryHandle(sink.folderName);
    const first = await (await result.getFileHandle(partFilename)).getFile();
    expect(await first.arrayBuffer()).toEqual(bytes);
    const manifest = await (await result.getFileHandle('parts.json')).getFile();
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
          filename: 'part-0002_50-100cs.gif',
          bytes: bytes.byteLength,
        },
      ],
    });
  });
});

it('removes an uncommitted file when Stop precedes close', async () => {
  await withFolder(async (folder) => {
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
    await expect(result.getFileHandle('parts.json')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});
