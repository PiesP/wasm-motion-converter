import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const checker = join(project, 'node_modules/vite-plus/bin/vp');

function check(directory: string, source: string) {
  const fixture = mkdtempSync(join(project, 'node_modules/typecheck-probe-'));
  try {
    const file = join(fixture, 'probe.ts');
    writeFileSync(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({ extends: `../../${directory}/tsconfig.json`, include: ['probe.ts'] })
    );
    writeFileSync(file, source);
    return spawnSync(process.execPath, [checker, 'check', '--no-fmt', '--no-lint', file], {
      cwd: project,
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('native type-check context contracts', () => {
  it('keeps scripts on strict NodeNext with erasable syntax', () => {
    const negative = check(
      'scripts',
      'enum Mode { Ready }\nvoid Mode;\nconst optional: { enabled?: boolean } = { enabled: undefined };\nvoid optional;\nconst first: number = [1][0];\nvoid first;\n'
    );
    expect(negative.status).not.toBe(0);
    expect(negative.stdout).toContain('erasableSyntaxOnly');
    expect(negative.stdout).toContain('exactOptionalPropertyTypes');
    expect(negative.stdout).toContain(
      "Type 'number | undefined' is not assignable to type 'number'"
    );
  });

  it('keeps browser source on DOM types without Node globals', () => {
    const positive = check('src', 'const title: string = document.title; void title;\n');
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    const negative = check('src', 'process.pid;\n');
    expect(negative.status).not.toBe(0);
    expect(negative.stdout).toMatch(/typescript\([^)]*\):[^\n]*process/);
  });

  it('keeps the service worker on WebWorker types without DOM or Node globals', () => {
    const positive = check('worker', 'const scope: WorkerGlobalScope = self; void scope;\n');
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    const negative = check('worker', 'document.title;\nprocess.pid;\n');
    expect(negative.status).not.toBe(0);
    expect(negative.stdout).toMatch(/typescript\([^)]*\):[^\n]*document/);
    expect(negative.stdout).toMatch(/typescript\([^)]*\):[^\n]*process/);
  });

  it('allows the Windows validation project to evaluate browser code from Node', () => {
    const positive = check(
      'validation/windows',
      'const title: string = document.title; const pid: number = process.pid; void title; void pid;\n'
    );
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
  });
});
