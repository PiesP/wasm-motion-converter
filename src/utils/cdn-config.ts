/**
 * CDN provider configuration and runtime URL loading.
 *
 * Single module for provider definitions, URL building, and CDN loading with fallback.
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

// ---------------------------------------------------------------------------
// Runtime dependency URL builder
// ---------------------------------------------------------------------------

import { RUNTIME_DEP_VERSIONS } from 'virtual:cdn-deps';

function buildModuleUrl(provider: CDNProvider, pkg: string, version: string): string {
  switch (provider.name) {
    case 'esm.sh':
      return `${provider.baseUrl}/${pkg}@${version}?target=esnext`;
    case 'jsdelivr':
      return `${provider.baseUrl}/npm/${pkg}@${version}/+esm`;
    case 'unpkg':
      return `${provider.baseUrl}/${pkg}@${version}/+esm`;
    default:
      throw new Error(`Unsupported CDN provider: ${provider.name}`);
  }
}

export function buildRuntimeModuleUrls(packageName: string): string[] {
  const version = RUNTIME_DEP_VERSIONS[packageName];
  if (!version) throw new Error(`[runtime-deps] Missing version for ${packageName}`);
  return CDN_PROVIDERS.map((p) => buildModuleUrl(p, packageName, version));
}

// ---------------------------------------------------------------------------
// CDN loader with fallback
// ---------------------------------------------------------------------------

export async function loadFromCDN<T>(
  moduleName: string,
  cdnUrls: string[],
  timeoutMs: number = 15000
): Promise<T> {
  const errors: Array<{ cdn: string; reason: string }> = [];

  for (const cdn of cdnUrls) {
    try {
      const module = await Promise.race([
        import(/* @vite-ignore */ cdn),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CDN timeout')), timeoutMs)
        ),
      ]);
      return (module as unknown as { default?: T }).default || (module as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({ cdn, reason });
    }
  }

  throw new Error(`Failed to load ${moduleName} from all CDN sources (${cdnUrls.length} attempts)`);
}
