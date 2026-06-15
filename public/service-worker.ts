/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const SW_VERSION = 'v1.0.0';

// Cache version from build (git commit hash)
const BUILD_VERSION = '__CACHE_VERSION__';

const CACHE_NAMES = {
  app: `app-${BUILD_VERSION}`,
} as const;

// Build-time injected precache manifest
const PRECACHE_URLS: string[] = 'PRECACHE_MANIFEST' as unknown as string[];

// ---------------------------------------------------------------------------
// Install: precache app shell
// ---------------------------------------------------------------------------
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAMES.app);
      // Use individual cache.add() so one failure doesn't abort entire install
      const results = await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        console.warn(`[SW ${SW_VERSION}] ${failed.length} precache URLs failed (non-fatal)`);
      }
      console.log(
        `[SW ${SW_VERSION}] App shell pre-cached (${PRECACHE_URLS.length - failed.length}/${PRECACHE_URLS.length} files)`
      );
      await self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// Activate: clean up old caches
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      const valid = new Set<string>(Object.values(CACHE_NAMES));
      await Promise.all(
        cacheNames.map((name) => {
          if (!valid.has(name)) {
            console.log(`[SW ${SW_VERSION}] Deleting old cache: ${name}`);
            return caches.delete(name);
          }
          return undefined;
        })
      );
      await self.clients.claim();
      console.log(`[SW ${SW_VERSION}] Activated`);
    })()
  );
});

// ---------------------------------------------------------------------------
// Fetch: cache-first for app assets, network-first for navigation, passthrough
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Navigation requests: network-first with app shell fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAMES.app).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAMES.app);
          const cached = await cache.match('/index.html');
          return cached ?? new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // App assets (JS/CSS/images): cache-first, background revalidate
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAMES.app).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          // Background revalidate
          fetch(event.request)
            .then((response) => {
              if (response.ok) cache.put(event.request, response);
            })
            .catch(() => {});
          return cached;
        }
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // All other requests: passthrough (CDN, API, etc.)
  // The app's core-assets-service handles CDN fallback directly
});

export {};
