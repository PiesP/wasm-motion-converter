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

import type { CDNProvider } from './cdn-config-service';

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
