'use strict';
// প্রতিটি Worker আলাদা প্রসেসে চলে (Cloudflare Workers-এর মতো fetch হ্যান্ডলার)।
// সমর্থিত: export default { fetch, scheduled }  অথবা  addEventListener('fetch', ...)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

const cfg = JSON.parse(process.env.WK_CONFIG || '{}');
const send = (m) => { try { if (process.connected) process.send(m); } catch { /* ignore */ } };
const MAX_RES = 5 * 1024 * 1024;

if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
globalThis.require = createRequire(cfg.file);

// ---------- KV (সরল, ফাইল-ভিত্তিক) ----------
class KV {
  constructor(file) {
    this.file = file; this.dirty = false; this.m = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.m.set(k, v); } catch { /* new */ }
    this.t = setInterval(() => this.flush(), 2000);
    this.t.unref();
  }
  _live(k) { const e = this.m.get(k); if (!e) return null; if (e.x && e.x < Date.now()) { this.m.delete(k); this.dirty = true; return null; } return e; }
  async get(key, opts) {
    const e = this._live(String(key)); if (!e) return null;
    const type = typeof opts === 'string' ? opts : (opts && opts.type) || 'text';
    if (type === 'json') return JSON.parse(e.v);
    if (type === 'arrayBuffer') return new TextEncoder().encode(e.v).buffer;
    return e.v;
  }
  async put(key, value, opts = {}) {
    let v = value;
    if (typeof v !== 'string') v = v instanceof ArrayBuffer ? Buffer.from(v).toString('utf8') : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8') : String(v);
    if (v.length > 1024 * 1024) throw new Error('KV value 1MB এর বেশি');
    if (!this.m.has(String(key)) && this.m.size >= 5000) throw new Error('KV সর্বোচ্চ ৫০০০ key');
    const x = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : 0;
    this.m.set(String(key), { v, x }); this.dirty = true;
  }
  async delete(key) { this.dirty = this.m.delete(String(key)) || this.dirty; }
  async list(o = {}) {
    const p = o.prefix || '', lim = Math.min(1000, o.limit || 1000);
    const keys = [];
    for (const k of [...this.m.keys()].sort()) if (k.startsWith(p) && this._live(k)) { keys.push({ name: k }); if (keys.length >= lim) break; }
    return { keys, list_complete: true };
  }
  flush() {
    if (!this.dirty) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.m))); fs.renameSync(this.file + '.tmp', this.file); this.dirty = false; send({ t: 'kv', n: this.m.size }); } catch { /* ignore */ }
  }
}
const kv = new KV(cfg.kv);

// ---------- .env / .dev.vars ফাইল (প্যানেলের ENV-এর চেয়ে কম অগ্রাধিকার) ----------
const dotenv = {};
for (const f of ['.env', '.dev.vars']) {
  try {
    for (const line of fs.readFileSync(path.join(cfg.dir, f), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) dotenv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* নেই */ }
}

// ---------- ASSETS: public/, static/, assets/ ফোল্ডার থেকে স্ট্যাটিক ফাইল ----------
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', xml: 'application/xml', pdf: 'application/pdf', mp3: 'audio/mpeg', mp4: 'video/mp4', wasm: 'application/wasm', map: 'application/json', md: 'text/markdown; charset=utf-8' };
const ASSETS = {
  async fetch(input) {
    const req = input instanceof Request ? input : new Request(input);
    let p;
    try { p = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('Bad Request', { status: 400 }); }
    if (p.endsWith('/')) p += 'index.html';
    for (const d of ['public', 'static', 'assets']) {
      const root = path.join(cfg.dir, d);
      const file = path.join(root, p);
      if (!file.startsWith(root + path.sep)) continue;
      let target = file;
      try {
        if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
        const body = await fs.promises.readFile(target);
        const ext = path.extname(target).slice(1).toLowerCase();
        return new Response(req.method === 'HEAD' ? null : body, { headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=300' } });
      } catch { /* পরের ফোল্ডার */ }
    }
    return new Response('Not Found', { status: 404 });
  },
};

// ---------- env / globals ----------
const env = { ...dotenv, ...(cfg.env || {}), KV: kv, ASSETS };
// CACHE: মেমরিতে ছোট ক্যাশ (TTL সহ, সর্বোচ্চ ৫০০ এন্ট্রি, LRU)। প্রসেস ঘুমালে ক্যাশ খালি হয়।
const cacheMap = new Map(); const CACHE_MAX = 500;
env.CACHE = {
  async get(k) { const key = String(k); const e = cacheMap.get(key); if (!e) return null; if (e.x && e.x < Date.now()) { cacheMap.delete(key); return null; } cacheMap.delete(key); cacheMap.set(key, e); return e.v; },
  async put(k, v, o = {}) { const key = String(k); if (!cacheMap.has(key) && cacheMap.size >= CACHE_MAX) cacheMap.delete(cacheMap.keys().next().value); cacheMap.set(key, { v: String(v).slice(0, 200000), x: o.ttl ? Date.now() + Number(o.ttl) * 1000 : 0 }); return true; },
  async delete(k) { return cacheMap.delete(String(k)); },
  size() { return cacheMap.size; },
};
// NOTIFY(message): Worker থেকে বাইরে বার্তা (NOTIFY_URL সেট থাকলে Discord/Slack/Webhook-এ যায়)
env.NOTIFY = async (message) => { const url = env.NOTIFY_URL; if (!url) return false; try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: String(message), text: String(message) }), signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; } };
for (const [k, v] of Object.entries({ ...dotenv, ...(cfg.env || {}) })) { process.env[k] = v; globalThis[k] = v; }
globalThis.KV = kv; globalThis.ASSETS = ASSETS; globalThis.env = env;

// ---------- DB: SQLite (Node-এর বিল্ট-ইন node:sqlite), D1-এর মতো API ----------
// env.DB.prepare(sql).bind(...args).all() / .first() / .run() / .raw(); env.DB.exec(sql); env.DB.batch([...])
if (cfg.db) {
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch { /* Node পুরনো, DB বন্ধ */ }
  if (sqlite && sqlite.DatabaseSync) {
    const raw = new sqlite.DatabaseSync(cfg.db);
    try { raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'); } catch { /* ignore */ }
    const stmt = (sql) => {
      const st = raw.prepare(String(sql));
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async all() { const rows = st.all(...args); return { results: rows, success: true, meta: {} }; },
        async first(col) { const r = st.get(...args) || null; return col && r ? (r[col] ?? null) : r; },
        async run() { const info = st.run(...args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; },
        async raw() { return st.all(...args).map((r) => Object.values(r)); },
      };
      return api;
    };
    const DBAPI = {
      prepare: (sql) => stmt(sql),
      exec: (sql) => { raw.exec(String(sql)); return { count: 1, duration: 0 }; },
      async batch(list) { const out = []; raw.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; } return out; },
    };
    env.DB = DBAPI; globalThis.DB = DBAPI;
  } else {
    const msg = 'env.DB পাওয়া যায়নি: Node 22.5+ (node:sqlite) লাগবে';
    env.DB = null; console.warn(msg);
  }
}
try { process.chdir(cfg.dir); } catch { /* ignore */ }

const listeners = { fetch: [], scheduled: [] };
globalThis.addEventListener = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };

let fetchFn = null, schedFn = null;
const mkCtx = () => { const w = []; return { w, ctx: { waitUntil: (p) => { w.push(Promise.resolve(p).catch((e) => console.error('waitUntil:', e && e.message))); }, passThroughOnException() {} } }; };

async function load() {
  const mod = await import(pathToFileURL(cfg.file).href); // package.json এর "type" অনুযায়ী ESM/CommonJS দুটোই চলে
  const def = mod.default || mod;
  if (def && typeof def.fetch === 'function') fetchFn = (req, ctx) => def.fetch(req, env, ctx);
  else if (listeners.fetch.length) fetchFn = null;
  else throw new Error('Worker-এ `export default { fetch(request, env, ctx) {...} }` অথবা addEventListener("fetch", ...) পাওয়া যায়নি');
  if (def && typeof def.scheduled === 'function') schedFn = (ev, ctx) => def.scheduled(ev, env, ctx);
  else if (listeners.scheduled.length) schedFn = (ev, ctx) => listeners.scheduled.forEach((f) => f({ ...ev, waitUntil: ctx.waitUntil }));
}

async function runFetch(request, ctx) {
  if (fetchFn) return fetchFn(request, ctx);
  return new Promise((resolve, reject) => {
    let done = false;
    const ev = { request, respondWith: (p) => { done = true; resolve(p); }, waitUntil: ctx.waitUntil, passThroughOnException() {} };
    try { listeners.fetch.forEach((f) => f(ev)); } catch (e) { return reject(e); }
    if (!done) reject(new Error('fetch listener respondWith() কল করেনি'));
  });
}

async function onReq(m) {
  const { w, ctx } = mkCtx();
  const c0 = process.cpuUsage();
  try {
    const init = { method: m.method, headers: m.headers };
    if (m.body && !['GET', 'HEAD'].includes(m.method)) init.body = Buffer.from(m.body, 'base64');
    const resp = await runFetch(new Request(m.url, init), ctx);
    if (!(resp instanceof Response)) throw new TypeError('fetch হ্যান্ডলার Response ফেরত দেয়নি');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_RES) throw new Error('Response ৫MB এর বেশি');
    const headers = [];
    resp.headers.forEach((v, k) => { if (k !== 'set-cookie') headers.push([k, v]); });
    const sc = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
    for (const c of sc) headers.push(['set-cookie', c]);
    const cu = process.cpuUsage(c0);
    send({ t: 'res', id: m.id, status: resp.status, headers, body: buf.toString('base64'), cpu: Math.round((cu.user + cu.system) / 100) / 10 });
  } catch (e) {
    send({ t: 'res', id: m.id, error: String((e && e.stack) || e).slice(0, 2000), cpu: Math.round((process.cpuUsage(c0).user) / 100) / 10 });
  }
  Promise.all(w).catch(() => {});
}

process.on('message', async (m) => {
  if (!m) return;
  if (m.t === 'req') return onReq(m);
  if (m.t === 'cron' && schedFn) {
    const { w, ctx } = mkCtx();
    try { await schedFn({ type: 'scheduled', scheduledTime: Date.now(), cron: m.cron || '' }, ctx); await Promise.all(w); } catch (e) { console.error('scheduled ত্রুটি:', (e && e.stack) || e); }
  }
  if (m.t === 'shutdown') { kv.flush(); process.exit(0); }
});
process.on('SIGTERM', () => { kv.flush(); process.exit(0); });
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.stack) || e));
setInterval(() => send({ t: 'hb' }), 5000);

load().then(() => send({ t: 'ready', kv: kv.m.size })).catch((e) => { send({ t: 'fatal', message: String((e && e.stack) || e).slice(0, 2000) }); setTimeout(() => process.exit(1), 200); });
