import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const project = resolve(import.meta.dirname, '../../..');
const biome = join(project, 'node_modules/@biomejs/biome/bin/biome');
const roots: string[] = [];

function fixture(path: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'wmc-biome-'));
  roots.push(root);
  const git = spawnSync('git', ['init', '-q', '--initial-branch=master'], { cwd: root });
  expect(git.status, git.stderr?.toString()).toBe(0);
  copyFileSync(join(project, 'biome.json'), join(root, 'biome.json'));
  copyFileSync(join(project, '.gitignore'), join(root, '.gitignore'));
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [biome, ...args, '--colors=off'], {
      cwd: root,
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { file, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installed Biome scope and browser import boundaries', () => {
  it('rejects warning-only input through the configured lint and quality gates', () => {
    const source = 'export function control(value: number) {\n  value += 1;\n  return value;\n}\n';
    const { file, run } = fixture('scripts/control.ts', source);
    const scripts = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
      .scripts as Record<string, string>;
    const advisory = run(['lint', '.']);
    expect(advisory.status, advisory.output).toBe(0);
    expect(advisory.output).toContain('noParameterAssign');
    for (const name of ['lint', 'quality']) {
      const command = scripts[name]?.split(' && ')[0];
      if (!command) throw new Error(`Missing ${name} command`);
      const result = run(command.split(' ').slice(1));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('noParameterAssign');
      expect(readFileSync(file, 'utf8')).toBe(source);
    }
  });

  it.each([
    'src/style-control.ts',
    'scripts/check/style-control.ts',
    'test/e2e/fixtures/style-control.ts',
    'tooling/vite/style-control.ts',
    'validation/windows/style-control.mjs',
    '.github/actions/setup-release/style-control.mjs',
    'vitest.config.ts',
    'playwright.config.ts',
  ])('checks format, lint and import order in %s without writing bytes', (path) => {
    const source =
      "import { basename } from 'node:path';\nimport { existsSync } from 'node:fs';\nexport const control:any=[basename,existsSync]\n";
    const { file, run } = fixture(path, source);
    const result = run(['ci', path]);
    expect(result.status).not.toBe(0);
    for (const category of ['format', 'noExplicitAny', 'organizeImports']) {
      expect(result.output).toContain(category);
    }
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it.each(['tsconfig.scripts.json', 'tsconfig.test.json', 'test/tsconfig.playwright.json'])(
    'formats maintained TypeScript configuration %s',
    (path) => {
      const { run } = fixture(path, '{"compilerOptions":{"strict":true}}');
      const result = run(['ci', path]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('format');
    }
  );

  it.each([
    'packages/core/src/style-control.ts',
    'node_modules/style-control.ts',
    'test/node_modules/style-control.ts',
    'dist/style-control.js',
    'reports/style-control.ts',
    'validation/windows/inputs/style-control.mjs',
    'validation/windows/prior-dist/style-control.js',
    'validation/windows/public-target.json',
  ])('leaves external, generated and ignored input %s outside the check', (path) => {
    const source = path.endsWith('.json') ? '{not-json' : 'export const control:any=1';
    const { file, run } = fixture(path, source);
    const result = run(['ci', '.', '--max-diagnostics=none']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('noExplicitAny');
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it.each([
    "import { value } from '../other'; export { value };",
    "import type { Value } from '../../other'; export type { Value };",
    "export { value } from '../other';",
    "export type { Value } from '../other';",
    "export * from '../other';",
    "export const load = () => import('../other');",
    "export { value } from 'src/other';",
    "export { value } from '/src/other';",
    "export { value } from './child/other';",
    "export const load = () => import('./child/nested/other');",
  ])('rejects a restricted literal browser module specifier: %s', (source) => {
    const { run } = fixture('src/control.ts', source);
    const result = run(['lint', 'src/control.ts', '--only=style/noRestrictedImports']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('noRestrictedImports');
  });

  it.each([
    ['src/control.ts', "export { value } from './same-folder';"],
    ['src/control.ts', "export { value } from '@services/frame-memory';"],
    ['src/control.ts', "export { value } from '@piesp/browser-core/error';"],
    ['src/control.ts', "export const load = () => import('@services/conversion-pipeline');"],
    ['src/control.ts', "export const worker = new URL('./child/worker.ts', import.meta.url);"],
    ['src/control.ts', 'export const load = (specifier: string) => import(specifier);'],
    ['src/control.ts', "export const load = () => require('../other');"],
    ['scripts/check/control.ts', "export { value } from '../build/run-vite.ts';"],
    ['validation/windows/control.mjs', "export { value } from './child/control.mjs';"],
  ])('permits the documented module/resource contract in %s: %s', (path, source) => {
    const { run } = fixture(path, source);
    const result = run(['lint', path, '--only=style/noRestrictedImports']);
    expect(result.status, result.output).toBe(0);
  });

  it('keeps existing fix commands idempotent and preserves fixture values', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The control asserts literal workflow bytes survive formatting.
    const source = "export const fixture={subject:'${{ github.sha }}',malformed:'{not-json'}\n";
    const { file, run } = fixture('test/control.ts', source);
    const fix = ['check', '--write', '--linter-enabled=false', 'test/control.ts'];
    const first = run(fix);
    expect(first.status, first.output).toBe(0);
    const formatted = readFileSync(file, 'utf8');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The expected value is a literal workflow expression.
    expect(formatted).toContain("subject: '${{ github.sha }}'");
    expect(formatted).toContain("malformed: '{not-json'");
    const second = run(fix);
    expect(second.status, second.output).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(formatted);
  });
});
