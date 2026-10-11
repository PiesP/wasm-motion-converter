import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationSourceSha, fingerprintedAssetHeaders, writeDeploymentState } from '../../../scripts/build/deployment-state';
import { pagesBuild } from '../../../scripts/build/pages-build';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wmc-pages-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.3', packageManager: 'pnpm@11.26.0', volta: { node: process.versions.node } }));
  writeFileSync(join(root, '.node-version'), process.versions.node);
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
    const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.test']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json', '.node-version']);
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
  it('initializes the recorded core before one frozen development install and the full build lifecycle', () => {
    const calls: { command: string; args: string[]; environment?: NodeJS.ProcessEnv }[] = [];
    const run = (command: string, args: string[], environment?: NodeJS.ProcessEnv): string => {
      calls.push({ command, args, ...(environment ? { environment } : {}) });
      if (args[0] === '--version') return '11.26.0';
      if (args.includes('rev-parse')) return 'a'.repeat(40);
      return '';
    };
    pagesBuild(fixture(), run);
    expect(calls.map(({ command, args }) => `${command} ${args.join(' ')}`)).toEqual([
      'pnpm --version', 'git submodule sync --recursive', 'git submodule update --init --recursive',
      'git rev-parse HEAD:packages/core', 'git -C packages/core rev-parse HEAD',
      'pnpm install --frozen-lockfile --prod=false', 'pnpm build',
    ]);
    expect(calls[5]?.environment?.NODE_ENV).toBe('development');
    expect(calls[6]?.environment?.NODE_ENV).toBe('production');
  });

  it('stops before install/build when the effective package manager or core differs', () => {
    const root = fixture();
    const wrongPnpm = vi.fn(() => '11.25.0');
    expect(() => pagesBuild(root, wrongPnpm)).toThrow('pnpm version');
    expect(wrongPnpm).toHaveBeenCalledTimes(1);
    const calls: string[] = [];
    expect(() => pagesBuild(root, (_command, args) => {
      calls.push(args.join(' '));
      return args[0] === '--version' ? '11.26.0' : args[0] === '-C' ? 'b'.repeat(40) : 'a'.repeat(40);
    })).toThrow('gitlink mismatch');
    expect(calls.some((call) => call.startsWith('install'))).toBe(false);
  });

  it('uses cumulative rules without giving missing or unversioned assets an immutable policy', () => {
    const template = readFileSync(resolve('public/_headers'), 'utf8');
    const headers = fingerprintedAssetHeaders(template, ['app.ABCDef12.js', 'codec-1234abcd.wasm', 'unversioned.wasm']);
    const matched = (path: string): string[] => {
      let route = '';
      const values: string[] = [];
      for (const line of headers.split('\n')) {
        if (line.startsWith('/')) route = line;
        const value = /^  Cache-Control: (.+)$/.exec(line)?.[1];
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
    const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.test']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json', '.node-version']);
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
    expect(state.files.map((file: { path: string }) => file.path)).toEqual(['assets/app.1234abcd.js', 'index.html']);
    expect(state.files[0].size).toBe(13);
    vi.stubEnv('CF_PAGES_COMMIT_SHA', 'b'.repeat(40));
    expect(() => writeDeploymentState(root, join(root, 'dist'))).toThrow('source SHA');
  });
});
