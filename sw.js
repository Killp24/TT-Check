const CACHE = "tt-check-v10";
const SHELL = ["./", "index.html", "manifest.json", "icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Data files: always try the network first, fall back to the last saved copy offline
  if (url.pathname.endsWith(".txt")) {
    e.respondWith(caches.open(CACHE).then(cache =>
      fetch(e.request, { cache: "no-store" }).then(res => {
        if (res.ok) cache.put(url.pathname, res.clone());
        return res;
      }).catch(() => cache.match(url.pathname))
    ));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
