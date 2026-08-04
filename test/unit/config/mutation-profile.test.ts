import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Fast mutation profile', () => {
  it('fails on regressions, mutates control-flow operators, and preserves reports', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'stryker.conf.fast.json'), 'utf8')
    ) as {
      reporters?: string[];
      thresholds?: { break?: number | null };
      mutator?: { excludedMutations?: string[] };
    };
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');

    expect(config.thresholds?.break).toBeGreaterThan(0);
    expect(config.reporters).toEqual(
      expect.arrayContaining(['clear-text', 'json', 'html'])
    );
    expect(config.mutator?.excludedMutations).not.toEqual(
      expect.arrayContaining(['ConditionalExpression', 'EqualityOperator', 'BooleanLiteral'])
    );
    expect(packageJson.scripts?.['mut:fast']).toBe('stryker run stryker.conf.fast.json');
    expect(workflow).toContain('path: reports/mutation/');
    expect(workflow).toContain('if-no-files-found: error');
  });
});
