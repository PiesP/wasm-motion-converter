// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const EXPECTED_SHA256 = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const EXPECTED_BYTES = 3_145_371;

export async function checkOwnedVp8Inputs(
  directory = resolve(root, 'validation/windows/owned-vp8-inputs'),
  manifest = resolve(root, 'validation/windows/owned-vp8-v8.json')
): Promise<'readme-only' | 'v8-admitted'> {
  const directoryStat = await lstat(directory);
  assert(
    directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
    'Owned VP8 input directory is not an ordinary directory'
  );
  const entries = (await readdir(directory)).sort();
  assert(
    entries.length >= 1 &&
      entries.length <= 2 &&
      entries[0] === 'README.md' &&
      (entries.length === 1 || entries[1] === 'v8.webm'),
    'Owned VP8 input directory contains unexpected entries'
  );
  for (const name of entries) {
    const entry = await lstat(resolve(directory, name));
    assert(
      entry.isFile() && !entry.isSymbolicLink(),
      `Owned VP8 input ${name} is not an ordinary file`
    );
  }
  if (entries.includes('v8.webm')) {
    const file = await readFile(resolve(directory, 'v8.webm'));
    assert.equal(file.length, EXPECTED_BYTES, 'Owned VP8 V8 input size differs from M0');
    assert.equal(
      createHash('sha256').update(file).digest('hex'),
      EXPECTED_SHA256,
      'Owned VP8 V8 input digest differs from M0'
    );
  }
  const specification = JSON.parse(await readFile(manifest, 'utf8')) as {
    input: {
      path: string;
      sha256: string;
      width: number;
      height: number;
      frames: number;
      fps: number;
      durationMs: number;
    };
  };
  assert.deepEqual(
    specification.input,
    {
      path: 'validation/windows/owned-vp8-inputs/v8.webm',
      sha256: EXPECTED_SHA256,
      width: 1920,
      height: 1080,
      frames: 192,
      fps: 30,
      durationMs: 6400,
    },
    'Owned VP8 V8 manifest differs from the frozen M0 input contract'
  );
  return entries.includes('v8.webm') ? 'v8-admitted' : 'readme-only';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = await checkOwnedVp8Inputs();
  process.stdout.write(
    status === 'v8-admitted'
      ? `Owned VP8 V8 input admitted: ${EXPECTED_BYTES} bytes, ${EXPECTED_SHA256}\n`
      : 'Owned VP8 input directory has no staged video; normal build admitted.\n'
  );
}
