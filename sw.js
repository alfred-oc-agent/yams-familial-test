const CACHE_NAME = "yams-score-v13";
// Replaced with false by prepare-release.mjs for production artifacts.
const DIAGNOSTICS_BUILD = true;
const DIAGNOSTICS_ORIGIN = ['localhost','127.0.0.1','[::1]'].includes(self.location.hostname)
  || self.location.origin === 'https://alfred-oc-agent.github.io' && self.location.pathname.startsWith('/yams-familial-test/');
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./scoring.js",
  "./sharing.js", "./build-profile.js", "./qr-camera.js", "./vendor/qr.js", "./wake-lock.js", "./locales/v3.js", "./storage.js", "./statistics.js", "./i18n.js",
  "./locales/en.js", "./locales/fr.js", "./locales/es.js", "./locales/de.js",
  "./locales/zh-Hans.js", "./locales/ja.js", "./locales/ar.js",
  "./manifest.webmanifest", "./icon.svg",
  "./icon-192.png", "./icon-512.png",
];
if (DIAGNOSTICS_BUILD && DIAGNOSTICS_ORIGIN) ASSETS.push('./debug-reporting.js','./peer-diagnostics.js');

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("yams-score-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
