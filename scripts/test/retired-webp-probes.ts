// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

import type { APIRequestContext } from '@playwright/test';

import type { DeploymentFile } from '../build/deployment-state.ts';
import { RETIRED_REQUEST_MODES, RETIRED_WEBP_DELIVERY_FILES } from './retired-webp-assets.ts';

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

export const RETIRED_WEBP_TEST =
  'Retired WebP URLs serve the deployed 404 document in both request modes';

export function retirementErrorDocument(files: readonly DeploymentFile[]): DeploymentFile {
  const document = files.find((file) => file.path === '404.html');
  if (!document) throw new Error('The verified deployment manifest has no 404.html');
  return document;
}

const NO_STORE_COMPANIONS = new Set([
  'no-store',
  'private',
  'no-cache',
  'no-transform',
  'must-revalidate',
  'proxy-revalidate',
]);

function hasNoStorePolicy(header: string | null): boolean {
  if (!header) return false;
  const directives = header
    .toLowerCase()
    .split(',')
    .map((value) => value.trim());
  // A quoted field list or unknown directive cannot supply proof of the required policy.
  return (
    directives.includes('no-store') &&
    directives.every(
      (value) => NO_STORE_COMPANIONS.has(value) || /^(?:s-maxage|max-age)\s*=\s*0$/.test(value)
    )
  );
}

export function retiredWebpResponseIsSafe(
  row: {
    status: number | null;
    cacheControl: string | null;
    contentType: string | null;
    responseSha256: string | null;
    priorSha256: string;
    responseBytes: number | null;
    wasmMagic: boolean | null;
    error: string | null;
  },
  expectedDocument: DeploymentFile
): boolean {
  return (
    row.error === null &&
    row.status === 404 &&
    hasNoStorePolicy(row.cacheControl) &&
    row.contentType !== null &&
    /^text\/html(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(row.contentType.trim()) &&
    row.responseBytes === expectedDocument.size &&
    row.responseSha256 === expectedDocument.sha256 &&
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
      const cacheControl = headers['cache-control'];
      const contentType = headers['content-type'];
      const observed = {
        ...identity,
        status: response.status(),
        cacheControl: cacheControl?.slice(0, MAX_PROBE_HEADER) ?? null,
        contentType: contentType?.slice(0, MAX_PROBE_HEADER) ?? null,
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
            (cacheControl?.length ?? 0) > MAX_PROBE_HEADER ||
            (contentType?.length ?? 0) > MAX_PROBE_HEADER
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
