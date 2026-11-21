// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const freezer = 'scripts/test/freeze-demux-oracle.ts';
const lock = 'pnpm-lock.yaml';
const installedLock = 'node_modules/.pnpm/lock.yaml';
const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')) as {
  devDependencies: { mediabunny: string };
};
const version = manifest.devDependencies.mediabunny;
const patch = `patches/mediabunny@${version}.patch`;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function runFreezer(source: string, output: string, input: string) {
  return spawnSync(process.execPath, [resolve(source, freezer), output, input], {
    cwd: dirname(output),
    encoding: 'utf8',
  });
}

it('records the installed version and selected patch and lock digests', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'demux-oracle-valid-'));
  try {
    const id = 'avc-baseline.mp4';
    const input = resolve(directory, id);
    const output = resolve(directory, 'capture.json');
    writeFileSync(
      input,
      Buffer.from(
        readFileSync(resolve(project, 'test/fixtures/owned-demux', `${id}.base64`), 'utf8'),
        'base64'
      )
    );
    const result = runFreezer(project, output, input);
    expect(result.status, result.stderr).toBe(0);
    const capture = JSON.parse(readFileSync(output, 'utf8')) as {
      oracle: unknown;
      fixtures: unknown;
    };
    expect(capture.oracle).toEqual({
      package: 'mediabunny',
      version,
      patchSha256: hash(resolve(project, patch)),
      lockSha256: hash(resolve(project, lock)),
    });
    expect(capture.fixtures).toMatchObject([{ status: 'success', id }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  {
    file: 'package.json',
    change: (text: string) => text.replace(`"mediabunny": "${version}"`, '"mediabunny": "0.0.0"'),
    error: 'Installed MediaBunny does not match the exact development dependency',
  },
  {
    file: 'pnpm-workspace.yaml',
    change: (text: string) => text.replace(`  mediabunny@${version}:`, '  mediabunny@0.0.0:'),
    error: `No configured patch for mediabunny@${version}`,
  },
  {
    file: patch,
    change: (text: string) => text + '\n',
    error: 'pnpm lockfile does not select the configured patch',
  },
  {
    file: lock,
    change: (text: string) => text.replace(`${version}(patch_hash=`, '0.0.0(patch_hash='),
    error: 'pnpm lockfile does not select the configured patch',
  },
  {
    file: 'both copies of the lock',
    changes: [lock, installedLock],
    change: (text: string) =>
      text
        .replace('    dependencies:\n', '    optionalDependencies:\n')
        .replace('    devDependencies:\n', '    dependencies:\n'),
    error: 'pnpm lockfile does not select the configured patch',
  },
  {
    file: installedLock,
    change: (text: string) => text + '\n# stale installed lock\n',
    error: 'Installed pnpm lock does not match pnpm-lock.yaml',
  },
])('rejects a mismatch in $file before writing a capture', ({ file, changes, change, error }) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'demux-oracle-mismatch-'));
  try {
    for (const path of [
      'package.json',
      lock,
      'pnpm-workspace.yaml',
      patch,
      freezer,
      'src/utils/constants.ts',
    ]) {
      const target = resolve(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(project, path), target);
    }
    mkdirSync(resolve(directory, 'node_modules/.pnpm'), { recursive: true });
    const installedConfig = JSON.parse(
      readFileSync(resolve(project, 'node_modules/.modules.yaml'), 'utf8')
    ) as {
      virtualStoreDir: string;
    };
    writeFileSync(
      resolve(directory, 'node_modules/.modules.yaml'),
      JSON.stringify({ virtualStoreDir: '.pnpm' })
    );
    copyFileSync(
      resolve(project, 'node_modules', installedConfig.virtualStoreDir, 'lock.yaml'),
      resolve(directory, installedLock)
    );
    symlinkSync(
      realpathSync(resolve(project, 'node_modules/mediabunny')),
      resolve(directory, 'node_modules/mediabunny'),
      'junction'
    );
    for (const path of changes ?? [file]) {
      const edited = resolve(directory, path);
      writeFileSync(edited, change(readFileSync(edited, 'utf8')));
    }
    const output = resolve(directory, 'capture.json');
    const missingOutput = resolve(directory, 'new.json');
    const input = resolve(directory, 'unused.mp4');
    const original = 'previous capture\n';
    writeFileSync(output, original);

    for (const target of [output, missingOutput]) {
      const result = runFreezer(directory, target, input);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(error);
    }
    expect(readFileSync(output, 'utf8')).toBe(original);
    expect(existsSync(missingOutput)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
