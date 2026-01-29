
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const SW_VERSION = "v1.0.0";

const CACHE_VERSION = "v1";

const CACHE_NAMES = {
  cdn: `cdn-deps-${CACHE_VERSION}`,
  ffmpeg: `ffmpeg-core-${CACHE_VERSION}`, // Preserve existing FFmpeg cache
  app: `app-bundle-${CACHE_VERSION}`,
  fallback: `fallback-${CACHE_VERSION}`,
} as const;

const ALL_CACHE_NAMES = Object.values(CACHE_NAMES);

type RuntimeDepVersions = Record<string, string>;
const RUNTIME_DEP_VERSIONS = JSON.parse(
  "__RUNTIME_DEP_VERSIONS__"
) as RuntimeDepVersions;

const getRuntimeDepVersion = (pkg: string): string => {
  const version = RUNTIME_DEP_VERSIONS[pkg];
  if (!version) {
    throw new Error(
      `[SW ${SW_VERSION}] Missing runtime dependency version for ${pkg}`
    );
  }
  return version;
};

const PRECACHE_URLS: string[] = "PRECACHE_MANIFEST" as unknown as string[];

const ffmpegPackageVersion = getRuntimeDepVersion("@ffmpeg/ffmpeg");
const ffmpegUtilVersion = getRuntimeDepVersion("@ffmpeg/util");
const ffmpegCoreVersion = getRuntimeDepVersion("@ffmpeg/core-mt");

const FFMPEG_PRECACHE_URLS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${ffmpegPackageVersion}/+esm`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/util@${ffmpegUtilVersion}/+esm`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${ffmpegCoreVersion}/dist/esm/ffmpeg-core.js`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${ffmpegCoreVersion}/dist/esm/ffmpeg-core.wasm`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${ffmpegCoreVersion}/dist/esm/ffmpeg-core.worker.js`,
];

const mp4boxVersion = getRuntimeDepVersion("mp4box");
const webDemuxerVersion = getRuntimeDepVersion("web-demuxer");

const DEMUXER_PRECACHE_URLS = [
  `https://esm.sh/mp4box@${mp4boxVersion}?target=esnext`,
  `https://esm.sh/web-demuxer@${webDemuxerVersion}?target=esnext`,
];

interface CDNProvider {
  name: string;
  hostname: string;
  priority: number;
  healthScore: number;
}

const CDN_PROVIDERS: CDNProvider[] = [
  { name: "esm.sh", hostname: "esm.sh", priority: 1, healthScore: 100 },
  {
    name: "jsdelivr",
    hostname: "cdn.jsdelivr.net",
    priority: 2,
    healthScore: 100,
  },
  { name: "unpkg", hostname: "unpkg.com", priority: 3, healthScore: 100 },
  {
    name: "skypack",
    hostname: "cdn.skypack.dev",
    priority: 4,
    healthScore: 100,
  },
];

const CDN_DOMAINS = CDN_PROVIDERS.map((p) => p.hostname);

interface CDNEntry {
  url: string;
  integrity: string;
  size: number;
}

interface ManifestEntry {
  "esm.sh": CDNEntry;
  jsdelivr: CDNEntry;
  unpkg: CDNEntry;
  skypack?: CDNEntry;
}

interface SRIManifest {
  version: string;
  generated: string;
  entries: Record<string, ManifestEntry>;
}

let sriManifest: SRIManifest | null = null;

async function loadSRIManifest(): Promise<SRIManifest | null> {
  if (sriManifest) {
    return sriManifest;
  }

  try {
    const response = await fetch("/cdn-integrity.json");
    if (!response.ok) {
      console.warn(
        `[SW ${SW_VERSION}] Failed to load SRI manifest: HTTP ${response.status}`
      );
      return null;
    }

    sriManifest = (await response.json()) as SRIManifest;
    console.log(
      `[SW ${SW_VERSION}] SRI manifest loaded: ${
        Object.keys(sriManifest.entries).length
      } entries`
    );
    return sriManifest;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Error loading SRI manifest:`, error);
    return null;
  }
}

async function verifyIntegrity(
  response: Response,
  expectedIntegrity: string
): Promise<boolean> {
  try {
    const buffer = await response.clone().arrayBuffer();

    const hashBuffer = await crypto.subtle.digest("SHA-384", buffer);

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode(...hashArray));
    const computedIntegrity = `sha384-${hashBase64}`;

    const isValid = computedIntegrity === expectedIntegrity;

    if (!isValid) {
      console.error(
        `[SW ${SW_VERSION}] ✗ Integrity verification failed!`,
        `\n  Expected: ${expectedIntegrity}`,
        `\n  Computed: ${computedIntegrity}`,
        `\n  URL: ${response.url}`
      );
    }

    return isValid;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Error verifying integrity:`, error);
    return false;
  }
}

function getExpectedIntegrity(
  url: string,
  manifest: SRIManifest
): string | null {
  const urlObj = new URL(url);

  let cdnProvider: keyof ManifestEntry | null = null;
  if (urlObj.hostname === "esm.sh") cdnProvider = "esm.sh";
  else if (urlObj.hostname === "cdn.jsdelivr.net") cdnProvider = "jsdelivr";
  else if (urlObj.hostname === "unpkg.com") cdnProvider = "unpkg";
  else if (urlObj.hostname === "cdn.skypack.dev") cdnProvider = "skypack";

  if (!cdnProvider) {
    return null;
  }

  for (const [_pkg, entry] of Object.entries(manifest.entries)) {
    const cdnEntry = entry[cdnProvider];
    if (cdnEntry && cdnEntry.url === url) {
      return cdnEntry.integrity;
    }
  }

  return null;
}

interface HealthMetric {
  hostname: string;
  successCount: number;
  failureCount: number;
  totalCount: number;
  successRate: number;
  lastUpdated: number;
}

interface HealthTrackingData {
  version: number;
  metrics: Record<string, HealthMetric>;
  createdAt: number;
}

function loadHealthScores(): Map<string, number> {
  const scores = new Map<string, number>();

  try {
    const stored = localStorage.getItem("cdn_health_tracking");
    if (!stored) return scores;

    const data = JSON.parse(stored) as HealthTrackingData;

    const age = Date.now() - data.createdAt;
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;
    if (age > TTL_MS) {
      return scores;
    }

    for (const [hostname, metric] of Object.entries(data.metrics)) {
      const healthScore = Math.round(metric.successRate * 100);
      scores.set(hostname, healthScore);
    }

    console.log(
      `[SW ${SW_VERSION}] Loaded health scores:`,
      Object.fromEntries(scores)
    );
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Failed to load health scores:`, error);
  }

  return scores;
}

function updateHealthScore(hostname: string, success: boolean): void {
  try {
    const stored = localStorage.getItem("cdn_health_tracking");
    let data: HealthTrackingData;

    if (stored) {
      data = JSON.parse(stored) as HealthTrackingData;
    } else {
      data = {
        version: 1,
        metrics: {},
        createdAt: Date.now(),
      };
    }

    if (!data.metrics[hostname]) {
      data.metrics[hostname] = {
        hostname,
        successCount: 0,
        failureCount: 0,
        totalCount: 0,
        successRate: 1.0,
        lastUpdated: Date.now(),
      };
    }

    const metric = data.metrics[hostname];

    if (success) {
      metric.successCount++;
    } else {
      metric.failureCount++;
    }
    metric.totalCount = metric.successCount + metric.failureCount;
    metric.successRate =
      metric.totalCount > 0 ? metric.successCount / metric.totalCount : 1.0;
    metric.lastUpdated = Date.now();

    localStorage.setItem("cdn_health_tracking", JSON.stringify(data));
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Failed to update health score:`, error);
  }
}

function getOrderedProviders(): CDNProvider[] {
  const healthScores = loadHealthScores();

  const providers = CDN_PROVIDERS.map((p) => ({
    ...p,
    healthScore: healthScores.get(p.hostname) ?? p.healthScore,
  }));

  providers.sort((a, b) => {
    if (a.healthScore !== b.healthScore) {
      return b.healthScore - a.healthScore;
    }
    return a.priority - b.priority;
  });

  console.log(
    `[SW ${SW_VERSION}] CDN order:`,
    providers.map((p) => `${p.name} (${p.healthScore})`)
  );

  return providers;
}

type RequestType = "cdn" | "ffmpeg" | "app" | "ignore";

function classifyRequest(url: URL): RequestType {
  if (
    CDN_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  ) {
    return "cdn";
  }

  if (url.pathname.includes("@ffmpeg/core")) {
    return "ffmpeg";
  }

  if (url.pathname.startsWith("/assets/")) {
    return "app";
  }

  return "ignore";
}

function isWorkerRequest(request: Request): boolean {
  const url = new URL(request.url);

  const workerPatterns = [
    "/worker.js",
    "/worker.mjs",
    "ffmpeg/dist/esm/worker",
  ];

  return (
    workerPatterns.some((pattern) => url.pathname.includes(pattern)) ||
    request.destination === "worker" ||
    request.mode === "same-origin"
  );
}

self.addEventListener("install", (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  self.skipWaiting();

  event.waitUntil(
    (async () => {
      const fallbackCache = await caches.open(CACHE_NAMES.fallback);

      const appCache = await caches.open(CACHE_NAMES.app);
      try {
        await appCache.addAll(PRECACHE_URLS);
        console.log(`[SW ${SW_VERSION}] App shell pre-cached`);
      } catch (error) {
        console.warn(
          `[SW ${SW_VERSION}] Failed to pre-cache app shell:`,
          error
        );
      }

      const ffmpegCache = await caches.open(CACHE_NAMES.ffmpeg);
      try {
        await Promise.allSettled(
          FFMPEG_PRECACHE_URLS.map((url) =>
            fetch(url).then((res) => {
              if (res.ok) return ffmpegCache.put(url, res);
            })
          )
        );
        console.log(
          `[SW ${SW_VERSION}] FFmpeg assets pre-cached (best effort)`
        );
      } catch (error) {
        console.warn(`[SW ${SW_VERSION}] Failed to pre-cache FFmpeg:`, error);
      }

      const cdnCache = await caches.open(CACHE_NAMES.cdn);
      try {
        const manifest = await loadSRIManifest();

        const sriUrls: string[] = manifest
          ? Object.values(manifest.entries)
              .map((entry) => entry["esm.sh"]?.url)
              .filter(
                (url): url is string =>
                  typeof url === "string" && url.length > 0
              )
          : [];

        const urls = Array.from(
          new Set([...DEMUXER_PRECACHE_URLS, ...sriUrls])
        );

        await Promise.allSettled(
          urls.map(async (url) => {
            try {
              const response = await fetchWithCascade(url, 15000, false);
              if (!response.ok) {
                return;
              }
              await cdnCache.put(url, response.clone());
              await fallbackCache.put(url, response.clone());
            } catch (error) {
              console.warn(
                `[SW ${SW_VERSION}] CDN pre-cache failed: ${url}`,
                error
              );
            }
          })
        );

        console.log(`[SW ${SW_VERSION}] CDN deps pre-cached (best effort)`, {
          count: urls.length,
        });
      } catch (error) {
        console.warn(`[SW ${SW_VERSION}] Failed to pre-cache CDN deps:`, error);
      }
    })()
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      const validCacheNames = ALL_CACHE_NAMES as readonly string[];
      await Promise.all(
        cacheNames.map((cacheName) => {
          if (!validCacheNames.includes(cacheName)) {
            console.log(`[SW ${SW_VERSION}] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );

      await self.clients.claim();
      console.log(`[SW ${SW_VERSION}] Activated and claimed clients`);
    })()
  );
});

async function fetchWithTimeout(
  request: Request,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

const CDN_CONVERTERS = {
  parseEsmSh(
    url: string
  ): { pkg: string; version: string; path: string; isAsset: boolean } | null {
    try {
      const u = new URL(url);
      if (u.hostname !== "esm.sh" && !u.hostname.endsWith(".esm.sh")) {
        return null;
      }

      const pathname = u.pathname.startsWith("/")
        ? u.pathname.slice(1)
        : u.pathname;
      const match = pathname.match(
        /^((?:@[^/]+\/[^@/]+)|(?:[^@/]+))@([^/]+)(\/.*)?$/
      );
      if (!match) {
        return null;
      }

      const pkg = match[1];
      const version = match[2];
      const rawPath = match[3] ?? "";

      if (!pkg || !version) {
        return null;
      }

      const path = rawPath || "";

      const lower = path.toLowerCase();
      const isAsset =
        lower.endsWith(".wasm") ||
        lower.endsWith(".data") ||
        lower.endsWith(".bin") ||
        lower.endsWith(".png") ||
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".gif") ||
        lower.endsWith(".webp") ||
        lower.endsWith(".svg") ||
        lower.endsWith(".css") ||
        lower.endsWith(".map");

      return { pkg, version, path, isAsset };
    } catch {
      return null;
    }
  },

  esmToJsdelivr(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    if (parsed.isAsset) {
      return `https://cdn.jsdelivr.net/npm/${parsed.pkg}@${parsed.version}${parsed.path}`;
    }

    return `https://cdn.jsdelivr.net/npm/${parsed.pkg}@${parsed.version}${parsed.path}/+esm`;
  },

  esmToUnpkg(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    if (parsed.isAsset) {
      return `https://unpkg.com/${parsed.pkg}@${parsed.version}${parsed.path}`;
    }

    return `https://unpkg.com/${parsed.pkg}@${parsed.version}${parsed.path}?module`;
  },

  esmToSkypack(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    if (parsed.isAsset) {
      return null;
    }

    return `https://cdn.skypack.dev/${parsed.pkg}@${parsed.version}${parsed.path}`;
  },
};

interface CDNMetrics {
  url: string;
  cdnName: string;
  latency: number;
  success: boolean;
  status?: number;
  error?: string;
  timestamp: number;
}

function logCDNMetrics(metrics: CDNMetrics): void {
  const emoji = metrics.success ? "✓" : "✗";
  const latencyMs = metrics.latency.toFixed(0);

  if (metrics.success) {
    console.log(
      `[SW ${SW_VERSION}] ${emoji} ${metrics.cdnName}: ${latencyMs}ms (HTTP ${metrics.status})`
    );
  } else {
    console.warn(
      `[SW ${SW_VERSION}] ${emoji} ${metrics.cdnName}: ${latencyMs}ms - ${metrics.error}`
    );
  }

}

function convertToCDN(
  originalUrl: string,
  targetProvider: string
): string | null {
  try {
    const parsedUrl = new URL(originalUrl);
    const providerByHostname: Record<string, string> = {
      "esm.sh": "esm.sh",
      "cdn.jsdelivr.net": "jsdelivr",
      "unpkg.com": "unpkg",
      "cdn.skypack.dev": "skypack",
    };

    const originalProvider = providerByHostname[parsedUrl.hostname];

    if (originalProvider && originalProvider === targetProvider) {
      return originalUrl;
    }

    if (originalProvider && originalProvider !== "esm.sh") {
      return null;
    }
  } catch {
    return null;
  }

  switch (targetProvider) {
    case "esm.sh":
      return originalUrl;
    case "jsdelivr":
      return CDN_CONVERTERS.esmToJsdelivr(originalUrl);
    case "unpkg":
      return CDN_CONVERTERS.esmToUnpkg(originalUrl);
    case "skypack":
      return CDN_CONVERTERS.esmToSkypack(originalUrl);
    default:
      return null;
  }
}

async function tryFetchFromCDN(
  url: string,
  provider: CDNProvider,
  timeout: number,
  manifest: SRIManifest | null
): Promise<Response | null> {
  const startTime = performance.now();

  try {
    console.log(`[SW ${SW_VERSION}] Trying ${provider.name}: ${url}`);
    const response = await fetchWithTimeout(new Request(url), timeout);
    const latency = performance.now() - startTime;

    if (!response.ok) {
      logCDNMetrics({
        url,
        cdnName: provider.name,
        latency,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        timestamp: Date.now(),
      });
      updateHealthScore(provider.hostname, false);
      return null;
    }

    if (manifest) {
      const expectedIntegrity = getExpectedIntegrity(url, manifest);
      if (expectedIntegrity) {
        const isValid = await verifyIntegrity(response, expectedIntegrity);
        if (!isValid) {
          console.error(
            `[SW ${SW_VERSION}] ✗ Integrity verification failed for ${provider.name}`
          );
          logCDNMetrics({
            url,
            cdnName: provider.name,
            latency,
            success: false,
            status: response.status,
            error: "Integrity verification failed",
            timestamp: Date.now(),
          });
          updateHealthScore(provider.hostname, false);
          return null;
        }
        console.log(
          `[SW ${SW_VERSION}] ✓ Integrity verified for ${provider.name}`
        );
      } else {
        console.warn(
          `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${url}, proceeding without verification`
        );
      }
    } else {
      console.warn(
        `[SW ${SW_VERSION}] ⚠ SRI manifest not loaded, proceeding without verification`
      );
    }

    logCDNMetrics({
      url,
      cdnName: provider.name,
      latency,
      success: true,
      status: response.status,
      timestamp: Date.now(),
    });
    updateHealthScore(provider.hostname, true);
    return response;
  } catch (error) {
    const latency = performance.now() - startTime;
    logCDNMetrics({
      url,
      cdnName: provider.name,
      latency,
      success: false,
      error: String(error),
      timestamp: Date.now(),
    });
    updateHealthScore(provider.hostname, false);
    return null;
  }
}

type ConnectionType = "fast" | "medium" | "slow" | "unknown";

interface NetworkInformation extends EventTarget {
  effectiveType?: "4g" | "3g" | "2g" | "slow-2g";
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

function detectConnectionType(): ConnectionType {
  try {
    const nav = self.navigator as NavigatorWithConnection;
    const connection = nav.connection;

    if (!connection) {
      return "unknown";
    }

    if (connection.saveData) {
      return "slow";
    }

    if (connection.effectiveType) {
      switch (connection.effectiveType) {
        case "4g":
          return "fast";
        case "3g":
          return "medium";
        case "2g":
        case "slow-2g":
          return "slow";
      }
    }

    if (connection.rtt !== undefined) {
      if (connection.rtt < 100) return "fast";
      if (connection.rtt < 400) return "medium";
      return "slow";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

function getAdaptiveTimeout(
  baseTimeout: number,
  connectionType: ConnectionType
): number {
  switch (connectionType) {
    case "fast":
      return baseTimeout;
    case "medium":
      return Math.round(baseTimeout * 1.5);
    case "slow":
      return Math.round(baseTimeout * 2.0);
    default:
      return baseTimeout;
  }
}

async function fetchWithRacing(
  originalUrl: string,
  providers: CDNProvider[],
  timeout: number,
  manifest: SRIManifest | null
): Promise<Response | null> {
  // Create abort controllers for each CDN request
  const controllers = new Map<string, AbortController>();

  try {
    const fetchPromises = providers.map(async (provider) => {
      const url = convertToCDN(originalUrl, provider.name);
      if (!url) {
        return { provider, response: null };
      }

      const controller = new AbortController();
      controllers.set(provider.name, controller);

      const response = await tryFetchFromCDN(url, provider, timeout, manifest);
      return { provider, response };
    });

    const results = await Promise.allSettled(fetchPromises);

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.response) {
        const { provider, response } = result.value;

        for (const [name, controller] of controllers.entries()) {
          if (name !== provider.name) {
            controller.abort();
          }
        }

        console.log(
          `[SW ${SW_VERSION}] ✓ Parallel racing won by ${provider.name}`
        );
        return response;
      }
    }

    return null;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Parallel racing error:`, error);
    return null;
  }
}

async function fetchWithCascade(
  originalUrl: string,
  baseTimeout = 15000,
  useRacing?: boolean
): Promise<Response> {
  const errors: Array<{ cdn: string; error: string }> = [];

  const connectionType = detectConnectionType();
  const adaptiveTimeout = getAdaptiveTimeout(baseTimeout, connectionType);

  const shouldRace =
    useRacing !== undefined ? useRacing : connectionType === "fast";

  console.log(
    `[SW ${SW_VERSION}] CDN strategy: ${
      shouldRace ? "parallel racing" : "sequential cascade"
    } ` + `(connection: ${connectionType}, timeout: ${adaptiveTimeout}ms)`
  );

  const manifest = await loadSRIManifest();

  const orderedProviders = getOrderedProviders();

  if (shouldRace && orderedProviders.length >= 2) {
    console.log(
      `[SW ${SW_VERSION}] Racing ${orderedProviders.length} CDNs in parallel...`
    );
    const racingResponse = await fetchWithRacing(
      originalUrl,
      orderedProviders,
      adaptiveTimeout,
      manifest
    );

    if (racingResponse) {
      return racingResponse;
    }

    console.warn(
      `[SW ${SW_VERSION}] Parallel racing failed, falling back to sequential cascade`
    );
  }

  for (const provider of orderedProviders) {
    const url = convertToCDN(originalUrl, provider.name);
    if (!url) {
      console.warn(
        `[SW ${SW_VERSION}] Cannot convert to ${provider.name}, skipping`
      );
      continue;
    }

    const response = await tryFetchFromCDN(
      url,
      provider,
      adaptiveTimeout,
      manifest
    );
    if (response) {
      return response; // Success!
    }

    errors.push({
      cdn: provider.name,
      error: "Failed (see metrics above)",
    });
  }

  console.error(
    `[SW ${SW_VERSION}] All CDNs failed for ${originalUrl}:`,
    errors
  );
  throw new Error(
    `All CDNs failed: ${errors.map((e) => `${e.cdn} (${e.error})`).join(", ")}`
  );
}

async function networkFirstStrategy(
  request: Request,
  cacheName: string
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const fallbackCache = await caches.open(CACHE_NAMES.fallback);

  try {
    const response = await fetchWithCascade(request.url);

    if (response.ok) {
      cache.put(request, response.clone()).catch((err) => {
        console.warn(`[SW ${SW_VERSION}] Main cache put failed:`, err);
      });

      fallbackCache.put(request, response.clone()).catch((err) => {
        console.warn(`[SW ${SW_VERSION}] Fallback cache put failed:`, err);
      });
    }

    return response;
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Network failed, trying caches:`, error);

    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      console.log(`[SW ${SW_VERSION}] Serving from main cache: ${request.url}`);
      return cachedResponse;
    }

    const fallbackResponse = await fallbackCache.match(request);
    if (fallbackResponse) {
      console.log(
        `[SW ${SW_VERSION}] Serving from fallback cache: ${request.url}`
      );
      return fallbackResponse;
    }

    throw error;
  }
}

async function cacheFirstStrategy(
  request: Request,
  cacheName: string
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const fallbackCache = await caches.open(CACHE_NAMES.fallback);

  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    console.log(`[SW ${SW_VERSION}] Cache hit: ${request.url}`);

    fetchWithCascade(request.url)
      .then((response) => {
        if (response.ok) {
          cache.put(request, response.clone());
          fallbackCache.put(request, response.clone());
          console.log(`[SW ${SW_VERSION}] Background updated: ${request.url}`);
        }
      })
      .catch(() => {
      });

    return cachedResponse;
  }

  const fallbackResponse = await fallbackCache.match(request);
  if (fallbackResponse) {
    console.log(`[SW ${SW_VERSION}] Fallback cache hit: ${request.url}`);

    fetchWithCascade(request.url)
      .then((response) => {
        if (response.ok) {
          cache.put(request, response.clone());
          fallbackCache.put(request, response.clone());
        }
      })
      .catch(() => {});

    return fallbackResponse;
  }

  console.log(`[SW ${SW_VERSION}] Cache miss: ${request.url}`);
  const response = await fetchWithCascade(request.url);

  if (response.ok) {
    cache.put(request, response.clone());
    fallbackCache.put(request, response.clone());
  }

  return response;
}

async function cacheFirstAppAsset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAMES.app);

  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }

  return response;
}

async function networkFirstNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAMES.app);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cachedShell = await cache.match('/index.html');
    if (cachedShell) {
      return cachedShell;
    }
    throw error;
  }
}

async function handleWorkerRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  console.log(`[SW ${SW_VERSION}] Worker request intercepted:`, url.href);

  const cache = await caches.open(CACHE_NAMES.cdn);
  let cached = await cache.match(request);

  if (cached) {
    console.log(`[SW ${SW_VERSION}] Serving worker from cache`);
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: {
        ...Object.fromEntries(cached.headers.entries()),
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  try {
    const response = await fetch(request);

    if (response.ok) {
      await cache.put(request, response.clone());

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers.entries()),
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    }
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Worker fetch failed:`, error);
  }

  return fetch(request);
}

async function isReturningUser(): Promise<boolean> {
  const cache = await caches.open(CACHE_NAMES.cdn);
  const keys = await cache.keys();
  return keys.length > 0;
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isWorkerRequest(request)) {
    event.respondWith(handleWorkerRequest(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  const requestType = classifyRequest(url);

  if (requestType === "app") {
    event.respondWith(cacheFirstAppAsset(event.request));
    return;
  }

  if (requestType === "cdn") {
    event.respondWith(
      (async () => {
        const returning = await isReturningUser();

        if (returning) {
        console.log(
          `[SW ${SW_VERSION}] CDN request (cache-first): ${url.href}`
        );
        return cacheFirstStrategy(event.request, CACHE_NAMES.cdn);
      }

      console.log(
        `[SW ${SW_VERSION}] CDN request (network-first): ${url.href}`
      );
      return networkFirstStrategy(event.request, CACHE_NAMES.cdn);
    })()
  );
  return;
  }

});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  console.log(`[SW ${SW_VERSION}] Message received:`, event.data);

  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data?.type === "CLEAR_CACHE") {
    event.waitUntil(
      (async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
        console.log(`[SW ${SW_VERSION}] All caches cleared`);
      })()
    );
  }
});

export {};
