// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Generate a source-bound lock after build:ci, outside the committed source tree. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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
    bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024,
    'V8 capture lock byte bound differs'
  );
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return 'new';
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const info = await lstat(path);
    assert(
      info.isFile() && !info.isSymbolicLink(),
      'Existing V8 capture lock is not a regular file'
    );
    assert.deepEqual(await readFile(path), Buffer.from(bytes), 'Existing V8 capture lock differs');
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
