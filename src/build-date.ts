import { BUILD_DATE_PATH, parseBuildDate } from '@utils/build-date';

import { readDeploymentJson } from './deployment-json.ts';

const STORAGE_KEY = 'dropconvert.build-date';

export async function loadBuildDate(sourceSha: string | null): Promise<string | null> {
  try {
    const url = new URL('/' + BUILD_DATE_PATH, location.href);
    const response = await fetch(url, {
      cache: 'no-cache',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const metadata = await readDeploymentJson(response, url.href, 256);
    const date = parseBuildDate(metadata, sourceSha);
    if (date) {
      if (sourceSha) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ sourceSha, date }));
        } catch {
          /* Storage is optional. */
        }
      }
      return date;
    }
  } catch {
    /* Offline and older deployments can lack matching metadata. */
  }

  // A cached shell may belong to an older deployment. Only reuse its own date.
  if (sourceSha) {
    try {
      return parseBuildDate(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), sourceSha);
    } catch {
      /* No usable date is available. */
    }
  }
  return null;
}
