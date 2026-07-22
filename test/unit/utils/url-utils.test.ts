import { describe, expect, it } from 'vitest';
import { containsUrlHostname, isCloudflareInsightsResource } from '../../e2e/fixtures/url-utils';

describe('containsUrlHostname', () => {
  it('matches the exact hostname in a resource message', () => {
    expect(
      containsUrlHostname(
        '503 https://static.cloudflareinsights.com/beacon',
        'static.cloudflareinsights.com',
      ),
    ).toBe(true);
  });

  it('rejects attacker-controlled hostnames containing the allowed hostname', () => {
    expect(
      containsUrlHostname(
        'https://evil-static.cloudflareinsights.com/beacon',
        'static.cloudflareinsights.com',
      ),
    ).toBe(false);
    expect(
      containsUrlHostname(
        'https://example.com/static.cloudflareinsights.com',
        'static.cloudflareinsights.com',
      ),
    ).toBe(false);
  });

  it('ignores malformed URL candidates', () => {
    expect(
      containsUrlHostname(
        'not a URL: https://[static.cloudflareinsights.com',
        'static.cloudflareinsights.com',
      ),
    ).toBe(false);
  });
});

describe('isCloudflareInsightsResource', () => {
  it('recognizes a Cloudflare Insights resource URL', () => {
    expect(
      isCloudflareInsightsResource('https://static.cloudflareinsights.com/beacon'),
    ).toBe(true);
  });

  it('does not recognize a different host', () => {
    expect(isCloudflareInsightsResource('https://example.com/static.cloudflareinsights.com')).toBe(false);
  });
});
