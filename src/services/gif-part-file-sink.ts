// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { validateOutput } from './error-recovery';
import type { GifOutputPart } from './gif-encoder-service';

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

export function supportsGifPartSaving(): boolean {
  return (
    window.isSecureContext &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
  );
}

export function selectGifPartDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('Writable directory selection is unavailable');
  return picker.call(window, { mode: 'readwrite' });
}

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function requireMissing(lookup: Promise<FileSystemHandle>): Promise<void> {
  try {
    await lookup;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error('An output entry already exists');
}

async function removeOwnedEntry(
  directory: FileSystemDirectoryHandle,
  entry: FileSystemHandle
): Promise<void> {
  try {
    const current =
      entry.kind === 'file'
        ? await directory.getFileHandle(entry.name)
        : await directory.getDirectoryHandle(entry.name);
    if (!(await entry.isSameEntry(current))) throw new Error('The output entry changed');
    await directory.removeEntry(entry.name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Close is the publication point. Cancellation observed after it preserves the file. */
async function writeNewFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  contents: ArrayBuffer | Blob | string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  await requireMissing(directory.getFileHandle(name));
  signal.throwIfAborted();
  const file = await directory.getFileHandle(name, { create: true });
  // Do not claim an entry containing data if another writer reached it first.
  if ((await file.getFile()).size !== 0) throw new Error('The output entry already contains data');
  let writer: FileSystemWritableFileStream | undefined;
  try {
    signal.throwIfAborted();
    writer = await file.createWritable();
    signal.throwIfAborted();
    if (contents instanceof Blob) {
      await contents.stream().pipeTo(writer, { preventClose: true, signal });
    } else {
      await writer.write(contents);
    }
    signal.throwIfAborted();
    await writer.close();
  } catch (error) {
    // A native write failure can put the stream in an errored state already.
    await writer?.abort().catch(() => undefined);
    try {
      await removeOwnedEntry(directory, file);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Unable to clean up incomplete GIF output');
    }
    throw error;
  }
}

function newFileName(stem: string, extension: string): string {
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  return `${stem}_${token}.${extension}`;
}

export async function saveContinuousGifToDirectory(
  directory: FileSystemDirectoryHandle,
  suggestedName: string,
  file: File,
  signal: AbortSignal
): Promise<string> {
  const filename = newFileName(suggestedName.replace(/\.gif$/i, ''), 'gif');
  await writeNewFile(directory, filename, file, signal);
  return filename;
}

export function createGifPartFileSink(destination: FileSystemDirectoryHandle) {
  const folderName = `dropconvert-gif-${crypto.randomUUID()}`;
  let folder: FileSystemDirectoryHandle | undefined;
  const parts: Array<Omit<GifOutputPart, 'bytes'> & { filename: string; bytes: number }> = [];

  return {
    folderName,
    get count() {
      return parts.length;
    },
    async save(part: GifOutputPart, signal: AbortSignal): Promise<void> {
      const { bytes, ...receipt } = part;
      const view = new Uint8Array(bytes);
      if (!validateOutput(view.subarray(0, 16), 'gif') || view.at(-1) !== 0x3b) {
        throw new Error('Conversion produced an invalid GIF part');
      }
      signal.throwIfAborted();
      if (!folder) {
        await requireMissing(destination.getDirectoryHandle(folderName));
        signal.throwIfAborted();
        folder = await destination.getDirectoryHandle(folderName, { create: true });
      }
      const ordinal = String(part.index).padStart(4, '0');
      const filename = newFileName(`part-${ordinal}_${part.startCs}-${part.endCs}cs`, 'gif');
      await writeNewFile(folder, filename, bytes, signal);
      parts.push({ ...receipt, filename, bytes: bytes.byteLength });
    },
    async finish(signal: AbortSignal): Promise<void> {
      if (!folder || parts.length === 0) throw new Error('Conversion produced no GIF parts');
      const manifest = JSON.stringify({ version: 1, timelineUnit: 'centiseconds', parts }, null, 2);
      await writeNewFile(folder, newFileName('parts', 'json'), manifest + '\n', signal);
    },
    async removeEmptyFolder(): Promise<void> {
      if (folder && parts.length === 0) await removeOwnedEntry(destination, folder);
    },
  };
}
