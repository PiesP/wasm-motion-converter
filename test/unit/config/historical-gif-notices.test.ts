import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, it } from 'vite-plus/test';

it('preserves the exact notice bytes linked from the historical GIF recipient index', () => {
  const root = resolve(import.meta.dirname, '../../../public/notices/historical-gif');
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  const linked = [...index.matchAll(/href="original\/([a-f0-9]{64}\.md)"/g)].map(
    (match) => match[1]
  );
  const files = readdirSync(join(root, 'original')).sort();

  expect(files.length).toBeGreaterThan(0);
  expect([...new Set(linked)].sort()).toEqual(files);
  for (const file of files) {
    const bytes = readFileSync(join(root, 'original', file));
    expect(createHash('sha256').update(bytes).digest('hex') + '.md').toBe(file);
  }
});
