/**
 * Virtual module type declarations.
 *
 * This project uses Vite virtual modules (provided by plugins) to keep
 * runtime CDN URL generation consistent across app code and workers.
 */

declare module 'virtual:cdn-deps' {
  /** Runtime dependency versions taken from package.json (dependencies). */
  export const RUNTIME_DEP_VERSIONS: Record<string, string>;

  /** Primary CDN base URL (currently esm.sh). */
  export const ESM_SH_BASE_URL: string;

  /** esm.sh target parameter used for ESM transpilation (e.g. esnext). */
  export const ESM_SH_TARGET: string;

  /**
   * CDN provider configuration interface
   */
  export interface CDNProvider {
    name: string;
    hostname: string;
    baseUrl: string;
    priority: number;
    timeout: number;
    enabled: boolean;
  }

  /**
   * Unified CDN provider configuration (matches cdn-config.ts)
   * Used for runtime CDN operations and debugging
   */
  export const CDN_PROVIDERS: CDNProvider[];

  /**
   * Gets all enabled CDN providers
   * @returns Array of enabled CDN providers
   */
  export function getCDNProviders(): CDNProvider[];

  /**
   * Builds an esm.sh module URL for a runtime dependency.
   *
   * @example
   * esmShModuleUrl('comlink')
   * esmShModuleUrl('@jsquash/webp', '/encode.js')
   */
  export function esmShModuleUrl(
    pkg: string,
    subpath?: string,
    params?: Record<string, string>
  ): string;

  /**
   * Builds an esm.sh raw asset URL (no target query) for binary resources.
   *
   * @example
   * esmShAssetUrl('@jsquash/webp', '/codec/enc/webp_enc.wasm')
   */
  export function esmShAssetUrl(pkg: string, assetPath: string): string;
}
