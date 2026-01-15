import { RUNTIME_DEP_VERSIONS } from "virtual:cdn-deps";

/**
 * Runtime dependency versions resolved from package.json.
 */
export { RUNTIME_DEP_VERSIONS };

/**
 * Get a runtime dependency version by package name.
 * Throws if the dependency is missing from the runtime map.
 */
export function getRuntimeDepVersion(packageName: string): string {
  const version = RUNTIME_DEP_VERSIONS[packageName];
  if (!version) {
    throw new Error(
      `[runtime-deps] Missing runtime dependency version for ${packageName}`
    );
  }
  return version;
}
