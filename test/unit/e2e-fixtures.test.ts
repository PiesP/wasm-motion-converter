import { describe, expect, it } from 'vitest';

import { validateGifMagic, validateWebpMagic } from '../../test/e2e/fixtures/verify';

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
