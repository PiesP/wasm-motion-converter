/**
 * CDN provider configuration — simplified constant-only file.
 * Used by service worker, FFmpeg loading, and runtime module loading.
 */

export interface CDNProvider {
  name: string;
  hostname: string;
  baseUrl: string;
  priority: number;
  timeout: number;
}

export const CDN_PROVIDERS: CDNProvider[] = [
  { name: 'esm.sh', hostname: 'esm.sh', baseUrl: 'https://esm.sh', priority: 1, timeout: 15000 },
  {
    name: 'jsdelivr',
    hostname: 'cdn.jsdelivr.net',
    baseUrl: 'https://cdn.jsdelivr.net',
    priority: 2,
    timeout: 15000,
  },
  {
    name: 'unpkg',
    hostname: 'unpkg.com',
    baseUrl: 'https://unpkg.com',
    priority: 3,
    timeout: 15000,
  },
];

export function getEnabledProviders(): CDNProvider[] {
  return CDN_PROVIDERS;
}

export function getProviderByHostname(hostname: string): CDNProvider | undefined {
  return CDN_PROVIDERS.find((p) => p.hostname === hostname || hostname.endsWith(`.${p.hostname}`));
}
