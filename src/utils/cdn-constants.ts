/**
 * CDN Configuration Constants
 *
 * Defines CDN providers, dependency versions, and URL generation for
 * external module loading. Supports multi-CDN fallback strategy for reliability.
 *
 * Priority order based on:
 * 1. Stability/availability (99.9%+ uptime)
 * 2. Cache hit rate (normalized URLs)
 * 3. Speed/latency (global edge coverage)
 * 4. Cost (free tier sustainability)
 */

/**
 * Dependency versions (must match package.json)
 * Use exact versions (not ranges) to maximize cache hits across sites
 */
export const DEPENDENCY_VERSIONS = {
  'solid-js': '1.9.10',
  'modern-gif': '2.0.4',
  comlink: '4.4.2',
} as const;

/**
 * CDN provider names in priority order
 * Order determines fallback cascade in Service Worker
 */
export const CDN_PROVIDERS = ['esm.sh', 'jsdelivr', 'unpkg', 'skypack'] as const;

/**
 * CDN provider type
 */
export type CDNProvider = (typeof CDN_PROVIDERS)[number];

/**
 * Dependency package names
 */
export type DependencyName = keyof typeof DEPENDENCY_VERSIONS;

/**
 * CDN base URLs for each provider
 */
export const CDN_BASE_URLS: Record<CDNProvider, string> = {
  'esm.sh': 'https://esm.sh',
  jsdelivr: 'https://cdn.jsdelivr.net/npm',
  unpkg: 'https://unpkg.com',
  skypack: 'https://cdn.skypack.dev',
} as const;

/**
 * Special configuration for specific dependencies
 */
interface DependencyConfig {
  /**
   * Sub-exports that should also be available
   * e.g., solid-js has solid-js/web, solid-js/store
   */
  subExports?: string[];

  /**
   * Query parameters to append to CDN URL
   * e.g., ?target=esnext for solid-js to preserve JSX runtime
   */
  queryParams?: Record<CDNProvider, string>;
}

/**
 * Dependency-specific configurations
 */
const DEPENDENCY_CONFIGS: Record<DependencyName, DependencyConfig> = {
  'solid-js': {
    subExports: ['web', 'store', 'h', 'html'],
    queryParams: {
      'esm.sh': 'target=esnext', // Preserve JSX runtime
      jsdelivr: '', // ESM via /+esm suffix
      unpkg: 'module', // ESM mode
      skypack: '', // Native ESM
    },
  },
  'modern-gif': {
    queryParams: {
      'esm.sh': '',
      jsdelivr: '',
      unpkg: 'module',
      skypack: '',
    },
  },
  comlink: {
    queryParams: {
      'esm.sh': '',
      jsdelivr: '',
      unpkg: 'module',
      skypack: '',
    },
  },
};

/**
 * Generates CDN URL for a specific dependency and provider
 *
 * @param dependency - Package name
 * @param provider - CDN provider name
 * @param subExport - Optional sub-export path (e.g., 'web' for solid-js/web)
 * @returns Full CDN URL
 *
 * @example
 * getCDNUrl('solid-js', 'esm.sh')
 * // Returns: 'https://esm.sh/solid-js@1.9.10?target=esnext'
 *
 * getCDNUrl('solid-js', 'esm.sh', 'web')
 * // Returns: 'https://esm.sh/solid-js@1.9.10/web?target=esnext'
 */
export function getCDNUrl(
  dependency: DependencyName,
  provider: CDNProvider,
  subExport?: string
): string {
  const baseUrl = CDN_BASE_URLS[provider];
  const version = DEPENDENCY_VERSIONS[dependency];
  const config = DEPENDENCY_CONFIGS[dependency];

  let url: string;

  // Provider-specific URL format
  switch (provider) {
    case 'esm.sh':
      url = `${baseUrl}/${dependency}@${version}`;
      if (subExport) {
        url += `/${subExport}`;
      }
      break;

    case 'jsdelivr':
      // jsDelivr uses /+esm suffix for ESM version
      url = `${baseUrl}/${dependency}@${version}`;
      if (subExport) {
        url += `/${subExport}`;
      }
      url += '/+esm';
      break;

    case 'unpkg':
      url = `${baseUrl}/${dependency}@${version}`;
      if (subExport) {
        url += `/${subExport}`;
      }
      break;

    case 'skypack':
      url = `${baseUrl}/${dependency}@${version}`;
      if (subExport) {
        url += `/${subExport}`;
      }
      break;

    default:
      throw new Error(`Unknown CDN provider: ${provider}`);
  }

  // Append query parameters if configured
  const queryParam = config.queryParams?.[provider];
  if (queryParam) {
    url += `?${queryParam}`;
  }

  return url;
}

/**
 * Generates all CDN URLs for a dependency in priority order
 * Used by Service Worker for cascade fallback
 *
 * @param dependency - Package name
 * @param subExport - Optional sub-export path
 * @returns Array of CDN URLs in fallback order
 *
 * @example
 * getAllCDNUrls('solid-js')
 * // Returns: [
 * //   'https://esm.sh/solid-js@1.9.10?target=esnext',
 * //   'https://cdn.jsdelivr.net/npm/solid-js@1.9.10/+esm',
 * //   'https://unpkg.com/solid-js@1.9.10?module',
 * //   'https://cdn.skypack.dev/solid-js@1.9.10',
 * // ]
 */
export function getAllCDNUrls(dependency: DependencyName, subExport?: string): string[] {
  return CDN_PROVIDERS.map((provider) => getCDNUrl(dependency, provider, subExport));
}

/**
 * Generates import map entries for all dependencies
 * Used by Vite plugin to inject into index.html
 *
 * @param provider - CDN provider to use (default: 'esm.sh')
 * @returns Import map entries object
 *
 * @example
 * generateImportMap()
 * // Returns: {
 * //   'solid-js': 'https://esm.sh/solid-js@1.9.10?target=esnext',
 * //   'solid-js/web': 'https://esm.sh/solid-js@1.9.10/web?target=esnext',
 * //   'modern-gif': 'https://esm.sh/modern-gif@2.0.4',
 * //   'comlink': 'https://esm.sh/comlink@4.4.2',
 * // }
 */
export function generateImportMap(provider: CDNProvider = 'esm.sh'): Record<string, string> {
  const importMap: Record<string, string> = {};

  // Add main dependencies
  for (const [dependency] of Object.entries(DEPENDENCY_VERSIONS)) {
    const dep = dependency as DependencyName;
    importMap[dep] = getCDNUrl(dep, provider);

    // Add sub-exports
    const subExports = DEPENDENCY_CONFIGS[dep].subExports;
    if (subExports) {
      for (const subExport of subExports) {
        const key = `${dep}/${subExport}`;
        importMap[key] = getCDNUrl(dep, provider, subExport);
      }
    }
  }

  return importMap;
}

/**
 * Converts a URL from one CDN provider to another
 * Used by Service Worker for cascade fallback
 *
 * @param url - Original CDN URL
 * @param targetProvider - Target CDN provider
 * @returns Converted URL or null if not a recognized CDN URL
 *
 * @example
 * convertCDNUrl('https://esm.sh/solid-js@1.9.10?target=esnext', 'jsdelivr')
 * // Returns: 'https://cdn.jsdelivr.net/npm/solid-js@1.9.10/+esm'
 */
export function convertCDNUrl(url: string, targetProvider: CDNProvider): string | null {
  try {
    const urlObj = new URL(url);

    // Extract package and version from URL
    for (const [dependency, version] of Object.entries(DEPENDENCY_VERSIONS)) {
      const dep = dependency as DependencyName;

      // Check if URL contains this dependency
      if (urlObj.pathname.includes(`/${dep}@${version}`)) {
        // Extract sub-export if present
        const pathMatch = urlObj.pathname.match(
          new RegExp(`/${dep}@${version}(?:/(\\w+))?(?:/\\+esm)?`)
        );
        const subExport = pathMatch?.[1];

        return getCDNUrl(dep, targetProvider, subExport);
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * CDN request timeout in milliseconds
 * Each CDN in cascade gets this timeout before trying next
 */
export const CDN_REQUEST_TIMEOUT = 15_000; // 15 seconds

/**
 * Maximum number of CDN retries before giving up
 */
export const MAX_CDN_RETRIES = CDN_PROVIDERS.length;
