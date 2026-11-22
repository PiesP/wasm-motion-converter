import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';

/** Check the identity and size of the same handle used to read the file. */
export async function withRegularFile<T>(
  path: string,
  label: string,
  limit: number,
  consume: (handle: FileHandle, size: number) => Promise<T>
): Promise<T> {
  try {
    // Open first: POSIX flags reject a leaf link and avoid blocking on a FIFO.
    // Windows Node lacks O_NOFOLLOW; compare the handle with the path before
    // consuming bytes. The digest still binds the admitted content.
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = await open(path, flags);
    try {
      const [before, entry] = await Promise.all([handle.stat(), lstat(path)]);
      assert(
        before.isFile() &&
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          before.dev === entry.dev &&
          before.ino === entry.ino,
        `${label} is missing or linked`
      );
      assert(
        Number.isSafeInteger(before.size) && before.size <= limit,
        `${label} exceeds byte limit`
      );
      const value = await consume(handle, before.size);
      const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
      assert(
        after.isFile() &&
          pathAfter.isFile() &&
          !pathAfter.isSymbolicLink() &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          pathAfter.dev === before.dev &&
          pathAfter.ino === before.ino &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs,
        `${label} changed while reading`
      );
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      throw new Error(`${label} is missing or linked`);
    if (error instanceof Error && 'code' in error && error.code !== 'ERR_ASSERTION')
      throw new Error(`${label} is missing or unreadable`);
    throw error;
  }
}

export async function readRegularFile(path: string, label: string, limit: number): Promise<Buffer> {
  return withRegularFile(path, label, limit, async (handle, size) => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(size - offset, 64 * 1024),
        offset
      );
      assert(bytesRead > 0, `${label} changed while reading`);
      offset += bytesRead;
    }
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size);
    assert(bytesRead === 0, `${label} changed while reading`);
    return bytes;
  });
}
