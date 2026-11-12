// Chesapeake Bay Support LLC — Daily Route Planner: server piece.
// Runs on Cloudflare Pages Functions. Handles every request to /api/*.
//
// Needs, in the Cloudflare Pages project settings:
//   Secret  GEOAPIFY_KEY  — your Geoapify API key (kept here, never sent to phones)
//   Secret  CREW_PIN      — the PIN you and your crew type to get in
//   D1 binding named DB   — the free database that holds today's route and check marks

const GEO = "https://api.geoapify.com/v1";
// Keep lookups in and around Virginia, nearest to Chesapeake first.
const AREA = "filter=rect:-83.8,36.4,-75.1,39.6&bias=proximity:-76.29,36.75&lang=en&format=json";
const COOKIE = "cbs_session";

/* ---------------- helpers ---------------- */
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const fail = (status, error) => json({ error }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// The session token can only be made by someone who knows both secrets.
const sessionToken = env => sha256(`cbs:${env.CREW_PIN}:${env.GEOAPIFY_KEY}`);
function readCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : "";
}
function sameText(a, b) {                           // compare without leaking timing
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS marks (day TEXT NOT NULL, job TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, job))"),
    db.prepare("CREATE TABLE IF NOT EXISTS customers (k INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)")
  ]);
  tablesReady = true;
}

// Trim a Geoapify result down to what the page needs.
const noCountry = s => String(s || "").replace(/,\s*United States( of America)?$/i, "");
const place = r => ({
  label: noCountry(r.formatted || [r.address_line1, r.address_line2].filter(Boolean).join(", ")),
  line1: r.address_line1 || "", line2: noCountry(r.address_line2),
  street: r.street || "", lat: r.lat, lon: r.lon,
  exact: !!(r.housenumber || r.result_type === "building" || r.result_type === "amenity")
});

// Address lookups: never wait more than a few seconds, retry once if Geoapify says "slow down",
// and remember answers at Cloudflare's edge for a day so repeat lookups come back instantly.
async function geoFetch(u) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(4500) });
      if (r.status === 429 && i === 0) { await new Promise(res => setTimeout(res, 350)); continue; }
      return r;
    } catch (e) { if (i === 1) throw e; }
  }
}
const edge = typeof caches !== "undefined" ? caches.default : null;
async function remembered(kind, text, ctx, make) {
  const key = new Request(`https://cbs-cache.local/${kind}?q=${encodeURIComponent(text.toLowerCase().replace(/\s+/g, " "))}`);
  if (edge) { const hit = await edge.match(key); if (hit) return hit.json(); }
  const data = await make();
  if (edge && data) {
    const put = edge.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } }));
    ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return data;
}

/* ---------------- routes ---------------- */
async function login(request, env) {
  const { pin } = await request.json().catch(() => ({}));
  if (!pin || !sameText(String(pin), String(env.CREW_PIN))) {
    await new Promise(r => setTimeout(r, 800));    // slow down guessing
    return fail(401, "Wrong PIN");
  }
  const token = await sessionToken(env);
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000` });
}

async function suggest(url, env, ctx) {
  const text = (url.searchParams.get("text") || "").trim();
  if (text.length < 3) return json({ results: [] });
  try {
    const out = await remembered("suggest", text, ctx, async () => {
      const r = await geoFetch(`${GEO}/geocode/autocomplete?text=${encodeURIComponent(text)}&limit=6&${AREA}&apiKey=${env.GEOAPIFY_KEY}`);
      if (!r.ok) return null;
      return { results: ((await r.json()).results || []).map(place) };
    });
    return out ? json(out) : fail(502, "Address lookup is unavailable right now");
  } catch (e) { return fail(504, "Address lookup took too long"); }
}

async function geocode(url, env, ctx) {
  const text = (url.searchParams.get("text") || "").trim();
  if (!text) return json({ result: null });
  try {
    const out = await remembered("geocode", text, ctx, async () => {
      const r = await geoFetch(`${GEO}/geocode/search?text=${encodeURIComponent(text)}&limit=1&${AREA}&apiKey=${env.GEOAPIFY_KEY}`);
      if (!r.ok) return null;
      const best = ((await r.json()).results || [])[0];
      // Only accept a confident match; otherwise the page shows "Not found".
      const ok = best && (!best.rank || best.rank.confidence >= 0.5);
      return { result: ok ? place(best) : null };
    });
    return out ? json(out) : fail(502, "Address lookup is unavailable right now");
  } catch (e) { return fail(504, "Address lookup took too long"); }
}

async function plan(request, env) {
  const body = await request.json().catch(() => null);
  const ok = p => p && isFinite(p.lat) && isFinite(p.lon);
  if (!body || !ok(body.start) || !Array.isArray(body.jobs) || !body.jobs.length || !body.jobs.every(ok))
    return fail(400, "Missing locations");
  if (body.jobs.length > 60) return fail(400, "Too many stops for one day");
  const start = [body.start.lon, body.start.lat];
  const req = {
    mode: "drive",
    agents: [{ start_location: start, ...(body.home ? { end_location: start } : {}) }],
    jobs: body.jobs.map((j, i) => ({ id: String(i), location: [j.lon, j.lat], duration: 0 })),
    ...(body.tolls ? { avoid: [{ type: "tolls" }] } : {})     // skip toll roads when a free road works
  };
  const r = await fetch(`${GEO}/routeplanner?apiKey=${env.GEOAPIFY_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req)
  });
  if (!r.ok) return fail(502, "Route planning is unavailable right now");
  const out = await r.json();
  const feature = (out.features || [])[0];
  if (!feature) return fail(422, "No route could be made for these stops");
  const order = (feature.properties.actions || [])
    .filter(a => a.type === "job")
    .map(a => a.job_index != null ? a.job_index : +a.job_id);
  const missed = (out.properties && out.properties.issues && out.properties.issues.unassigned_jobs) || [];
  // Draw the real driving path: ask for turn-by-turn roads through the stops in the chosen order.
  const stops = [body.start, ...order.map(i => body.jobs[i]), ...(body.home ? [body.start] : [])];
  const line = (await roadLine(stops, !!body.tolls, env)) || linePoints(feature.geometry);
  return json({ order, missed, line });
}

const linePoints = g => !g ? [] : g.type === "MultiLineString" ? g.coordinates.flat() : g.type === "LineString" ? g.coordinates : [];
async function roadLine(stops, avoidTolls, env) {
  if (stops.length < 2) return null;
  try {
    const waypoints = stops.map(p => `${p.lat},${p.lon}`).join("|");
    const r = await fetch(`${GEO}/routing?waypoints=${encodeURIComponent(waypoints)}&mode=drive${avoidTolls ? "&avoid=tolls" : ""}&apiKey=${env.GEOAPIFY_KEY}`);
    if (!r.ok) return null;
    const f = ((await r.json()).features || [])[0];
    const pts = f ? linePoints(f.geometry) : [];
    return pts.length ? pts : null;
  } catch (e) { return null; }
}

async function getDay(url, env) {
  const day = url.searchParams.get("d");
  if (!validDay(day)) return fail(400, "Bad date");
  await ensureTables(env.DB);
  const row = await env.DB.prepare("SELECT data, updated FROM days WHERE day = ?").bind(day).first();
  const marks = await env.DB.prepare("SELECT job FROM marks WHERE day = ?").bind(day).all();
  return json({ route: row ? JSON.parse(row.data) : null, updated: row ? row.updated : 0, done: (marks.results || []).map(m => m.job) });
}

async function saveDay(request, url, env) {
  const day = url.searchParams.get("d");
  if (!validDay(day)) return fail(400, "Bad date");
  const route = await request.json().catch(() => null);
  if (!route || !Array.isArray(route.jobs)) return fail(400, "Missing route");
  const data = JSON.stringify(route);
  if (data.length > 200000) return fail(413, "Route too large");
  await ensureTables(env.DB);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO days (day, data, updated) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data, updated = excluded.updated").bind(day, data, now),
    // drop check marks for jobs that are no longer on the route
    env.DB.prepare(`DELETE FROM marks WHERE day = ? AND job NOT IN (SELECT value FROM json_each(?))`).bind(day, JSON.stringify(route.jobs.map(j => String(j.id))))
  ]);
  return json({ ok: true, updated: now });
}

async function clearDay(url, env) {
  const day = url.searchParams.get("d");
  if (!validDay(day)) return fail(400, "Bad date");
  await ensureTables(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM days WHERE day = ?").bind(day),
    env.DB.prepare("DELETE FROM marks WHERE day = ?").bind(day)
  ]);
  return json({ ok: true });
}

async function mark(request, url, env) {
  const day = url.searchParams.get("d");
  const { job, done } = await request.json().catch(() => ({}));
  if (!validDay(day) || !job) return fail(400, "Bad request");
  await ensureTables(env.DB);
  if (done) await env.DB.prepare("INSERT OR IGNORE INTO marks (day, job, at) VALUES (?, ?, ?)").bind(day, String(job), Date.now()).run();
  else await env.DB.prepare("DELETE FROM marks WHERE day = ? AND job = ?").bind(day, String(job)).run();
  return json({ ok: true });
}

/* ---------------- customer list (backup, shared by every phone) ---------------- */
// Each customer carries "mod" (when it last changed). Merging keeps the newest copy of each,
// so two phones editing different customers never undo each other. Removed customers stay as
// small "del" markers for 60 days so the removal reaches every phone.
function mergeCustomers(a, b) {
  const byId = new Map();
  for (const c of [...a, ...b]) {
    if (!c || typeof c.id !== "string") continue;
    const cur = byId.get(c.id);
    if (!cur || (c.mod || 0) > (cur.mod || 0)) byId.set(c.id, c);
  }
  const cutoff = Date.now() - 60 * 864e5;
  return [...byId.values()].filter(c => !(c.del && (c.mod || 0) < cutoff)).sort((x, y) => (x.born || 0) - (y.born || 0));
}
async function readCustomers(env) {
  await ensureTables(env.DB);
  const row = await env.DB.prepare("SELECT data, updated FROM customers WHERE k = 1").first();
  return { list: row ? JSON.parse(row.data) : [], updated: row ? row.updated : 0 };
}
async function getCustomers(env) { return json(await readCustomers(env)); }
async function saveCustomers(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.list) || body.list.length > 10000) return fail(400, "Bad customer list");
  const now = await readCustomers(env);
  const list = mergeCustomers(now.list, body.list);
  const data = JSON.stringify(list);
  if (data.length > 1800000) return fail(413, "Customer list is too large to back up");
  const updated = Date.now();
  await env.DB.prepare("INSERT INTO customers (k, data, updated) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data, updated = excluded.updated").bind(data, updated).run();
  return json({ list, updated });
}

/* ---------------- entry point ---------------- */
export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;

  if (!env.GEOAPIFY_KEY || !env.CREW_PIN || !env.DB)
    return fail(500, "Site setup isn't finished: add GEOAPIFY_KEY, CREW_PIN and the DB database in Cloudflare settings.");

  try {
    if (path === "login" && method === "POST") return await login(request, env);
    if (path === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });

    // everything below needs the crew PIN
    if (!sameText(readCookie(request, COOKIE), await sessionToken(env))) return fail(401, "PIN needed");

    if (path === "session") return json({ ok: true });
    if (path === "suggest" && method === "GET") return await suggest(url, env, ctx);
    if (path === "geocode" && method === "GET") return await geocode(url, env, ctx);
    if (path === "plan" && method === "POST") return await plan(request, env);
    if (path === "day" && method === "GET") return await getDay(url, env);
    if (path === "day" && method === "PUT") return await saveDay(request, url, env);
    if (path === "day" && method === "DELETE") return await clearDay(url, env);
    if (path === "mark" && method === "POST") return await mark(request, url, env);
    if (path === "customers" && method === "GET") return await getCustomers(env);
    if (path === "customers" && method === "PUT") return await saveCustomers(request, env);
    return fail(404, "Not found");
  } catch (e) {
    return fail(500, "Something went wrong on the server. Try again.");
  }
}
