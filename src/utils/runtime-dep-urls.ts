import { CDN_PROVIDERS } from '@utils/cdn-config';
import { getRuntimeDepVersion } from '@utils/runtime-deps';

const buildModuleUrl = (
  providerName: string,
  baseUrl: string,
  pkg: string,
  version: string
): string => {
  switch (providerName) {
    case 'esm.sh':
      return `${baseUrl}/${pkg}@${version}?target=esnext`;
    case 'jsdelivr':
      return `${baseUrl}/npm/${pkg}@${version}/+esm`;
    case 'unpkg':
      return `${baseUrl}/${pkg}@${version}/+esm`;
    default:
      throw new Error(`Unsupported CDN provider for module URLs: ${providerName}`);
  }
};

export function buildRuntimeModuleUrls(packageName: string): string[] {
  const version = getRuntimeDepVersion(packageName);
  return CDN_PROVIDERS.map((p) => buildModuleUrl(p.name, p.baseUrl, packageName, version));
}
