import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const vp = join(project, 'node_modules/vite-plus/bin/vp');
const directories: string[] = [];

function lint() {
  const result = spawnSync(process.execPath, [vp, 'lint', 'src', '--deny-warnings'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('native application cycle policy', () => {
  it.each(['static', 'alias', 'type', 're-export', 'tsx', 'worker'] as const)(
    'rejects a %s cycle and passes after the edge is restored',
    (kind) => {
      const parent = join(project, kind === 'worker' ? 'src/services/conversion-worker' : 'src');
      const directory = mkdtempSync(join(parent, '__vp_cycle_'));
      directories.push(directory);
      const alias = `@/${relative(join(project, 'src'), directory)}`;
      const extension = kind === 'tsx' ? 'tsx' : 'ts';
      const a = join(directory, `${kind === 'worker' ? 'worker' : 'a'}.${extension}`);
      const b = join(directory, `b.${extension}`);
      const aSpecifier = kind === 'worker' ? './worker' : './a';
      if (kind === 'type') {
        writeFileSync(a, "import type { B } from './b'; export interface A { b?: B }\n");
        writeFileSync(b, "import type { A } from './a'; export interface B { a?: A }\n");
      } else if (kind === 're-export') {
        writeFileSync(a, "export { b } from './b'; export const a = 1;\n");
        writeFileSync(b, "export { a } from './a'; export const b = 2;\n");
      } else {
        writeFileSync(
          a,
          `import { b } from '${kind === 'alias' ? `${alias}/b` : './b'}'; export function a() { return b(); }\n`
        );
        writeFileSync(
          b,
          `import { a } from '${aSpecifier}'; export function b() { return a(); }\n`
        );
      }
      const rejected = lint();
      expect(rejected.status, rejected.output).not.toBe(0);
      expect(rejected.output).toContain('import(no-cycle)');
      writeFileSync(
        b,
        kind === 'type'
          ? 'export interface B { value?: number }\n'
          : kind === 're-export'
            ? 'export const b = 2;\n'
            : 'export function b() { return 2; }\n'
      );
      const restored = lint();
      expect(restored.status, restored.output).toBe(0);
    }
  );

  it('includes a root source file and a deep dependency', () => {
    const directory = mkdtempSync(join(project, 'src/__vp_cycle_'));
    directories.push(directory);
    const name = relative(join(project, 'src'), directory);
    const rootFile = join(project, `src/${name}.ts`);
    mkdirSync(join(directory, 'deep'));
    try {
      writeFileSync(rootFile, `export { b } from '@/${name}/deep/b'; export const a = 1;\n`);
      writeFileSync(
        join(directory, 'deep/b.ts'),
        `export { a } from '@/${name}'; export const b = 2;\n`
      );
      const rejected = lint();
      expect(rejected.status, rejected.output).not.toBe(0);
      expect(rejected.output).toContain('import(no-cycle)');
      writeFileSync(rootFile, 'export const a = 1;\n');
      const restored = lint();
      expect(restored.status, restored.output).toBe(0);
    } finally {
      rmSync(rootFile, { force: true });
    }
  });
});
