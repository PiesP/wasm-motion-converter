// GitHub Actions expressions are literal workflow assertions.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
const release = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
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
    expect(existsSync(resolve(root, '.github/actions/setup-release/action.yaml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/actions/setup-project/action.yaml'))).toBe(false);
    for (const name of ['quality', 'unit', 'e2e', 'build']) {
      expect(job(ci, name)).toContain(provider);
      expect(job(release, name)).toContain(provider);
      expect(job(release, name)).toContain(
        'node-version: ${{ needs.provenance.outputs.node-version }}'
      );
    }
  });

  it('keeps no-dependency provenance and protected publication setup', () => {
    const provenance = job(release, 'provenance');
    const publish = job(release, 'publish');
    expect(provenance).toContain(provider);
    expect(provenance).toContain("install-dependencies: 'false'");
    expect(publish).toContain(provider);
    expect(publish).toContain('node-version: "${{ needs.provenance.outputs.node-version }}"');
    expect(publish).toContain("install-dependencies: 'false'");
    expect(publish.indexOf('Checkout protected publication guard')).toBeLessThan(
      publish.indexOf('Setup verified Vite+ runtime without dependencies')
    );
    expect(publish.indexOf('Setup verified Vite+ runtime without dependencies')).toBeLessThan(
      publish.indexOf('Check live publication order')
    );
  });

  it('does not bootstrap Node or pnpm separately in current workflows', () => {
    for (const workflow of [ci, release]) {
      expect(workflow).not.toContain('uses: actions/setup-node@');
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: ./.github/actions/setup-release');
      expect(workflow).not.toContain('run: pnpm install');
    }
  });
});
