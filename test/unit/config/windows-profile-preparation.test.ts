import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const profile = JSON.parse(
  readFileSync(resolve(root, 'validation/windows/profile.json'), 'utf8')
) as {
  assets: string[];
  preparation: {
    selector_files: string[];
    scenarios: Record<
      string,
      {
        selector: string;
        browsers: string[];
        modes: string[];
        required_inputs: string[];
        generated_assets: string[];
        bundle_asset_policy: string;
        build_commands: string[][];
        unused_full_campaign_assets: string[];
      }
    >;
  };
};
const source = readFileSync(resolve(root, 'validation/windows/profile.ts'), 'utf8');

describe('Windows campaign preparation contract', () => {
  it('covers focused selector paths referenced by the executing profile', () => {
    const referenced = [...source.matchAll(/inputs\/([a-z][a-z0-9-]+\.json)/g)]
      .map((match) => match[1]!)
      .filter((name) => !name.endsWith('-fixtures.json'));
    expect([...new Set(referenced)].sort()).toEqual([...profile.preparation.selector_files].sort());
  });

  it('keeps settings-schema inputs scoped to the branch that executes it', () => {
    const selected = profile.preparation.scenarios['settings-schema']!;
    expect(selected.selector).toBe('settings-schema.json');
    expect(selected.browsers).toEqual(['msedge']);
    expect(selected.modes).toEqual(['desktop']);
    expect(selected.required_inputs).toEqual([
      'dist',
      `validation/windows/inputs/${selected.selector}`,
    ]);
    expect(selected.generated_assets).toEqual(['dist']);
    expect(selected.build_commands).toEqual([['vp', 'run', 'build:ci']]);
    expect(selected.bundle_asset_policy).toBe('source-modules-and-required-inputs');
    const pending = ['validation/windows/profile.ts'];
    const visited = new Set<string>();
    while (pending.length) {
      const name = pending.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const moduleSource = readFileSync(resolve(root, name), 'utf8');
      for (const match of moduleSource.matchAll(/from ['"]\.\/([^'"]+\.ts)['"]/g)) {
        const imported = `validation/windows/${match[1]}`;
        expect(profile.assets).toContain(imported);
        pending.push(imported);
      }
    }
    for (const name of selected.unused_full_campaign_assets) {
      expect(profile.assets).toContain(name);
    }
    const branch = source.slice(
      source.indexOf('const schemaSelector'),
      source.indexOf('const finalizationSelector')
    );
    expect(branch).toContain("{ scenario: 'settings-schema' }");
    expect(branch).not.toMatch(/prior-dist|public-target|PUBLIC_TARGET/);
  });
});
