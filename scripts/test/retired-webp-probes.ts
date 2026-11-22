// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

import type { APIRequestContext } from '@playwright/test';

import {
  isExecutableMediaType,
  RETIRED_REQUEST_MODES,
  RETIRED_WEBP_DELIVERY_FILES,
} from './retired-webp-assets.ts';

export const MAX_PROBE_HEADER = 512;

export function retiredWebpTargets(target: URL) {
  return RETIRED_REQUEST_MODES.flatMap((mode) =>
    RETIRED_WEBP_DELIVERY_FILES.map(({ path, sha256 }) => ({
      mode,
      url: new URL(`/${path}`, target).href,
      priorSha256: sha256,
    }))
  );
}

export function retiredWebpResponseIsSafe(row: {
  status: number | null;
  cacheControl: string | null;
  contentType: string | null;
  responseSha256: string | null;
  priorSha256: string;
  wasmMagic: boolean | null;
  error: string | null;
}): boolean {
  return (
    row.error === null &&
    row.status === 404 &&
    row.cacheControl !== null &&
    !/\bimmutable\b/i.test(row.cacheControl) &&
    row.contentType !== null &&
    !isExecutableMediaType(row.contentType) &&
    row.responseSha256 !== null &&
    row.responseSha256 !== row.priorSha256 &&
    row.wasmMagic === false
  );
}

export async function collectRetiredWebpUrls(
  target: URL,
  contexts: Record<(typeof RETIRED_REQUEST_MODES)[number], Pick<APIRequestContext, 'get'>>
) {
  const rows = [];
  for (const probe of retiredWebpTargets(target)) {
    const identity = { ...probe, observedAt: new Date().toISOString() };
    const noBody = { responseSha256: null, responseBytes: null, wasmMagic: null };
    let response;
    try {
      response = await contexts[probe.mode].get(probe.url, {
        timeout: 10_000,
        maxRedirects: 0,
        failOnStatusCode: false,
        ...(probe.mode === 'revalidated'
          ? { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }
          : {}),
      });
    } catch {
      // Playwright errors can contain request headers. Retain only the failed operation.
      rows.push({
        ...identity,
        status: null,
        cacheControl: null,
        contentType: null,
        cfRay: null,
        cfCacheStatus: null,
        age: null,
        ...noBody,
        error: 'request-failed',
      });
      continue;
    }
    try {
      const headers = response.headers();
      const cacheControl = headers['cache-control'] ?? '';
      const contentType = headers['content-type'] ?? '';
      const observed = {
        ...identity,
        status: response.status(),
        cacheControl: cacheControl.slice(0, MAX_PROBE_HEADER),
        contentType: contentType.slice(0, MAX_PROBE_HEADER),
        cfRay: headers['cf-ray']?.slice(0, MAX_PROBE_HEADER) ?? null,
        cfCacheStatus: headers['cf-cache-status']?.slice(0, MAX_PROBE_HEADER) ?? null,
        age: headers.age?.slice(0, MAX_PROBE_HEADER) ?? null,
      };
      try {
        const bytes = await response.body();
        rows.push({
          ...observed,
          responseSha256: createHash('sha256').update(bytes).digest('hex'),
          responseBytes: bytes.byteLength,
          wasmMagic: bytes.subarray(0, 4).toString('hex') === '0061736d',
          // A truncated policy or MIME header cannot establish a safe response.
          error:
            cacheControl.length > MAX_PROBE_HEADER || contentType.length > MAX_PROBE_HEADER
              ? 'headers-too-long'
              : null,
        });
      } catch {
        rows.push({ ...observed, ...noBody, error: 'body-unavailable' });
      }
    } finally {
      await response.dispose();
    }
  }
  return rows;
}
