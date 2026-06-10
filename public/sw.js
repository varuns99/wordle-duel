const CACHE_NAME = "word-sprint-public-v0.5.12";
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "app.js?v=0.5.12",
  "styles.css?v=0.5.12",
  "words.json",
  "icon-192.png",
  "icon-512.png",
  "icon-180.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes("/api/") || event.request.method !== "GET") return;
  const wantsHtml = event.request.mode === "navigate" || event.request.headers.get("accept")?.includes("text/html");
  if (wantsHtml) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
