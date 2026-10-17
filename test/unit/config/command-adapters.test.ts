import { spawnSync } from 'node:child_process';
import {
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

import { afterEach, describe, expect, it } from 'vite-plus/test';

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
  copyFileSync(
    join(projectRoot, 'scripts/check/bootstrap.ts'),
    join(root, 'scripts/check/bootstrap.ts')
  );
  return root;
}

function runCli(root: string, name: string, environment = process.env) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(root, 'scripts/check', name)],
    {
      cwd: tmpdir(),
      env: environment,
      encoding: 'utf8',
    }
  );
}

describe('dependency-free command adapters', () => {
  it('uses the production preinstall script', () => {
    expect(manifest.scripts.preinstall).toBe(
      'node --experimental-strip-types scripts/check/bootstrap.ts'
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
      JSON.stringify({
        name: 'wmc-command-fixture',
        private: true,
        type: 'module',
        scripts: { preinstall: manifest.scripts.preinstall },
      })
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
    const url = pathToFileURL(join(root, 'scripts/check/bootstrap.ts')).href;
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', `import ${JSON.stringify(url)};`],
      { cwd: tmpdir(), encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
