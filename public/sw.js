// Chesapeake Bay Support LLC route planner: keeps the site working with weak or no signal.
// - The page: network first (so updates arrive), the saved copy when there's no signal.
// - Map library and fonts: the saved copy first.
// - Map tiles: the saved copy first, refreshed in the background; capped so it never fills the phone.
// - /api/*: never saved here; the page handles no-signal itself.
const SHELL = "cbs-shell-v1", LIBS = "cbs-libs-v1", TILES = "cbs-tiles-v1", KEEP = [SHELL, LIBS, TILES];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.add("/")).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function pageFirstFromNetwork(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(5000) });
    if (res.ok) cache.put("/", res.clone());
    return res;
  } catch (e) {
    return (await cache.match("/")) || Response.error();
  }
}
async function savedFirst(req, name) {
  const cache = await caches.open(name), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
let tilePuts = 0;
async function tile(req) {
  const cache = await caches.open(TILES), hit = await cache.match(req);
  const fresh = fetch(req).then(res => {
    if (res.ok) {
      cache.put(req, res.clone());
      if (++tilePuts % 50 === 0) cache.keys().then(keys => { const extra = keys.length - 3000; for (let i = 0; i < extra; i++) cache.delete(keys[i]); });
    }
    return res;
  }).catch(() => hit || Response.error());
  return hit || fresh;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") { e.respondWith(pageFirstFromNetwork(req)); return; }
    return;
  }
  if (url.hostname === "unpkg.com" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") { e.respondWith(savedFirst(req, LIBS)); return; }
  if (url.hostname === "tiles.openfreemap.org") { e.respondWith(tile(req)); return; }
});
