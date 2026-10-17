import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const vp = join(project, 'node_modules/vite-plus/bin/vp');
const root = mkdtempSync(join(project, 'test/unit/config/__vp_lint_'));
const configFile = join(root, '.oxlintrc.json');

function run(args: string[]) {
  const result = spawnSync(process.execPath, [vp, 'lint', ...args, '--config', configFile], {
    cwd: project,
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function fixture(source: string) {
  const file = join(root, 'control.ts');
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
});
