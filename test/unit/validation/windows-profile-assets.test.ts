import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  installCancellationInspector,
  readCancellationInspector,
} from '../../../validation/windows/cancellation-inspector.ts';
import { installOutputFinalizationObserver } from '../../../validation/windows/output-finalization-observer.ts';
import { installOutputFinalizationObserver as originalOutputObserver } from '../../../validation/windows/output-finalization.ts';
import {
  installCancellationInspector as originalCancellationInspector,
  readCancellationInspector as originalReadCancellationInspector,
} from '../../../validation/windows/profile.ts';

const root = process.cwd();

describe('Windows media profile package', () => {
  it('declares the transitive local TypeScript imports needed by its entrypoint', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'validation/windows/profile.json'), 'utf8')
    ) as { entry: string; assets: string[] };
    const declared = new Set([manifest.entry, ...manifest.assets]);
    const pending = [manifest.entry];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const module = pending.pop()!;
      if (visited.has(module)) continue;
      visited.add(module);
      const path = resolve(root, module);
      expect(existsSync(path), `${module} is missing`).toBe(true);
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"](\.\/[^'"]+\.ts)['"]/g)) {
        const dependency = normalize(join(dirname(module), match[1]!));
        expect(declared.has(dependency), `${module} imports undeclared ${dependency}`).toBe(true);
        pending.push(dependency);
      }
    }
    expect([...visited]).toEqual(
      expect.arrayContaining([
        'validation/windows/cancellation-inspector.ts',
        'validation/windows/output-finalization-observer.ts',
      ])
    );
  });

  it('preserves original controller exports as the browser-safe probe functions', () => {
    expect(originalCancellationInspector).toBe(installCancellationInspector);
    expect(originalReadCancellationInspector).toBe(readCancellationInspector);
    expect(originalOutputObserver).toBe(installOutputFinalizationObserver);
  });
});
