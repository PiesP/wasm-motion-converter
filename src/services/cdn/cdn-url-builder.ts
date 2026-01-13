/**
 * Unified CDN URL Builder
 *
 * Consolidates URL generation logic for all CDN providers.
 * Handles conversion between different CDN URL formats.
 *
 * Used by:
 * - Service Worker (cascade fallback)
 * - FFmpeg core asset loading
 * - Runtime module loading
 */

import type { CDNProvider } from './cdn-config';

/**
 * Builds a CDN URL for a package
 *
 * @param provider - CDN provider configuration
 * @param packageName - NPM package name (e.g., "solid-js", "@ffmpeg/ffmpeg")
 * @param version - Package version
 * @param subpath - Optional subpath (e.g., "/web", "/dist/index.js")
 * @param queryParams - Optional query parameters
 * @returns Complete CDN URL
 */
export function buildModuleUrl(
  provider: CDNProvider,
  packageName: string,
  version: string,
  subpath = '',
  queryParams: Record<string, string> = {}
): string {
  const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '';

  let url: string;

  switch (provider.name) {
    case 'esm.sh':
      // esm.sh format: https://esm.sh/package@version/subpath?target=esnext
      url = `${provider.baseUrl}/${packageName}@${version}${cleanSubpath}`;
      // Add default target parameter if not specified
      if (!queryParams.target) {
        queryParams.target = 'esnext';
      }
      break;

    case 'jsdelivr':
      // jsdelivr format: https://cdn.jsdelivr.net/npm/package@version/subpath/+esm
      // Note: +esm suffix enables ESM mode
      url = `${provider.baseUrl}/npm/${packageName}@${version}${cleanSubpath}/+esm`;
      break;

    case 'unpkg':
      // unpkg format: https://unpkg.com/package@version/subpath?module
      url = `${provider.baseUrl}/${packageName}@${version}${cleanSubpath}`;
      // Add module parameter for ESM mode if not specified
      if (!queryParams.module) {
        queryParams.module = '';
      }
      break;

    case 'skypack':
      // skypack format: https://cdn.skypack.dev/package@version/subpath
      url = `${provider.baseUrl}/${packageName}@${version}${cleanSubpath}`;
      break;

    default:
      throw new Error(`Unknown CDN provider: ${provider.name}`);
  }

  // Add query parameters
  const queryString = buildQueryString(queryParams);
  if (queryString) {
    url += `?${queryString}`;
  }

  return url;
}

/**
 * Builds a CDN URL for an asset (non-module file)
 *
 * @param provider - CDN provider configuration
 * @param packageName - NPM package name
 * @param version - Package version
 * @param assetPath - Path to the asset within the package
 * @returns Complete CDN URL for the asset
 */
export function buildAssetUrl(
  provider: CDNProvider,
  packageName: string,
  version: string,
  assetPath: string
): string {
  const cleanPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;

  switch (provider.name) {
    case 'esm.sh':
      // esm.sh serves assets without transformation
      return `${provider.baseUrl}/${packageName}@${version}${cleanPath}`;

    case 'jsdelivr':
      // jsdelivr format for assets (no +esm suffix)
      return `${provider.baseUrl}/npm/${packageName}@${version}${cleanPath}`;

    case 'unpkg':
      // unpkg serves assets directly
      return `${provider.baseUrl}/${packageName}@${version}${cleanPath}`;

    case 'skypack':
      // skypack serves assets directly
      return `${provider.baseUrl}/${packageName}@${version}${cleanPath}`;

    default:
      throw new Error(`Unknown CDN provider: ${provider.name}`);
  }
}

/**
 * Converts an esm.sh URL to jsdelivr format
 *
 * @param esmUrl - Original esm.sh URL
 * @returns Equivalent jsdelivr URL or null if conversion fails
 */
export function convertEsmToJsdelivr(esmUrl: string): string | null {
  try {
    const url = new URL(esmUrl);
    if (url.hostname !== 'esm.sh') return null;

    // Extract package info from pathname: /package@version/subpath
    const match = url.pathname.match(/^\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)(.*)?$/);
    if (!match) return null;

    const [, packageName, version, subpath = ''] = match;

    // Convert to jsdelivr format with +esm suffix
    return `https://cdn.jsdelivr.net/npm/${packageName}@${version}${subpath}/+esm`;
  } catch {
    return null;
  }
}

/**
 * Converts an esm.sh URL to unpkg format
 *
 * @param esmUrl - Original esm.sh URL
 * @returns Equivalent unpkg URL or null if conversion fails
 */
export function convertEsmToUnpkg(esmUrl: string): string | null {
  try {
    const url = new URL(esmUrl);
    if (url.hostname !== 'esm.sh') return null;

    // Extract package info from pathname
    const match = url.pathname.match(/^\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)(.*)?$/);
    if (!match) return null;

    const [, packageName, version, subpath = ''] = match;

    // Convert to unpkg format with ?module parameter
    return `https://unpkg.com/${packageName}@${version}${subpath}?module`;
  } catch {
    return null;
  }
}

/**
 * Converts an esm.sh URL to skypack format
 *
 * @param esmUrl - Original esm.sh URL
 * @returns Equivalent skypack URL or null if conversion fails
 */
export function convertEsmToSkypack(esmUrl: string): string | null {
  try {
    const url = new URL(esmUrl);
    if (url.hostname !== 'esm.sh') return null;

    // Extract package info from pathname
    const match = url.pathname.match(/^\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)(.*)?$/);
    if (!match) return null;

    const [, packageName, version, subpath = ''] = match;

    // Convert to skypack format
    return `https://cdn.skypack.dev/${packageName}@${version}${subpath}`;
  } catch {
    return null;
  }
}

/**
 * Builds a query string from an object
 *
 * @param params - Query parameters object
 * @returns Query string (without leading "?")
 */
function buildQueryString(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== null && value !== undefined
  );

  if (entries.length === 0) return '';

  const searchParams = new URLSearchParams();
  for (const [key, value] of entries) {
    searchParams.set(key, value);
  }

  return searchParams.toString();
}

/**
 * Parses a CDN URL to extract package information
 *
 * @param url - CDN URL to parse
 * @returns Package information or null if parsing fails
 */
export function parseCdnUrl(
  url: string
): { packageName: string; version: string; subpath: string; provider: string } | null {
  try {
    const urlObj = new URL(url);

    // Determine provider from hostname
    let provider: string;
    if (urlObj.hostname === 'esm.sh') provider = 'esm.sh';
    else if (urlObj.hostname === 'cdn.jsdelivr.net') provider = 'jsdelivr';
    else if (urlObj.hostname === 'unpkg.com') provider = 'unpkg';
    else if (urlObj.hostname === 'cdn.skypack.dev') provider = 'skypack';
    else return null;

    // Extract package info from pathname
    // Format: /package@version/subpath or /npm/package@version/subpath (jsdelivr)
    let pathname = urlObj.pathname;
    if (provider === 'jsdelivr' && pathname.startsWith('/npm/')) {
      pathname = pathname.substring(4); // Remove /npm/ prefix
    }

    // Remove /+esm suffix from jsdelivr URLs
    if (provider === 'jsdelivr' && pathname.endsWith('/+esm')) {
      pathname = pathname.substring(0, pathname.length - 5);
    }

    const match = pathname.match(/^\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)(.*)?$/);
    if (!match) return null;

    const packageName = match[1];
    const version = match[2];
    const subpath = match[3] || '';

    if (!packageName || !version) return null;

    return { packageName, version, subpath, provider };
  } catch {
    return null;
  }
}
