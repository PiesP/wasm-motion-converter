import type { Page } from '@playwright/test';

/** Observe page timing only; dedicated-worker requests may not appear here. */
export function firstConversionTraffic(
  page: Page,
  scenario: 'normal-gif' | 'forced-webp-wasm'
): { markInitial: () => Promise<void>; observation: (outputBytes: number) => Promise<unknown> } {
  let phaseBoundaryMs: number | null = null;
  const encodings = new Map<string, { value: string; responses: number }>();
  page.on('response', (response) => {
    const previous = encodings.get(response.url());
    encodings.set(response.url(), {
      value: response.headers()['content-encoding'] ?? 'identity',
      responses: (previous?.responses ?? 0) + 1,
    });
  });
  return {
    markInitial: async () => {
      phaseBoundaryMs = await page.evaluate(() => performance.now());
    },
    observation: async (outputBytes) => {
      if (phaseBoundaryMs === null) throw new Error('First-conversion boundary was not marked');
      const resources = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter(
            (entry): entry is PerformanceResourceTiming =>
              entry instanceof PerformanceResourceTiming &&
              new URL(entry.name).origin === location.origin &&
              /\.(?:js|css|wasm)$/.test(new URL(entry.name).pathname)
          )
          .map((entry) => ({
            url: entry.name,
            path: new URL(entry.name).pathname,
            initiatorType: entry.initiatorType,
            startTime: entry.startTime,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
          }))
      );
      return {
        schemaVersion: 1,
        target: page.url(),
        measuredAt: new Date().toISOString(),
        browserVersion: page.context().browser()?.version() ?? 'unavailable',
        scenario,
        phase: 'cumulative-first-conversion',
        phaseBoundaryMs,
        cache: 'fresh-browser-context-http-cache-not-disabled',
        serviceWorkers: 'blocked',
        coverage: 'page-resource-timing-only-worker-internal-traffic-unknown',
        contentEncoding: 'response-header-when-observed-null-is-unavailable',
        runtimeMemoryBytes: null,
        outputBytes,
        resources: resources.map(({ url, ...row }) => ({
          ...row,
          // Timing has no request identity; repeated URLs cannot be paired safely.
          contentEncoding:
            encodings.get(url)?.responses === 1 &&
            resources.filter((entry) => entry.url === url).length === 1
              ? encodings.get(url)!.value
              : null,
        })),
      };
    },
  };
}
