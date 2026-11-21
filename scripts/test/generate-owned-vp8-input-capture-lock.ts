// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Generate a source-bound lock after build:ci, outside the committed source tree. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBuild } from '../../validation/windows/app-update.ts';
import {
  createV8CaptureLock,
  patchV8MainEncoderCallback,
  V8_CAPTURE_LOCK_PATH,
} from '../../validation/windows/helpers/owned-vp8-input-capture.ts';
import { applicationSourceSha } from '../build/deployment-state.ts';

const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAX_CAPTURE_LOCK_BYTES = 8 * 1024;

function sameLockSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read only the bounded opened file and reject replaced paths. */
async function assertExistingLock(path: string, expected: Buffer): Promise<void> {
  assert(
    typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_NONBLOCK === 'number',
    'Existing V8 capture lock reuse requires no-follow and nonblocking file support'
  );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    const named = await lstat(path);
    assert(
      initial.isFile() &&
        named.isFile() &&
        !named.isSymbolicLink() &&
        sameLockSnapshot(initial, named),
      'Existing V8 capture lock is not an unchanged regular file'
    );
    assert(
      initial.size <= MAX_CAPTURE_LOCK_BYTES && initial.size === expected.length,
      'Existing V8 capture lock extent differs'
    );
    const actual = Buffer.alloc(expected.length);
    for (let offset = 0; offset < actual.length;) {
      const { bytesRead } = await file.read(actual, offset, actual.length - offset, offset);
      assert(bytesRead > 0, 'Existing V8 capture lock is truncated');
      offset += bytesRead;
    }
    const { bytesRead } = await file.read(Buffer.alloc(1), 0, 1, actual.length);
    assert.equal(bytesRead, 0, 'Existing V8 capture lock exceeds its frozen extent');
    assert(
      sameLockSnapshot(initial, await file.stat()) && sameLockSnapshot(initial, await lstat(path)),
      'Existing V8 capture lock changed while reading'
    );
    assert(actual.equals(expected), 'Existing V8 capture lock differs');
  } finally {
    await file.close();
  }
}

function git(root: string, ...arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trimEnd();
}

async function validateLocalFile(root: string, relativePath: string): Promise<string> {
  assert(
    relativePath.split('/').every((part) => part && part !== '.' && part !== '..') &&
      !relativePath.startsWith('/') &&
      !relativePath.includes('\\'),
    `V8 capture build path is unsafe: ${relativePath}`
  );
  const path = await realpath(resolve(root, relativePath));
  assert(
    path.startsWith(`${root}${sep}`),
    `V8 capture build path escapes checkout: ${relativePath}`
  );
  const info = await stat(path);
  assert(info.isFile() && info.size > 0, `V8 capture build file is empty: ${relativePath}`);
  return path;
}

/** Preserve an existing lock, including on a failed repeated preparation. */
export async function writeOwnedVp8InputCaptureLock(
  path: string,
  bytes: Uint8Array
): Promise<'new' | 'reused'> {
  assert(
    bytes.byteLength > 0 && bytes.byteLength <= MAX_CAPTURE_LOCK_BYTES,
    'V8 capture lock byte bound differs'
  );
  const expected = Buffer.from(bytes);
  try {
    await writeFile(path, expected, { flag: 'wx', mode: 0o600 });
    return 'new';
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    await assertExistingLock(path, expected);
    return 'reused';
  }
}

export async function generateOwnedVp8InputCaptureLock(root = SOURCE_ROOT): Promise<{
  path: string;
  sha256: string;
  disposition: 'new' | 'reused';
}> {
  const checkout = await realpath(root);
  const sourceSha = git(checkout, 'rev-parse', 'HEAD');
  // The canonical build source guard allows only its generated LICENSES.md
  // exception. The controller checks date-only content and restores it later.
  assert.equal(
    applicationSourceSha(checkout),
    sourceSha,
    'V8 capture source differs from clean HEAD'
  );
  const treeSha = git(checkout, 'rev-parse', 'HEAD^{tree}');
  const coreSha = git(checkout, 'rev-parse', 'HEAD:packages/core');
  const [prior, candidate] = await Promise.all([
    readBuild(checkout, 'validation/windows/prior-dist', validateLocalFile, {
      requireCompiledSource: true,
      verifyInventory: true,
      exactInventory: true,
    }),
    readBuild(checkout, 'dist', validateLocalFile, {
      requireCompiledSource: true,
      verifyInventory: true,
      exactInventory: true,
    }),
  ]);
  assert.equal(candidate.state.sourceSha, sourceSha, 'V8 candidate source differs from clean HEAD');
  assert.equal(candidate.state.treeSha, treeSha, 'V8 candidate tree differs from clean HEAD');
  assert.equal(candidate.state.coreSha, coreSha, 'V8 candidate core differs from clean HEAD');
  const lock = createV8CaptureLock(prior, candidate);
  for (const build of ['prior', 'candidate'] as const) {
    const distribution = build === 'prior' ? prior.relativePath : candidate.relativePath;
    const asset = lock[build].callbackAsset;
    const bytes = await readFile(
      await validateLocalFile(checkout, `${distribution}/${asset.path}`)
    );
    patchV8MainEncoderCallback(bytes, build, asset.size, asset.sha256);
  }
  const bytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  const directory = resolve(checkout, dirname(V8_CAPTURE_LOCK_PATH));
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  assert(
    directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(),
    'V8 capture lock directory differs'
  );
  const path = resolve(checkout, V8_CAPTURE_LOCK_PATH);
  const disposition = await writeOwnedVp8InputCaptureLock(path, bytes);
  return {
    path: V8_CAPTURE_LOCK_PATH,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    disposition,
  };
}

if (import.meta.main) {
  const result = await generateOwnedVp8InputCaptureLock();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
