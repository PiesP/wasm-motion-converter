const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'<>()[\]]+/gi;

/** Return whether a value contains an absolute URL with the exact hostname. */
export function containsUrlHostname(value: string, expectedHostname: string): boolean {
  const candidates = value.match(ABSOLUTE_URL_PATTERN) ?? [];

  return candidates.some((candidate) => {
    try {
      return new URL(candidate).hostname === expectedHostname;
    } catch {
      return false;
    }
  });
}

/** Identify failures caused by the optional Cloudflare Insights beacon. */
export function isCloudflareInsightsResource(value: string): boolean {
  return containsUrlHostname(value, 'static.cloudflareinsights.com');
}
