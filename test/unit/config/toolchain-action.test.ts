import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
const provider =
  'uses: PiesP/browser-core/automation/actions/setup-project@38cd1cb18c9c37e57e8b53a98e811450bb1a18fc';

function job(workflow: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing job ${name}`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return workflow.slice(start, next < 0 ? undefined : start + marker.length + next);
}

describe('qualified Vite+ setup action', () => {
  it('uses the reviewed provider pin without a local setup adapter', () => {
    expect(provider).toMatch(/@[0-9a-f]{40}$/u);
    expect(existsSync(resolve(root, '.github/actions/setup-project/action.yaml'))).toBe(false);
    for (const name of ['quality', 'unit', 'e2e', 'build']) {
      expect(job(ci, name)).toContain(provider);
    }
  });

  it('does not bootstrap Node or pnpm separately in CI', () => {
    expect(ci).not.toContain('uses: actions/setup-node@');
    expect(ci).not.toContain('uses: pnpm/action-setup@');
    expect(ci).not.toContain('run: pnpm install');
  });
});
