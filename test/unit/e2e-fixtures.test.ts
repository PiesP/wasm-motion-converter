import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateGifMagic, validateWebpMagic, validateFileMagic } from '../e2e/fixtures/validate-magic';

describe('E2E media validation fixtures', () => {
  it('rejects a GIF without its trailer byte', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('GIF89a'),
      0x80,
      0x02,
      0xe0,
      0x01,
      0x00,
      0x00,
      0x00,
    ]);

    expect(validateGifMagic(bytes).valid).toBe(false);
  });

  it('rejects a WebP without a complete chunk header', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('RIFF'),
      0x00,
      0x00,
      0x00,
      0x00,
      ...new TextEncoder().encode('WEBP'),
      ...new TextEncoder().encode('VP8 '),
    ]);

    expect(validateWebpMagic(bytes).valid).toBe(false);
  });
});

describe('E2E fixture security', () => {
  const invalidFileSpecs = ['test/e2e/smoke.spec.ts', 'test/e2e/i18n.spec.ts'];

  it.each(invalidFileSpecs)('%s avoids fixed files in shared OS temp directories', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');

    expect(source).not.toMatch(/\/tmp(?:\/|['"`])/);
  });
});
