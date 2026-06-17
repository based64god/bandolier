/* Bandolier service worker — provides installability and basic offline support.
 *
 * Strategy:
 *  - Navigations: network-first, falling back to the cached page (or the cached
 *    app root) when offline.
 *  - Same-origin GET requests: stale-while-revalidate so repeat visits are fast
 *    and the cache stays warm.
 * Bump CACHE_VERSION to invalidate old caches on deploy.
 */
const CACHE_VERSION = "v2";
const CACHE_NAME = `bandolier-${CACHE_VERSION}`;
const OFFLINE_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)),
  );
  // Note: intentionally NOT calling skipWaiting() here. A freshly installed
  // worker waits so the UI can surface an "update available" prompt; it only
  // takes over when the user clicks Refresh (which posts SKIP_WAITING below).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Lets the page activate a waiting worker on demand: when the update prompt's
// "Refresh" button is clicked, the page posts { type: "SKIP_WAITING" } so the
// new worker takes over immediately instead of waiting for all tabs to close.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// Clicking a task notification focuses an existing app window (or opens one).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow("/");
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GET requests; let everything else (POST, APIs on
  // other origins, etc.) hit the network directly.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or auth traffic — always go to the network.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match(request)) ?? (await cache.match(OFFLINE_URL))
          );
        }),
    );
    return;
  }

  // Stale-while-revalidate for other same-origin assets.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
