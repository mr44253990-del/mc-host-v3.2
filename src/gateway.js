'use strict';
// AI Gateway v3
// - প্রতিটি provider ফ্রি বা প্রিমিয়াম; মোড: free | premium | all
// - এক provider-এ অনেক মডেল; একই নামের মডেল সব provider-এ একত্রে (একটা নামে গেলে সবখানে যায়)
// - Sticky failover (শেষে আবার প্রথমে), বিরতি শেষে আবার চেষ্টা, দেরি হলে hedging (দ্বিতীয় provider সমান্তরালে)
// - OpenAI পুরো ফরম্যাট (tools, response_format, stream...) ফরওয়ার্ড; বড় কনটেক্সট স্বয়ংক্রিয় সারসংক্ষেপে ছোট
// - ছবি তৈরির provider, সমস্যার ইভেন্ট (FCM/Telegram), বিশ্লেষণ, ব্যাকআপ
const crypto = require('crypto');
const EventEmitter = require('events');
const { genId } = require('./util');

const PRESETS = [
  { key: 'openrouter', kind: 'llm', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', free: true, keyUrl: 'https://openrouter.ai/keys', note: 'মডেলের নামের শেষে :free থাকলে সেটি ফ্রি' },
  { key: 'groq', kind: 'llm', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', free: true, keyUrl: 'https://console.groq.com/keys', note: 'ফ্রি টিয়ার আছে (সীমাসহ)' },
  { key: 'gemini', kind: 'llm', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', free: true, keyUrl: 'https://aistudio.google.com/apikey', note: 'ফ্রি টিয়ার আছে (সীমাসহ)' },
  { key: 'cerebras', kind: 'llm', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', free: true, keyUrl: 'https://cloud.cerebras.ai', note: 'ফ্রি টিয়ার আছে (সীমাসহ)' },
  { key: 'sambanova', kind: 'llm', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', free: true, keyUrl: 'https://cloud.sambanova.ai', note: 'ফ্রি টিয়ার/ক্রেডিট থাকতে পারে' },
  { key: 'mistral', kind: 'llm', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', free: true, keyUrl: 'https://console.mistral.ai/api-keys', note: 'ফ্রি পরীক্ষামূলক টিয়ার থাকতে পারে' },
  { key: 'nvidia', kind: 'llm', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', free: true, keyUrl: 'https://build.nvidia.com', note: 'ফ্রি ক্রেডিট থাকতে পারে' },
  { key: 'github', kind: 'llm', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', free: true, keyUrl: 'https://github.com/settings/tokens', note: 'GitHub token দিয়ে, ফ্রি সীমাসহ' },
  { key: 'huggingface', kind: 'llm', name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', free: true, keyUrl: 'https://huggingface.co/settings/tokens', note: 'ফ্রি মাসিক ক্রেডিট থাকতে পারে' },
  { key: 'together', kind: 'llm', name: 'Together', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { key: 'deepinfra', kind: 'llm', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys' },
  { key: 'fireworks', kind: 'llm', name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys' },
  { key: 'openai', kind: 'llm', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { key: 'pollinations-text', kind: 'llm', name: 'Pollinations (key ছাড়া)', baseUrl: 'https://text.pollinations.ai/openai', noKey: true, free: true, note: 'কোনো key লাগে না; মডেলের নাম নিজে লিখুন' },
  { key: 'ollama', kind: 'llm', name: 'Ollama (নিজের সার্ভার)', baseUrl: 'http://localhost:11434/v1', noKey: true, free: true, note: 'নিজের মেশিনে চললে' },
  { key: 'custom', kind: 'llm', name: 'Custom (OpenAI-compatible)', baseUrl: '' },
  { key: 'pollinations-image', kind: 'image', adapter: 'pollinations', name: 'Pollinations ছবি (key ছাড়া)', baseUrl: 'https://image.pollinations.ai', noKey: true, free: true, staticModels: ['flux', 'turbo'], note: 'কোনো key লাগে না' },
  { key: 'together-image', kind: 'image', adapter: 'openai', name: 'Together ছবি', baseUrl: 'https://api.together.xyz/v1', staticModels: ['black-forest-labs/FLUX.1-schnell-Free', 'black-forest-labs/FLUX.1-schnell'], keyUrl: 'https://api.together.ai/settings/api-keys', note: '"-Free" মডেল ফ্রি হতে পারে (বদলায়)' },
  { key: 'openai-image', kind: 'image', adapter: 'openai', name: 'OpenAI ছবি', baseUrl: 'https://api.openai.com/v1', staticModels: ['gpt-image-1', 'dall-e-3'], keyUrl: 'https://platform.openai.com/api-keys' },
  { key: 'custom-image', kind: 'image', adapter: 'openai', name: 'Custom ছবি (OpenAI-compatible)', baseUrl: '', staticModels: [] },
];
const VIRTUAL = { 'mc-free': 'free', 'mc-premium': 'premium', 'mc-all': 'all' };
const MODE_LABEL = { free: 'ফ্রি', premium: 'প্রিমিয়াম', all: 'সব' };
const DEFAULTS = { model: 'mc-router', strategy: 'sticky', mode: 'all', modeFallback: false, systemPrompt: '', hedgeMs: 6000, firstTokenMs: 25000, timeoutMs: 90000, ctxMode: 'auto', ctxTokens: 0, slowMs: 20000 };
const KIND = {
  key: { status: 'invalid', cool: 6 * 3600e3, label: 'key ভুল/বাতিল', ev: 'invalid_key' },
  credits: { status: 'nocredit', cool: 30 * 60e3, label: 'ক্রেডিট শেষ', ev: 'nocredit' },
  quota: { status: 'nocredit', cool: 30 * 60e3, label: 'কোটা শেষ', ev: 'nocredit' },
  model: { status: 'error', cool: 10 * 60e3, label: 'মডেল পাওয়া যায়নি', ev: 'model_missing' },
  rate: { status: 'cooldown', cool: 60e3, label: 'রেট লিমিট', ev: 'provider_error' },
  server: { status: 'error', cool: 20e3, label: 'সার্ভার ত্রুটি', ev: 'provider_error' },
  timeout: { status: 'error', cool: 20e3, label: 'সময় শেষ/ধীর', ev: 'provider_error' },
  empty: { status: 'error', cool: 20e3, label: 'খালি উত্তর', ev: 'empty' },
  context: { status: 'error', cool: 5e3, label: 'কনটেক্সট অনেক বড়', ev: null },
  other: { status: 'error', cool: 30e3, label: 'অজানা ত্রুটি', ev: 'provider_error' },
};
const CODE_KIND = { 401: 'key', 402: 'credits', 403: 'quota', 404: 'model', 413: 'context', 429: 'rate' };
const CTX_RE = /context.{0,24}(length|window)|maximum context|too (long|large)|exceed.{0,30}(token|context)|reduce the length|context_length_exceeded|prompt is too long|input.{0,12}too long/i;
const PASS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'logit_bias', 'user', 'n', 'logprobs', 'top_logprobs', 'reasoning_effort', 'stream_options', 'functions', 'function_call'];
const HIST_MAX = 400;
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const p95 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const norm = (m) => String(m || '').toLowerCase().replace(/:free$/, '').split('/').pop().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// টোকেন অনুমান: ASCII ≈ ৪ অক্ষরে ১, বাংলা/অন্য ≈ ০.৯ প্রতি অক্ষর (সতর্কভাবে বেশি ধরা)
function estTokens(str) {
  const s = String(str || ''); let ascii = 0, other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other * 0.9);
}
function contentText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n');
  return '';
}
function estMsg(m) {
  let t = 6 + estTokens(contentText(m));
  if (Array.isArray(m.content)) t += m.content.filter((p) => p && /image/.test(p.type || '')).length * 800;
  if (m.tool_calls) t += estTokens(JSON.stringify(m.tool_calls));
  return t;
}
const estAll = (ms) => ms.reduce((s, m) => s + estMsg(m), 0);

class Gateway extends EventEmitter {
  constructor(store) {
    super(); this.store = store; this.cool = new Map(); this.hist = []; this.ptrs = new Map(); this.rrs = new Map();
    this.mstat = {}; this.hours = {}; this.sumCache = new Map(); this.counters = { compactions: 0, hedgeWins: 0, emptyRetries: 0 };
  }

  cfg() { const c = (this.store.data.gateway ||= { providers: [], key: '' }); for (const [k, v] of Object.entries(DEFAULTS)) if (c[k] === undefined) c[k] = v; c.providers ||= []; return c; }
  providers() { const ps = this.cfg().providers; for (const p of ps) { p.kind ||= 'llm'; p.tier ||= 'free'; p.ctx ||= {}; p.stats ||= { req: 0, ok: 0, fail: 0, tokens: 0 }; } return ps; }
  presets() { return PRESETS; }
  find(id) { return this.providers().find((p) => p.id === id); }
  mask(k) { return k ? k.slice(0, 8) + '••••' + k.slice(-4) : ''; }
  newKey() { return 'sk-nh-v1-' + crypto.randomBytes(32).toString('hex'); }
  ensureKey() { const c = this.cfg(); if (!c.key) { c.key = this.newKey(); this.store.save(); } return c.key; }
  rotateKey() { const c = this.cfg(); c.key = this.newKey(); this.store.save(); return c.key; }
  setKey(k) { const v = String(k || '').trim(); if (v.length < 8 || /\s/.test(v)) throw new Error('key কমপক্ষে ৮ অক্ষর, ফাঁকা ছাড়া'); this.cfg().key = v; this.store.save(); return v; }
  checkKey(token) { const k = this.cfg().key; if (!k || !token) return false; const a = Buffer.from(String(token)), b = Buffer.from(k); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  modeLabel(m) { return MODE_LABEL[m] || m; }

  // ----- মডেল ও pool -----
  modelsOf(p) { const u = Array.isArray(p.useModels) && p.useModels.length ? p.useModels : (p.model ? [p.model] : []); return [...new Set(u)]; }
  usable(p) { return p.enabled && (p.apiKey || p.noAuth); }
  entries({ kind = 'llm', mode = 'all', want = null } = {}) {
    const out = [];
    for (const p of this.providers()) {
      if (!this.usable(p) || p.kind !== kind) continue;
      if (mode !== 'all' && p.tier !== mode) continue;
      for (const m of this.modelsOf(p)) { if (want && !(m === want || norm(m) === norm(want))) continue; out.push({ key: p.id + '|' + m, p, model: m }); }
    }
    return out;
  }
  resolve(name) {
    const c = this.cfg(); const n = String(name || '').trim();
    if (!n || n === c.model) return { mode: c.mode, want: null, display: c.model };
    if (VIRTUAL[n]) return { mode: VIRTUAL[n], want: null, display: n };
    return { mode: c.mode, want: n, display: n };
  }
  poolKey(kind, res) { return `${kind}|${res.mode}|${res.want || ''}`; }
  pool(kind, res) {
    let all = this.entries({ kind, mode: res.mode, want: res.want });
    if (!all.length && this.cfg().modeFallback && res.mode !== 'all') all = this.entries({ kind, mode: 'all', want: res.want });
    return all;
  }
  provCool(p) { const t = this.cool.get(p.id); if (!t) return 0; if (Date.now() >= t) { this.cool.delete(p.id); return 0; } return t; }
  isCool(e) { const now = Date.now(); for (const k of [e.key, e.p.id]) { const t = this.cool.get(k); if (t) { if (now >= t) this.cool.delete(k); else return t; } } return 0; }

  _plan(res, kind) {
    const all = this.pool(kind, res); const n = all.length; const key = this.poolKey(kind, res);
    if (!n) {
      const any = this.entries({ kind, mode: 'all', want: res.want }).length;
      const err = new Error(res.want && !any ? `মডেল পাওয়া যায়নি: ${res.want}` : `${MODE_LABEL[res.mode] || res.mode} মোডে কোনো সক্রিয় ${kind === 'image' ? 'ছবির ' : ''}provider/মডেল নেই`);
      err.status = res.want && !any ? 404 : 503; throw err;
    }
    if (this.cfg().strategy === 'roundrobin') {
      const avail = all.filter((e) => !this.isCool(e));
      if (!avail.length) return { all, order: [], key };
      const c = this.rrs.get(key) || 0; this.rrs.set(key, c + 1); const s = c % avail.length;
      return { all, order: [...avail.slice(s), ...avail.slice(0, s)], key };
    }
    const start = (this.ptrs.get(key) || 0) % n;
    return { all, order: [...all.slice(start), ...all.slice(0, start)].filter((e) => !this.isCool(e)), key };
  }
  async _pick(res, kind = 'llm') {
    let plan = this._plan(res, kind);
    if (!plan.order.length) {
      const ends = plan.all.map((e) => this.isCool(e)).filter(Boolean);
      const wait = ends.length ? Math.min(...ends) - Date.now() : Infinity;
      if (wait > 0 && wait <= 90000) { await sleep(wait + 50); plan = this._plan(res, kind); }
      if (!plan.order.length) { const e = new Error('সব provider/মডেল এখন বিরতিতে; বিরতি শেষে আবার চেষ্টা হবে'); e.status = 503; throw e; }
    }
    return plan;
  }

  // ----- HTTP -----
  headers(p) { return { 'content-type': 'application/json', ...(p.noAuth || !p.apiKey ? {} : { authorization: 'Bearer ' + p.apiKey }) }; }
  async _http(p, path, { method = 'GET', body, timeout = 30000 } = {}) {
    const base = String(p.baseUrl || '').replace(/\/$/, '');
    let r;
    try { r = await fetch(base + path, { method, headers: this.headers(p), body, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { const er = new Error(e.name === 'TimeoutError' ? 'সময় শেষ' : 'সংযোগ হয়নি: ' + e.message); er.kind = 'timeout'; throw er; }
    const txt = await r.text();
    return { status: r.status, ok: r.ok, json: tryJson(txt), text: txt };
  }
  toErr(r) {
    const msg = (r.json && (r.json.error?.message || r.json.message || (typeof r.json.error === 'string' ? r.json.error : ''))) || (r.text || '').slice(0, 200) || ('HTTP ' + r.status);
    const e = new Error(`HTTP ${r.status}: ${String(msg).slice(0, 220)}`);
    e.status = r.status;
    e.kind = CTX_RE.test(String(msg)) ? 'context' : (CODE_KIND[r.status] || (r.status >= 500 ? 'server' : 'other'));
    e.label = (KIND[e.kind] || KIND.other).label;
    return e;
  }
  async listModels(p) {
    const r = await this._http(p, '/models', { timeout: 20000 });
    if (!r.ok) throw this.toErr(r);
    const arr = (r.json && (r.json.data || r.json.models)) || (Array.isArray(r.json) ? r.json : []);
    p.ctx = p.ctx || {};
    const ids = [];
    for (const m of arr) {
      const id = typeof m === 'string' ? m : (m.id || m.name); if (!id) continue; ids.push(String(id));
      const c = typeof m === 'object' ? Number(m.context_length || m.context_window || m.max_context_length || m.max_model_len || 0) : 0;
      if (c > 0) p.ctx[id] = c;
    }
    return [...new Set(ids)].slice(0, 800);
  }
  async credits(p) {
    if (!/openrouter\.ai/.test(p.baseUrl || '')) return null;
    try { const r = await this._http(p, '/credits', { timeout: 15000 }); if (r.ok && r.json && r.json.data) { const d = r.json.data; return { total: d.total_credits, used: d.total_usage, left: Math.round((Number(d.total_credits) - Number(d.total_usage)) * 10000) / 10000 }; } } catch { /* ignore */ }
    return null;
  }

  // ----- provider ব্যবস্থাপনা -----
  addProvider({ preset, name, baseUrl, apiKey, tier }) {
    const pr = PRESETS.find((x) => x.key === preset) || PRESETS.find((x) => x.key === 'custom');
    const url = String(baseUrl || pr.baseUrl || '').trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)) throw new Error('Base URL অবশ্যই https:// দিয়ে শুরু হবে');
    const key = String(apiKey || '').trim();
    if (!pr.noKey && key.length < 8) throw new Error('API key দিন');
    if (this.providers().length >= 80) throw new Error('সর্বোচ্চ ৮০টি provider');
    const t = tier === 'premium' ? 'premium' : 'free';
    const p = { id: crypto.randomBytes(5).toString('hex'), preset: pr.key, kind: pr.kind || 'llm', adapter: pr.adapter || 'openai', name: String(name || pr.name).trim().slice(0, 40) || pr.name, baseUrl: url, apiKey: pr.noKey && key.length < 8 ? '' : key, noAuth: !!pr.noKey && key.length < 8, tier: t, model: '', useModels: [], models: pr.staticModels ? [...pr.staticModels] : [], ctx: {}, enabled: true, status: 'untested', lastError: '', latency: 0, lastTested: 0, credits: null, stats: { req: 0, ok: 0, fail: 0, tokens: 0 }, addedAt: Date.now() };
    if (pr.staticModels && pr.staticModels.length) { p.model = pr.staticModels[0]; p.useModels = [pr.staticModels[0]]; }
    this.cfg().providers.push(p); this.store.save();
    return p;
  }
  setModels(p, list) {
    const arr = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
    p.useModels = arr; if (!arr.includes(p.model)) p.model = arr[0] || '';
    this.store.save();
  }
  setTier(p, tier) { p.tier = tier === 'premium' ? 'premium' : 'free'; this.ptrs.clear(); this.store.save(); }
  move(id, dir) {
    const ps = this.cfg().providers; const i = ps.findIndex((p) => p.id === id); const j = i + (Number(dir) < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= ps.length) return false;
    [ps[i], ps[j]] = [ps[j], ps[i]]; this.ptrs.clear(); this.store.save(); return true;
  }
  remove(id) { this.cfg().providers = this.providers().filter((p) => p.id !== id); for (const k of [...this.cool.keys()]) if (k === id || k.startsWith(id + '|')) this.cool.delete(k); this.ptrs.clear(); this.store.save(); }
  setMode(mode) { if (!['free', 'premium', 'all'].includes(mode)) throw new Error('মোড free, premium বা all'); this.cfg().mode = mode; this.ptrs.clear(); this.store.save(); this.emit('mode', mode); }

  // পরীক্ষা
  async test(p) {
    const t0 = Date.now(); const prev = p.status;
    try {
      if (p.kind === 'image') {
        const pr = PRESETS.find((x) => x.key === p.preset) || {};
        if (p.adapter === 'pollinations') { const r = await fetch(p.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch((e) => { const er = new Error('সংযোগ হয়নি: ' + e.message); er.kind = 'timeout'; throw er; }); if (r.status >= 500) { const er = new Error('HTTP ' + r.status); er.kind = 'server'; throw er; } }
        else { const r = await this._http(p, '/models', { timeout: 15000 }); if (!r.ok && r.status !== 404 && r.status !== 405) throw this.toErr(r); }
        if (!p.models.length && pr.staticModels) p.models = [...pr.staticModels];
        if (!p.useModels.length && p.models.length) { p.useModels = [p.models[0]]; p.model = p.models[0]; }
      } else {
        const pr = PRESETS.find((x) => x.key === p.preset) || {};
        let models = [];
        try { models = await this.listModels(p); } catch (e) { if (!(pr.noKey && (e.status === 404 || e.status === 405))) throw e; }
        if (models.length) p.models = models.slice(0, 500);
        if (!p.model && p.models.length) p.model = p.models[0];
        if (!p.useModels || !p.useModels.length) p.useModels = p.model ? [p.model] : [];
        if (p.model) { const r = await this._http(p, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), timeout: 30000 }); if (!r.ok && ![400, 422].includes(r.status)) throw this.toErr(r); }
      }
      p.status = 'ok'; p.lastError = ''; p.latency = Date.now() - t0; this.cool.delete(p.id);
      if (prev && prev !== 'ok' && prev !== 'untested') this._event('recovered', `${p.name}: আবার সক্রিয়`, 'provider আবার ঠিকভাবে কাজ করছে', 'rec:' + p.id);
    } catch (e) {
      const k = KIND[e.kind] || KIND.other;
      this.cool.set(p.id, Date.now() + k.cool); p.status = k.status; p.lastError = `${k.label}: ${e.message}`.slice(0, 240);
      this._event(k.ev || 'provider_error', `${p.name}: ${k.label}`, e.message.slice(0, 240), 'test:' + p.id + ':' + e.kind);
    }
    p.lastTested = Date.now();
    p.credits = (await this.credits(p)) || p.credits || null;
    this.store.save();
    return p;
  }
  async healthPass() {
    for (const p of this.providers()) {
      if (!this.usable(p) || this.provCool(p)) continue;
      if (p.status !== 'ok' || Date.now() - (p.lastTested || 0) > 30 * 60e3) await this.test(p).catch(() => {});
    }
  }

  _event(type, title, body, key) { try { this.emit('event', { type, title, body, key: key || type + ':' + title }); } catch { /* ignore */ } }

  // ----- কনটেক্সট ব্যবস্থাপনা -----
  _prep(messages) {
    const c = this.cfg(); const sp = String(c.systemPrompt || '').trim();
    const msgs = (Array.isArray(messages) ? messages : []).slice(-300).filter((m) => m && typeof m === 'object').map((m) => ({ ...m, role: String(m.role || 'user') }));
    if (sp && !(msgs[0] && msgs[0].role === 'system')) msgs.unshift({ role: 'system', content: sp });
    return msgs;
  }
  _shrink(m, maxTok) {
    const t = contentText(m); const maxChars = Math.max(200, maxTok * 2);
    if (t.length <= maxChars) return m;
    const k = Math.floor(maxChars * 0.45);
    return { ...m, content: t.slice(0, k) + '\n[... মাঝের অংশ কনটেক্সট সীমার জন্য বাদ ...]\n' + t.slice(-k) };
  }
  async _summary(older, opts) {
    const key = crypto.createHash('sha1').update(JSON.stringify(older)).digest('hex').slice(0, 20);
    if (this.sumCache.has(key)) return this.sumCache.get(key);
    const transcript = older.map((m) => `${m.role}: ${contentText(m).slice(0, 2500)}`).join('\n');
    const clipped = transcript.length > 14000 ? transcript.slice(0, 3000) + '\n...\n' + transcript.slice(-11000) : transcript;
    let text = '';
    try {
      const r = await this.chat({ messages: [{ role: 'system', content: 'Summarize the conversation below for another AI to continue it. Keep names, numbers, decisions, code identifiers, user preferences and open questions. Write in the same language as the conversation, max 350 words, no preface.' }, { role: 'user', content: clipped }], max_tokens: 700 }, { src: 'summarizer', noCompact: true, noHedge: true, mode: opts && opts.mode });
      text = r.text;
    } catch { text = ''; }
    if (!text) text = older.slice(-12).map((m) => `${m.role}: ${contentText(m).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
    this.sumCache.set(key, text); if (this.sumCache.size > 100) this.sumCache.delete(this.sumCache.keys().next().value);
    return text;
  }
  async _compact(messages, budget, opts) {
    if (estAll(messages) <= budget) return messages;
    const sys = messages.filter((m) => m.role === 'system'); const rest = messages.filter((m) => m.role !== 'system');
    const sysTok = estAll(sys); const room = Math.max(300, budget - sysTok - 700);
    let ts = rest.length; let used = 0;
    for (let i = rest.length - 1; i >= 0; i--) { const t = estMsg(rest[i]); if (used + t > room * 0.6 && ts < rest.length) break; used += t; ts = i; }
    while (ts > 0 && rest[ts] && rest[ts].role === 'tool') ts--;
    let tail = rest.slice(ts); const older = rest.slice(0, ts);
    tail = tail.map((m) => this._shrink(m, Math.floor(room * 0.5 / Math.max(1, Math.min(tail.length, 4)))));
    this.counters.compactions++;
    if (!older.length) return [...sys.map((m) => this._shrink(m, Math.floor(budget * 0.25))), ...tail];
    const summary = await this._summary(older, opts);
    return [...sys.map((m) => this._shrink(m, Math.floor(budget * 0.2))), { role: 'system', content: 'আগের কথোপকথনের সারসংক্ষেপ (স্বয়ংক্রিয়):\n' + summary }, ...tail];
  }
  async _fitFor(e, messages, opts, factor = 1, force = false) {
    const c = this.cfg();
    if ((opts && opts.noCompact) || (c.ctxMode === 'off' && !force)) return messages;
    const win = (e.p.ctx && e.p.ctx[e.model]) || 0;
    const base = c.ctxTokens > 0 ? c.ctxTokens : (win ? Math.floor(win * 0.7) : 24000);
    return this._compact(messages, Math.floor(base * factor), opts);
  }

  // ----- অনুরোধ তৈরি -----
  _body(client, e, messages, stream) {
    const b = {};
    for (const k of PASS) if (client[k] !== undefined && client[k] !== null) b[k] = client[k];
    return { ...b, model: e.model, messages, stream: !!stream };
  }
  _wrapErr(err, att) {
    if (att.cancelled) { const er = new Error('cancelled'); er.cancelled = true; return er; }
    if (att.timedOut) { const er = new Error(att.phase === 'first' ? 'প্রথম টোকেন আসতে অনেক দেরি' : 'সময় শেষ'); er.kind = 'timeout'; return er; }
    if (err && err.kind) return err;
    const er = new Error('সংযোগ হয়নি: ' + (err && err.message)); er.kind = 'timeout'; return er;
  }
  _validJson(j) {
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return false;
    return !!((typeof m.content === 'string' && m.content.trim()) || (Array.isArray(m.content) && m.content.length) || (m.tool_calls && m.tool_calls.length) || m.function_call);
  }
  async _attemptChat(e, client, messages, ctrl, att, opts) {
    const c = this.cfg(); let msgs = await this._fitFor(e, messages, opts, 1);
    for (let tryN = 0; tryN < 2; tryN++) {
      att.timedOut = false; att.phase = 'total';
      att.timer = setTimeout(() => { att.timedOut = true; ctrl.abort(); }, opts.timeoutMs || c.timeoutMs);
      try {
        const r = await fetch(String(e.p.baseUrl).replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: this.headers(e.p), body: JSON.stringify(this._body(client, e, msgs, false)), signal: ctrl.signal });
        const txt = await r.text(); const j = tryJson(txt);
        if (!r.ok) throw this.toErr({ status: r.status, text: txt, json: j });
        if (!this._validJson(j)) { const er = new Error('মডেল খালি উত্তর দিয়েছে'); er.kind = 'empty'; throw er; }
        return j;
      } catch (err) {
        const w = this._wrapErr(err, att);
        if (w.kind === 'context' && tryN === 0 && !(opts && opts.noCompact)) { msgs = await this._fitFor(e, messages, opts, 0.5, true); continue; }
        throw w;
      } finally { clearTimeout(att.timer); }
    }
  }
  async _attemptStream(e, client, messages, ctrl, att, opts) {
    const c = this.cfg(); let msgs = await this._fitFor(e, messages, opts, 1);
    for (let tryN = 0; tryN < 2; tryN++) {
      att.timedOut = false; att.phase = 'first';
      att.timer = setTimeout(() => { att.timedOut = true; ctrl.abort(); }, opts.firstTokenMs || c.firstTokenMs);
      try {
        const r = await fetch(String(e.p.baseUrl).replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { ...this.headers(e.p), accept: 'text/event-stream' }, body: JSON.stringify(this._body(client, e, msgs, true)), signal: ctrl.signal });
        if (!r.ok) { const txt = await r.text(); throw this.toErr({ status: r.status, text: txt, json: tryJson(txt) }); }
        if (!/event-stream/.test(r.headers.get('content-type') || '')) { // provider স্ট্রিম করেনি
          const j = tryJson(await r.text());
          if (!this._validJson(j)) { const er = new Error('মডেল খালি উত্তর দিয়েছে'); er.kind = 'empty'; throw er; }
          clearTimeout(att.timer);
          const m = j.choices[0].message; const base = { id: j.id || 'chatcmpl-' + genId(), object: 'chat.completion.chunk', created: j.created || Math.floor(Date.now() / 1000) };
          const delta = { role: 'assistant', ...(m.content ? { content: m.content } : {}), ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t, i) => ({ index: i, ...t })) } : {}) };
          return { reader: null, dec: null, buf: '', pending: [{ ...base, choices: [{ index: 0, delta, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: j.choices[0].finish_reason || 'stop' }], ...(j.usage ? { usage: j.usage } : {}) }], usage: j.usage || null, content: m.content || '', done: true };
        }
        const reader = r.body.getReader(); const dec = new TextDecoder(); const st = { reader, dec, buf: '', pending: [], usage: null, content: '', done: false, real: false };
        while (!st.real && !st.done) {
          const { value, done } = await reader.read();
          if (done) { st.done = true; break; }
          st.buf += dec.decode(value, { stream: true });
          this._drain(st);
        }
        if (!st.real) { const er = new Error('মডেল খালি উত্তর দিয়েছে'); er.kind = 'empty'; throw er; }
        clearTimeout(att.timer);
        return st;
      } catch (err) {
        clearTimeout(att.timer);
        const w = this._wrapErr(err, att);
        if (w.kind === 'context' && tryN === 0 && !(opts && opts.noCompact)) { msgs = await this._fitFor(e, messages, opts, 0.5, true); continue; }
        throw w;
      }
    }
  }
  _drain(st) { // buffer থেকে সম্পূর্ণ SSE লাইন পড়ে pending-এ রাখে
    let nl;
    while ((nl = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, nl).trim(); st.buf = st.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (!d) continue;
      if (d === '[DONE]') { st.done = true; continue; }
      const j = tryJson(d); if (!j) continue;
      if (j.usage) st.usage = j.usage;
      const ch = j.choices && j.choices[0];
      const dl = (ch && ch.delta) || {};
      if (dl.content) st.content += dl.content;
      if (dl.content || dl.tool_calls || dl.function_call || (ch && ch.finish_reason)) { if (dl.content || dl.tool_calls || dl.function_call) st.real = true; }
      st.pending.push(j);
    }
  }

  // ----- hedged race -----
  async _race(plan, mk, opts, onFail) {
    const order = plan.order; let i = 0; const active = new Set(); const chain = [];
    let hedgeMs = opts.noHedge ? 0 : (opts.hedgeMs ?? this.cfg().hedgeMs);
    const launch = () => {
      if (i >= order.length) return false;
      const e = order[i++]; const ctrl = new AbortController(); const att = { e, ctrl, idx: plan.all.indexOf(e), t0: Date.now(), cancelled: false, timedOut: false };
      att.p = mk(e, ctrl, att).then((r) => ({ att, r }), (err) => ({ att, err }));
      active.add(att); return true;
    };
    launch();
    while (active.size) {
      const waits = [...active].map((a) => a.p); let timer;
      if (hedgeMs > 0 && i < order.length) waits.push(new Promise((res) => { timer = setTimeout(() => res({ hedge: true }), hedgeMs); }));
      const w = await Promise.race(waits); clearTimeout(timer);
      if (w.hedge) { launch(); continue; }
      active.delete(w.att);
      if (w.err) {
        if (w.att.cancelled || w.err.cancelled) continue;
        if (w.err.status === 400 && w.err.kind !== 'context') { for (const a of active) { a.cancelled = true; a.ctrl.abort(); } throw w.err; }
        const k = onFail(w.att, w.err, chain.length); chain.push(`${w.att.e.p.name}/${w.att.e.model} (${k.label})`);
        if (!active.size && !launch()) break;
        continue;
      }
      for (const a of active) { a.cancelled = true; a.ctrl.abort(); }
      if (active.size && plan.order.indexOf(w.att.e) > 0) this.counters.hedgeWins++;
      return { win: w.att, res: w.r, chain };
    }
    const msg = 'সব provider ব্যর্থ: ' + chain.join(' → ');
    const er = new Error(msg); er.status = 503; this._event('allfail', 'AI Gateway: সব provider ব্যর্থ', msg.slice(0, 300), 'allfail'); this.emit('allfail', msg); throw er;
  }

  _fail(att, err, fallbacks, src, mode) {
    const kind = err.kind || (err.status >= 500 ? 'server' : 'other'); const k = KIND[kind] || KIND.other; const e = att.e;
    const target = kind === 'model' || kind === 'context' ? e.key : e.p.id;
    this.cool.set(target, Date.now() + k.cool);
    if (kind !== 'context') { e.p.status = k.status; e.p.lastError = `${k.label}: ${err.message}`.slice(0, 240); }
    this._record(e, { ok: false, ms: Date.now() - att.t0, pno: this.providers().indexOf(e.p) + 1, fallbacks, src, mode, err: `${k.label}: ${err.message}` });
    if (k.ev) this._event(k.ev, `${e.p.name}${e.model ? ' / ' + e.model : ''}: ${k.label}`, err.message.slice(0, 240), `${k.ev}:${e.p.id}:${kind === 'model' ? e.model : ''}`);
    return k;
  }
  _record(e, { ok, ms, usage, pno, fallbacks, src, err, mode, preview, kind }) {
    const key = e.key; const ms_ = this.mstat[key] ||= { provider: e.p.name, model: e.model, tier: e.p.tier, req: 0, ok: 0, fail: 0, tokens: 0, ms: [] };
    ms_.req++; if (ok) { ms_.ok++; ms_.tokens += Number(usage && usage.total_tokens) || 0; } else ms_.fail++;
    ms_.ms.push(ms); if (ms_.ms.length > 200) ms_.ms.shift();
    const h = Math.floor(Date.now() / 3600e3); const b = this.hours[h] ||= { req: 0, ok: 0, fail: 0, tokens: 0 };
    b.req++; if (ok) { b.ok++; b.tokens += Number(usage && usage.total_tokens) || 0; } else b.fail++;
    for (const k of Object.keys(this.hours)) if (Number(k) < h - 47) delete this.hours[k];
    this.hist.push({ t: Date.now(), provider: e.p.name, tier: e.p.tier, pno, model: e.model, ok, ms, err: err || '', fallbacks, src: src || 'panel', mode: mode || '', kind: kind || e.p.kind, preview: preview || null });
    if (this.hist.length > HIST_MAX) this.hist.splice(0, this.hist.length - HIST_MAX);
    const st = e.p.stats ||= { req: 0, ok: 0, fail: 0, tokens: 0 }; st.req++;
    if (ok) {
      st.ok++; st.tokens += Number(usage && usage.total_tokens) || 0; const was = e.p.status; e.p.status = 'ok'; e.p.lastError = ''; e.p.latency = ms;
      if (was && was !== 'ok' && was !== 'untested') this._event('recovered', `${e.p.name}: আবার সক্রিয়`, 'অনুরোধ সফল হয়েছে', 'rec:' + e.p.id);
      if (ms > this.cfg().slowMs) this._event('slow', `${e.p.name} ধীর`, `${Math.round(ms / 1000)} সেকেন্ড লেগেছে (${e.model})`, 'slow:' + e.p.id);
    } else st.fail++;
    this.store.save();
  }

  // ----- নন-স্ট্রিম চ্যাট -----
  async chat(client, opts = {}) {
    const res = opts.mode ? { mode: opts.mode, want: null, display: this.cfg().model } : this.resolve(client.model);
    const plan = await this._pick(res); const messages = this._prep(client.messages);
    const o = { ...opts }; const t0 = Date.now();
    const out = await this._race(plan, (e, ctrl, att) => this._attemptChat(e, client, messages, ctrl, att, o), o, (att, err, fb) => this._fail(att, err, fb, o.src, res.mode));
    const e = out.win.e; const j = out.res; const idx = out.win.idx; const ms = Date.now() - out.win.t0;
    const m = j.choices[0].message; const text = typeof m.content === 'string' ? m.content : contentText(m);
    const usage = j.usage || { prompt_tokens: estAll(messages), completion_tokens: estTokens(text), total_tokens: estAll(messages) + estTokens(text) };
    this.ptrs.set(plan.key, idx);
    this._record(e, { ok: true, ms, usage, pno: this.providers().indexOf(e.p) + 1, fallbacks: out.chain.length, src: o.src, mode: res.mode, preview: o.noPreview ? null : { q: contentText(messages[messages.length - 1]).slice(0, 140), a: text.slice(0, 180) } });
    void t0;
    return { json: { ...j, model: res.display, usage }, text, message: m, provider: e.p.name, tier: e.p.tier, model: e.model, providerNo: this.providers().indexOf(e.p) + 1, fallbacks: out.chain.length, latency: ms, usage, mode: res.mode };
  }

  // ----- আসল স্ট্রিম -----
  _chunkStr(j, display) { return 'data: ' + JSON.stringify({ ...j, id: j.id || 'chatcmpl-' + genId(), model: display }) + '\n\n'; }
  async *streamChat(client, opts = {}) {
    const res = opts.mode ? { mode: opts.mode, want: null, display: this.cfg().model } : this.resolve(client.model);
    const plan = await this._pick(res); const messages = this._prep(client.messages); const o = { ...opts };
    const out = await this._race(plan, (e, ctrl, att) => this._attemptStream(e, client, messages, ctrl, att, o), o, (att, err, fb) => this._fail(att, err, fb, o.src, res.mode));
    const e = out.win.e; const st = out.res; const pno = this.providers().indexOf(e.p) + 1; const display = res.display; const t0 = out.win.t0;
    this.ptrs.set(plan.key, out.win.idx);
    let failed = null;
    try {
      for (const j of st.pending) yield this._chunkStr(j, display);
      st.pending = [];
      while (!st.done && st.reader) {
        const idle = new Promise((_, rej) => { st._t = setTimeout(() => { const er = new Error('স্ট্রিম থেমে গেছে (৬০ সেকেন্ড কোনো ডাটা নেই)'); er.kind = 'timeout'; rej(er); }, 60000); });
        let chunk;
        try { chunk = await Promise.race([st.reader.read(), idle]); } finally { clearTimeout(st._t); }
        if (chunk.done) break;
        st.buf += st.dec.decode(chunk.value, { stream: true });
        this._drain(st);
        for (const j of st.pending) yield this._chunkStr(j, display);
        st.pending = [];
      }
    } catch (err) { failed = err; }
    if (failed) {
      this._fail({ e, t0 }, failed, out.chain.length, o.src, res.mode);
      yield `data: ${JSON.stringify({ error: { message: failed.message, type: 'stream_interrupted' } })}\n\n`; yield 'data: [DONE]\n\n';
      this._event('stream_cut', `${e.p.name}: স্ট্রিম মাঝপথে কেটে গেছে`, failed.message.slice(0, 200), 'cut:' + e.p.id);
      return;
    }
    yield 'data: [DONE]\n\n';
    const text = st.content; const usage = st.usage || { prompt_tokens: estAll(messages), completion_tokens: estTokens(text), total_tokens: estAll(messages) + estTokens(text) };
    this._record(e, { ok: true, ms: Date.now() - t0, usage, pno, fallbacks: out.chain.length, src: o.src, mode: res.mode, preview: { q: contentText(messages[messages.length - 1]).slice(0, 140), a: text.slice(0, 180) } });
  }

  // ----- ছবি তৈরি -----
  async image(body, opts = {}) {
    const res = { mode: this.cfg().mode, want: body.model && !VIRTUAL[body.model] && body.model !== this.cfg().model ? body.model : null, display: body.model || this.cfg().model };
    const plan = await this._pick(res, 'image'); const o = { ...opts, noHedge: true };
    const prompt = String(body.prompt || '');
    const out = await this._race(plan, async (e, ctrl, att) => {
      att.timer = setTimeout(() => { att.timedOut = true; ctrl.abort(); }, 150000);
      try {
        if (e.p.adapter === 'pollinations') {
          const m = String(body.size || '1024x1024').match(/(\d+)x(\d+)/); const w = m ? m[1] : 1024, h = m ? m[2] : 1024;
          const url = `${String(e.p.baseUrl).replace(/\/$/, '')}/prompt/${encodeURIComponent(prompt)}?model=${encodeURIComponent(e.model)}&width=${w}&height=${h}&nologo=true&seed=${body.seed || Math.floor(Math.random() * 1e6)}`;
          const r = await fetch(url, { signal: ctrl.signal });
          if (!r.ok) throw this.toErr({ status: r.status, text: await r.text().catch(() => ''), json: null });
          if (!/image/.test(r.headers.get('content-type') || '')) { const er = new Error('ছবি আসেনি (অন্য ধরনের উত্তর)'); er.kind = 'empty'; throw er; }
          const buf = Buffer.from(await r.arrayBuffer());
          return { created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString('base64'), revised_prompt: prompt }] };
        }
        const r = await fetch(String(e.p.baseUrl).replace(/\/$/, '') + '/images/generations', { method: 'POST', headers: this.headers(e.p), body: JSON.stringify({ ...body, model: e.model }), signal: ctrl.signal });
        const txt = await r.text(); const j = tryJson(txt);
        if (!r.ok) throw this.toErr({ status: r.status, text: txt, json: j });
        if (!j || !Array.isArray(j.data) || !j.data.length) { const er = new Error('ছবির উত্তর খালি'); er.kind = 'empty'; throw er; }
        return j;
      } catch (err) { throw this._wrapErr(err, att); } finally { clearTimeout(att.timer); }
    }, o, (att, err, fb) => this._fail(att, err, fb, o.src || 'api', res.mode));
    const e = out.win.e;
    this.ptrs.set(plan.key, out.win.idx);
    this._record(e, { ok: true, ms: Date.now() - out.win.t0, usage: null, pno: this.providers().indexOf(e.p) + 1, fallbacks: out.chain.length, src: o.src || 'api', mode: res.mode, kind: 'image', preview: { q: prompt.slice(0, 140), a: 'ছবি' } });
    return { json: out.res, provider: e.p.name, model: e.model, fallbacks: out.chain.length };
  }

  // ----- Embeddings ইত্যাদি সাধারণ ফরওয়ার্ড -----
  async forward(path, body, opts = {}) {
    const res = this.resolve(body && body.model); const plan = await this._pick(res); const o = { ...opts, noHedge: true };
    const out = await this._race(plan, async (e, ctrl, att) => {
      att.timer = setTimeout(() => { att.timedOut = true; ctrl.abort(); }, 90000);
      try {
        const r = await fetch(String(e.p.baseUrl).replace(/\/$/, '') + path, { method: 'POST', headers: this.headers(e.p), body: JSON.stringify({ ...body, model: e.model }), signal: ctrl.signal });
        const txt = await r.text(); const j = tryJson(txt);
        if (!r.ok) throw this.toErr({ status: r.status, text: txt, json: j });
        return j;
      } catch (err) { throw this._wrapErr(err, att); } finally { clearTimeout(att.timer); }
    }, o, (att, err, fb) => this._fail(att, err, fb, o.src || 'api', res.mode));
    const e = out.win.e; this.ptrs.set(plan.key, out.win.idx);
    this._record(e, { ok: true, ms: Date.now() - out.win.t0, usage: out.res && out.res.usage, pno: this.providers().indexOf(e.p) + 1, fallbacks: out.chain.length, src: o.src || 'api', mode: res.mode });
    return { json: out.res, provider: e.p.name, model: e.model, fallbacks: out.chain.length };
  }

  // ----- মডেল তালিকা (একই নাম একত্রে) -----
  merged(mode = this.cfg().mode, kind = 'llm') {
    const map = new Map();
    for (const e of this.entries({ kind, mode })) {
      const k = norm(e.model); let it = map.get(k);
      if (!it) { it = { id: k, raw: new Set(), providers: [] }; map.set(k, it); }
      it.raw.add(e.model); it.providers.push({ id: e.p.id, name: e.p.name, tier: e.p.tier, model: e.model });
    }
    return [...map.values()].map((x) => ({ id: x.id, raw: [...x.raw], providers: x.providers, count: x.providers.length })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }
  openaiModels(mode) {
    const m = mode || this.cfg().mode; const c = this.cfg(); const now = Math.floor(Date.now() / 1000);
    const data = [{ id: c.model, object: 'model', created: now, owned_by: 'gateway', x_note: `ডিফল্ট (${MODE_LABEL[c.mode]} মোড)` }, ...Object.keys(VIRTUAL).map((id) => ({ id, object: 'model', created: now, owned_by: 'gateway', x_note: `${MODE_LABEL[VIRTUAL[id]]} provider-গুলো থেকে` }))];
    for (const x of this.merged(m, 'llm')) data.push({ id: x.id, object: 'model', created: now, owned_by: x.providers.map((p) => p.name).join(','), x_providers: x.providers.map((p) => ({ name: p.name, tier: p.tier })), x_kind: 'chat' });
    for (const x of this.merged(m, 'image')) data.push({ id: x.id, object: 'model', created: now, owned_by: x.providers.map((p) => p.name).join(','), x_kind: 'image' });
    return { object: 'list', data };
  }

  // ----- বিশ্লেষণ ও অবস্থা -----
  analytics() {
    const now = Math.floor(Date.now() / 3600e3); const series = [];
    for (let i = 23; i >= 0; i--) { const b = this.hours[now - i] || { req: 0, ok: 0, fail: 0, tokens: 0 }; series.push({ h: now - i, ...b }); }
    const totals = { req: 0, ok: 0, fail: 0, tokens: 0 };
    for (const b of Object.values(this.hours)) { totals.req += b.req; totals.ok += b.ok; totals.fail += b.fail; totals.tokens += b.tokens; }
    const models = Object.entries(this.mstat).map(([key, m]) => ({ key, provider: m.provider, model: m.model, tier: m.tier, req: m.req, ok: m.ok, fail: m.fail, tokens: m.tokens, okPct: m.req ? Math.round(m.ok / m.req * 1000) / 10 : 0, avgMs: m.ms.length ? Math.round(m.ms.reduce((a, b) => a + b, 0) / m.ms.length) : 0, p95: p95(m.ms) })).sort((a, b) => b.req - a.req);
    return { series, totals, models: models.slice(0, 60), counters: { ...this.counters } };
  }
  recentHistory(n = 80) { return this.hist.slice(-n).reverse(); }
  problems() {
    return this.providers().filter((p) => p.enabled && p.status && !['ok', 'untested'].includes(p.status)).map((p) => ({ id: p.id, name: p.name, tier: p.tier, status: p.status, error: p.lastError, until: this.cool.get(p.id) || 0 }));
  }
  current(kind = 'llm') {
    const res = { mode: this.cfg().mode, want: null }; const all = this.pool(kind, res); if (!all.length) return null;
    const start = (this.ptrs.get(this.poolKey(kind, res)) || 0) % all.length;
    const e = [...all.slice(start), ...all.slice(0, start)].find((x) => !this.isCool(x)) || all[start];
    return { provider: e.p.name, model: e.model, tier: e.p.tier, no: this.providers().indexOf(e.p) + 1, id: e.key };
  }

  // ----- ব্যাকআপ / পুনরুদ্ধার (Gateway key বাদে) -----
  backup() {
    const c = this.cfg();
    const cfg = {}; for (const k of Object.keys(DEFAULTS)) cfg[k] = c[k];
    return { v: 3, kind: 'mc-host-ai-gateway', ts: Date.now(), cfg, providers: this.providers().map((p) => ({ preset: p.preset, kind: p.kind, adapter: p.adapter, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, noAuth: !!p.noAuth, tier: p.tier, model: p.model, useModels: this.modelsOf(p), models: (p.models || []).slice(0, 300), enabled: p.enabled })) };
  }
  restore(data) {
    if (!data || data.kind !== 'mc-host-ai-gateway' || !Array.isArray(data.providers)) throw new Error('এটি AI Gateway ব্যাকআপ ফাইল নয়');
    const c = this.cfg(); c.providers = []; this.cool.clear(); this.ptrs.clear();
    for (const x of data.providers.slice(0, 80)) {
      try {
        const url = String(x.baseUrl || '').trim().replace(/\/$/, ''); if (!/^https?:\/\//i.test(url)) continue;
        c.providers.push({ id: crypto.randomBytes(5).toString('hex'), preset: String(x.preset || 'custom'), kind: x.kind === 'image' ? 'image' : 'llm', adapter: x.adapter === 'pollinations' ? 'pollinations' : 'openai', name: String(x.name || 'Provider').slice(0, 40), baseUrl: url, apiKey: String(x.apiKey || ''), noAuth: !!x.noAuth, tier: x.tier === 'premium' ? 'premium' : 'free', model: String(x.model || ''), useModels: Array.isArray(x.useModels) ? x.useModels.map(String).slice(0, 100) : [], models: Array.isArray(x.models) ? x.models.map(String).slice(0, 300) : [], ctx: {}, enabled: x.enabled !== false, status: 'untested', lastError: '', latency: 0, lastTested: 0, credits: null, stats: { req: 0, ok: 0, fail: 0, tokens: 0 }, addedAt: Date.now() });
      } catch { /* বাদ */ }
    }
    const src = data.cfg || data;
    if (typeof src.model === 'string' && src.model) c.model = src.model.slice(0, 80);
    if (['sticky', 'roundrobin'].includes(src.strategy)) c.strategy = src.strategy;
    if (['free', 'premium', 'all'].includes(src.mode)) c.mode = src.mode;
    if (typeof src.systemPrompt === 'string') c.systemPrompt = src.systemPrompt.slice(0, 4000);
    for (const k of ['hedgeMs', 'firstTokenMs', 'timeoutMs', 'ctxTokens', 'slowMs']) if (Number.isFinite(Number(src[k]))) c[k] = Number(src[k]);
    if (['auto', 'off'].includes(src.ctxMode)) c.ctxMode = src.ctxMode;
    if (typeof src.modeFallback === 'boolean') c.modeFallback = src.modeFallback;
    this.store.save();
    return { providers: c.providers.length };
  }

  summary(origin) {
    const c = this.cfg(); const act = this.entries({ kind: 'llm', mode: c.mode }).filter((e) => !this.isCool(e));
    const tiers = { free: 0, premium: 0 }; for (const p of this.providers()) if (p.kind === 'llm' && this.usable(p)) tiers[p.tier]++;
    return {
      endpoint: origin + '/v1', model: c.model, key: c.key, keyReady: !!c.key, strategy: c.strategy, mode: c.mode, modeFallback: c.modeFallback, systemPrompt: c.systemPrompt,
      settings: { hedgeMs: c.hedgeMs, firstTokenMs: c.firstTokenMs, timeoutMs: c.timeoutMs, ctxMode: c.ctxMode, ctxTokens: c.ctxTokens, slowMs: c.slowMs },
      current: this.current(), tiers, entries: this.entries({ kind: 'llm', mode: c.mode }).length, activeCount: act.length, total: this.providers().length,
      problems: this.problems(), merged: this.merged('all', 'llm'), mergedImage: this.merged('all', 'image'), history: this.recentHistory(80), analytics: this.analytics(),
      providers: this.providers().map((p, i) => ({
        id: p.id, no: i + 1, name: p.name, preset: p.preset, kind: p.kind, tier: p.tier, baseUrl: p.baseUrl, keyMask: p.noAuth ? 'key নেই' : this.mask(p.apiKey), model: p.model, useModels: this.modelsOf(p), models: p.models || [], enabled: p.enabled,
        status: this.provCool(p) && p.status === 'ok' ? 'cooldown' : p.status, lastError: p.lastError, latency: p.latency, lastTested: p.lastTested, credits: p.credits, stats: p.stats,
        cooling: !!this.provCool(p), coolUntil: this.cool.get(p.id) || 0,
        modelState: this.modelsOf(p).map((m) => ({ model: m, cooling: !!this.isCool({ key: p.id + '|' + m, p }), current: !!(this.current(p.kind) && this.current(p.kind).id === p.id + '|' + m) })),
      })),
    };
  }
}
Gateway.PRESETS = PRESETS; Gateway.estTokens = estTokens; Gateway.norm = norm; Gateway.VIRTUAL = VIRTUAL; Gateway.MODE_LABEL = MODE_LABEL;
module.exports = Gateway;
