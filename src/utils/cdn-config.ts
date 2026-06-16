// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

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
import { getErrorMessage } from './error-utils';

/**
 * Get the pinned version for a runtime dependency from package.json.
 *
 * @param pkg - Package name (e.g., '@ffmpeg/core-mt')
 * @returns Pinned version string
 * @throws Error if the package is not listed in dependencies or cdnDependencies
 */
export function getRuntimeDepVersion(pkg: string): string {
  const v = RUNTIME_DEP_VERSIONS[pkg];
  if (!v) throw new Error(`[runtime-deps] Missing version for ${pkg}`);
  return v;
}

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
  // Only use CDN for packages not installed in dependencies
  if (LOCAL_MODULES.includes(packageName)) {
    return [`/assets/${packageName}.js`];
  }
  return CDN_PROVIDERS.map((p) => buildModuleUrl(p, packageName, version));
}

/** Packages installed as direct dependencies (bundled, not CDN-loaded). */
const LOCAL_MODULES: string[] = (() => {
  // Generated at build time from dependencies ∩ cdnDependencies keys
  // mp4box and web-demuxer were removed — only @ffmpeg/core-mt remains as a CDN dependency.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as {
      dependencies?: Record<string, string>;
      cdnDependencies?: Record<string, string>;
    };
    const cdnDeps = Object.keys(pkg.cdnDependencies ?? {});
    const allDeps = Object.keys(pkg.dependencies ?? {});
    // Local modules = in dependencies but NOT in cdnDependencies
    return allDeps.filter((d) => !cdnDeps.includes(d));
  } catch {
    return [];
  }
})();

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
      const reason = getErrorMessage(error);
      errors.push({ cdn, reason });
    }
  }

  throw new Error(`Failed to load ${moduleName} from all CDN sources (${cdnUrls.length} attempts)`);
}
