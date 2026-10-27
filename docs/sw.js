/* Keeps the page shell for offline start and shows notifications on Android.
 * Never caches market data: Binance requests always go to the network. */
var SHELL = "robo-shell-v1";
var FILES = ["./", "index.html", "style.css", "engine.js", "app.js", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// network first for our own files (so updates arrive), cache only when offline
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) {
    var copy = r.clone();
    caches.open(SHELL).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () { return caches.match(e.request); }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(function (list) {
    if (list.length) return list[0].focus();
    return self.clients.openWindow("./");
  }));
});
