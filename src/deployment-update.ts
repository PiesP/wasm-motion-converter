// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const SOURCE_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const MIN_ATTEMPT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 65_536;

interface DeploymentUpdateOptions {
  sourceSha: string | null;
  onUpdate: () => void;
}

function deploymentUrl(): URL | null {
  try {
    const url = new URL(location.href);
    const localHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin === 'null' || (url.protocol !== 'https:' && !localHttp)) return null;
    return new URL('/deployment-state.json', url.origin);
  } catch {
    return null;
  }
}

async function readMetadata(response: Response, expectedUrl: string): Promise<string> {
  if (
    response.status !== 200 ||
    response.redirected ||
    response.url !== expectedUrl ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new Error('Unusable deployment metadata response');

  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_METADATA_BYTES)
  )
    throw new Error('Invalid deployment metadata length');
  if (!response.body) throw new Error('Missing deployment metadata body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error('Deployment metadata is too large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid deployment metadata schema');
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 1 ||
    metadata.sourceDirty !== false ||
    ![metadata.sourceSha, metadata.treeSha, metadata.coreSha].every(
      (sha) => typeof sha === 'string' && SOURCE_SHA.test(sha)
    ) ||
    typeof metadata.version !== 'string' ||
    metadata.version.length > 64 ||
    !VERSION.test(metadata.version)
  )
    throw new Error('Invalid deployment metadata identity');
  return metadata.sourceSha as string;
}

/** Observe the current deployment at bounded, user-driven page lifecycle points. */
export function observeDeploymentUpdates({
  sourceSha,
  onUpdate,
}: DeploymentUpdateOptions): () => void {
  const url = deploymentUrl();
  if (!sourceSha || !SOURCE_SHA.test(sourceSha) || !url) return () => {};

  let disposed = false;
  let suspended = false;
  let reported = false;
  let inFlight = false;
  let lastAttempt: number | null = null;
  let generation = 0;
  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const invalidate = (): void => {
    generation += 1;
    controller?.abort();
    controller = null;
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    inFlight = false;
  };

  const check = (): void => {
    if (
      disposed ||
      suspended ||
      reported ||
      inFlight ||
      document.visibilityState !== 'visible' ||
      navigator.onLine === false
    )
      return;
    const now = performance.now();
    if (lastAttempt !== null && now - lastAttempt < MIN_ATTEMPT_INTERVAL_MS) return;
    lastAttempt = now;
    inFlight = true;
    const token = ++generation;
    const requestController = new AbortController();
    controller = requestController;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        requestController.abort();
        reject(new Error('Deployment metadata request timed out'));
      }, REQUEST_TIMEOUT_MS);
    });
    let request: Promise<string>;
    try {
      request = fetch(url, {
        cache: 'no-cache',
        redirect: 'error',
        mode: 'same-origin',
        signal: requestController.signal,
      }).then((response) => readMetadata(response, url.href));
    } catch (error) {
      request = Promise.reject(error);
    }
    void Promise.race([request, deadline])
      .then((remoteSha) => {
        if (disposed || suspended || token !== generation || reported || remoteSha === sourceSha)
          return;
        reported = true;
        try {
          onUpdate();
        } catch {
          /* A notice callback must not disrupt the page. */
        }
      })
      .catch(() => {
        /* Offline, malformed, and unavailable metadata are unknown. */
      })
      .finally(() => {
        if (token !== generation) return;
        if (timeout !== null) clearTimeout(timeout);
        timeout = null;
        controller = null;
        inFlight = false;
      });
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') check();
  };
  const onOnline = (): void => {
    check();
  };
  const onPageShow = (): void => {
    if (disposed) return;
    suspended = false;
    check();
  };
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    invalidate();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      cleanup();
      return;
    }
    suspended = true;
    invalidate();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
  check();
  return cleanup;
}
