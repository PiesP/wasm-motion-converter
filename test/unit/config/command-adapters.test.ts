import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOptionalNose } from '../../../scripts/check/nose.ts';

const projectRoot = resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wmc commands with spaces '));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'scripts/check'), { recursive: true });
  copyFileSync(join(projectRoot, 'scripts/check/bootstrap.ts'), join(root, 'scripts/check/bootstrap.ts'));
  copyFileSync(join(projectRoot, 'scripts/check/nose.ts'), join(root, 'scripts/check/nose.ts'));
  return root;
}

function runCli(root: string, name: string, environment = process.env) {
  return spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/check', name)], {
    cwd: tmpdir(),
    env: environment,
    encoding: 'utf8',
  });
}

describe('dependency-free command adapters', () => {
  it('uses the production scripts for the two command paths', () => {
    expect(manifest.scripts.preinstall).toBe(
      'node --experimental-strip-types scripts/check/bootstrap.ts'
    );
    expect(manifest.scripts['quality:nose']).toBe(
      'node --experimental-strip-types scripts/check/nose.ts'
    );
  });

  it('rejects a missing submodule without dependencies and accepts a file or symlink', () => {
    const root = fixtureRoot();
    const packagePath = join(root, 'packages/core/package.json');
    const missing = runCli(root, 'bootstrap.ts');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('Submodule not initialized');
    expect(missing.stdout).toContain('git submodule update --init --recursive');
    expect(missing.stderr).toBe('');

    mkdirSync(join(root, 'packages/core'), { recursive: true });
    expect(runCli(root, 'bootstrap.ts').status).toBe(1);
    writeFileSync(packagePath, '{}\n');
    expect(runCli(root, 'bootstrap.ts').status).toBe(0);

    const linkedScript = join(root, 'linked-bootstrap.ts');
    symlinkSync(join(root, 'scripts/check/bootstrap.ts'), linkedScript);
    expect(
      spawnSync(process.execPath, ['--experimental-strip-types', linkedScript], {
        cwd: tmpdir(),
        encoding: 'utf8',
      }).status
    ).toBe(0);

    rmSync(join(root, 'packages/core'), { recursive: true });
    const target = join(root, 'core target');
    mkdirSync(target);
    writeFileSync(join(target, 'package.json'), '{}\n');
    symlinkSync(target, join(root, 'packages/core'));
    expect(runCli(root, 'bootstrap.ts').status).toBe(0);
  });

  it('runs the package preinstall lifecycle without node_modules', () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'wmc-command-fixture', private: true, type: 'module', scripts: { preinstall: manifest.scripts.preinstall } })
    );
    const result = spawnSync('pnpm', ['run', 'preinstall'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('git submodule update --init --recursive');
  });

  it('has no side effects when imported', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const record = join(root, 'nose-record');
    writeFileSync(join(fakeBin, 'nose'), '#!/bin/sh\nprintf invoked > "$NOSE_RECORD"\n', {
      mode: 0o755,
    });
    for (const name of ['bootstrap.ts', 'nose.ts']) {
      const url = pathToFileURL(join(root, 'scripts/check', name)).href;
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', `import ${JSON.stringify(url)};`],
        { cwd: tmpdir(), env: { ...process.env, PATH: fakeBin, NOSE_RECORD: record }, encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(existsSync(record)).toBe(false);
    }
  });

  it('skips only when Nose is absent', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'empty-bin');
    mkdirSync(fakeBin);
    const result = runCli(root, 'nose.ts', { ...process.env, PATH: fakeBin });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[nose] not installed — skipping');
  });

  it('fails for an unavailable project directory', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(runOptionalNose(join(tmpdir(), 'wmc-project-does-not-exist'))).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('could not run in project directory'));
    } finally {
      error.mockRestore();
    }
  });

  it('passes the original arguments, project cwd and inherited environment', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const record = join(root, 'nose-record');
    writeFileSync(
      join(fakeBin, 'nose'),
      '#!/bin/sh\nprintf "%s\\n" "$(pwd)" "$NOSE_ENV_MARKER" "$@" > "$NOSE_RECORD"\n',
      { mode: 0o755 }
    );
    const result = runCli(root, 'nose.ts', {
      ...process.env,
      PATH: fakeBin,
      NOSE_ENV_MARKER: 'inherited',
      NOSE_RECORD: record,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(record, 'utf8').split('\n').slice(0, -1)).toEqual([
      root,
      'inherited',
      'query',
      'src',
      '--baseline',
      '.nose-baseline.json',
      '--fail-on',
      'new',
    ]);
    expect(result.stdout).not.toContain('skipping');
  });

  it('propagates installed Nose failure and rejects non-executable files', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const nose = join(fakeBin, 'nose');
    const environment = { ...process.env, PATH: fakeBin };
    writeFileSync(nose, '#!/bin/sh\necho nose-failed >&2\nexit 17\n', { mode: 0o755 });
    const failed = runCli(root, 'nose.ts', environment);
    expect(failed.status).toBe(17);
    expect(failed.stderr).toContain('nose-failed');
    expect(failed.stdout).not.toContain('skipping');

    chmodSync(nose, 0o644);
    const inaccessible = runCli(root, 'nose.ts', environment);
    expect(inaccessible.status).toBe(1);
    expect(inaccessible.stderr).toContain('[nose] could not run:');
    expect(inaccessible.stdout).not.toContain('skipping');
  });

  it.skipIf(process.platform === 'win32')('fails when an installed Nose has a missing interpreter', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'nose'), '#!/no/such/nose-interpreter\n', { mode: 0o755 });
    const result = runCli(root, 'nose.ts', { ...process.env, PATH: fakeBin });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[nose] could not run:');
    expect(result.stdout).not.toContain('skipping');
  });

  it.skipIf(process.platform === 'win32')('propagates a Nose termination signal', () => {
    const root = fixtureRoot();
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'nose'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
    expect(runCli(root, 'nose.ts', { ...process.env, PATH: fakeBin }).signal).toBe('SIGTERM');
  });
});
