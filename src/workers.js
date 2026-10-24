'use strict';
// Cloudflare Workers-এর মতো: একাধিক ফাইলসহ প্রজেক্ট আপলোড > ডিপ্লয় > /w/<slug> URL, ENV, KV, ASSETS, cron, বিশ্লেষণ।
const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { genId } = require('./util');
const { zip, unzip } = require('./zip');
const { rssOf } = require('./sys');

const HOST = path.join(__dirname, 'worker-host.js');
const HEAP = Number(process.env.WORKER_HEAP_MB) || 64;
const IDLE_DEFAULT = 2; // মিনিট; 0 = সবসময় চালু
const MEM_CAP = 16384;   // সীমাহীন মানে 0; বড় মান শুধু নিরাপত্তার জন্য সীমাবদ্ধ
const REQ_TIMEOUT = 30000;
const BUCKET = 15 * 60000;
const KEEP_DAYS = 31;
const MAX_FILES = 200, MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 25 * 1024 * 1024, KEEP_VERSIONS = 8;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'json', 'md', 'txt', 'html', 'htm', 'css', 'svg', 'xml', 'yml', 'yaml', 'toml', 'env', 'csv', 'map', 'sh', 'sql', 'ini', 'conf', 'log', 'vars', 'gitignore', 'jsx', 'tsx']);
const LAT_EDGES = [10, 25, 50, 100, 250, 1000];
// সীমা: 0 = সীমাহীন/বন্ধ। নেতিবাচক বা NaN হলে 0।
const normMem = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; return Math.min(MEM_CAP, Math.round(n)); };
const normIdle = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; return Math.min(1e7, n); };
const normCount = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; return Math.min(1e12, Math.floor(n)); };
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

function normPath(p) {
  const clean = String(p || '/').split('?')[0].split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f-]{36}$/i.test(s) ? ':id' : s)).join('/');
  return (clean || '/').slice(0, 80);
}
function uaGroup(ua) {
  const u = String(ua || '').toLowerCase();
  if (!u) return 'অজানা';
  if (/bot|crawl|spider|slurp|monitor|uptime/.test(u)) return 'বট/ক্রলার';
  if (/curl|wget|python|httpie|postman|insomnia|node|axios|go-http|java|okhttp/.test(u)) return 'টুল/স্ক্রিপ্ট';
  if (/mobile|android|iphone|ipad/.test(u)) return 'মোবাইল';
  if (/mozilla|chrome|safari|firefox|edge/.test(u)) return 'ডেস্কটপ ব্রাউজার';
  return 'অন্যান্য';
}

// সরল LCS লাইন-ডিফ; বড় ফাইলে আনুমানিক গণনা (পারফরম্যান্স রক্ষা)
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 2500000) return { add: Math.max(0, m - n), del: Math.max(0, n - m), lines: [{ t: '~', s: 'ফাইল খুব বড়, বিস্তারিত দেখানো হচ্ছে না' }] };
  const W = m + 1; const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const lines = []; let i = 0, j = 0, add = 0, del = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { lines.push({ t: '-', s: a[i] }); del++; i++; }
    else { lines.push({ t: '+', s: b[j] }); add++; j++; }
  }
  while (i < n) { lines.push({ t: '-', s: a[i++] }); del++; }
  while (j < m) { lines.push({ t: '+', s: b[j++] }); add++; }
  return { add, del, lines };
}

class Workers extends EventEmitter {
  constructor(store, { max = 10 } = {}) {
    super();
    this.store = store; this.max = max;
    this.dir = path.join(store.dir, 'workers');
    fs.mkdirSync(this.dir, { recursive: true });
    store.data.workers ||= [];
    this.rt = new Map(); this._n = 0; this._gen = 0; this._rl = new Map(); this.origin = 'http://localhost';
    this._migrate();
    store.hooks = { export: () => this.exportAll() };
    if (store.pendingWorkerFiles) { this.importAll(store.pendingWorkerFiles); store.pendingWorkerFiles = null; }
    this._t = setInterval(() => this._tick(), 5000); this._t.unref();
    this._s = setInterval(() => this.flushStats(), 20000); this._s.unref();
  }

  all() { return (this.store.data.workers ||= []); }
  get(id) { return this.all().find((w) => w.id === id); }
  bySlug(s) { return this.all().find((w) => w.slug === s); }
  dirOf(id) { return path.join(this.dir, id); }
  verDir(id) { return path.join(this.dir, id + '.v'); }
  kvFile(id) { return path.join(this.dir, id + '.kv.json'); }
  statsFile(id) { return path.join(this.dir, id + '.stats.json'); }
  dbFile(id) { return path.join(this.dir, id + '.db'); }

  _migrate() {
    for (const w of this.all()) {
      const d = this.dirOf(w.id), old = path.join(this.dir, w.id + '.mjs');
      if (fs.existsSync(old) && !fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
        fs.renameSync(old, path.join(d, 'worker.js')); w.entry = 'worker.js';
        for (const x of ['.prev.mjs', '.cjs']) fs.rmSync(path.join(this.dir, w.id + x), { force: true });
      } else fs.mkdirSync(d, { recursive: true });
    }
    this.store.save();
  }

  // ---------- নিরাপদ পাথ ----------
  safeRel(rel) {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!r || r.length > 180) throw new Error('ফাইলের পাথ সঠিক নয়');
    const parts = r.split('/');
    if (parts.length > 8) throw new Error('ফোল্ডার অনেক গভীর');
    for (const p of parts) if (!p || p === '.' || p === '..' || p.length > 100 || /[\0<>:"|?*]/.test(p) || p === 'node_modules' || p === '.git') throw new Error('অনুমোদিত নয়: ' + p);
    return parts.join('/');
  }
  absOf(id, rel) {
    const root = this.dirOf(id), f = path.join(root, this.safeRel(rel));
    if (!f.startsWith(root + path.sep)) throw new Error('পাথ সঠিক নয়');
    return f;
  }

  // ---------- ফাইল ম্যানেজার ----------
  _walk(root) {
    const out = [];
    const rec = (d, pre) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const rel = pre ? pre + '/' + e.name : e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') rec(path.join(d, e.name), rel); } else if (e.isFile()) { const st = fs.statSync(path.join(d, e.name)); out.push({ path: rel, size: st.size, mtime: st.mtimeMs }); }
      }
    };
    rec(root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  listFiles(id) { return this._walk(this.dirOf(id)); }
  isText(rel, buf) { const ext = rel.split('.').pop().toLowerCase(); return TEXT_EXT.has(ext) || !buf.subarray(0, 4096).includes(0); }
  readFile(id, rel) {
    const f = this.absOf(id, rel); const st = fs.statSync(f); const buf = fs.readFileSync(f);
    const p = this.safeRel(rel);
    if (!this.isText(p, buf)) return { path: p, size: st.size, binary: true };
    if (st.size > 1024 * 1024) return { path: p, size: st.size, tooLarge: true };
    return { path: p, size: st.size, text: buf.toString('utf8') };
  }
  writeFile(id, rel, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const f = this.absOf(id, rel);
    if (buf.length > MAX_FILE) throw new Error('ফাইল ৫MB এর বেশি');
    const files = this.listFiles(id); const exists = files.find((x) => x.path === this.safeRel(rel));
    if (!exists && files.length >= MAX_FILES) throw new Error(`সর্বোচ্চ ${MAX_FILES}টি ফাইল`);
    const total = files.reduce((s, x) => s + x.size, 0) - (exists ? exists.size : 0) + buf.length;
    if (total > MAX_TOTAL) throw new Error('Worker-এর মোট সাইজ ২৫MB এর বেশি');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    const w = this.get(id); if (w) { w.updatedAt = Date.now(); this.store.save(); }
  }
  deleteFile(id, rel) {
    const f = this.absOf(id, rel);
    if (!fs.existsSync(f)) throw new Error('ফাইল পাওয়া যায়নি');
    fs.rmSync(f, { recursive: true, force: true });
    // ফাঁকা ফোল্ডার সরানো
    let d = path.dirname(f); const root = this.dirOf(id);
    while (d !== root && d.startsWith(root)) { try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; } d = path.dirname(d); }
  }
  moveFile(id, from, to) {
    const a = this.absOf(id, from), b = this.absOf(id, to);
    if (!fs.existsSync(a)) throw new Error('ফাইল পাওয়া যায়নি');
    if (fs.existsSync(b)) throw new Error('এই নামে আগেই আছে');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
  }
  syntaxCheck(rel, content) {
    if (!/\.(m?js|cjs)$/.test(rel)) return null;
    const esm = rel.endsWith('.mjs') || (!rel.endsWith('.cjs') && /^\s*(export|import)\s/m.test(content));
    const tmp = path.join(os.tmpdir(), `wk-${genId()}${esm ? '.mjs' : '.cjs'}`);
    try {
      fs.writeFileSync(tmp, content);
      const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 8000, encoding: 'utf8' });
      return r.status === 0 ? null : String(r.stderr || 'সিনট্যাক্স ত্রুটি').split('\n').filter(Boolean).slice(0, 4).join('\n').replace(tmp, rel);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  applyChanges(id, changes) {
    let n = 0;
    for (const c of changes) { this.writeFile(id, c.path, String(c.content ?? '')); n++; }
    return n;
  }

  exportZip(id) {
    const root = this.dirOf(id);
    return zip(this.listFiles(id).map((f) => ({ name: f.path, data: fs.readFileSync(path.join(root, f.path)) })));
  }
  importZip(id, buf, { replace = false } = {}) {
    let entries = unzip(buf, { maxFiles: MAX_FILES + 50, maxTotal: MAX_TOTAL });
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    if (tops.size === 1 && entries.every((e) => e.name.includes('/'))) entries = entries.map((e) => ({ ...e, name: e.name.split('/').slice(1).join('/') }));
    const valid = []; let skipped = 0;
    for (const e of entries) { try { valid.push({ rel: this.safeRel(e.name), data: e.data }); } catch { skipped++; } }
    if (replace) { fs.rmSync(this.dirOf(id), { recursive: true, force: true }); fs.mkdirSync(this.dirOf(id), { recursive: true }); }
    let written = 0;
    for (const v of valid) { try { this.writeFile(id, v.rel, v.data); written++; } catch { skipped++; } }
    return { written, skipped };
  }
  exportAll() {
    const out = {};
    for (const w of this.all()) { out[w.id] = {}; for (const f of this.listFiles(w.id)) { try { out[w.id][f.path] = fs.readFileSync(path.join(this.dirOf(w.id), f.path)).toString('base64'); } catch { /* skip */ } } }
    return out;
  }
  importAll(map) {
    for (const [id, files] of Object.entries(map || {})) {
      if (!this.get(id)) continue;
      fs.mkdirSync(this.dirOf(id), { recursive: true });
      if (typeof files === 'string') { fs.writeFileSync(path.join(this.dirOf(id), 'worker.js'), files); continue; }
      for (const [rel, b64] of Object.entries(files)) { try { const f = this.absOf(id, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(b64, 'base64')); } catch { /* skip */ } }
    }
  }

  // ---------- এন্ট্রি ও package.json ----------
  entryOf(w) {
    const files = this.listFiles(w.id).map((f) => f.path);
    for (const c of [w.entry, 'worker.js', 'index.js', 'worker.mjs', 'index.mjs', 'src/index.js', 'src/worker.js', 'main.js']) if (c && files.includes(c)) return c;
    return files.find((f) => /\.(m?js|cjs)$/.test(f)) || null;
  }
  _ensureType(w, entry) {
    const dir = this.dirOf(w.id), pj = path.join(dir, 'package.json');
    let auto = true;
    if (fs.existsSync(pj)) { try { auto = !!JSON.parse(fs.readFileSync(pj, 'utf8'))['x-auto']; } catch { auto = false; } }
    if (!auto) return;
    let src = ''; try { src = fs.readFileSync(path.join(dir, entry), 'utf8'); } catch { /* none */ }
    const cjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$][\w$]*\s*=/.test(src) && !/^\s*(export|import)\s/m.test(src);
    fs.writeFileSync(pj, JSON.stringify({ type: cjs ? 'commonjs' : 'module', private: true, 'x-auto': true }));
  }

  // ---------- ভার্সন ইতিহাস ----------
  _size(dir) { return this._walk(dir).reduce((s, f) => s + f.size, 0); }
  snapshot(id, label = 'ok') {
    const ts = Date.now(), vd = this.verDir(id);
    fs.mkdirSync(vd, { recursive: true });
    fs.cpSync(this.dirOf(id), path.join(vd, `${ts}_${label}`), { recursive: true });
    const names = fs.readdirSync(vd).sort().reverse();
    for (const n of names.slice(KEEP_VERSIONS)) fs.rmSync(path.join(vd, n), { recursive: true, force: true });
    return ts;
  }
  versions(id) {
    let names = []; try { names = fs.readdirSync(this.verDir(id)); } catch { /* none */ }
    return names.filter((n) => /^\d+_(ok|failed|manual)$/.test(n)).sort().reverse().map((n) => {
      const d = path.join(this.verDir(id), n), fl = this._walk(d);
      return { name: n, ts: Number(n.split('_')[0]), label: n.split('_')[1], files: fl.length, size: fl.reduce((s, f) => s + f.size, 0) };
    });
  }
  restoreVersion(id, name) {
    if (!/^\d+_(ok|failed|manual)$/.test(name)) throw new Error('ভার্সন সঠিক নয়');
    const src = path.join(this.verDir(id), name);
    if (!fs.existsSync(src)) throw new Error('ভার্সন পাওয়া যায়নি');
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    fs.cpSync(src, this.dirOf(id), { recursive: true });
  }

  // ---------- যাচাই ----------
  _rt(id) {
    if (!this.rt.has(id)) this.rt.set(id, { state: 'stopped', proc: null, pending: new Map(), logs: [], recent: [], lat: [], win: [], seq: 0, inflight: 0, lastBeat: 0, startedAt: 0, fails: 0, error: '', manual: false, waiters: [], timer: null, restartTimer: null, lastCron: 0, kvKeys: 0, stats: null, dirty: false, readyAt: 0, downNotified: false, lastAlert: 0, fc: null, lastReq: 0, day: '', dayCount: 0, sleeping: false });
    return this.rt.get(id);
  }

  view(w) {
    const rt = this._rt(w.id);
    if (!rt.fc || Date.now() - rt.fc.t > 10000) { const fl = this.listFiles(w.id); rt.fc = { t: Date.now(), count: fl.length, size: fl.reduce((s, f) => s + f.size, 0) }; }
    return { id: w.id, name: w.name, slug: w.slug, domain: w.domain || '', enabled: !!w.enabled, ram: rssOf(rt.proc && rt.proc.pid), memoryMb: w.memoryMb === undefined ? HEAP : Number(w.memoryMb) || 0, idleMin: w.idleMin === undefined ? IDLE_DEFAULT : Number(w.idleMin), dailyLimit: Number(w.dailyLimit) || 0, dailyUsed: rt.day === new Date().toISOString().slice(0, 10) ? rt.dayCount : 0, lastReq: rt.lastReq || 0, cronMin: w.cronMin || 0, rateLimit: w.rateLimit || 0, entry: this.entryOf(w) || w.entry || 'worker.js', envCount: (w.env || []).length, fileCount: rt.fc.count, totalSize: rt.fc.size, createdAt: w.createdAt, updatedAt: w.updatedAt, state: rt.state, error: rt.error, startedAt: rt.startedAt, inflight: rt.inflight, versions: this.versions(w.id).length, kvKeys: rt.kvKeys };
  }

  cleanEnv(list, old = []) {
    const out = []; const seen = new Set();
    for (const e of (Array.isArray(list) ? list : []).slice(0, 50)) {
      const key = String(e.key || '').trim();
      if (!key) continue;
      if (!ENV_RE.test(key)) throw new Error(`ENV নাম সঠিক নয়: ${key}`);
      if (seen.has(key)) throw new Error(`ENV নাম দুইবার: ${key}`);
      seen.add(key);
      let value = String(e.value ?? '').slice(0, 4096);
      const secret = !!e.secret;
      if (secret && value === '') { const o = old.find((x) => x.key === key); if (o) value = o.value; }
      out.push({ key, value, secret });
    }
    return out;
  }

  uniqueSlug(base, selfId) {
    let s = slugify(base) || 'worker-' + genId().slice(0, 4);
    if (s.length < 2) s += '-w';
    let n = 1; let c = s;
    while (this.all().some((w) => w.slug === c && w.id !== selfId)) { n++; c = `${s.slice(0, 36)}-${n}`; }
    return c;
  }

  // ---------- CRUD ----------
  // files: [{path, content}] অথবা code (এক ফাইল = worker.js)
  create({ name, slug, code, files, env, cronMin, entry, memoryMb, idleMin, dailyLimit }) {
    if (this.all().length >= this.max) throw new Error(`সর্বোচ্চ ${this.max}টি Worker`);
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error('নাম দিন');
    const list = Array.isArray(files) && files.length ? files : [{ path: 'worker.js', content: String(code || '') }];
    if (!list.some((f) => String(f.content || '').trim())) throw new Error('worker.js ফাঁকা');
    if (slug && !SLUG_RE.test(String(slug))) throw new Error('URL নাম: ছোট হাতের a-z, 0-9, হাইফেন (২-৪০ অক্ষর)');
    if (slug && this.bySlug(slug)) throw new Error('এই URL নাম আগেই আছে');
    const w = { id: genId(), name: n, slug: slug || this.uniqueSlug(n), enabled: true, env: this.cleanEnv(env), cronMin: Math.max(0, Math.min(1440, Number(cronMin) || 0)), rateLimit: 0, entry: entry || list[0].path, createdAt: Date.now(), updatedAt: Date.now() };
    if (memoryMb !== undefined) w.memoryMb = normMem(memoryMb);
    if (idleMin !== undefined) w.idleMin = normIdle(idleMin);
    if (dailyLimit !== undefined) w.dailyLimit = normCount(dailyLimit);
    fs.mkdirSync(this.dirOf(w.id), { recursive: true });
    this.all().push(w);
    try { for (const f of list) this.writeFile(w.id, f.path, String(f.content ?? '')); } catch (e) { this.store.data.workers = this.all().filter((x) => x.id !== w.id); fs.rmSync(this.dirOf(w.id), { recursive: true, force: true }); throw e; }
    this.store.save();
    return w;
  }

  clone(id, name) {
    const w = this.get(id); if (!w) throw new Error('Worker নেই');
    if (this.all().length >= this.max) throw new Error(`সর্বোচ্চ ${this.max}টি Worker`);
    const c = { ...JSON.parse(JSON.stringify(w)), id: genId(), name: String(name || w.name + ' copy').slice(0, 60), enabled: false, createdAt: Date.now(), updatedAt: Date.now() };
    c.slug = this.uniqueSlug(c.name, c.id);
    fs.cpSync(this.dirOf(id), this.dirOf(c.id), { recursive: true });
    this.all().push(c); this.store.save();
    return c;
  }

  update(w, { name, slug, cronMin, entry, rateLimit }) {
    if (name !== undefined) { const n = String(name).trim().slice(0, 60); if (!n) throw new Error('নাম ফাঁকা'); w.name = n; }
    if (slug !== undefined && slug !== w.slug) {
      if (!SLUG_RE.test(String(slug))) throw new Error('URL নাম সঠিক নয়');
      if (this.bySlug(slug)) throw new Error('এই URL নাম আগেই আছে');
      w.slug = slug;
    }
    if (cronMin !== undefined) w.cronMin = Math.max(0, Math.min(1440, Number(cronMin) || 0));
    if (rateLimit !== undefined) w.rateLimit = Math.max(0, Math.min(100000, Number(rateLimit) || 0));
    if (entry !== undefined) { const e = this.safeRel(entry); if (!this.listFiles(w.id).some((f) => f.path === e)) throw new Error('এন্ট্রি ফাইল পাওয়া যায়নি'); w.entry = e; }
    w.updatedAt = Date.now();
    this.store.save();
  }

  async remove(id) {
    await this.stop(id, { keep: true });
    this.store.data.workers = this.all().filter((w) => w.id !== id);
    for (const f of [this.dirOf(id), this.verDir(id), this.kvFile(id), this.statsFile(id), this.dbFile(id), this.dbFile(id) + '-wal', this.dbFile(id) + '-shm']) fs.rmSync(f, { recursive: true, force: true });
    this.rt.delete(id);
    this.store.save();
  }

  // ---------- জীবনচক্র ----------
  _spawn(w) {
    const rt = this._rt(w.id);
    clearTimeout(rt.restartTimer);
    rt.state = 'starting'; rt.error = ''; rt.startedAt = Date.now(); rt.lastBeat = Date.now(); rt.manual = false; rt.readyAt = 0; rt.loadFailed = false; rt.sleeping = false;
    const entry = this.entryOf(w);
    if (!entry) { this._fail(rt, w, 'এন্ট্রি ফাইল নেই। worker.js (বা index.js) তৈরি করুন।', false); return; }
    this._ensureType(w, entry);
    const cfg = { file: path.join(this.dirOf(w.id), entry), dir: this.dirOf(w.id), kv: this.kvFile(w.id), db: this.dbFile(w.id), name: w.name, slug: w.slug, env: Object.fromEntries((w.env || []).map((e) => [e.key, e.value])) };
    const memFlag = Number(w.memoryMb) > 0 ? [`--max-old-space-size=${Math.min(MEM_CAP, Number(w.memoryMb))}`] : [];
    const proc = spawn(process.execPath, [...memFlag, '--disable-warning=ExperimentalWarning', HOST], { cwd: this.dirOf(w.id), env: { PATH: process.env.PATH, NODE_ENV: 'production', WK_CONFIG: JSON.stringify(cfg) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    rt.proc = proc;
    this._pipe(proc.stdout, rt, false); this._pipe(proc.stderr, rt, true);
    clearTimeout(rt.timer);
    rt.timer = setTimeout(() => { if (rt.state === 'starting' && rt.proc === proc) { this._fail(rt, w, 'লোড হতে ১০ সেকেন্ডের বেশি লাগছে (top-level await আটকে?)', true); try { proc.kill('SIGKILL'); } catch { /* gone */ } } }, 10000);
    proc.on('message', (m) => this._msg(w, rt, m));
    proc.on('error', (e) => this._fail(rt, w, e.message, true));
    proc.on('exit', (code, sig) => {
      if (rt.proc !== proc) return;
      rt.proc = null; clearTimeout(rt.timer);
      for (const [, p] of rt.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Worker বন্ধ হয়ে গেছে'), { code: 502 })); }
      rt.pending.clear();
      if (rt.manual) {
        if (rt.wakePending) { rt.wakePending = false; this._spawn(w); return; }
        rt.state = rt.sleeping ? 'sleeping' : 'stopped';
        return;
      }
      if (rt.loadFailed) return;
      if (rt.state === 'starting') return this._fail(rt, w, rt.error || `লোড হয়নি (exit ${code ?? sig})`, true);
      rt.fails++;
      rt.error = rt.error || `ক্র্যাশ (exit ${code ?? sig})`;
      rt.state = 'error';
      this._log(rt, '! ' + rt.error);
      if (!rt.downNotified) { rt.downNotified = true; this.emit('event', { type: 'down', worker: this.view(w), reason: rt.error }); }
      const w2 = this.get(w.id);
      if (w2 && w2.enabled) rt.restartTimer = setTimeout(() => { const x = this.get(w.id); if (x && x.enabled && !rt.proc) this._spawn(x); }, Math.min(30000, 1000 * 2 ** Math.min(rt.fails, 5)));
    });
  }

  _fail(rt, w, msg, loadError) {
    rt.state = 'error'; rt.error = msg; if (loadError) rt.loadFailed = true;
    this._log(rt, '! ' + msg.split('\n')[0]);
    const ws = rt.waiters; rt.waiters = [];
    if (!ws.length && !rt.downNotified && !rt.manual) { rt.downNotified = true; this.emit('event', { type: 'down', worker: this.view(w), reason: msg.split('\n')[0] }); }
    ws.forEach((f) => f({ ok: false, error: msg }));
    if (loadError && rt.proc) { try { rt.proc.kill('SIGKILL'); } catch { /* gone */ } }
  }

  _msg(w, rt, m) {
    if (!m) return;
    if (m.t === 'hb') rt.lastBeat = Date.now();
    else if (m.t === 'ready') {
      clearTimeout(rt.timer); rt.state = 'running'; rt.error = ''; rt.readyAt = Date.now(); rt.lastBeat = Date.now(); rt.kvKeys = m.kv || 0;
      this._log(rt, 'চালু হয়েছে');
      if (rt.downNotified) { rt.downNotified = false; this.emit('event', { type: 'up', worker: this.view(w) }); }
      const ws = rt.waiters; rt.waiters = []; ws.forEach((f) => f({ ok: true }));
      setTimeout(() => { if (rt.state === 'running') rt.fails = 0; }, 60000).unref();
    } else if (m.t === 'fatal') { clearTimeout(rt.timer); this._fail(rt, w, m.message || 'লোড ব্যর্থ', true); }
    else if (m.t === 'kv') rt.kvKeys = m.n;
    else if (m.t === 'res') {
      const p = rt.pending.get(m.id); if (!p) return;
      rt.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error), { code: 500, cpu: m.cpu }));
      else p.resolve({ status: m.status, headers: m.headers, body: Buffer.from(m.body || '', 'base64'), cpu: m.cpu || 0 });
    }
  }

  _pipe(stream, rt, isErr) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1); if (line) this._log(rt, (isErr ? '! ' : '') + line.slice(0, 400)); }
      if (buf.length > 6000) buf = '';
    });
  }

  _log(rt, line) {
    rt.logs.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
    if (rt.logs.length > 300) rt.logs.splice(0, rt.logs.length - 300);
  }

  logs(id) { return this._rt(id).logs.slice(-200); }

  async _startWait(w) {
    await this.stop(w.id, { keep: true });
    const rt = this._rt(w.id);
    return new Promise((resolve) => { rt.waiters.push(resolve); this._spawn(w); });
  }

  // ডিপ্লয়: ফাইলগুলো ডিস্কে আগেই আছে। সফল হলে সংস্করণ সেভ; ব্যর্থ হলে শেষ ভালো সংস্করণ ফেরত
  async deploy(id) {
    const w = this.get(id); if (!w) return { ok: false, error: 'Worker নেই' };
    w.enabled = true; w.updatedAt = Date.now(); this.store.save();
    const pre = this.check(id);
    // ডিপ্লয়ের আগে যাচাই: ভুল থাকলে প্রসেস শুরুই হবে না (দ্রুত ও নিরাপদ)
    let r = pre.ok ? await this._startWait(w) : { ok: false, error: 'ডিপ্লয়ের আগের যাচাই ব্যর্থ:\n' + pre.errors.join('\n'), precheck: true };
    if (r.ok && w.strictTests) {
      const t = await this.runTests(id);
      if (t.total && !t.ok) r = { ok: false, error: `টেস্ট ব্যর্থ (${t.failed}/${t.total}):\n` + t.results.filter((x) => !x.pass).slice(0, 5).map((x) => `${x.name}: ${x.reason}`).join('\n') };
    }
    if (r.ok) { this.snapshot(id, 'ok'); return { ...r, warnings: pre.warnings }; }
    const good = this.versions(id).find((v) => v.label === 'ok');
    if (good) {
      this.snapshot(id, 'failed');
      this.restoreVersion(id, good.name);
      await this._startWait(w).catch(() => {});
      return { ok: false, error: r.error, rolledBack: true };
    }
    return r;
  }

  async restore(id, name) { this.restoreVersion(id, name); return this.deploy(id); }
  async start(id) { const w = this.get(id); if (!w) return { ok: false, error: 'Worker নেই' }; w.enabled = true; this.store.save(); return this._startWait(w); }
  async restart(id) { return this.start(id); }

  stop(id, { keep = false } = {}) {
    return new Promise((resolve) => {
      const w = this.get(id); const rt = this._rt(id);
      if (w && !keep) { w.enabled = false; this.store.save(); }
      rt.manual = true; clearTimeout(rt.restartTimer); clearTimeout(rt.timer);
      const p = rt.proc;
      if (!p) { rt.state = 'stopped'; if (!keep) rt.error = ''; return resolve(); }
      p.once('exit', () => resolve());
      setTimeout(resolve, 4000).unref();
      try { p.send({ t: 'shutdown' }); } catch { /* ipc closed */ }
      setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* gone */ } }, 2500).unref();
      rt.state = 'stopped'; if (!keep) rt.error = '';
    });
  }

  async stopAll() { this.flushStats(); await Promise.all(this.all().map((w) => this.stop(w.id, { keep: true }))); }
  autostart() { let i = 0; for (const w of this.all()) if (w.enabled) setTimeout(() => this._startWait(w).catch(() => {}), 800 * i++); }

  // ঘুমন্ত Worker: প্রথম রিকোয়েস্টে জাগে
  _wake(w) {
    const rt = this._rt(w.id);
    if (rt.state === 'running') return Promise.resolve(true);
    return new Promise((res) => {
      rt.waiters.push((r) => res(!!r.ok));
      if (rt.proc) rt.wakePending = true; else this._spawn(w);
    });
  }
  _sleep(w) {
    const rt = this._rt(w.id);
    rt.sleeping = true; rt.state = 'sleeping';
    this._log(rt, 'নিষ্ক্রিয় থাকায় ঘুমিয়ে পড়েছে (RAM বাঁচাতে)');
    this.stop(w.id, { keep: true });
  }

  _tick() {
    this._n++;
    const now = Date.now();
    for (const [k, v] of this._rl) if (v.reset < now) this._rl.delete(k);
    for (const w of this.all()) {
      const rt = this._rt(w.id);
      if (rt.state === 'running' && rt.proc && now - rt.lastBeat > 20000) {
        this._log(rt, '! event loop আটকে গিয়েছিল, রিস্টার্ট');
        rt.error = 'event loop আটকে ছিল'; try { rt.proc.kill('SIGKILL'); } catch { /* gone */ }
      }
      if (rt.state === 'running' && rt.proc && w.enabled && !w.cronMin && rt.inflight === 0) {
        const idleMs = (w.idleMin === undefined ? IDLE_DEFAULT : Number(w.idleMin)) * 60000;
        if (idleMs > 0 && now - (rt.lastReq || rt.readyAt || 0) > idleMs) this._sleep(w);
      }
      if (this._n % 3 === 0 && w.cronMin > 0 && rt.state === 'running' && now - (rt.lastCron || rt.readyAt) >= w.cronMin * 60000) {
        rt.lastCron = now;
        try { rt.proc.send({ t: 'cron', cron: `every ${w.cronMin}m` }); } catch { /* ipc closed */ }
      }
      // ত্রুটির হার সতর্কতা: গত ৫ মিনিটে ≥২০ রিকোয়েস্টের ≥৫০% 5xx
      if (this._n % 6 === 0) {
        rt.win = rt.win.filter((x) => now - x.t < 300000);
        const err = rt.win.filter((x) => x.err).length;
        if (rt.win.length >= 20 && err / rt.win.length >= 0.5 && now - rt.lastAlert > 1800000) {
          rt.lastAlert = now;
          this.emit('event', { type: 'errorrate', worker: this.view(w), total: rt.win.length, errors: err });
        }
      }
    }
  }

  // ---------- রিকোয়েস্ট ----------
  _call(rt, payload) {
    return new Promise((resolve, reject) => {
      const id = ++rt.seq;
      const timer = setTimeout(() => { rt.pending.delete(id); reject(Object.assign(new Error('Worker ৩০ সেকেন্ডে উত্তর দেয়নি'), { code: 504 })); }, REQ_TIMEOUT);
      rt.pending.set(id, { resolve, reject, timer });
      try { rt.proc.send({ t: 'req', id, ...payload }); } catch (e) { clearTimeout(timer); rt.pending.delete(id); reject(Object.assign(e, { code: 502 })); }
    });
  }

  _limited(w, ip) {
    if (!w.rateLimit) return false;
    const k = w.id + '|' + ip, now = Date.now();
    let e = this._rl.get(k);
    if (!e || e.reset < now) { e = { n: 0, reset: now + 60000 }; this._rl.set(k, e); }
    return ++e.n > w.rateLimit;
  }

  // অভ্যন্তরীণ: HTTP ছাড়াই রিকোয়েস্ট চালানো (টেলিগ্রাম টেস্ট ইত্যাদি)
  async _dispatch(w, { method, url, headers, body, ip, path: p, ua, skipLimit }) {
    const rt = this._rt(w.id);
    const t0 = Date.now();
    const done = (out, kind, err = '') => { out.ms = Date.now() - t0; this._rec(w, rt, out, kind, method, p, ua, err); return out; };
    const plain = (status, text) => ({ status, headers: [['content-type', 'text/plain; charset=utf-8']], body: Buffer.from(text), cpu: 0 });
    if (!w.enabled) return plain(503, 'Worker is stopped');
    rt.lastReq = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    if (rt.day !== today) { rt.day = today; rt.dayCount = 0; }
    if (!skipLimit && w.dailyLimit && rt.dayCount >= Number(w.dailyLimit)) return done(plain(429, 'আজকের দৈনিক সীমা শেষ (dailyLimit)'), 'limited');
    rt.dayCount++;
    if (rt.state === 'sleeping') { const woke = await this._wake(w); if (!woke) return done(plain(503, 'Worker জাগাতে ব্যর্থ'), 'unavail', rt.error); }
    for (let i = 0; i < 50 && rt.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 100));
    if (rt.state !== 'running' || !rt.proc) return done(plain(503, 'Worker unavailable'), 'unavail', rt.error);
    if (!skipLimit && this._limited(w, ip)) { const o = plain(429, 'Rate limit exceeded'); o.headers.push(['retry-after', '60']); return done(o, 'limited'); }
    if (w.concurrency > 0 && rt.inflight >= w.concurrency) return plain(429, 'Too many requests (concurrency সীমা)');
    rt.inflight++;
    try {
      const out = await this._call(rt, { method, url, headers, body });
      return done(out, 'ok');
    } catch (e) {
      const err = e.message || 'error';
      this._log(rt, '! ' + err.split('\n').slice(0, 3).join(' | '));
      const o = plain(e.code === 504 ? 504 : e.code === 502 ? 502 : 500, e.code === 504 ? 'Worker timed out' : e.code === 502 ? 'Worker unavailable' : 'Worker threw exception');
      o.cpu = e.cpu || 0;
      return done(o, e.code === 504 ? 'tmo' : e.code === 502 ? 'unavail' : 'exc', err);
    } finally { rt.inflight--; }
  }

  async serve(req, res) {
    const w = this.bySlug(req.params.slug);
    if (!w) return res.status(404).type('text').send('Worker not found');
    const origin = `${req.protocol}://${req.get('host')}`;
    this.origin = origin;
    const rest = String(req.params[0] || '');
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['content-length', 'connection', 'transfer-encoding'].includes(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    if (headers.cookie) headers.cookie = headers.cookie.split(';').map((s) => s.trim()).filter((s) => !s.startsWith('mch=')).join('; ');
    if (!headers.cookie) delete headers.cookie;
    delete headers['x-mch-token'];
    headers['cf-connecting-ip'] = req.ip || '';
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body.toString('base64') : null;
    const out = await this._dispatch(w, { method: req.method, url: `${origin}/${rest}${qs}`, headers, body, ip: req.ip || '', path: '/' + rest, ua: headers['user-agent'] });
    res.status(out.status);
    for (const [k, v] of out.headers) { if (HOP.has(k)) continue; try { res.append(k, v); } catch { /* invalid header */ } }
    res.set('content-length', String(out.body.length));
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }

  // প্যানেল/টেলিগ্রাম থেকে সরাসরি টেস্ট
  async invoke(id, { method = 'GET', path: p = '/', headers = {}, body = null }) {
    const w = this.get(id); if (!w) throw new Error('Worker নেই');
    const pp = p.startsWith('/') ? p : '/' + p;
    return this._dispatch(w, { method, url: this.origin + pp, headers, body: body ? Buffer.from(body).toString('base64') : null, ip: 'admin', path: pp.split('?')[0], ua: 'mc-host-test', skipLimit: true });
  }

  // ---------- পরিসংখ্যান ----------
  stats(id) {
    const rt = this._rt(id);
    if (!rt.stats) { try { rt.stats = JSON.parse(fs.readFileSync(this.statsFile(id), 'utf8')); } catch { rt.stats = {}; } }
    const s = rt.stats; s.t ||= 0; s.e ||= 0; s.b ||= {}; s.p ||= {}; s.m ||= {}; s.u ||= {}; s.lh ||= [0, 0, 0, 0, 0, 0, 0];
    return s;
  }

  // বাকেট: [req, ms, 2xx, 3xx, 4xx, 5xx, bytes, cpuMs, exceptions, timeouts]
  _rec(w, rt, out, kind, method, p, ua, err) {
    const st = this.stats(w.id); const k = Math.floor(Date.now() / BUCKET);
    const a = (st.b[k] ||= [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const status = out.status, ms = out.ms;
    a[0]++; a[1] += Math.round(ms);
    a[status >= 500 ? 5 : status >= 400 ? 4 : status >= 300 ? 3 : 2]++;
    a[6] += out.body ? out.body.length : 0; a[7] += Math.round(out.cpu || 0);
    if (kind === 'exc') a[8]++; if (kind === 'tmo') a[9]++;
    st.t++; if (status >= 500) st.e++;
    st.m[method] = (st.m[method] || 0) + 1;
    const g = uaGroup(ua); st.u[g] = (st.u[g] || 0) + 1;
    let li = LAT_EDGES.findIndex((e) => ms < e); if (li < 0) li = LAT_EDGES.length; st.lh[li]++;
    const key = normPath(p);
    const e = (st.p[key] ||= [0, 0, 0]); e[0]++; if (status >= 500) e[1]++; e[2] += Math.round(ms);
    const keys = Object.keys(st.p);
    if (keys.length > 100) { let min = keys[0]; for (const x of keys) if (st.p[x][0] < st.p[min][0]) min = x; if (min !== key) delete st.p[min]; }
    rt.dirty = true; this._gen = (this._gen || 0) + 1;
    rt.lat.push(ms); if (rt.lat.length > 300) rt.lat.shift();
    rt.win.push({ t: Date.now(), err: status >= 500 });
    rt.recent.push({ t: Date.now(), method, path: String(p || '/').slice(0, 120), status, ms, err: err ? err.split('\n')[0].slice(0, 120) : '' });
    if (rt.recent.length > 60) rt.recent.shift();
  }

  flushStats() {
    const cutoff = Math.floor((Date.now() - KEEP_DAYS * 86400000) / BUCKET);
    for (const [id, rt] of this.rt) {
      if (!rt.dirty || !rt.stats) continue;
      for (const k of Object.keys(rt.stats.b)) if (Number(k) < cutoff) delete rt.stats.b[k];
      try { fs.writeFileSync(this.statsFile(id) + '.tmp', JSON.stringify(rt.stats)); fs.renameSync(this.statsFile(id) + '.tmp', this.statsFile(id)); rt.dirty = false; } catch { /* ignore */ }
    }
  }


  // দৈনিক সারাংশ (সর্বশেষ ৩০ দিন), CSV-র জন্য। tzMin = getTimezoneOffset()
  dailyRows(id, tzMin = 0) {
    const off = -Number(tzMin || 0) * 60000, day = 86400000, now = Date.now();
    const today = Math.floor((now + off) / day);
    const map = new Map();
    for (const [k, a] of Object.entries(this.stats(id).b)) {
      const t = Number(k) * BUCKET; const di = Math.floor((t + off) / day);
      if (today - di < 0 || today - di > 29) continue;
      const r = map.get(di) || { req: 0, ok: 0, err: 0, ms: 0, bytes: 0, cpu: 0, exc: 0, tmo: 0 };
      r.req += a[0]; r.ms += a[1]; r.ok += a[2] + a[3] + a[4]; r.err += a[5]; r.bytes += a[6] || 0; r.cpu += a[7] || 0; r.exc += a[8] || 0; r.tmo += a[9] || 0;
      map.set(di, r);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([di, r]) => ({ date: new Date(di * day).toISOString().slice(0, 10), ...r, avgMs: r.req ? Math.round(r.ms / r.req) : 0, errRate: r.req ? Math.round(r.err / r.req * 1000) / 10 : 0 }));
  }
  csv(id, tzMin = 0) {
    const head = 'date,requests,ok,errors_5xx,error_rate_pct,avg_ms,bytes,cpu_ms,exceptions,timeouts';
    const rows = this.dailyRows(id, tzMin).map((r) => [r.date, r.req, r.ok, r.err, r.errRate, r.avgMs, r.bytes, Math.round(r.cpu), r.exc, r.tmo].join(','));
    return [head, ...rows].join('\n') + '\n';
  }


  // SQLite স্ন্যাপশট: VACUUM INTO দিয়ে WAL-সহ সুসংগত কপি (Worker চলাকালীনও নিরাপদ)
  dbSnapshot(id) {
    const f = this.dbFile(id);
    if (!fs.existsSync(f)) return null;
    let sqlite = null; try { sqlite = require('node:sqlite'); } catch { return null; }
    const tmp = path.join(os.tmpdir(), `dbsnap-${genId()}.db`);
    const db = new sqlite.DatabaseSync(f);
    try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); return fs.readFileSync(tmp); }
    finally { try { db.close(); } catch { /* ignore */ } fs.rmSync(tmp, { force: true }); }
  }
  dbRestore(id, buf) {
    const f = this.dbFile(id);
    fs.rmSync(f + '-wal', { force: true }); fs.rmSync(f + '-shm', { force: true });
    fs.writeFileSync(f, buf);
  }
  dbExportAll() {
    const out = {};
    for (const w of this.all()) { const b = this.dbSnapshot(w.id); if (b) out[w.id] = b.toString('base64'); }
    return out;
  }
  dbImportAll(map) {
    for (const [id, b64] of Object.entries(map || {})) { if (this.get(id)) { try { this.dbRestore(id, Buffer.from(b64, 'base64')); } catch { /* skip */ } } }
  }

  // ---------- ডিপ্লয়-পূর্ব যাচাই ----------
  check(id) {
    const w = this.get(id); const errors = []; const warnings = [];
    const files = this.listFiles(id).map((f) => f.path); const set = new Set(files);
    const entry = this.entryOf(w);
    if (!entry) errors.push('এন্ট্রি ফাইল নেই (worker.js বা index.js লাগবে)');
    const envKeys = new Set((w.env || []).map((e) => e.key));
    const used = new Map();
    const IMP = /(?:import\s[^'"]*?from\s*|export\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
    const BARE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*)(['"])([^'"./][^'"]*)\1/g;
    const builtins = new Set(require('module').builtinModules.map((m) => m.replace(/^node:/, '')));
    for (const rel of files.filter((f) => /\.(m?js|cjs)$/.test(f))) {
      const content = fs.readFileSync(path.join(this.dirOf(id), rel), 'utf8');
      const se = this.syntaxCheck(rel, content);
      if (se) errors.push(`${rel}: সিনট্যাক্স ত্রুটি — ${se.split('\n')[0]}`);
      let m;
      IMP.lastIndex = 0;
      while ((m = IMP.exec(content))) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]));
        const cands = [target, target + '.js', target + '.mjs', target + '.cjs', target + '/index.js'];
        if (!cands.some((c) => set.has(c))) errors.push(`${rel}: "${m[2]}" ইমপোর্ট হচ্ছে কিন্তু ফাইলটি নেই`);
      }
      BARE.lastIndex = 0;
      while ((m = BARE.exec(content))) {
        const pkg = m[2].replace(/^node:/, '').split('/')[0];
        if (!builtins.has(pkg) && !fs.existsSync(path.join(this.dirOf(id), 'node_modules', pkg))) warnings.push(`${rel}: প্যাকেজ "${m[2]}" node_modules-এ নেই, চলবে না`);
      }
      const ENVU = /\b(?:process\.env|env)\.([A-Za-z_][A-Za-z0-9_]*)/g;
      while ((m = ENVU.exec(content))) used.set(m[1], rel);
    }
    const dotenvKeys = new Set();
    for (const f of ['.env', '.dev.vars']) { if (set.has(f)) { try { for (const l of fs.readFileSync(path.join(this.dirOf(id), f), 'utf8').split('\n')) { const mm = l.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/); if (mm) dotenvKeys.add(mm[1]); } } catch { /* ignore */ } } }
    for (const [k, rel] of used) if (!envKeys.has(k) && !dotenvKeys.has(k) && !['KV', 'ASSETS', 'DB'].includes(k)) warnings.push(`${rel}: ENV "${k}" ব্যবহার হচ্ছে কিন্তু সেট নেই`);
    return { ok: errors.length === 0, errors, warnings, entry, files: files.length };
  }

  // ---------- টেস্ট স্যুট (tests.json) ----------
  // ফরম্যাট: [{ "name":"home", "method":"GET", "path":"/", "body":"...", "expect":{ "status":200, "includes":"text" } }]
  async runTests(id) {
    const w = this.get(id); const f = path.join(this.dirOf(id), 'tests.json');
    if (!fs.existsSync(f)) return { ok: true, total: 0, failed: 0, results: [], note: 'tests.json নেই' };
    let cases; try { cases = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, total: 1, failed: 1, results: [{ name: 'tests.json', pass: false, reason: 'JSON সঠিক নয়: ' + e.message }] }; }
    if (!Array.isArray(cases)) return { ok: false, total: 1, failed: 1, results: [{ name: 'tests.json', pass: false, reason: 'অ্যারে হতে হবে' }] };
    const results = [];
    for (const c of cases.slice(0, 100)) {
      const name = String(c.name || c.path || 'test').slice(0, 80);
      let out;
      try { out = await this.invoke(id, { method: String(c.method || 'GET').toUpperCase(), path: String(c.path || '/'), headers: c.headers || {}, body: c.body == null ? null : (typeof c.body === 'string' ? c.body : JSON.stringify(c.body)) }); }
      catch (e) { results.push({ name, pass: false, reason: e.message }); continue; }
      const text = out.body.toString('utf8'); const exp = c.expect || {}; const reasons = [];
      if (exp.status !== undefined && out.status !== Number(exp.status)) reasons.push(`স্ট্যাটাস ${out.status}, চেয়েছিলাম ${exp.status}`);
      if (exp.includes && !text.includes(String(exp.includes))) reasons.push(`উত্তরে "${String(exp.includes).slice(0, 40)}" নেই`);
      if (exp.maxMs !== undefined && out.ms > Number(exp.maxMs)) reasons.push(`${out.ms}ms, সীমা ${exp.maxMs}ms`);
      if (exp.status === undefined && exp.includes === undefined && exp.maxMs === undefined && out.status >= 500) reasons.push('সার্ভার ত্রুটি ' + out.status);
      results.push({ name, pass: reasons.length === 0, reason: reasons.join('; ') || 'ঠিক আছে', status: out.status, ms: out.ms });
    }
    const failed = results.filter((x) => !x.pass).length;
    w.lastTests = { t: Date.now(), total: results.length, failed }; this.store.save();
    return { ok: failed === 0, total: results.length, failed, results };
  }

  // ---------- ডাটাবেস (শুধু পড়া) ----------
  openDbRO(id) {
    const f = this.dbFile(id); if (!fs.existsSync(f)) return null;
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(f, { readOnly: true });
  }
  dbTables(id) {
    const db = this.openDbRO(id); if (!db) return { exists: false, tables: [] };
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
      return { exists: true, tables: names.map((n) => ({ name: n, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`).get().n })) };
    } finally { db.close(); }
  }
  dbRows(id, table, limit = 50, offset = 0) {
    const t = this.dbTables(id).tables.find((x) => x.name === table);
    if (!t) throw new Error('টেবিল পাওয়া যায়নি');
    const db = this.openDbRO(id);
    try {
      const lim = Math.max(1, Math.min(200, Number(limit) || 50)), off = Math.max(0, Number(offset) || 0);
      const rows = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ? OFFSET ?`).all(lim, off);
      return { table, total: t.rows, columns: rows[0] ? Object.keys(rows[0]) : [], rows, limit: lim, offset: off };
    } finally { db.close(); }
  }
  dbQuery(id, sql) {
    const s = String(sql || '').trim().replace(/;\s*$/, '');
    if (!/^select\s/i.test(s) || s.includes(';')) throw new Error('শুধু একটি SELECT কোয়েরি চলবে');
    if (/\b(attach|pragma|insert|update|delete|drop|alter|create|replace)\b/i.test(s)) throw new Error('এই কোয়েরি অনুমোদিত নয়');
    const db = this.openDbRO(id); if (!db) throw new Error('ডাটাবেস নেই');
    try { const rows = db.prepare(s).all(); return { rows: rows.slice(0, 200), total: rows.length, columns: rows[0] ? Object.keys(rows[0]) : [] }; }
    finally { db.close(); }
  }

  // ---------- ভার্সন তুলনা ----------
  diffVersion(id, name, file) {
    if (!/^\d+_(ok|failed|manual)$/.test(name)) throw new Error('ভার্সন সঠিক নয়');
    const vdir = path.join(this.verDir(id), name);
    if (!fs.existsSync(vdir)) throw new Error('ভার্সন পাওয়া যায়নি');
    const cdir = this.dirOf(id);
    const cur = new Map(this._walk(cdir).map((f) => [f.path, f]));
    const old = new Map(this._walk(vdir).map((f) => [f.path, f]));
    const paths = [...new Set([...cur.keys(), ...old.keys()])].sort();
    const out = [];
    for (const p of paths) {
      const a = old.has(p) ? fs.readFileSync(path.join(vdir, p)) : null;
      const b = cur.has(p) ? fs.readFileSync(path.join(cdir, p)) : null;
      let st = 'same';
      if (!a) st = 'added'; else if (!b) st = 'removed'; else if (!a.equals(b)) st = 'changed';
      if (st === 'same') continue;
      const e = { path: p, status: st, size: (b || a).length, add: 0, del: 0, binary: false };
      const text = !(a || b || Buffer.alloc(0)).subarray(0, 4096).includes(0);
      if (!text) e.binary = true;
      else {
        const d = lineDiff(((a || Buffer.alloc(0)).toString('utf8')).split('\n'), ((b || Buffer.alloc(0)).toString('utf8')).split('\n'));
        e.add = d.add; e.del = d.del;
        if (file === p) e.lines = d.lines.slice(0, 800);
      }
      out.push(e);
    }
    return { name, ts: Number(name.split('_')[0]), files: out, file: file || null, note: 'ভার্সন → বর্তমান (+ নতুন, − বাদ)' };
  }

  totalRequests() { let n = 0; for (const w of this.all()) n += this.stats(w.id).t; return n; }

  agg(ids, tzMin = 0) {
    const key = ids.join(',') + '|' + tzMin + '|' + this._gen + '|' + Math.floor(Date.now() / 60000);
    this._aggCache ||= new Map();
    if (this._aggCache.has(key)) return this._aggCache.get(key);
    const out = this._aggRaw(ids, tzMin);
    this._aggCache.set(key, out);
    if (this._aggCache.size > 40) this._aggCache.delete(this._aggCache.keys().next().value);
    return out;
  }
  _aggRaw(ids, tzMin = 0) {
    const off = -Number(tzMin || 0) * 60000, hr = 3600000, day = 86400000, now = Date.now();
    const dayStart = Math.floor((now + off) / day) * day - off;
    const hourStart = Math.floor((now + off) / hr) * hr - off;
    const z = () => ({ req: 0, err: 0, ms: 0, bytes: 0, cpu: 0 });
    const out = { today: z(), yesterday: z(), d7: z(), d30: z(), total: 0, totalErr: 0, hours: [], days: [], codesToday: [0, 0, 0, 0], codes30: [0, 0, 0, 0], inv: { ok: 0, exc: 0, tmo: 0 }, heat: Array.from({ length: 7 }, () => Array(24).fill(0)) };
    for (let i = 0; i < 24; i++) out.hours.push({ req: 0, err: 0, label: String((((Math.floor((hourStart - (23 - i) * hr + off) / hr)) % 24) + 24) % 24) });
    for (let i = 0; i < 14; i++) { const d = new Date(dayStart - (13 - i) * day + off); out.days.push({ req: 0, err: 0, label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}` }); }
    const add = (o, a) => { o.req += a[0]; o.err += a[5]; o.ms += a[1]; o.bytes += a[6] || 0; o.cpu += a[7] || 0; };
    for (const id of ids) {
      const st = this.stats(id); out.total += st.t; out.totalErr += st.e;
      for (const [k, a] of Object.entries(st.b)) {
        const t = Number(k) * BUCKET;
        const dIdx = Math.floor((dayStart - (Math.floor((t + off) / day) * day - off)) / day);
        const hIdx = Math.floor((hourStart - (Math.floor((t + off) / hr) * hr - off)) / hr);
        if (dIdx < 0 || dIdx > 30) continue;
        add(out.d30, a); for (let c = 0; c < 4; c++) out.codes30[c] += a[2 + c];
        out.inv.exc += a[8] || 0; out.inv.tmo += a[9] || 0;
        const d = new Date(t + off); out.heat[d.getUTCDay()][d.getUTCHours()] += a[0];
        if (dIdx < 7) add(out.d7, a);
        if (dIdx === 0) { add(out.today, a); for (let c = 0; c < 4; c++) out.codesToday[c] += a[2 + c]; }
        if (dIdx === 1) add(out.yesterday, a);
        if (dIdx < 14) { out.days[13 - dIdx].req += a[0]; out.days[13 - dIdx].err += a[5]; }
        if (hIdx >= 0 && hIdx < 24) { out.hours[23 - hIdx].req += a[0]; out.hours[23 - hIdx].err += a[5]; }
      }
    }
    out.inv.ok = Math.max(0, out.d30.req - out.inv.exc - out.inv.tmo);
    return out;
  }

  extra(id) {
    const st = this.stats(id);
    const top = Object.entries(st.p).map(([p, a]) => ({ path: p, req: a[0], err: a[1], avg: a[0] ? Math.round(a[2] / a[0]) : 0 })).sort((a, b) => b.req - a.req).slice(0, 10);
    return { top, methods: st.m, ua: st.u, lhist: st.lh, edges: LAT_EDGES };
  }

  latency(id) {
    const l = [...this._rt(id).lat].sort((a, b) => a - b);
    if (!l.length) return { p50: 0, p95: 0, p99: 0, n: 0 };
    const q = (p) => l[Math.min(l.length - 1, Math.floor(l.length * p))];
    return { p50: q(0.5), p95: q(0.95), p99: q(0.99), n: l.length };
  }

  recent(id) { return [...this._rt(id).recent].reverse().slice(0, 40); }
}

module.exports = Workers;
module.exports.slugify = slugify;
