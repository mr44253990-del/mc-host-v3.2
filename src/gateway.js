'use strict';
// AI Gateway v2: অনেক provider, প্রতিটিতে অনেক মডেল। Sticky failover (প্রথমটায় থাকে, ব্যর্থ হলে পরেরটায়,
// শেষে আবার প্রথমে), বিরতি শেষে আবার চেষ্টা, আসল SSE streaming, সিস্টেম প্রম্পট, বিশ্লেষণ ও ব্যাকআপ।
const crypto = require('crypto');
const EventEmitter = require('events');
const { genId } = require('./util');

const PRESETS = [
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { key: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { key: 'together', name: 'Together', baseUrl: 'https://api.together.xyz/v1' },
  { key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { key: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '' },
];
const KIND = {
  key: { status: 'invalid', cool: 6 * 3600e3, label: 'key ভুল/বাতিল' },
  credits: { status: 'nocredit', cool: 30 * 60e3, label: 'ক্রেডিট শেষ' },
  quota: { status: 'nocredit', cool: 30 * 60e3, label: 'কোটা শেষ' },
  model: { status: 'error', cool: 10 * 60e3, label: 'মডেল পাওয়া যায়নি' },
  rate: { status: 'cooldown', cool: 60e3, label: 'রেট লিমিট' },
  server: { status: 'error', cool: 20e3, label: 'সার্ভার ত্রুটি' },
  timeout: { status: 'error', cool: 20e3, label: 'সময় শেষ' },
  empty: { status: 'error', cool: 20e3, label: 'খালি উত্তর' },
  other: { status: 'error', cool: 30e3, label: 'অজানা ত্রুটি' },
};
const CODE_KIND = { 401: 'key', 402: 'credits', 403: 'quota', 404: 'model', 429: 'rate' };
const HIST_MAX = 400;
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const p95 = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

class Gateway extends EventEmitter {
  constructor(store) { super(); this.store = store; this.cool = new Map(); this.hist = []; this.ptr = 0; this.rr = 0; this.mstat = {}; this.hours = {}; }

  cfg() { return (this.store.data.gateway ||= { providers: [], key: '', model: 'mc-router', strategy: 'sticky', systemPrompt: '' }); }
  providers() { return this.cfg().providers; }
  presets() { return PRESETS; }
  mask(k) { return k ? k.slice(0, 6) + '••••' + k.slice(-4) : ''; }
  ensureKey() { const c = this.cfg(); if (!c.key) { c.key = 'mcgw_' + crypto.randomBytes(24).toString('hex'); this.store.save(); } return c.key; }
  rotateKey() { const c = this.cfg(); c.key = 'mcgw_' + crypto.randomBytes(24).toString('hex'); this.store.save(); return c.key; }
  checkKey(token) { const k = this.cfg().key; if (!k || !token) return false; const a = Buffer.from(String(token)), b = Buffer.from(k); return a.length === b.length && crypto.timingSafeEqual(a, b); }

  // ----- প্রোভাইডার × মডেল তালিকা (ক্রম = অগ্রাধিকার) -----
  modelsOf(p) { const u = Array.isArray(p.useModels) && p.useModels.length ? p.useModels : (p.model ? [p.model] : []); return [...new Set(u)]; }
  entries() { const out = []; for (const p of this.providers()) { if (!p.enabled || !p.apiKey) continue; for (const m of this.modelsOf(p)) out.push({ key: p.id + '|' + m, p, model: m }); } return out; }
  hasProviders() { return this.entries().length > 0; }
  isCool(e) { const now = Date.now(); for (const k of [e.key, e.p.id]) { const t = this.cool.get(k); if (t) { if (now >= t) this.cool.delete(k); else return t; } } return 0; }
  provCool(p) { const t = this.cool.get(p.id); if (!t) return 0; if (Date.now() >= t) { this.cool.delete(p.id); return 0; } return t; }
  active() { return this.entries().filter((e) => !this.isCool(e)); }
  nextNumber() { const all = this.entries(); if (!all.length) return 0; return (this.ptr % all.length) + 1; }
  coolDown(target, kind, status, err) { const k = KIND[kind] || KIND.other; this.cool.set(target, Date.now() + k.cool); this.store.save(); return k; }

  // ----- HTTP -----
  async _http(p, path, { method = 'GET', body, timeout = 30000 } = {}) {
    const base = String(p.baseUrl || '').replace(/\/$/, '');
    let r;
    try { r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.apiKey }, body, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { const er = new Error(e.name === 'TimeoutError' ? 'সময় শেষ' : 'সংযোগ হয়নি: ' + e.message); er.kind = 'timeout'; er.label = KIND.timeout.label; throw er; }
    const txt = await r.text();
    return { status: r.status, ok: r.ok, json: tryJson(txt), text: txt };
  }
  toErr(r) {
    const msg = (r.json && (r.json.error?.message || r.json.message)) || (r.text || '').slice(0, 160) || ('HTTP ' + r.status);
    const e = new Error(`HTTP ${r.status}: ${String(msg).slice(0, 180)}`);
    e.status = r.status;
    e.kind = CODE_KIND[r.status] || (r.status >= 500 ? 'server' : 'other');
    e.label = (KIND[e.kind] || KIND.other).label;
    return e;
  }
  async listModels(p) {
    const r = await this._http(p, '/models', { timeout: 20000 });
    if (!r.ok) throw this.toErr(r);
    const arr = (r.json && (r.json.data || r.json.models)) || [];
    return [...new Set(arr.map((m) => m.id || m.name).filter(Boolean).map(String))].slice(0, 800);
  }
  async credits(p) {
    if (!/openrouter\.ai/.test(p.baseUrl || '')) return null;
    try { const r = await this._http(p, '/credits', { timeout: 15000 }); if (r.ok && r.json && r.json.data) { const d = r.json.data; return { total: d.total_credits, used: d.total_usage, left: Math.round((Number(d.total_credits) - Number(d.total_usage)) * 10000) / 10000 }; } } catch { /* ignore */ }
    return null;
  }

  // পরীক্ষা: key + মডেল তালিকা + ছোট চ্যাট। সফল হলে ঘূর্ণনে যোগ।
  async test(p) {
    const t0 = Date.now();
    try {
      const models = await this.listModels(p);
      p.models = models.slice(0, 500);
      if (!p.model && models.length) p.model = models[0];
      if (!p.useModels || !p.useModels.length) p.useModels = p.model ? [p.model] : [];
      if (p.model) { const r = await this._http(p, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), timeout: 30000 }); if (!r.ok) throw this.toErr(r); }
      p.status = 'ok'; p.lastError = ''; p.latency = Date.now() - t0; this.cool.delete(p.id);
    } catch (e) {
      const k = KIND[e.kind] || KIND.other;
      this.cool.set(p.id, Date.now() + k.cool); p.status = k.status; p.lastError = `${k.label}: ${e.message}`.slice(0, 220);
    }
    p.lastTested = Date.now();
    p.credits = (await this.credits(p)) || p.credits || null;
    this.store.save();
    return p;
  }

  addProvider({ preset, name, baseUrl, apiKey }) {
    const pr = PRESETS.find((x) => x.key === preset) || PRESETS[PRESETS.length - 1];
    const url = String(baseUrl || pr.baseUrl || '').trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost/i.test(url)) throw new Error('Base URL অবশ্যই https:// দিয়ে শুরু হবে');
    const key = String(apiKey || '').trim();
    if (key.length < 8) throw new Error('API key দিন');
    if (this.providers().length >= 50) throw new Error('সর্বোচ্চ ৫০টি provider');
    const p = { id: crypto.randomBytes(5).toString('hex'), preset: pr.key, name: String(name || pr.name).trim().slice(0, 40) || pr.name, baseUrl: url, apiKey: key, model: '', useModels: [], models: [], enabled: true, status: 'untested', lastError: '', latency: 0, lastTested: 0, credits: null, addedAt: Date.now() };
    this.cfg().providers.push(p); this.store.save();
    return p;
  }
  setModels(p, list) {
    const arr = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
    p.useModels = arr;
    if (!arr.includes(p.model)) p.model = arr[0] || '';
    this.store.save();
  }
  find(id) { return this.providers().find((p) => p.id === id); }
  remove(id) { this.cfg().providers = this.providers().filter((p) => p.id !== id); for (const k of [...this.cool.keys()]) if (k === id || k.startsWith(id + '|')) this.cool.delete(k); this.store.save(); }

  // ----- রাউটিং -----
  _plan() {
    const all = this.entries(); const n = all.length;
    if (!n) throw new Error('কোনো সক্রিয় provider/মডেল নেই (provider যোগ করে মডেল বাছুন)');
    if (this.cfg().strategy === 'roundrobin') { // শুধু সক্রিয় entry-গুলোর মধ্যে ঘোরে
      const avail = all.filter((e) => !this.isCool(e));
      if (!avail.length) return { all, order: [] };
      const s = this.rr++ % avail.length;
      return { all, order: [...avail.slice(s), ...avail.slice(0, s)] };
    }
    const start = this.ptr % n;
    const order = [...all.slice(start), ...all.slice(0, start)].filter((e) => !this.isCool(e));
    return { all, order };
  }
  async _pick() {
    let plan = this._plan();
    if (!plan.order.length) {
      const ends = this.entries().map((e) => this.isCool(e)).filter(Boolean);
      const wait = ends.length ? Math.min(...ends) - Date.now() : Infinity;
      if (wait > 0 && wait <= 90000) { await new Promise((r) => setTimeout(r, wait + 50)); plan = this._plan(); }
      if (!plan.order.length) throw new Error('সব provider/মডেল এখন বিরতিতে; বিরতি শেষে স্বয়ংক্রিয়ভাবে আবার চেষ্টা হবে');
    }
    return plan;
  }
  _prep(messages) {
    const sp = String(this.cfg().systemPrompt || '').trim();
    const msgs = messages.map((m) => ({ role: String(m.role || 'user'), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
    if (sp && !(msgs[0] && msgs[0].role === 'system')) msgs.unshift({ role: 'system', content: sp });
    return msgs;
  }
  _record(e, { ok, ms, usage, pno, fallbacks, src, err }) {
    const ms_ = this.mstat[e.key] ||= { provider: e.p.name, model: e.model, req: 0, ok: 0, fail: 0, tokens: 0, ms: [] };
    ms_.req++; if (ok) { ms_.ok++; ms_.tokens += Number(usage && usage.total_tokens) || 0; } else ms_.fail++;
    ms_.ms.push(ms); if (ms_.ms.length > 200) ms_.ms.shift();
    const h = Math.floor(Date.now() / 3600e3); const b = this.hours[h] ||= { req: 0, ok: 0, fail: 0, tokens: 0 };
    b.req++; if (ok) { b.ok++; b.tokens += Number(usage && usage.total_tokens) || 0; } else b.fail++;
    for (const k of Object.keys(this.hours)) if (Number(k) < h - 47) delete this.hours[k];
    this.hist.push({ t: Date.now(), provider: e.p.name, pno, model: e.model, ok, ms, err: err || '', fallbacks, src: src || 'panel' });
    if (this.hist.length > HIST_MAX) this.hist.splice(0, this.hist.length - HIST_MAX);
    e.p.stats = e.p.stats || { req: 0, ok: 0, fail: 0, tokens: 0 };
    e.p.stats.req++; if (ok) { e.p.stats.ok++; e.p.stats.tokens += Number(usage && usage.total_tokens) || 0; e.p.status = 'ok'; e.p.lastError = ''; e.p.latency = ms; } else e.p.stats.fail++;
    this.store.save();
  }
  _fail(e, err, ms, pno, fallbacks, src) {
    const kind = err.kind || (err.status >= 500 ? 'server' : 'other');
    const k = KIND[kind] || KIND.other;
    if (err.status !== 400) { const target = kind === 'model' ? e.key : e.p.id; this.cool.set(target, Date.now() + k.cool); e.p.status = k.status; e.p.lastError = `${k.label}: ${err.message}`.slice(0, 220); }
    this._record(e, { ok: false, ms, pno, fallbacks, src, err: `${k.label}: ${err.message}` });
    return k;
  }

  // ----- সাধারণ (নন-স্ট্রিম) চ্যাট -----
  async chat(messages, opts = {}) {
    const plan = await this._pick(); const chain = [];
    for (const e of plan.order) {
      const idx = plan.all.indexOf(e), pno = idx + 1, t0 = Date.now();
      try {
        const r = await this._http(e.p, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: e.model, messages: this._prep(messages), max_tokens: opts.max_tokens || 1500, temperature: opts.temperature ?? 0.3 }), timeout: opts.timeout || 120000 });
        if (!r.ok) throw this.toErr(r);
        const text = (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || '';
        if (!text) { const er = new Error('মডেল খালি উত্তর দিয়েছে'); er.kind = 'empty'; throw er; }
        const usage = (r.json && r.json.usage) || {}; const ms = Date.now() - t0;
        this._record(e, { ok: true, ms, usage, pno, fallbacks: chain.length, src: opts.src });
        this.ptr = idx;
        return { text, provider: e.p.name, model: e.model, providerNo: pno, fallbacks: chain.length, latency: ms, usage, entry: e.key };
      } catch (err) {
        if (err.status === 400) { this._record(e, { ok: false, ms: Date.now() - t0, pno, fallbacks: chain.length, src: opts.src, err: err.message }); throw err; }
        const k = this._fail(e, err, Date.now() - t0, pno, chain.length, opts.src);
        chain.push(`${e.p.name}/${e.model} (${k.label})`);
        this.ptr = (idx + 1) % plan.all.length;
      }
    }
    const msg = 'সব provider ব্যর্থ: ' + chain.join(' → ');
    this.emit('allfail', msg); throw new Error(msg);
  }

  // ----- আসল স্ট্রিমিং: SSE লাইন হিসেবে আউটপুট (শুধু প্রথম চাঙ্ক আসার আগে ফলব্যাক সম্ভব) -----
  _chunk(content, { role, finish } = {}) {
    const delta = finish ? {} : { ...(role ? { role } : {}), content };
    const j = { id: 'chatcmpl-' + genId() + genId(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.cfg().model, choices: [{ index: 0, delta, finish_reason: finish ? 'stop' : null }] };
    return 'data: ' + JSON.stringify(j) + '\n\n';
  }
  async *streamChat(messages, opts = {}) {
    const plan = await this._pick(); const chain = [];
    for (const e of plan.order) {
      const idx = plan.all.indexOf(e), pno = idx + 1, t0 = Date.now(); let started = false; let usage = null; let content = '';
      try {
        const r = await fetch(String(e.p.baseUrl).replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.p.apiKey, accept: 'text/event-stream' },
          body: JSON.stringify({ model: e.model, messages: this._prep(messages), max_tokens: opts.max_tokens || 1500, temperature: opts.temperature ?? 0.3, stream: true }),
          signal: AbortSignal.timeout(opts.timeout || 180000),
        });
        if (!r.ok) { const txt = await r.text(); throw this.toErr({ status: r.status, text: txt, json: tryJson(txt) }); }
        if (!/event-stream/.test(r.headers.get('content-type') || '')) { // provider স্ট্রিম করেনি: একবারে পাঠাই
          const j = tryJson(await r.text()); const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          if (!text) { const er = new Error('খালি উত্তর'); er.kind = 'empty'; throw er; }
          started = true; yield this._chunk(text, { role: 'assistant' }); yield this._chunk('', { finish: true }); yield 'data: [DONE]\n\n';
          this._record(e, { ok: true, ms: Date.now() - t0, usage: j.usage, pno, fallbacks: chain.length, src: opts.src }); this.ptr = idx; return;
        }
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); if (data === '[DONE]' || !data) continue;
            const j = tryJson(data); if (!j) continue;
            if (j.usage) usage = j.usage;
            const ch = j.choices && j.choices[0]; if (!ch) continue;
            const piece = (ch.delta && ch.delta.content) || '';
            if (piece) content += piece;
            if (piece || ch.finish_reason) {
              started = true;
              yield 'data: ' + JSON.stringify({ ...j, id: j.id || 'chatcmpl-' + genId(), model: this.cfg().model, choices: [{ index: 0, delta: ch.delta || {}, finish_reason: ch.finish_reason || null }] }) + '\n\n';
            }
          }
        }
        if (!content) { const er = new Error('মডেল খালি উত্তর দিয়েছে'); er.kind = 'empty'; throw er; }
        yield 'data: [DONE]\n\n';
        this._record(e, { ok: true, ms: Date.now() - t0, usage, pno, fallbacks: chain.length, src: opts.src }); this.ptr = idx; return;
      } catch (err) {
        if (started) { // মাঝপথে ব্যর্থ: ফলব্যাক সম্ভব নয়, ত্রুটি জানিয়ে শেষ
          this._fail(e, err, Date.now() - t0, pno, chain.length, opts.src);
          yield `data: ${JSON.stringify({ error: { message: err.message, type: 'stream_interrupted' } })}\n\n`; yield 'data: [DONE]\n\n'; return;
        }
        if (err.status === 400) { this._record(e, { ok: false, ms: Date.now() - t0, pno, fallbacks: chain.length, src: opts.src, err: err.message }); throw err; }
        const k = this._fail(e, err, Date.now() - t0, pno, chain.length, opts.src);
        chain.push(`${e.p.name}/${e.model} (${k.label})`);
        this.ptr = (idx + 1) % plan.all.length;
      }
    }
    const msg = 'সব provider ব্যর্থ: ' + chain.join(' → ');
    this.emit('allfail', msg); throw new Error(msg);
  }

  // ----- পটভূমি: বিরতি শেষ না হওয়া provider আবার যাচাই -----
  async healthPass() {
    for (const p of this.providers()) {
      if (!p.enabled || !p.apiKey || this.provCool(p)) continue;
      if (p.status !== 'ok' || Date.now() - (p.lastTested || 0) > 30 * 60e3) await this.test(p).catch(() => {});
    }
  }

  // ----- বিশ্লেষণ -----
  analytics() {
    const now = Math.floor(Date.now() / 3600e3); const series = [];
    for (let i = 23; i >= 0; i--) { const b = this.hours[now - i] || { req: 0, ok: 0, fail: 0, tokens: 0 }; series.push({ h: now - i, ...b }); }
    const totals = { req: 0, ok: 0, fail: 0, tokens: 0 };
    for (const b of Object.values(this.hours)) { totals.req += b.req; totals.ok += b.ok; totals.fail += b.fail; totals.tokens += b.tokens; }
    const models = Object.entries(this.mstat).map(([key, m]) => ({ key, provider: m.provider, model: m.model, req: m.req, ok: m.ok, fail: m.fail, tokens: m.tokens, okPct: m.req ? Math.round(m.ok / m.req * 1000) / 10 : 0, avgMs: m.ms.length ? Math.round(m.ms.reduce((a, b) => a + b, 0) / m.ms.length) : 0, p95: p95(m.ms) })).sort((a, b) => b.req - a.req);
    return { series, totals, models: models.slice(0, 60) };
  }
  recentHistory(n = 80) { return this.hist.slice(-n).reverse(); }

  // ----- ব্যাকআপ / পুনরুদ্ধার (Gateway key বাদে) -----
  backup() {
    const c = this.cfg();
    return { v: 2, kind: 'mc-host-ai-gateway', ts: Date.now(), model: c.model, strategy: c.strategy, systemPrompt: c.systemPrompt || '', providers: this.providers().map((p) => ({ preset: p.preset, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, useModels: this.modelsOf(p), enabled: p.enabled })) };
  }
  restore(data) {
    if (!data || data.kind !== 'mc-host-ai-gateway' || !Array.isArray(data.providers)) throw new Error('এটি AI Gateway ব্যাকআপ ফাইল নয়');
    const c = this.cfg(); c.providers = []; this.cool.clear();
    for (const x of data.providers.slice(0, 50)) {
      try { const p = this.addProvider({ preset: x.preset, name: x.name, baseUrl: x.baseUrl, apiKey: x.apiKey }); p.model = String(x.model || ''); p.useModels = Array.isArray(x.useModels) ? x.useModels.map(String).slice(0, 100) : (p.model ? [p.model] : []); p.enabled = x.enabled !== false; p.status = 'untested'; } catch { /* বাদ */ }
    }
    if (typeof data.model === 'string' && data.model) c.model = data.model.slice(0, 80);
    if (data.strategy === 'roundrobin' || data.strategy === 'sticky') c.strategy = data.strategy;
    if (typeof data.systemPrompt === 'string') c.systemPrompt = data.systemPrompt.slice(0, 4000);
    this.store.save();
    return { providers: c.providers.length };
  }

  summary(origin) {
    const all = this.entries(); const c = this.cfg();
    const cur = all.length ? all[this.ptr % all.length] : null;
    return {
      endpoint: origin + '/v1', model: c.model, key: this.mask(c.key), keyReady: !!c.key, strategy: c.strategy || 'sticky', systemPrompt: c.systemPrompt || '',
      next: this.nextNumber(), currentId: cur ? cur.p.id + '|' + cur.model : '', entries: all.length, activeCount: this.active().length, total: this.providers().length,
      history: this.recentHistory(80), analytics: this.analytics(),
      providers: this.providers().map((p, i) => ({
        id: p.id, no: i + 1, name: p.name, preset: p.preset, baseUrl: p.baseUrl, keyMask: this.mask(p.apiKey), model: p.model, useModels: this.modelsOf(p), models: p.models || [], enabled: p.enabled,
        status: this.provCool(p) && p.status === 'ok' ? 'cooldown' : p.status, lastError: p.lastError, latency: p.latency, lastTested: p.lastTested, credits: p.credits, stats: p.stats || { req: 0, ok: 0, fail: 0, tokens: 0 },
        cooling: !!this.provCool(p), coolUntil: this.cool.get(p.id) || 0,
        modelState: this.modelsOf(p).map((m) => ({ model: m, cooling: !!this.isCool({ key: p.id + '|' + m, p }), coolUntil: this.cool.get(p.id + '|' + m) || 0, current: !!(cur && cur.p.id === p.id && cur.model === m) })),
      })),
    };
  }
}
Gateway.PRESETS = PRESETS;
module.exports = Gateway;
