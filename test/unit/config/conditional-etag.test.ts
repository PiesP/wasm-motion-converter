import { describe, expect, it } from 'vite-plus/test';

import { conditionalEtagObservation } from '../../e2e/lib/conditional-etag';

describe('conditional ETag integration compatibility', () => {
  const etag = '"bound-asset"';
  const pages = 'https://wasm-motion-converter.pages.dev/assets/app.1234abcd.js';
  it('reports a matching present validator as conforming to the ETag requirement', () => {
    expect(conditionalEtagObservation(pages, etag, etag, false)).toEqual({
      conditionalEtag: etag,
      rfc9110Etag: true,
      compatibilityException: null,
    });
  });
  it.each([pages, 'https://1234abcd.wasm-motion-converter.pages.dev/assets/app.1234abcd.js'])(
    'reports missing Pages validators as an explicit exception: %s',
    (url) => {
      expect(conditionalEtagObservation(url, etag, undefined, false)).toMatchObject({
        conditionalEtag: null,
        rfc9110Etag: false,
        compatibilityException: 'pages-304-etag-omission',
      });
    }
  );
  it('limits a local omission to the selected maintained Wrangler profile', () => {
    const url = 'http://127.0.0.1:44321/assets/app.1234abcd.js';
    expect(conditionalEtagObservation(url, etag, undefined, true).compatibilityException).toBe(
      'wrangler-304-etag-omission'
    );
    expect(() => conditionalEtagObservation(url, etag, undefined, false)).toThrow('RFC 9110');
    expect(() =>
      conditionalEtagObservation('https://unrelated.test/', etag, undefined, true)
    ).toThrow('RFC 9110');
  });
  it.each(['"different"', ''])('rejects any present mismatched 304 validator: %s', (value) => {
    expect(() => conditionalEtagObservation(pages, etag, value, false)).toThrow('differs');
  });
  it('continues to require a usable validator on 200', () => {
    expect(() => conditionalEtagObservation(pages, '', undefined, false)).toThrow('200 response');
  });
});
