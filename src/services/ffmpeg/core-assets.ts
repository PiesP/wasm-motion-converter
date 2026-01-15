// External dependencies
import { toBlobURL } from "@ffmpeg/util";
import { RUNTIME_DEP_VERSIONS } from "virtual:cdn-deps";

// Internal imports
import { FFMPEG_CORE_VERSION } from "@utils/constants";
import { logger } from "@utils/logger";
import { withTimeout } from "@utils/with-timeout";
import { getEnabledProviders } from "@services/cdn/cdn-config";
import { buildAssetUrl } from "@services/cdn/cdn-url-builder";
import { recordCdnRequest } from "@services/cdn/cdn-health-tracker";

export type FFmpegCoreVariant = "mt" | "st";

const FFMPEG_CORE_ST_VERSION = FFMPEG_CORE_VERSION;

/**
 * Cache name for FFmpeg core assets with version identifier.
 */
const FFMPEG_CACHE_NAME = `ffmpeg-core-${FFMPEG_CORE_VERSION}`;

/**
 * Request idle callback with fallback to setTimeout for browsers that don't support it.
 *
 * @param callback - Function to execute during idle time
 * @param options - Idle callback options including timeout
 * @returns Idle callback ID (or setTimeout ID)
 */
export const requestIdle = (
  callback: IdleRequestCallback,
  options?: IdleRequestOptions
): number => {
  if (typeof requestIdleCallback !== "undefined") {
    return requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    options?.timeout ?? 0
  );
};

/**
 * Check if Cache Storage API is available in current environment.
 */
export const supportsCacheStorage = (): boolean =>
  typeof caches !== "undefined";

/**
 * Load blob URL with cache awareness.
 * Uses Cache Storage API when available for faster repeat loads.
 * Falls back to direct blob URL creation if caching fails.
 *
 * NOTE: This intentionally mirrors the previous in-file implementation to
 * avoid behavior changes during refactoring.
 */
export async function cacheAwareBlobURL(
  url: string,
  mimeType: string
): Promise<string> {
  if (!supportsCacheStorage()) {
    return toBlobURL(url, mimeType);
  }

  const cache = await caches.open(FFMPEG_CACHE_NAME);
  const cachedResponse = await cache.match(url);
  if (cachedResponse) {
    const contentLength = cachedResponse.headers.get("content-length");
    const cachedBlob = await cachedResponse.blob();

    // Validate blob has expected size (not empty/corrupted)
    if (
      cachedBlob.size === 0 ||
      (contentLength && cachedBlob.size < Number.parseInt(contentLength, 10))
    ) {
      logger.warn("ffmpeg", "Cached response appears corrupted, refetching", {
        url,
        expectedSize: contentLength,
        actualSize: cachedBlob.size,
      });
      // Delete corrupted cache entry and fall through to fetch
      await cache.delete(url);
    } else {
      return URL.createObjectURL(cachedBlob);
    }
  }

  const response = await fetch(url, {
    cache: "force-cache",
    credentials: "omit",
  });
  if (!response.ok) {
    return toBlobURL(url, mimeType);
  }

  await cache.put(url, response.clone());
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

type PackageAssetOptions = {
  packageName: string;
  version: string;
  assetPath: string;
  mimeType: string;
  label: string;
};

const FALLBACK_FFMPEG_PACKAGE_VERSION = "0.12.15";
const FFMPEG_CLASS_WORKER_PATH = "/dist/esm/worker.js";

const getFFmpegPackageVersion = (): string =>
  RUNTIME_DEP_VERSIONS["@ffmpeg/ffmpeg"] ?? FALLBACK_FFMPEG_PACKAGE_VERSION;

const normalizeAssetPath = (assetPath: string): string =>
  assetPath.startsWith("/") ? assetPath : `/${assetPath}`;

const getBlobCompatibleProviders = () =>
  getEnabledProviders().filter(
    (p) => p.name !== "esm.sh" && p.name !== "skypack"
  );

const logProviderExclusions = () => ({
  excludedProviders: ["esm.sh", "skypack"],
  exclusionReason: "blob:// incompatibility (shim code with bare imports)",
});

async function loadPackageAsset({
  packageName,
  version,
  assetPath,
  mimeType,
  label,
}: PackageAssetOptions): Promise<string> {
  // Get all enabled CDN providers
  const providers = getBlobCompatibleProviders();

  const errors: Array<{ provider: string; error: string }> = [];

  logger.info("ffmpeg", "Loading FFmpeg asset from CDN providers", {
    label,
    assetPath,
    packageName,
    version,
    providerCount: providers.length,
    ...logProviderExclusions(),
  });

  for (const provider of providers) {
    try {
      // Build URL for this CDN provider
      const url = buildAssetUrl(
        provider,
        packageName,
        version,
        normalizeAssetPath(assetPath)
      );

      logger.debug("ffmpeg", "Trying CDN provider for FFmpeg asset", {
        label,
        assetPath,
        packageName,
        provider: provider.name,
        url,
        timeoutMs: provider.timeout,
      });

      const startTime = performance.now();

      // Load with timeout
      const blobUrl = await withTimeout(
        cacheAwareBlobURL(url, mimeType),
        provider.timeout,
        `Timeout after ${provider.timeout / 1000}s`
      );

      const elapsed = performance.now() - startTime;

      // Record success
      recordCdnRequest(provider.hostname, true);

      logger.info("ffmpeg", "FFmpeg asset loaded successfully", {
        label,
        assetPath,
        packageName,
        provider: provider.name,
        elapsedMs: Math.round(elapsed),
      });

      return blobUrl;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: provider.name, error: errorMsg });

      // Record failure
      recordCdnRequest(provider.hostname, false);

      logger.warn(
        "ffmpeg",
        "FFmpeg asset download failed; trying next provider",
        {
          label,
          assetPath,
          packageName,
          provider: provider.name,
          error: errorMsg,
        }
      );

      // Continue to next CDN
    }
  }

  // All CDNs failed
  const errorSummary = errors
    .map((e) => `${e.provider} (${e.error})`)
    .join(", ");
  throw new Error(
    `Failed to download ${label} from all CDN providers. Errors: ${errorSummary}. Please check your network connection.`
  );
}

/**
 * Clear FFmpeg cache for recovery from corrupted cache entries.
 * Call this when FFmpeg initialization fails repeatedly.
 */
export async function clearFFmpegCache(): Promise<void> {
  if (supportsCacheStorage()) {
    await caches.delete(FFMPEG_CACHE_NAME);
    logger.info("ffmpeg", "FFmpeg cache cleared");
  }
}

/**
 * Load FFmpeg core asset with CDN fallback and timeout protection.
 * Tries all enabled CDN providers in order until one succeeds.
 *
 * @param assetPath - Path to the asset (e.g., "ffmpeg-core.js")
 * @param mimeType - MIME type for blob creation
 * @param label - Human-readable label for error messages
 * @returns Blob URL that can be used to load the asset
 */
export async function loadFFmpegCoreAsset(
  assetPath: string,
  mimeType: string,
  label: string,
  variant: FFmpegCoreVariant = "mt"
): Promise<string> {
  const packageName = variant === "mt" ? "@ffmpeg/core-mt" : "@ffmpeg/core";
  const version =
    variant === "mt" ? FFMPEG_CORE_VERSION : FFMPEG_CORE_ST_VERSION;

  return loadPackageAsset({
    packageName,
    version,
    assetPath: `/dist/esm/${assetPath}`,
    mimeType,
    label,
  });
}

export async function loadFFmpegAsset(
  assetPath: string,
  mimeType: string,
  label: string
): Promise<string> {
  return loadFFmpegCoreAsset(assetPath, mimeType, label, "mt");
}

/**
 * Load the FFmpeg class worker (bridge worker) as a blob URL.
 * Required to avoid cross-origin worker restrictions in production.
 */
export async function loadFFmpegClassWorker(): Promise<string> {
  return loadPackageAsset({
    packageName: "@ffmpeg/ffmpeg",
    version: getFFmpegPackageVersion(),
    assetPath: FFMPEG_CLASS_WORKER_PATH,
    mimeType: "text/javascript",
    label: "FFmpeg class worker",
  });
}
