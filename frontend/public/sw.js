/*
  AscendAI Service Worker v2
  Strategy: network-first for everything.
  We do NOT cache Next.js page routes because they are JS bundles.
  We only cache truly static files: icons, manifest, fonts.
*/

// Cache version — increment this to force all clients to update
const CACHE_NAME = "ascendai-v2";

// Only cache genuinely static files that never change
// Do NOT add page routes here — Next.js routes are JS chunks not HTML
const STATIC_ASSETS = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// Install — cache only the static assets above
self.addEventListener("install", (event) => {
  console.log("[SW] Installing v2...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each static asset individually so one failure doesn't block all
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Failed to cache ${url}:`, err);
          })
        )
      );
    })
  );
  // Take control immediately — don't wait for old SW to die
  self.skipWaiting();
});

// Activate — delete all old caches so we start fresh
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating v2...");
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log("[SW] Removing old cache:", name);
            return caches.delete(name);
          })
      );
    })
  );
  // Take control of all open pages immediately
  self.clients.claim();
});

// Fetch — network first, cache fallback only for static assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Always go to network for these — never serve from cache:
  // API calls, Supabase, Groq, auth, non-GET requests
  if (
    url.hostname.includes("supabase") ||
    url.hostname.includes("groq") ||
    url.hostname.includes("render.com") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/") ||
    event.request.method !== "GET"
  ) {
    // Pass straight through to network — no caching
    return;
  }

  // For static assets only — try network first, fall back to cache
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache the fresh response for next time
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed — serve from cache if available
          return caches.match(event.request);
        })
    );
    return;
  }

  // For all page navigation — always network, never cache
  // This fixes the "only logo shows" bug on mobile PWA
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => {
        // If completely offline, try to serve the cached home page
        return caches.match("/") || fetch(event.request);
      })
    );
    return;
  }

  // Everything else — just use the network
  return;
});

// Listen for messages from the app
self.addEventListener("message", (event) => {
  // Allow the app to force the SW to take control immediately
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});
