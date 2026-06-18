/* Bandolier service worker — provides installability and basic offline support.
 *
 * Strategy:
 *  - Navigations: network-first, falling back to the cached page (or the cached
 *    app root) when offline.
 *  - Same-origin GET requests: stale-while-revalidate so repeat visits are fast
 *    and the cache stays warm.
 * Bump CACHE_VERSION to invalidate old caches on deploy.
 */
const CACHE_VERSION = "v3";
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

// Web Push: render a server-sent notification even when no tab is open. The
// payload (JSON) comes from ~/server/agents/web-push; fields are defensive so a
// malformed/empty push still shows something rather than throwing.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to its text as the body.
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Bandolier";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Collapse repeats for the same subject (e.g. one per job).
    tag: data.tag || undefined,
    // Stash the click target so notificationclick can route to it.
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a task notification focuses an existing app window (navigating it to
// the notification's target when it differs) or opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            // Best-effort navigate to the target before focusing.
            if ("navigate" in client && targetUrl) {
              return client
                .navigate(targetUrl)
                .then((c) => (c ?? client).focus());
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
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
