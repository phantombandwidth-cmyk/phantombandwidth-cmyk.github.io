/* Phantom Bandwidth — offline service worker.
   HTML is network-first (so updates show immediately, offline still works);
   everything else is cache-first with a runtime cache. Bump V to refresh. */
var V = "phantombw-v7";
var CORE = ["/", "/index.html", "/roomtone.html", "/manifest.webmanifest", "/icon.svg", "/lofi-engine.js"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(CORE).catch(function(){}); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== V; })
      .map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var isHTML = req.mode === "navigate" ||
    (req.headers.get("accept") || "").indexOf("text/html") !== -1;
  if (isHTML) {
    e.respondWith(
      fetch(req).then(function (r) {
        var cp = r.clone();
        caches.open(V).then(function (c) { c.put(req, cp); });
        return r;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match("/index.html"); });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(function (m) {
      return m || fetch(req).then(function (r) {
        if (r && r.status === 200) {
          var cp = r.clone();
          caches.open(V).then(function (c) { c.put(req, cp); });
        }
        return r;
      }).catch(function () { return m; });
    })
  );
});
