import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  inspectAnimatedWebp,
  validateFileMagic,
  validateGifMagic,
  validateWebpMagic,
} from '../e2e/fixtures/validate-magic';

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

  it('counts animated WebP frames and their encoded durations', () => {
    const bytes = new Uint8Array(60);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBP'), 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);

    for (const [index, durationMs] of [33, 34].entries()) {
      const offset = 12 + index * 24;
      bytes.set(new TextEncoder().encode('ANMF'), offset);
      view.setUint32(offset + 4, 16, true);
      bytes[offset + 20] = durationMs;
    }

    expect(inspectAnimatedWebp(bytes)).toEqual({
      valid: true,
      frameCount: 2,
      durationMs: 67,
    });
  });

  it('rejects an animated WebP chunk that exceeds its RIFF boundary', () => {
    const bytes = new Uint8Array(20);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBP'), 8);
    bytes.set(new TextEncoder().encode('ANMF'), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, 16, true);

    expect(inspectAnimatedWebp(bytes).valid).toBe(false);
  });
});

describe('E2E fixture security', () => {
  const invalidFileSpecs = ['test/e2e/smoke.spec.ts', 'test/e2e/i18n.spec.ts'];

  it.each(invalidFileSpecs)('%s avoids fixed files in shared OS temp directories', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');

    expect(source).not.toMatch(/\/tmp(?:\/|['"`])/);
  });
});
