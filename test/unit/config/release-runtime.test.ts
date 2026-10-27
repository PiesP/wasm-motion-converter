import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');

describe('release runtime selection', () => {
  it('uses the exact source file pin and keeps provenance ahead of tagged setup', () => {
    const pin = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/u);
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
    const provenance = workflow.split('  provenance:\n')[1]?.split('\n  quality:')[0] ?? '';
    expect(provenance.indexOf('Checkout protected workflow source')).toBeLessThan(
      provenance.indexOf('Setup trusted provenance runtime')
    );
    expect(provenance.indexOf('Setup trusted provenance runtime')).toBeLessThan(
      provenance.indexOf('Verify tag belongs to protected master')
    );
    expect(provenance).toContain("install-dependencies: 'false'");
    expect(
      workflow.match(/node-version: \$\{\{ needs.provenance.outputs.node-version \}\}/gu)
    ).toHaveLength(4);
  });
});
