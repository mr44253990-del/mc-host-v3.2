'use strict';
// MC Host v3 — শুধু Workers। বট, Telegram ও অন্যান্য সব অংশ বাদ; কম RAM, দ্রুত সার্ভার।
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const Workers = require('./workers');
const Ai = require('./ai');
const GDrive = require('./gdrive');
const Sec = require('./security');
const sys = require('./sys');
const insights = require('./insights');
const Gateway = require('./gateway');
const { genId } = require('./util');
const TEMPLATES = require('./worker-templates');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 11336);
const HOST = '0.0.0.0';
const MAX_WK = Number(process.env.MAX_WORKERS) || 20;
const normMemory = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(16384, Math.round(n)) : 0; };
const normIdle = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(1e7, n) : 0; };
const normCount = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(1e12, Math.floor(n)) : 0; };
const clean = (v) => String(v ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
const ok = (res, extra = {}) => res.json({ ok: true, ...extra });
const fail = (res, error, code = 400) => res.status(code).json({ ok: false, error });
const tplFiles = (t) => t.files || [{ path: 'worker.js', content: t.code }];

(async () => {
  await store.init();

  // ---------- পাসওয়ার্ড ও সেশন ----------
  const envPw = clean(process.env.ADMIN_PASSWORD);
  if (store.setting('customPassword') && envPw && envPw !== store.setting('customPasswordEnv', envPw)) store.setSetting('customPassword', '');
  let password = clean(store.setting('customPassword')) || envPw || store.setting('autoPassword');
  if (!password) { password = crypto.randomBytes(5).toString('hex'); store.setSetting('autoPassword', password); }
  const pwMode = () => (store.setting('customPassword') ? 'custom' : envPw ? 'env' : 'auto');
  console.log(pwMode() === 'auto' ? `[auth] ADMIN_PASSWORD সেট নেই। অটো পাসওয়ার্ড: ${password}` : `[auth] পাসওয়ার্ড উৎস: ${pwMode() === 'custom' ? 'ড্যাশবোর্ড' : 'ADMIN_PASSWORD env'}`);
  const secret = crypto.createHash('sha256').update('mchost3|' + password).digest();
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');
  const mkCookie = () => { const exp = String(Date.now() + 7 * 864e5); return `${exp}.${sign(exp)}`; };
  const readCookie = (c) => {
    const [exp, sig] = String(c || '').split('.'); if (!exp || !sig || !(Number(exp) > Date.now())) return false;
    const x = Buffer.from(sig), y = Buffer.from(sign(exp)); return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const tries = new Map();
  const cookieOf = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('mch='))?.slice(4) || String(req.headers['x-mch-token'] || '');
  const getSession = (req) => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const raw = bearer || cookieOf(req);
    if (raw.startsWith('mcht_')) {
      const t = store.data.tokens.find((x) => x.hash === Sec.sha256(raw)); if (!t) return null;
      t.lastUsed = Date.now(); return { role: t.scope === 'control' ? 'operator' : 'viewer', name: 'টোকেন: ' + t.name, via: 'token' };
    }
    return readCookie(raw) ? { role: 'admin', name: 'মালিক', via: 'session' } : null;
  };
  const audit = (req, type, detail = '') => { const a = (store.data.audit ||= []); a.push({ t: Date.now(), ip: req.ip || '', type, detail: String(detail).slice(0, 160) }); if (a.length > 150) a.splice(0, a.length - 150); store.save(); };
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e.message || 'ত্রুটি', 500); } };
  const ADMIN_ONLY = /^\/(tokens|settings|password|backup|restore|gdrive|hooks|reports|ai\/settings|gateway)(\/|$)/;

  const workers = new Workers(store, { max: MAX_WK });
  const ai = new Ai(store, workers);
  const gw = new Gateway(store);
  ai.gateway = gw; gw.ensureKey();
  const gd = new GDrive(store);
  const withWk = (fn) => guard(async (req, res) => { const w = workers.get(req.params.id); if (!w) return fail(res, 'Worker পাওয়া যায়নি', 404); return fn(w, req, res); });
  const tzOf = (req) => Number(req.query.tz) || 0;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  const jsonParser = express.json({ limit: '2mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/hooks/') || req.path === '/api/gdrive/callback' ? next() : jsonParser(req, res, next)));

  // ---------- পাবলিক: স্বাস্থ্য, Worker URL, কাস্টম ডোমেইন ----------
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  const rawBody = express.raw({ type: () => true, limit: '1mb' });
  const wkServe = (req, res) => workers.serve(req, res).catch((e) => { console.error('[worker]', e.message); if (!res.headersSent) res.status(500).type('text').send('Worker error'); });
  app.use((req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    const w = host && workers.all().find((x) => x.domain && x.domain === host);
    if (!w) return next();
    req.params = { slug: w.slug, 0: String(req.path || '/').replace(/^\//, '') };
    rawBody(req, res, () => wkServe(req, res));
  });
  app.all('/w/:slug', rawBody, wkServe);
  app.all('/w/:slug/*', rawBody, wkServe);

  // ---------- পাবলিক: ওয়েবহুক রিসিভার (HMAC যাচাই) ----------
  app.post('/api/hooks/:id', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const h = store.data.hooks.find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ ok: false, error: 'হুক পাওয়া যায়নি' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const want = 'sha256=' + crypto.createHmac('sha256', h.secret).update(body).digest('hex');
    const good = sig ? Sec.safeEq(sig, want) : Sec.safeEq(String(req.headers['x-mch-secret'] || ''), h.secret);
    if (!good) { audit(req, 'hook-denied', h.name); return res.status(401).json({ ok: false, error: 'সিগনেচার মেলেনি' }); }
    if (String(req.headers['x-github-event'] || '') === 'ping') return res.json({ ok: true, pong: true });
    try {
      let result = '';
      if (h.action === 'restart-worker' || h.action === 'start-worker') { const r = await workers.start(h.target); result = r.ok ? 'Worker চালু/রিস্টার্ট' : r.error; }
      else if (h.action === 'stop-worker') { await workers.stop(h.target); result = 'Worker বন্ধ'; }
      else if (h.action === 'backup-drive') { const r = await gd.backupNow(buildBackup, origin(req)); result = 'ব্যাকআপ: ' + r.name; }
      h.fired = (h.fired || 0) + 1; h.lastFired = Date.now(); store.save();
      audit(req, 'hook-fired', `${h.name}: ${result}`);
      res.json({ ok: true, result });
    } catch (e) { audit(req, 'hook-error', `${h.name}: ${e.message}`); res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- OpenAI-সামঞ্জস্যপূর্ণ endpoint: https://আপনার-হোস্ট/v1 (Gateway key দিয়ে) ----------
  const v1Auth = (req, res) => {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!gw.checkKey(tok)) { res.status(401).json({ error: { message: 'Gateway key ভুল বা নেই', type: 'invalid_request_error' } }); return false; }
    return true;
  };
  app.get('/v1/models', (req, res) => { if (!v1Auth(req, res)) return; res.json({ object: 'list', data: [{ id: gw.cfg().model, object: 'model', created: 0, owned_by: 'mc-host' }] }); });
  app.post('/v1/chat/completions', guard(async (req, res) => {
    if (!v1Auth(req, res)) return;
    const b = req.body || {};
    if (!Array.isArray(b.messages) || !b.messages.length) return res.status(400).json({ error: { message: 'messages দিন', type: 'invalid_request_error' } });
    const messages = b.messages.slice(-60).map((m) => ({ role: String(m.role || 'user'), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
    let r;
    try { r = await gw.chat(messages, { max_tokens: Number(b.max_tokens) || 1500, temperature: b.temperature, src: 'api' }); }
    catch (e) { return res.status(e.status === 400 ? 400 : 503).json({ error: { message: e.message, type: 'gateway_error' } }); }
    const id = 'chatcmpl-' + genId() + genId(); const created = Math.floor(Date.now() / 1000);
    const msg = { role: 'assistant', content: r.text };
    res.setHeader('x-mc-provider', encodeURIComponent(r.provider)); res.setHeader('x-mc-fallbacks', String(r.fallbacks));
    if (b.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: gw.cfg().model, choices: [{ index: 0, delta: msg, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: gw.cfg().model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.json({ id, object: 'chat.completion', created, model: gw.cfg().model, choices: [{ index: 0, message: msg, finish_reason: 'stop' }], usage: { prompt_tokens: r.usage.prompt_tokens || 0, completion_tokens: r.usage.completion_tokens || 0, total_tokens: r.usage.total_tokens || 0 }, x_provider_no: r.providerNo, x_fallbacks: r.fallbacks });
  }));

  // ---------- পাবলিক: Google Drive OAuth কলব্যাক ----------
  app.get('/api/gdrive/callback', async (req, res) => {
    try {
      if (req.query.error) throw new Error('Google অনুমতি দেয়নি: ' + String(req.query.error));
      await gd.callback(origin(req), String(req.query.code || ''), String(req.query.state || ''));
      audit(req, 'gdrive-connect', 'Google Drive সংযুক্ত');
      res.redirect('/#gdrive=ok');
    } catch (e) { res.redirect('/#gdrive=err:' + encodeURIComponent(e.message).slice(0, 300)); }
  });

  // ---------- লগইন ----------
  app.get('/api/login-info', (req, res) => { const t = tries.get(req.ip); res.json({ ok: true, mode: pwMode(), wait: t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0 }); });
  app.post('/api/login', (req, res) => {
    const t = tries.get(req.ip) || { n: 0, until: 0 };
    if (Date.now() < t.until) return res.status(429).json({ ok: false, wait: Math.ceil((t.until - Date.now()) / 1000), error: 'অনেকবার ভুল হয়েছে, কিছুক্ষণ পরে চেষ্টা করুন' });
    if (!Sec.safeEq(clean((req.body || {}).password), password)) {
      t.n++; if (t.n >= 10) { t.until = Date.now() + 5 * 60000; t.n = 0; } tries.set(req.ip, t);
      audit(req, 'login-fail', 'ভুল পাসওয়ার্ড');
      return fail(res, `পাসওয়ার্ড ভুল (আর ${Math.max(0, 10 - t.n)}বার চেষ্টা)`, 401);
    }
    tries.delete(req.ip); audit(req, 'login', 'সফল লগইন');
    const token = mkCookie();
    res.setHeader('Set-Cookie', `mch=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
    ok(res, { token });
    if (gd.connected() && Date.now() - (gd.cfg().lastBackup || 0) > 30 * 60000) setTimeout(() => gd.backupNow(buildBackup, origin(req)).catch(() => {}), 1500);
  });
  app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'mch=; Max-Age=0; Path=/'); ok(res); });
  app.get('/api/me', (req, res) => { const s = getSession(req); res.json({ ok: !!s, role: s ? s.role : null, name: s ? s.name : '' }); });

  // ---------- /api গার্ড ----------
  app.use('/api', (req, res, next) => {
    const s = getSession(req);
    if (!s) return fail(res, 'লগইন করুন', 401);
    req.sess = s;
    const write = req.method !== 'GET';
    if (write && s.role === 'viewer') return fail(res, 'শুধু পড়ার অনুমতি আছে', 403);
    if (ADMIN_ONLY.test(req.path) && s.role !== 'admin') return fail(res, 'এটি শুধু মালিক করতে পারে', 403);
    if (write && !/\/ai/.test(req.path)) audit(req, 'api', `${s.name}: ${req.method} ${req.path}`);
    next();
  });

  // ---------- অবস্থা (ড্যাশবোর্ড) ----------
  const workerRow = (w, tz) => {
    const v = workers.view(w); const a = workers.agg([w.id], tz);
    return { ...v, today: a.today, yesterday: a.yesterday, lat: workers.latency(w.id), cpuPerReq: a.today.req ? Math.round(a.today.cpu / a.today.req * 10) / 10 : 0 };
  };
  const stateOf = (sess, tz = 0) => {
    const list = workers.all().map((w) => workerRow(w, tz));
    const fleet = { total: list.length, running: 0, sleeping: 0, stopped: 0, error: 0, ram: 0, todayReq: 0, todayErr: 0 };
    for (const r of list) {
      fleet[r.state === 'running' ? 'running' : r.state === 'sleeping' ? 'sleeping' : r.state === 'error' ? 'error' : 'stopped']++;
      fleet.ram += r.ram || 0; fleet.todayReq += r.today.req; fleet.todayErr += r.today.err;
    }
    return {
      ok: true, me: { role: sess ? sess.role : null, name: sess ? sess.name : '' },
      host: sys.host(), fleet, workers: list, max: MAX_WK,
      ai: { ready: ai.ready(), model: ai.model(), keyMask: ai.key() ? ai.key().slice(0, 4) + '••••' + ai.key().slice(-3) : '' },
      gd: gd.status(''), settings: { tzOffset: store.setting('tzOffset', null), weeklyReport: !!store.setting('weeklyReport', false) },
      insights: insights.build({ workers, tzMin: tz ? -tz : 0 }).slice(0, 8), pwMode: pwMode(),
      gateway: gw.summary(''),
    };
  };
  app.get('/api/state', (req, res) => res.json(stateOf(req.sess, tzOf(req))));
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const push = () => { try { res.write('data: ' + JSON.stringify(stateOf(req.sess, tzOf(req))) + '\n\n'); } catch { /* বন্ধ */ } };
    push(); const t = setInterval(push, 3000); req.on('close', () => clearInterval(t));
  });
  app.get('/api/templates', (req, res) => ok(res, { templates: TEMPLATES.map((t) => ({ key: t.key, name: t.name, desc: t.desc })) }));
  app.get('/api/openapi.json', (req, res) => {
    const op = (summary) => ({ summary, responses: { 200: { description: 'OK' }, 401: { description: 'লগইন দরকার' }, 403: { description: 'অনুমতি নেই' } } });
    res.json({ openapi: '3.0.3', info: { title: 'MC Host Workers API', version: '3.0.0', description: 'Authorization: Bearer mcht_... দিয়ে ব্যবহার করুন।' }, servers: [{ url: origin(req) }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      paths: {
        '/api/state': { get: op('সব অবস্থা, RAM ও CPU') }, '/api/workers': { get: op('Worker তালিকা'), post: op('নতুন Worker') },
        '/api/workers/{id}/start': { post: op('চালু (ঘুম থেকে জাগায়)') }, '/api/workers/{id}/stop': { post: op('বন্ধ') },
        '/api/workers/{id}/deploy': { post: op('ডিপ্লয়') }, '/api/workers/{id}/tests/run': { post: op('টেস্ট স্যুট') },
        '/api/workers/{id}/db/query': { post: op('শুধু SELECT') }, '/api/workers/{id}/stats.csv': { get: op('দৈনিক CSV') },
        '/api/reports/csv': { get: op('রিপোর্ট (CSV)') }, '/api/hooks/{id}': { post: { summary: 'ওয়েবহুক (HMAC)', responses: { 200: { description: 'OK' }, 401: { description: 'সিগনেচার মেলেনি' } } } },
      } });
  });

  // ---------- AI Gateway (শুধু মালিক) ----------
  app.get('/api/gateway', (req, res) => ok(res, { gateway: gw.summary(origin(req)), presets: gw.presets() }));
  app.post('/api/gateway/key/rotate', (req, res) => { const k = gw.rotateKey(); audit(req, 'gateway-key-rotate', ''); ok(res, { key: k }); });
  app.put('/api/gateway/settings', (req, res) => { const m = String((req.body || {}).model || '').trim().slice(0, 80); if (m) gw.cfg().model = m; store.save(); ok(res); });
  app.post('/api/gateway/providers', guard(async (req, res) => {
    let p; try { p = gw.addProvider(req.body || {}); } catch (e) { return fail(res, e.message); }
    await gw.test(p);
    audit(req, 'gateway-add', p.name);
    ok(res, { id: p.id, status: p.status, models: p.models || [], lastError: p.lastError });
  }));
  app.patch('/api/gateway/providers/:id', (req, res) => {
    const p = gw.find(req.params.id); if (!p) return fail(res, 'provider নেই', 404);
    const b = req.body || {};
    if (b.model !== undefined) p.model = String(b.model).slice(0, 200);
    if (b.enabled !== undefined) p.enabled = !!b.enabled;
    if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 40) || p.name;
    if (b.apiKey !== undefined && String(b.apiKey).trim().length >= 8) { p.apiKey = String(b.apiKey).trim(); p.status = 'untested'; gw.cool.delete(p.id); }
    store.save(); ok(res);
  });
  app.delete('/api/gateway/providers/:id', (req, res) => { gw.remove(req.params.id); audit(req, 'gateway-remove', req.params.id); ok(res); });
  app.post('/api/gateway/providers/:id/test', guard(async (req, res) => { const p = gw.find(req.params.id); if (!p) return fail(res, 'provider নেই', 404); await gw.test(p); ok(res, { status: p.status, lastError: p.lastError, models: p.models || [], latency: p.latency, credits: p.credits }); }));
  app.post('/api/gateway/test-all', guard(async (req, res) => { for (const p of gw.providers()) await gw.test(p); ok(res); }));
  app.post('/api/gateway/chat', guard(async (req, res) => {
    const text = String((req.body || {}).text || '').trim(); if (!text) return fail(res, 'মেসেজ ফাঁকা');
    try { const r = await gw.chat([{ role: 'user', content: text }], { src: 'panel' }); ok(res, r); } catch (e) { fail(res, e.message, 503); }
  }));

  // ---------- টোকেন ও সেটিংস (শুধু মালিক) ----------
  app.get('/api/tokens', (req, res) => ok(res, { tokens: store.data.tokens.map((t) => ({ id: t.id, name: t.name, scope: t.scope, createdAt: t.createdAt, lastUsed: t.lastUsed || 0 })) }));
  app.post('/api/tokens', (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 40); const scope = (req.body || {}).scope === 'control' ? 'control' : 'read';
    if (!name) return fail(res, 'নাম দিন');
    if (store.data.tokens.length >= 20) return fail(res, 'সর্বোচ্চ ২০টি টোকেন');
    const token = Sec.newToken(); const t = { id: genId(), name, scope, hash: Sec.sha256(token), createdAt: Date.now(), lastUsed: 0 };
    store.data.tokens.push(t); store.save(); audit(req, 'token-create', `${name} (${scope})`);
    ok(res, { token, id: t.id });
  });
  app.delete('/api/tokens/:id', (req, res) => { const t = store.data.tokens.find((x) => x.id === req.params.id); if (!t) return fail(res, 'টোকেন নেই', 404); store.data.tokens = store.data.tokens.filter((x) => x.id !== t.id); store.save(); audit(req, 'token-revoke', t.name); ok(res); });
  app.post('/api/password', (req, res) => {
    const cur = clean((req.body || {}).current), nw = clean((req.body || {}).next);
    if (!Sec.safeEq(cur, password)) return fail(res, 'বর্তমান পাসওয়ার্ড ভুল');
    if (nw.length < 6) return fail(res, 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষর');
    password = nw; store.setSetting('customPassword', nw); store.setSetting('customPasswordEnv', envPw);
    res.setHeader('Set-Cookie', `mch=${mkCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`); ok(res, { token: mkCookie() });
  });
  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    if (b.tzOffset !== undefined && Number.isFinite(Number(b.tzOffset))) store.setSetting('tzOffset', Math.max(-840, Math.min(840, Number(b.tzOffset))));
    if (typeof b.weeklyReport === 'boolean') store.setSetting('weeklyReport', b.weeklyReport);
    ok(res);
  });
  app.put('/api/ai/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b.mistralKey === 'string' && b.mistralKey.trim()) store.setSetting('mistralKey', b.mistralKey.trim());
    if (b.mistralKey === '') store.setSetting('mistralKey', '');
    if (typeof b.mistralModel === 'string' && b.mistralModel.trim()) store.setSetting('mistralModel', b.mistralModel.trim());
    ok(res);
  });
  app.get('/api/ai/models', guard(async (req, res) => ok(res, { models: await ai.models(), current: ai.model() })));

  // ---------- Worker: তালিকা, তৈরি, বাল্ক ----------
  app.get('/api/workers', (req, res) => { const tz = tzOf(req); ok(res, { workers: workers.all().map((w) => workerRow(w, tz)), max: MAX_WK }); });
  app.post('/api/workers', guard(async (req, res) => {
    const b = req.body || {};
    if (String(b.code || '').length > 900000) return fail(res, 'worker.js অনেক বড়');
    let files = Array.isArray(b.files) && b.files.length ? b.files : null;
    if (!files && b.template) { const t = TEMPLATES.find((x) => x.key === b.template); if (!t) return fail(res, 'টেমপ্লেট নেই'); files = tplFiles(t); }
    const w = workers.create({ name: b.name, slug: b.slug, code: b.code, files, env: b.env, cronMin: b.cronMin, entry: b.entry, memoryMb: b.memoryMb, idleMin: b.idleMin, dailyLimit: b.dailyLimit });
    const deploy = await workers.deploy(w.id);
    ok(res, { id: w.id, slug: w.slug, deploy });
  }));
  app.post('/api/workers/bulk/:action', guard(async (req, res) => {
    const act = req.params.action; const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : workers.all().map((w) => w.id);
    const list = ids.map((id) => workers.get(id)).filter(Boolean).slice(0, 50);
    if (act === 'stop') { await Promise.all(list.map((w) => workers.stop(w.id))); return ok(res, { n: list.length }); }
    if (act === 'start' || act === 'restart') { const r = await Promise.all(list.map((w) => workers.start(w.id))); return ok(res, { n: list.length, failed: r.filter((x) => !x.ok).length }); }
    fail(res, 'অজানা কাজ');
  }));
  app.get('/api/workers/:id', withWk((w, req, res) => { const tz = tzOf(req); ok(res, { w: workerRow(w, tz), agg: workers.agg([w.id], tz), lat: workers.latency(w.id), extra: workers.extra(w.id), recent: workers.recent(w.id) }); }));
  app.patch('/api/workers/:id', withWk(async (w, req, res) => {
    const b = req.body || {};
    if (b.concurrency !== undefined) { const n = Number(b.concurrency); w.concurrency = Number.isFinite(n) && n > 0 ? Math.min(1e6, Math.floor(n)) : 0; }
    if (b.memoryMb !== undefined) w.memoryMb = normMemory(b.memoryMb);
    if (b.idleMin !== undefined) w.idleMin = normIdle(b.idleMin);
    if (b.dailyLimit !== undefined) w.dailyLimit = normCount(b.dailyLimit);
    if (b.strictTests !== undefined) w.strictTests = !!b.strictTests;
    if (b.budget !== undefined) { const bu = b.budget || {}; w.budget = { p95Ms: Math.max(0, Math.min(60000, Number(bu.p95Ms) || 0)), errPct: Math.max(0, Math.min(100, Number(bu.errPct) || 0)) }; }
    if (b.domain !== undefined) {
      const d = String(b.domain || '').trim().toLowerCase();
      if (d) {
        if (!Sec.validDomain(d)) return fail(res, 'ডোমেইন সঠিক নয় (যেমন api.example.com)');
        if (workers.all().some((x) => x.id !== w.id && x.domain === d)) return fail(res, 'এই ডোমেইন আগেই আরেক Worker-এ আছে');
      }
      w.domain = d; store.save();
    }
    const needRestart = b.memoryMb !== undefined;
    workers.update(w, b);
    if (needRestart && w.enabled) await workers.start(w.id);
    ok(res);
  }));
  app.delete('/api/workers/:id', withWk(async (w, req, res) => { await workers.remove(w.id); ok(res); }));
  app.post('/api/workers/:id/start', withWk(async (w, req, res) => { const r = await workers.start(w.id); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/workers/:id/restart', withWk(async (w, req, res) => { const r = await workers.start(w.id); r.ok ? ok(res) : fail(res, r.error); }));
  app.post('/api/workers/:id/stop', withWk(async (w, req, res) => { await workers.stop(w.id); ok(res); }));
  app.post('/api/workers/:id/deploy', withWk(async (w, req, res) => { const r = await workers.deploy(w.id); r.ok ? ok(res, { warnings: r.warnings || [] }) : res.status(422).json({ ok: false, error: r.error, rolledBack: !!r.rolledBack }); }));
  app.post('/api/workers/:id/clone', withWk((w, req, res) => { try { ok(res, { id: workers.clone(w.id, (req.body || {}).name).id }); } catch (e) { fail(res, e.message); } }));
  app.get('/api/workers/:id/check', withWk((w, req, res) => ok(res, workers.check(w.id))));
  app.post('/api/workers/:id/tests/run', withWk(async (w, req, res) => ok(res, await workers.runTests(w.id))));
  app.get('/api/workers/:id/stats', withWk((w, req, res) => ok(res, { agg: workers.agg([w.id], tzOf(req)), lat: workers.latency(w.id), recent: workers.recent(w.id), extra: workers.extra(w.id), w: workerRow(w, tzOf(req)) })));
  app.get('/api/workers/:id/stats.csv', withWk((w, req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${w.slug}-daily.csv"`); res.end(workers.csv(w.id, tzOf(req))); }));
  app.get('/api/workers/:id/logs', withWk((w, req, res) => ok(res, { logs: workers.logs(w.id) })));
  app.post('/api/workers/:id/test', withWk(async (w, req, res) => {
    const b = req.body || {};
    const o = await workers.invoke(w.id, { method: String(b.method || 'GET').toUpperCase(), path: String(b.path || '/'), headers: b.headers || {}, body: b.body || null });
    ok(res, { status: o.status, ms: o.ms, headers: o.headers, body: o.body.subarray(0, 20000).toString('utf8') });
  }));

  // ---------- Worker: ফাইল ----------
  app.get('/api/workers/:id/files', withWk((w, req, res) => ok(res, { files: workers.listFiles(w.id), entry: workers.entryOf(w), w: workerRow(w, 0) })));
  app.get('/api/workers/:id/file', withWk((w, req, res) => ok(res, workers.readFile(w.id, String(req.query.path || '')))));
  app.get('/api/workers/:id/raw', withWk((w, req, res) => { const f = workers.absOf(w.id, String(req.query.path || '')); if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(f)}"`); res.end(require('fs').readFileSync(f)); }));
  app.put('/api/workers/:id/file', withWk((w, req, res) => { const p = workers.safeRel((req.body || {}).path); const content = String((req.body || {}).content ?? ''); workers.writeFile(w.id, p, content); ok(res, { path: p, syntax: workers.syntaxCheck(p, content) }); }));
  app.put('/api/workers/:id/blob', express.raw({ type: () => true, limit: '30mb' }), withWk((w, req, res) => { if (!Buffer.isBuffer(req.body)) return fail(res, 'ফাইল ডাটা নেই'); const p = workers.safeRel(req.query.path); workers.writeFile(w.id, p, req.body); ok(res, { path: p, size: req.body.length }); }));
  app.delete('/api/workers/:id/file', withWk((w, req, res) => { workers.deleteFile(w.id, String(req.query.path || '')); ok(res); }));
  app.post('/api/workers/:id/move', withWk((w, req, res) => { workers.moveFile(w.id, (req.body || {}).from, (req.body || {}).to); ok(res); }));
  app.post('/api/workers/:id/import-zip', express.raw({ type: () => true, limit: '30mb' }), withWk((w, req, res) => { if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 'ZIP নেই'); ok(res, workers.importZip(w.id, req.body, { replace: req.query.replace === '1' })); }));
  app.get('/api/workers/:id/export', withWk((w, req, res) => { res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="${w.slug}.zip"`); res.end(workers.exportZip(w.id)); }));
  app.get('/api/workers/:id/versions', withWk((w, req, res) => ok(res, { versions: workers.versions(w.id) })));
  app.get('/api/workers/:id/versions/:name/diff', withWk((w, req, res) => { try { ok(res, workers.diffVersion(w.id, req.params.name, req.query.file ? String(req.query.file) : null)); } catch (e) { fail(res, e.message); } }));
  app.post('/api/workers/:id/restore', withWk(async (w, req, res) => { const r = await workers.restore(w.id, String((req.body || {}).name || '')); r.ok ? ok(res) : res.status(422).json({ ok: false, error: r.error }); }));
  app.post('/api/workers/:id/snapshot', withWk((w, req, res) => { workers.snapshot(w.id, 'manual'); ok(res); }));

  // ---------- Worker: ENV ----------
  app.get('/api/workers/:id/env', withWk((w, req, res) => ok(res, { env: (w.env || []).map((e) => ({ key: e.key, secret: !!e.secret, value: e.secret ? '' : e.value, has: e.value !== '' })) })));
  app.put('/api/workers/:id/env', withWk(async (w, req, res) => { w.env = workers.cleanEnv((req.body || {}).env, w.env); w.updatedAt = Date.now(); store.save(); const r = w.enabled ? await workers.start(w.id) : { ok: true }; ok(res, { deploy: r }); }));

  // ---------- Worker: ডাটাবেস (শুধু পড়া) ----------
  app.get('/api/workers/:id/db', withWk((w, req, res) => { try { ok(res, workers.dbTables(w.id)); } catch (e) { fail(res, e.message); } }));
  app.get('/api/workers/:id/db/rows', withWk((w, req, res) => { try { ok(res, workers.dbRows(w.id, String(req.query.table || ''), req.query.limit, req.query.offset)); } catch (e) { fail(res, e.message); } }));
  app.post('/api/workers/:id/db/query', withWk((w, req, res) => { try { ok(res, workers.dbQuery(w.id, (req.body || {}).sql)); } catch (e) { fail(res, e.message); } }));

  // ---------- Worker: AI ----------
  app.post('/api/workers/:id/ai', withWk(async (w, req, res) => {
    const text = String((req.body || {}).text || '').trim(); if (!text) return fail(res, 'মেসেজ ফাঁকা');
    if (!ai.ready()) return fail(res, 'AI চালু নেই (সেটিংসে Mistral key দিন)');
    ok(res, await ai.chat(w, text, Array.isArray((req.body || {}).history) ? req.body.history : null));
  }));
  app.post('/api/workers/:id/ai/apply', withWk(async (w, req, res) => {
    let changes = ai.takePending(w.id);
    const only = Array.isArray((req.body || {}).paths) ? new Set(req.body.paths) : null;
    if (only) changes = changes.filter((c) => only.has(c.path));
    if (!changes.length) return fail(res, 'প্রয়োগ করার মতো পরিবর্তন নেই');
    workers.applyChanges(w.id, changes);
    store.mem('w:' + w.id).notes.push(`AI পরিবর্তন: ${changes.map((c) => c.path).join(', ')}`.slice(0, 280));
    const r = await workers.deploy(w.id);
    r.ok ? ok(res, { applied: changes.length }) : res.status(422).json({ ok: false, error: r.error, rolledBack: !!r.rolledBack });
  }));
  app.post('/api/workers/:id/review', withWk(async (w, req, res) => { if (!ai.ready()) return fail(res, 'AI চালু নেই'); ok(res, { reply: await ai.review(w) }); }));

  // ---------- রিপোর্ট ----------
  const buildReport = (days, tz = 0) => {
    const period = days === 30 ? 'd30' : 'd7';
    const rows = [['name', 'requests', 'errors_5xx', 'error_rate_pct', 'avg_ms', 'p95_ms', 'cpu_ms_per_req', 'bytes', 'ram_mb', 'budget_status']];
    for (const w of workers.all()) {
      const a = workers.agg([w.id], tz); const x = a[period]; const lat = workers.latency(w.id); const v = workers.view(w);
      const errPct = x.req ? Math.round(x.err / x.req * 1000) / 10 : 0; const bu = w.budget || {}; const br = [];
      if (bu.p95Ms && lat.p95 > bu.p95Ms) br.push('p95');
      if (bu.errPct && errPct > bu.errPct) br.push('err');
      rows.push([w.name, x.req, x.err, errPct, x.req ? Math.round(x.ms / x.req) : 0, lat.p95, x.req ? Math.round(x.cpu / x.req * 10) / 10 : 0, x.bytes, v.ram || 0, br.length ? 'breach:' + br.join('+') : (bu.p95Ms || bu.errPct ? 'ok' : '')]);
    }
    return rows.map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(',')).join('\n') + '\n';
  };
  app.get('/api/reports/csv', (req, res) => { const days = Number(req.query.days) === 7 ? 7 : 30; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="mc-host-workers-${days}d.csv"`); res.end(buildReport(days, tzOf(req))); });
  app.post('/api/reports/drive', guard(async (req, res) => { const days = Number((req.body || {}).days) === 7 ? 7 : 30; const name = `mc-host-workers-${days}d-${new Date().toISOString().slice(0, 10)}.csv`; const f = await gd.uploadReport(name, Buffer.from(buildReport(days, Number((req.body || {}).tz) || 0)), 'text/csv'); audit(req, 'report-drive', name); ok(res, { file: f }); }));

  // ---------- হুক ----------
  const HOOK_ACTIONS = ['restart-worker', 'start-worker', 'stop-worker', 'backup-drive'];
  app.get('/api/hooks', (req, res) => ok(res, { hooks: store.data.hooks.map((h) => ({ ...h, url: origin(req) + '/api/hooks/' + h.id })) }));
  app.post('/api/hooks', (req, res) => {
    const b = req.body || {}; const name = String(b.name || '').trim().slice(0, 40); const action = String(b.action || '');
    if (!name) return fail(res, 'নাম দিন');
    if (!HOOK_ACTIONS.includes(action)) return fail(res, 'অজানা কাজ');
    if (action.endsWith('worker') && !workers.get(String(b.target || ''))) return fail(res, 'Worker বাছুন');
    if (store.data.hooks.length >= 30) return fail(res, 'সর্বোচ্চ ৩০টি হুক');
    const h = { id: genId() + genId(), name, action, target: String(b.target || ''), secret: Sec.newToken().replace('mcht_', ''), createdAt: Date.now(), fired: 0, lastFired: 0 };
    store.data.hooks.push(h); store.save(); audit(req, 'hook-create', name);
    ok(res, { hook: { ...h, url: origin(req) + '/api/hooks/' + h.id } });
  });
  app.delete('/api/hooks/:id', (req, res) => { store.data.hooks = store.data.hooks.filter((h) => h.id !== req.params.id); store.save(); ok(res); });

  // ---------- Google Drive ----------
  app.get('/api/gdrive', guard(async (req, res) => ok(res, { gd: gd.status(origin(req)), files: gd.connected() ? await gd.list().catch(() => []) : [] })));
  app.post('/api/gdrive/setup', (req, res) => { try { ok(res, gd.setup(origin(req), (req.body || {}).clientId, (req.body || {}).clientSecret)); } catch (e) { fail(res, e.message); } });
  app.post('/api/gdrive/disconnect', guard(async (req, res) => { await gd.disconnect(); ok(res); }));
  app.post('/api/gdrive/backup', guard(async (req, res) => ok(res, { backup: await gd.backupNow(buildBackup, origin(req)) })));
  app.put('/api/gdrive/settings', (req, res) => { const c = gd.cfg(); const b = req.body || {}; if (b.autoHours !== undefined) c.autoHours = [0, 1, 6, 12, 24].includes(Number(b.autoHours)) ? Number(b.autoHours) : 0; if (b.keep !== undefined) c.keep = Math.max(3, Math.min(60, Number(b.keep) || 14)); store.save(); ok(res); });
  app.post('/api/gdrive/restore', guard(async (req, res) => {
    const id = String((req.body || {}).id || ''); if (!/^[\w-]{10,}$/.test(id)) return fail(res, 'ফাইল আইডি সঠিক নয়');
    let data; try { data = JSON.parse((await gd.download(id)).toString('utf8')); } catch { return fail(res, 'ফাইলটি JSON ব্যাকআপ নয়'); }
    ok(res, await doRestore(data));
  }));
  app.delete('/api/gdrive/backups/:id', guard(async (req, res) => { await gd.remove(req.params.id); ok(res); }));
  app.put('/api/reports/settings', (req, res) => { store.setSetting('weeklyReport', !!(req.body || {}).weekly); ok(res); });

  // ---------- ব্যাকআপ / পুনরুদ্ধার (শুধু Worker) ----------
  function buildBackup() {
    return { v: 7, ts: Date.now(), workers: JSON.parse(JSON.stringify(store.data.workers)), workerFiles: workers.exportAll(), workerDbs: workers.dbExportAll(), hooks: store.data.hooks, settings: { tzOffset: store.setting('tzOffset', null) } };
  }
  app.get('/api/backup', (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="mc-host-backup.json"'); res.json(buildBackup()); });
  async function doRestore(body) {
    if (!body || !Array.isArray(body.workers)) throw new Error('ব্যাকআপ ফাইল সঠিক নয়');
    for (const w of workers.all().slice()) await workers.remove(w.id);
    store.data.workers = body.workers.slice(0, MAX_WK).map((w) => ({ ...w, enabled: !!w.enabled }));
    workers.importAll(body.workerFiles || {});
    workers.dbImportAll(body.workerDbs || {});
    if (Array.isArray(body.hooks)) store.data.hooks = body.hooks.slice(0, 30);
    workers._migrate(); workers.autostart(); store.save();
    return { workers: store.data.workers.length };
  }
  app.post('/api/restore', express.json({ limit: '60mb' }), guard(async (req, res) => ok(res, await doRestore(req.body || {}))));

  // ---------- স্থির ফাইল (প্যানেল) ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.use((err, req, res, next) => { console.error('[http]', err.message); if (!res.headersSent) fail(res, 'সার্ভার ত্রুটি', 500); });

  // AI Gateway: পটভূমির স্বাস্থ্য-পরীক্ষা (ক্রেডিট ও বিরতি শেষ হওয়া provider আবার যাচাই)
  setInterval(() => gw.healthPass().catch(() => {}), 5 * 60e3).unref();

  // ---------- স্বয়ংক্রিয় কাজ: সাপ্তাহিক রিপোর্ট, Drive ব্যাকআপ ----------
  setInterval(() => {
    const c = gd.cfg();
    if (gd.connected() && c.autoHours > 0 && Date.now() - (c.lastBackup || 0) > c.autoHours * 3600000 && !gd.busy) gd.backupNow(buildBackup, '').catch((e) => console.error('[gdrive auto]', e.message));
  }, 60000).unref();
  setInterval(() => {
    if (!store.setting('weeklyReport', false) || !gd.connected()) return;
    const tz = Number(store.setting('tzOffset', 0)) || 0; const local = new Date(Date.now() + tz * 60000);
    if (local.getUTCDay() !== 1 || local.getUTCHours() !== 9) return;
    const key = local.toISOString().slice(0, 10);
    if (store.setting('weeklyLast', '') === key) return;
    store.setSetting('weeklyLast', key);
    gd.uploadReport(`mc-host-workers-7d-${key}.csv`, Buffer.from(buildReport(7, -tz)), 'text/csv').catch((e) => console.error('[report]', e.message));
  }, 60 * 60000).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log('============================================');
    console.log(` MC Host v3 (Workers) চালু: http://${HOST}:${PORT}`);
    console.log(` ডাটা: ${store.dir}   Node ${process.version}`);
    console.log(` AI: ${ai.ready() ? 'Mistral ' + ai.model() : 'বন্ধ'}   Drive: ${gd.connected() ? 'সংযুক্ত' : 'বন্ধ'}`);
    console.log('============================================');
    workers.autostart();
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `পোর্ট ${PORT} ব্যবহৃত। PORT env সেট করুন।` : e.message); process.exit(1); });
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; console.log('বন্ধ হচ্ছে...'); await workers.stopAll(); store.flushAll(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
})();
