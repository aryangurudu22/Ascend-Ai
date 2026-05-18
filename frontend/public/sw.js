/*
  AscendAI Service Worker
  Handles caching for offline access.
  AI features require internet — everything else works offline.
*/

// Cache name — update version to force refresh
const CACHE_NAME = "ascendai-v1";

// Files to cache immediately on install
// These are the core app shell files
const STATIC_ASSETS = [
  "/",
  "/dashboard",
  "/features/homework",
  "/features/notes",
  "/features/flashcards",
  "/features/timetable",
  "/features/past-papers",
  "/analytics",
  "/syllabus",
  "/settings",
];

// Install event — cache static assets
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Caching static assets");
      // Cache each URL — don't fail if one is missing
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Failed to cache ${url}:`, err);
          }),
        ),
      );
    }),
  );
  // Take control immediately without waiting
  self.skipWaiting();
});

// Activate event — clean up old caches
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log("[SW] Deleting old cache:", name);
            return caches.delete(name);
          }),
      );
    }),
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Fetch event — serve from cache when offline
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always need fresh data
  // AI features, Supabase, Groq all need internet
  if (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.port === "8001" ||
    url.hostname.includes("supabase") ||
    url.hostname.includes("groq") ||
    url.pathname.startsWith("/api/") ||
    event.request.method !== "GET"
  ) {
    // Pass through to network — no caching
    return;
  }

  // For everything else: network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If network succeeds — cache the response for later
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        console.log("[SW] Network failed, serving from cache:", url.pathname);
        return caches.match(event.request).then((cached) => {
          if (cached) {
            return cached;
          }
          // Nothing in cache — return offline page
          return caches.match("/dashboard");
        });
      }),
  );
});

// Message event — handle manual cache requests
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});
