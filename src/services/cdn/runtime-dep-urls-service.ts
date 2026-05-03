import type { CDNProvider } from '@utils/cdn-config';
import { CDN_PROVIDERS } from '@utils/cdn-config';
import { getRuntimeDepVersion } from '@utils/runtime-deps';

const DEFAULT_PROVIDER_NAMES = ['esm.sh', 'jsdelivr', 'unpkg'] as const;

const buildLegacyModuleUrl = (
  provider: CDNProvider,
  packageName: string,
  version: string
): string => {
  switch (provider.name) {
    case 'esm.sh':
      return `${provider.baseUrl}/${packageName}@${version}?target=esnext`;
    case 'jsdelivr':
      return `${provider.baseUrl}/npm/${packageName}@${version}/+esm`;
    case 'unpkg':
      return `${provider.baseUrl}/${packageName}@${version}/+esm`;
    default:
      throw new Error(`[cdn-deps] Unsupported CDN provider for module URLs: ${provider.name}`);
  }
};

export function buildRuntimeModuleUrls(
  packageName: string,
  providerNames: readonly string[] = DEFAULT_PROVIDER_NAMES
): string[] {
  const version = getRuntimeDepVersion(packageName);
  const providers = CDN_PROVIDERS.filter((provider) => providerNames.includes(provider.name));

  if (providers.length === 0) {
    throw new Error(`[cdn-deps] No enabled CDN providers for ${packageName}`);
  }

  return providers.map((provider) => buildLegacyModuleUrl(provider, packageName, version));
}
