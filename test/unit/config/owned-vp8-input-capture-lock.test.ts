import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { writeOwnedVp8InputCaptureLock } from '../../../scripts/test/generate-owned-vp8-input-capture-lock.ts';

describe('owned VP8 input capture lock reuse', () => {
  it('creates a lock exclusively, reuses identical bytes, and preserves a mismatched file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owned-vp8-capture-lock-'));
    const path = join(root, 'lock.json');
    const expected = Buffer.from('{"source":"frozen"}\n');
    const different = Buffer.from('{"source":"staged"}\n');
    try {
      await expect(writeOwnedVp8InputCaptureLock(path, expected)).resolves.toBe('new');
      await expect(writeOwnedVp8InputCaptureLock(path, expected)).resolves.toBe('reused');
      await expect(writeOwnedVp8InputCaptureLock(path, different)).rejects.toThrow(
        /Existing V8 capture lock differs/
      );
      expect(await readFile(path)).toEqual(expected);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('rejects a linked existing lock without reading or replacing its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owned-vp8-capture-link-'));
    const target = join(root, 'target.json');
    const path = join(root, 'lock.json');
    const expected = Buffer.from('{"source":"frozen"}\n');
    try {
      await writeFile(target, expected);
      await symlink(target, path);
      await expect(writeOwnedVp8InputCaptureLock(path, expected)).rejects.toBeDefined();
      expect(await readFile(target)).toEqual(expected);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('rejects oversized, empty, and non-file existing locks without changing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owned-vp8-capture-shape-'));
    const expected = Buffer.from('{"source":"frozen"}\n');
    const cases = [
      { name: 'oversized.json', bytes: Buffer.alloc(8 * 1024 + 1, 0x78) },
      { name: 'empty.json', bytes: Buffer.alloc(0) },
    ];
    try {
      for (const entry of cases) {
        const path = join(root, entry.name);
        await writeFile(path, entry.bytes);
        await expect(writeOwnedVp8InputCaptureLock(path, expected)).rejects.toThrow(
          /Existing V8 capture lock extent differs/
        );
        expect(await readFile(path)).toEqual(entry.bytes);
      }
      const directory = join(root, 'directory.json');
      await mkdir(directory);
      await expect(writeOwnedVp8InputCaptureLock(directory, expected)).rejects.toThrow(
        /Existing V8 capture lock is not an unchanged regular file/
      );
      expect((await stat(directory)).isDirectory()).toBe(true);
      const absent = join(root, 'absent.json');
      await expect(writeOwnedVp8InputCaptureLock(absent, Buffer.alloc(0))).rejects.toThrow(
        /V8 capture lock byte bound differs/
      );
      await expect(
        writeOwnedVp8InputCaptureLock(absent, Buffer.alloc(8 * 1024 + 1))
      ).rejects.toThrow(/V8 capture lock byte bound differs/);
      await expect(stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
