import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const vp = join(project, 'node_modules/vite-plus/bin/vp');
const root = mkdtempSync(join(project, 'test/unit/config/__vp_lint_'));
const configFile = join(root, '.oxlintrc.json');

function run(args: string[], useFixtureConfig = true) {
  const result = spawnSync(
    process.execPath,
    [vp, 'lint', ...args, ...(useFixtureConfig ? ['--config', configFile] : [])],
    {
      cwd: project,
      encoding: 'utf8',
    }
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

function fixture(source: string, name = 'control.ts') {
  const file = join(root, name);
  writeFileSync(file, source);
  return { file, path: relative(project, file) };
}

beforeAll(() => {
  const result = spawnSync(process.execPath, [vp, 'lint', '--print-config'], {
    cwd: project,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(result.stdout);
  expect(config.overrides[0].files).toEqual(['src/**']);
  expect(config.ignorePatterns).toContain('packages/core/**');
  expect(config.ignorePatterns).toContain('validation/windows/inputs/**');
  // Route the installed browser rule over this disposable test-only fixture.
  config.jsPlugins = ['vite-plus/oxlint-plugin'];
  config.rules['vite-plus/prefer-vite-plus-imports'] = 'error';
  config.overrides[0].files = ['**/*'];
  const restriction = config.overrides[0].rules['no-restricted-imports'];
  config.overrides[0].rules['no-restricted-imports'] = ['error', restriction[1][0]];
  writeFileSync(configFile, JSON.stringify(config));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('installed Vite+ lint boundaries', () => {
  it('makes warnings fail the maintained lint command without modifying source', () => {
    const source = 'export function control(value: number) { value += 1; return value; }\n';
    const { file, path } = fixture(source);
    const advisory = run([path]);
    expect(advisory.status, advisory.output).toBe(0);
    expect(advisory.output).toContain('no-param-reassign');
    const strict = run([path, '--deny-warnings']);
    expect(strict.status, strict.output).not.toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(source);
    const scripts = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).scripts;
    expect(scripts.lint).toContain('vp lint . --deny-warnings');
    expect(scripts.quality).toContain('pnpm -s lint');
  });

  it.each([
    "export { value } from '../other';",
    "export type { Value } from './child/other';",
    "export const load = () => import('src/other');",
  ])('rejects a restricted browser specifier: %s', (source) => {
    const { path } = fixture(source);
    const result = run([path, '--deny-warnings']);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('no-restricted-imports');
  });

  it('allows same-folder imports', () => {
    const { path } = fixture("export { value } from './same-folder';\n");
    const result = run([path, '--deny-warnings']);
    expect(result.status, result.output).toBe(0);
  });

  it.each([
    [
      'prefer-const',
      'export function control() { let value = 1; return value; }',
      'export const value = 1;',
    ],
    [
      'prefer-exponentiation-operator',
      'export const square = (value: number) => Math.pow(value, 2);',
      'export const square = (value: number) => value ** 2;',
    ],
    [
      'no-self-compare',
      'export const compare = (value: number) => value === value;',
      'export const compare = (value: number) => value === 1;',
    ],
    [
      'array-callback-return',
      'export const mapped = [1].map(() => {});',
      'export const mapped = [1].map((value) => value);',
    ],
    [
      'no-unneeded-ternary',
      'export const flag = (value: boolean) => value ? true : false;',
      'export const flag = (value: boolean) => value;',
    ],
    [
      'no-useless-switch-case',
      'export function control(value: number) { switch (value) { case 1: default: return 0; } }',
      'export function control(value: number) { switch (value) { case 1: return 1; default: return 0; } }',
    ],
    [
      'no-lone-blocks',
      'export function control() { { console.log(1); } }',
      'export function control() { console.log(1); }',
    ],
    [
      'prefer-vite-plus-imports',
      "import type { Plugin } from 'vite'; export type Control = Plugin;",
      "import type { Plugin } from 'vite-plus'; export type Control = Plugin;",
    ],
  ])('enforces native %s and accepts the restored control', (rule, invalid, valid) => {
    const rejected = run(
      [
        fixture(
          `${invalid}\n`,
          rule === 'prefer-vite-plus-imports' ? 'vite.config.ts' : 'control.ts'
        ).path,
        '--deny-warnings',
      ],
      rule !== 'prefer-vite-plus-imports'
    );
    expect(rejected.status, rejected.output).not.toBe(0);
    expect(rejected.output).toContain(rule);
    const accepted = run(
      [
        fixture(`${valid}\n`, rule === 'prefer-vite-plus-imports' ? 'vite.config.ts' : 'control.ts')
          .path,
        '--deny-warnings',
      ],
      rule !== 'prefer-vite-plus-imports'
    );
    expect(accepted.status, accepted.output).toBe(0);
  });
});
