import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Fast mutation profile', () => {
  it('runs mutation on schedule and manual dispatch with opt-in reuse', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');
    const dispatch = workflow.match(
      / {2}workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\npermissions:/
    )?.[1];

    expect(workflow).toContain('cron: "17 2 * * 0"');
    expect(dispatch).toMatch(
      /reuse_success:\n\s+description:.*\n\s+required: true\n\s+default: false/
    );
    expect(dispatch).not.toMatch(/\bscope:/);
    expect(workflow).toMatch(/\n {2}mutation:\n {4}name: 🧬 Mutation\n {4}runs-on:/);
    expect(workflow).toContain('run: pnpm mut:fast');
    expect(workflow).toMatch(/REUSE_SUCCESS: \$\{\{ inputs\.reuse_success \}\}/);
  });

  it('fails on regressions, mutates control-flow operators, and preserves reports', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'stryker.conf.fast.json'), 'utf8')) as {
      ignoreStatic?: boolean;
      mutate?: string[];
      coverageAnalysis?: string;
      vitest?: { related?: boolean };
      reporters?: string[];
      thresholds?: { break?: number | null };
      mutator?: { excludedMutations?: string[] };
    };
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');
    const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');

    expect(config.thresholds?.break).toBe(70);
    expect(config.coverageAnalysis).toBe('perTest');
    expect(config.vitest?.related).toBe(true);
    expect(config.ignoreStatic).toBe(true);
    expect(config.mutate).toEqual(
      expect.arrayContaining(['!src/utils/dom-utils.ts', '!src/utils/mediabunny-utils.ts'])
    );
    expect(config.reporters).toEqual(expect.arrayContaining(['clear-text', 'json', 'html']));
    expect(config.mutator?.excludedMutations).not.toContain('ConditionalExpression');
    expect(config.mutator?.excludedMutations).not.toContain('EqualityOperator');
    expect(config.mutator?.excludedMutations).not.toContain('BooleanLiteral');
    expect(packageJson.scripts?.['mut:fast']).toBe(
      'node --experimental-strip-types scripts/ci/mutation-workspace.ts run fast'
    );
    expect(workflow).not.toContain('\n  push:\n');
    expect(ciWorkflow).not.toContain('name: pr-gate/duplication');
    expect(workflow).toContain('path: reports/mutation/');
    expect(workflow).toContain('if-no-files-found: error');
  });
});
