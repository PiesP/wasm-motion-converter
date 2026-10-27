import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  applicationSourceSha,
  fingerprintedAssetHeaders,
  writeDeploymentState,
} from '../../../scripts/build/deployment-state';
import { installPagesVitePlus, pagesBuild } from '../../../scripts/build/pages-build';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wmc-pages-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      version: '0.2.3',
      packageManager: 'pnpm@12.15.0',
    })
  );
  writeFileSync(join(root, '.node-version'), process.versions.node);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'catalog:\n  vite-plus: 1.4.0\n');
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Pages source-build contract', () => {
  it('binds the app to a clean source and leaves dirty/non-Git local builds unknown', () => {
    const root = fixture();
    expect(applicationSourceSha(root)).toBeNull();
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.test']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json', '.node-version', 'pnpm-workspace.yaml']);
    git(['commit', '-qm', 'fixture']);
    const source = git(['rev-parse', 'HEAD']);
    expect(applicationSourceSha(root)).toBe(source);
    writeFileSync(join(root, '.node-version'), 'dirty');
    expect(applicationSourceSha(root)).toBeNull();
    git(['checkout', '--', '.node-version']);
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public/LICENSES.md'), 'Generated only');
    expect(applicationSourceSha(root)).toBe(source);
    vi.stubEnv('CF_PAGES_COMMIT_SHA', 'b'.repeat(40));
    expect(() => applicationSourceSha(root)).toThrow('source SHA');
  });
  const selected = JSON.stringify({
    node: { version: process.versions.node },
    package_manager: { name: 'pnpm', version: '12.15.0' },
  });
  const run =
    (calls: { command: string; args: string[]; environment?: NodeJS.ProcessEnv }[]) =>
    (command: string, args: string[], environment?: NodeJS.ProcessEnv): string => {
      calls.push({ command, args, ...(environment ? { environment } : {}) });
      if (args[0] === '--version') return 'vp v1.4.0';
      if (args[0] === 'env') return selected;
      if (args.includes('rev-parse')) return 'a'.repeat(40);
      return '';
    };

  it('initializes the recorded core before one frozen development install and full build lifecycle', () => {
    const calls: { command: string; args: string[]; environment?: NodeJS.ProcessEnv }[] = [];
    pagesBuild(fixture(), run(calls));
    expect(calls.map(({ command, args }) => `${command} ${args.join(' ')}`)).toEqual([
      'vp --version',
      'vp env current --json',
      'vp env install pnpm',
      'vp --version',
      'git submodule sync --recursive',
      'git submodule update --init --recursive',
      'git rev-parse HEAD:packages/core',
      'git -C packages/core rev-parse HEAD',
      'vp install --frozen-lockfile -- --no-runtime',
      'vp run build',
    ]);
    expect(calls[8]?.environment?.NODE_ENV).toBe('development');
    expect(calls[9]?.environment?.NODE_ENV).toBe('production');
  });

  it('stops before install/build when the Vite+ environment or core differs', () => {
    const root = fixture();
    const wrong = vi.fn((_command: string, args: string[]) =>
      args[0] === '--version'
        ? 'vp v1.4.0'
        : JSON.stringify({
            node: { version: process.versions.node },
            package_manager: { name: 'pnpm', version: '11.25.0' },
          })
    );
    expect(() => pagesBuild(root, wrong)).toThrow('environment differs');
    expect(wrong).toHaveBeenCalledTimes(2);
    const calls: { command: string; args: string[] }[] = [];
    expect(() =>
      pagesBuild(root, (command, args) => {
        calls.push({ command, args });
        if (args[0] === '--version') return 'vp v1.4.0';
        if (args[0] === 'env') return selected;
        return args[0] === '-C' ? 'b'.repeat(40) : 'a'.repeat(40);
      })
    ).toThrow('gitlink mismatch');
    expect(calls.some(({ args }) => args[0] === 'install')).toBe(false);
  });

  it('rejects an altered installer before executing it', () => {
    const calls: string[] = [];
    expect(() =>
      pagesBuild(fixture(), (command) => {
        calls.push(command);
        if (command === 'vp') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        if (command === 'curl') return '#!/bin/bash\necho altered\n';
        throw new Error(`Unexpected command: ${command}`);
      })
    ).toThrow('installer digest mismatch');
    expect(calls).toEqual(['vp', 'curl']);
  });

  it('removes only the installer-owned suffix from existing shell profiles', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    const suffix = `\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`;
    for (const name of ['.bashrc', '.profile']) writeFileSync(join(root, name), `${name}\n`);
    installPagesVitePlus(
      'installer.sh',
      home,
      process.versions.node,
      '1.4.0',
      (command, args, environment) => {
        expect(command).toBe('bash');
        expect(args).toEqual(['installer.sh']);
        expect(environment?.VP_HOME).toBe(home);
        expect(environment?.VP_PM_MANAGER).toBe('yes');
        expect(environment).not.toHaveProperty('HOME');
        for (const name of ['.bashrc', '.profile'])
          writeFileSync(join(root, name), `${name}\n${suffix}`);
        return '';
      },
      root
    );
    for (const name of ['.bashrc', '.profile'])
      expect(readFileSync(join(root, name), 'utf8')).toBe(`${name}\n`);
  });

  it('accepts the exact installer suffix when the original profile is at the read limit', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    const profile = join(root, '.profile');
    const original = Buffer.alloc(4 * 1024 * 1024, 0x61);
    writeFileSync(profile, original);
    installPagesVitePlus(
      'installer.sh',
      home,
      process.versions.node,
      '1.4.0',
      () => {
        writeFileSync(
          profile,
          Buffer.concat([
            original,
            Buffer.from(`\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`),
          ])
        );
        return '';
      },
      root
    );
    expect(readFileSync(profile).equals(original)).toBe(true);
  });

  it('removes a newly created profile only when it contains the exact installer suffix', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    installPagesVitePlus(
      'installer.sh',
      home,
      process.versions.node,
      '1.4.0',
      () => {
        writeFileSync(
          join(root, '.profile'),
          `\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`
        );
        return '';
      },
      root
    );
    expect(existsSync(join(root, '.profile'))).toBe(false);
  });

  it('rejects a replaced profile even when it carries the expected suffix', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    const profile = join(root, '.profile');
    const original = 'original\n';
    const appended = `${original}\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`;
    writeFileSync(profile, original);
    expect(() =>
      installPagesVitePlus(
        'installer.sh',
        home,
        process.versions.node,
        '1.4.0',
        () => {
          renameSync(profile, join(root, 'saved-profile'));
          writeFileSync(profile, appended);
          return '';
        },
        root
      )
    ).toThrow('Installer replaced profile');
    expect(readFileSync(profile, 'utf8')).toBe(appended);
    expect(readFileSync(join(root, 'saved-profile'), 'utf8')).toBe(original);
  });

  it('rejects a symlink replacement without changing its target', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    const profile = join(root, '.profile');
    const target = join(root, 'target');
    writeFileSync(profile, 'original\n');
    writeFileSync(target, 'target remains\n');
    expect(() =>
      installPagesVitePlus(
        'installer.sh',
        home,
        process.versions.node,
        '1.4.0',
        () => {
          rmSync(profile);
          symlinkSync(target, profile);
          return '';
        },
        root
      )
    ).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('target remains\n');
  });

  it('rejects symlink and oversized Node pin inputs before running commands', () => {
    const root = fixture();
    const pin = join(root, '.node-version');
    const target = join(root, 'pin-target');
    writeFileSync(target, process.versions.node);
    rmSync(pin);
    symlinkSync(target, pin);
    const run = vi.fn(() => '');
    expect(() => pagesBuild(root, run)).toThrow();
    expect(run).not.toHaveBeenCalled();
    rmSync(pin);
    writeFileSync(pin, Buffer.alloc(65, 0x32));
    expect(() => pagesBuild(root, run)).toThrow('exceeds 64 bytes');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps unexpected profile edits and the primary installer failure', () => {
    const root = fixture();
    const home = join(root, 'selected-vp');
    const profile = join(root, '.profile');
    writeFileSync(profile, 'original\n');
    const original = new Error('installer failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        installPagesVitePlus(
          'installer.sh',
          home,
          process.versions.node,
          '1.4.0',
          () => {
            writeFileSync(profile, 'original\nconcurrent edit\n');
            throw original;
          },
          root
        )
      ).toThrow(original);
      expect(readFileSync(profile, 'utf8')).toBe('original\nconcurrent edit\n');
      expect(log).toHaveBeenCalledWith(
        'Failed to restore installer-owned profile suffix:',
        expect.objectContaining({
          message: expect.stringContaining('outside its exact Vite+ suffix'),
        })
      );
    } finally {
      log.mockRestore();
    }
  });

  it('runs the runtime qualifier only for explicitly opted-in Pages builds', () => {
    const calls: { command: string; args: string[] }[] = [];
    const execute = (command: string, args: string[]): string => {
      calls.push({ command, args });
      if (args[0] === '--version') return 'vp v1.4.0';
      if (args[0] === 'env') return selected;
      return 'a'.repeat(40);
    };
    vi.stubEnv('PAGES_NODE_QUALIFICATION', '1');
    pagesBuild(fixture(), execute);
    const hasQualifier = ({ args }: { args: string[] }): boolean =>
      args.some((arg) => arg.endsWith('/scripts/build/qualify-pages-runtime.ts'));
    expect(calls.some(hasQualifier)).toBe(false);
    calls.length = 0;
    vi.stubEnv('CF_PAGES', '1');
    pagesBuild(fixture(), execute);
    expect(calls[0]).toEqual({ command: 'vp', args: ['--version'] });
    expect(calls[3]?.command).toBe(process.execPath);
    expect(calls[3]?.args).toEqual([
      '--experimental-strip-types',
      expect.stringMatching(/\/scripts\/build\/qualify-pages-runtime\.ts$/u),
    ]);
    expect(calls.slice(4).some(hasQualifier)).toBe(false);
  });

  it('uses cumulative rules without giving missing or unversioned assets an immutable policy', () => {
    const template = readFileSync(resolve('public/_headers'), 'utf8');
    const headers = fingerprintedAssetHeaders(template, [
      'app.ABCDef12.js',
      'codec-1234abcd.wasm',
      'unversioned.wasm',
    ]);
    const matched = (path: string): string[] => {
      let route = '';
      const values: string[] = [];
      for (const line of headers.split('\n')) {
        if (line.startsWith('/')) route = line;
        const value = /^ {2}Cache-Control: (.+)$/.exec(line)?.[1];
        if (value && (route === '/*' || route === path)) values.push(value);
      }
      return values;
    };
    expect(matched('/assets/app.ABCDef12.js')).toEqual(['public, max-age=31536000, immutable']);
    expect(matched('/assets/codec-1234abcd.wasm')).toEqual(['public, max-age=31536000, immutable']);
    expect(matched('/assets/missing.1234abcd.js')).toEqual([]);
    expect(matched('/assets/unversioned.wasm')).toEqual([]);
    expect(matched('/')).toEqual(['public, max-age=0, must-revalidate']);
    expect(matched('/service-worker.js')).toEqual(['public, max-age=0, must-revalidate']);
  });

  it('records postprocessed bytes and distinct Git/core identity, and rejects a provider source mismatch', () => {
    const root = fixture();
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.test']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json', '.node-version', 'pnpm-workspace.yaml']);
    git(['commit', '-qm', 'fixture']);
    const core = git(['rev-parse', 'HEAD']);
    git(['update-index', '--add', '--cacheinfo', `160000,${core},packages/core`]);
    git(['commit', '-qm', 'pin core']);
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    writeFileSync(join(root, 'dist/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    writeFileSync(join(root, 'dist/index.html'), '<main>fixture</main>');
    writeFileSync(join(root, 'dist/assets/app.1234abcd.js'), 'postprocessed');
    writeDeploymentState(root, join(root, 'dist'));
    const state = JSON.parse(readFileSync(join(root, 'dist/deployment-state.json'), 'utf8'));
    expect(state.sourceSha).toBe(git(['rev-parse', 'HEAD']));
    expect(state.coreSha).toBe(core);
    expect(state.files.map((file: { path: string }) => file.path)).toEqual([
      'assets/app.1234abcd.js',
      'index.html',
    ]);
    expect(state.files[0].size).toBe(13);
    vi.stubEnv('CF_PAGES_COMMIT_SHA', 'b'.repeat(40));
    expect(() => writeDeploymentState(root, join(root, 'dist'))).toThrow('source SHA');
  });
});
