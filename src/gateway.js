'use strict';
// AI Gateway: অনেকগুলো OpenAI-সামঞ্জস্যপূর্ণ provider (নিজের key) এক URL + এক key দিয়ে ব্যবহার।
// round-robin (১ → N → ১ …), ব্যর্থ হলে পরেরটায় যায়, কোন key কেন ব্যর্থ তার হিস্টরি রাখে।
const crypto = require('crypto');

const PRESETS = [
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { key: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { key: 'together', name: 'Together', baseUrl: 'https://api.together.xyz/v1' },
  { key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { key: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '' },
];
// ত্রুটির ধরন -> বিরতি (মিলিসেকেন্ড) ও স্ট্যাটাস
const KIND = {
  key: { status: 'invalid', cool: 6 * 3600e3, label: 'key ভুল/বাতিল' },
  credits: { status: 'nocredit', cool: 30 * 60e3, label: 'ক্রেডিট শেষ' },
  quota: { status: 'nocredit', cool: 30 * 60e3, label: 'কোটা শেষ' },
  model: { status: 'error', cool: 10 * 60e3, label: 'মডেল পাওয়া যায়নি' },
  rate: { status: 'cooldown', cool: 60e3, label: 'রেট লিমিট' },
  server: { status: 'error', cool: 20e3, label: 'সার্ভার ত্রুটি' },
  timeout: { status: 'error', cool: 20e3, label: 'সময় শেষ' },
  other: { status: 'error', cool: 30e3, label: 'অজানা ত্রুটি' },
};
const CODE_KIND = { 401: 'key', 402: 'credits', 403: 'quota', 404: 'model', 429: 'rate' };
const HIST_MAX = 300;

class Gateway {
  constructor(store) { this.store = store; this.cursor = 0; this.cool = new Map(); this.hist = []; }

  cfg() { return (this.store.data.gateway ||= { providers: [], key: '', model: 'mc-router' }); }
  providers() { return this.cfg().providers; }
  hasProviders() { return this.providers().some((p) => p.enabled && p.model && p.apiKey); }
  ensureKey() { const c = this.cfg(); if (!c.key) { c.key = 'mcgw_' + crypto.randomBytes(24).toString('hex'); this.store.save(); } return c.key; }
  rotateKey() { const c = this.cfg(); c.key = 'mcgw_' + crypto.randomBytes(24).toString('hex'); this.store.save(); return c.key; }
  checkKey(token) {
    const k = this.cfg().key; if (!k || !token) return false;
    const a = Buffer.from(String(token)), b = Buffer.from(k);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  presets() { return PRESETS; }
  mask(k) { return k ? k.slice(0, 6) + '••••' + k.slice(-4) : ''; }

  // সক্রিয় (বিরতিতে নেই, মডেল ও key আছে) provider-এর তালিকা
  active() { return this.providers().filter((p) => p.enabled && p.model && p.apiKey && !this.isCool(p.id)); }
  // পরের পালা: ১-ভিত্তিক সংখ্যা (০ = কোনোটি সক্রিয় নেই)
  nextNumber() { const act = this.active(); return act.length ? (this.cursor % act.length) + 1 : 0; }
  isCool(id) { const t = this.cool.get(id); if (!t) return false; if (Date.now() >= t) { this.cool.delete(id); return false; } return true; }
  coolDown(p, ms, status, err) { this.cool.set(p.id, Date.now() + ms); p.status = status; p.lastError = String(err).slice(0, 220); this.store.save(); }

  async _http(p, path, { method = 'GET', body, timeout = 30000 } = {}) {
    const base = String(p.baseUrl || '').replace(/\/$/, '');
    let r;
    try {
      r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.apiKey }, body, signal: AbortSignal.timeout(timeout) });
    } catch (e) { const er = new Error(e.name === 'TimeoutError' ? 'সময় শেষ' : 'সংযোগ হয়নি: ' + e.message); er.kind = 'timeout'; throw er; }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { /* text */ }
    return { status: r.status, ok: r.ok, json: j, text: txt };
  }
  toErr(r) {
    const msg = (r.json && (r.json.error?.message || r.json.message)) || r.text.slice(0, 160) || ('HTTP ' + r.status);
    const e = new Error(`HTTP ${r.status}: ${String(msg).slice(0, 180)}`);
    e.status = r.status;
    e.kind = CODE_KIND[r.status] || (r.status >= 500 ? 'server' : 'other');
    return e;
  }

  async listModels(p) {
    const r = await this._http(p, '/models', { timeout: 20000 });
    if (!r.ok) throw this.toErr(r);
    const arr = (r.json && (r.json.data || r.json.models)) || [];
    return [...new Set(arr.map((m) => m.id || m.name).filter(Boolean).map(String))].slice(0, 800);
  }
  // OpenRouter-এর ক্রেডিট ব্যালেন্স (অন্যদের জন্য null)
  async credits(p) {
    if (!/openrouter\.ai/.test(p.baseUrl || '')) return null;
    try {
      const r = await this._http(p, '/credits', { timeout: 15000 });
      if (r.ok && r.json && r.json.data) { const d = r.json.data; return { total: d.total_credits, used: d.total_usage, left: Math.round((Number(d.total_credits) - Number(d.total_usage)) * 10000) / 10000 }; }
    } catch { /* ignore */ }
    return null;
  }

  // পরীক্ষা: মডেল তালিকা (key যাচাই) + ছোট চ্যাট (ক্রেডিট যাচাই)
  async test(p) {
    const t0 = Date.now();
    try {
      const models = await this.listModels(p);
      p.models = models.slice(0, 300);
      if (!p.model && models.length) p.model = models[0];
      if (p.model) {
        const r = await this._http(p, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }), timeout: 30000 });
        if (!r.ok) throw this.toErr(r);
      }
      p.status = 'ok'; p.lastError = ''; p.latency = Date.now() - t0; this.cool.delete(p.id);
    } catch (e) {
      const k = KIND[e.kind] || KIND.other;
      this.coolDown(p, k.cool, k.status, `${k.label}: ${e.message}`);
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
    const p = { id: crypto.randomBytes(5).toString('hex'), preset: pr.key, name: String(name || pr.name).trim().slice(0, 40) || pr.name, baseUrl: url, apiKey: key, model: '', models: [], enabled: true, status: 'untested', lastError: '', latency: 0, lastTested: 0, credits: null, stats: { req: 0, ok: 0, fail: 0, tokens: 0 }, addedAt: Date.now() };
    this.cfg().providers.push(p); this.store.save();
    return p;
  }
  find(id) { return this.providers().find((p) => p.id === id); }
  remove(id) { this.cfg().providers = this.providers().filter((p) => p.id !== id); this.cool.delete(id); this.store.save(); }

  // ----- আসল রাউটিং: round-robin + ব্যর্থতায় পরেরটা -----
  async chat(messages, opts = {}) {
    const act = this.active();
    if (!act.length) throw new Error('কোনো সক্রিয় provider নেই (provider যোগ করে পরীক্ষা করুন)');
    const n = act.length;
    const start = this.cursor % n;
    this.cursor = (this.cursor + 1) % 1000000;
    const order = [...act.slice(start), ...act.slice(0, start)];
    const chain = [];
    for (const p of order) {
      const t0 = Date.now(); p.stats.req++;
      const pno = this.providers().indexOf(p) + 1;
      try {
        const body = { model: p.model, messages, max_tokens: opts.max_tokens || 1500, temperature: opts.temperature ?? 0.3 };
        const r = await this._http(p, '/chat/completions', { method: 'POST', body: JSON.stringify(body), timeout: opts.timeout || 90000 });
        if (!r.ok) throw this.toErr(r);
        const text = (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || '';
        const usage = (r.json && r.json.usage) || {};
        p.stats.ok++; p.stats.tokens += Number(usage.total_tokens) || 0; p.latency = Date.now() - t0; p.status = 'ok'; p.lastError = '';
        this.log({ provider: p.name, pno, model: p.model, ok: true, ms: Date.now() - t0, fallbacks: chain.length, src: opts.src || 'panel' });
        this.store.save();
        return { text, provider: p.name, providerNo: pno, model: p.model, fallbacks: chain.length, latency: Date.now() - t0, usage };
      } catch (e) {
        p.stats.fail++;
        if (e.status === 400) { this.log({ provider: p.name, pno, model: p.model, ok: false, ms: Date.now() - t0, err: e.message, fallbacks: chain.length, src: opts.src || 'panel' }); this.store.save(); throw e; }
        const k = KIND[e.kind] || KIND.other;
        this.coolDown(p, k.cool, k.status, `${k.label}: ${e.message}`);
        this.log({ provider: p.name, pno, model: p.model, ok: false, ms: Date.now() - t0, err: `${k.label}: ${e.message}`, fallbacks: chain.length, src: opts.src || 'panel' });
        chain.push(`${p.name} (${k.label})`);
      }
    }
    this.store.save();
    throw new Error('সব provider ব্যর্থ: ' + chain.join(' → '));
  }

  log(x) { this.hist.push({ t: Date.now(), ...x }); if (this.hist.length > HIST_MAX) this.hist.splice(0, this.hist.length - HIST_MAX); }
  recentHistory(n = 60) { return this.hist.slice(-n).reverse(); }

  // পটভূমি: বিরতি শেষ না হওয়া সক্রিয়/ব্যর্থ provider আবার যাচাই, ক্রেডিট আপডেট
  async healthPass() {
    for (const p of this.providers()) {
      if (!p.enabled || !p.apiKey || this.isCool(p.id)) continue;
      if (p.status !== 'ok' || Date.now() - (p.lastTested || 0) > 30 * 60e3) await this.test(p).catch(() => {});
    }
  }

  summary(origin) {
    const act = this.active();
    const nextP = act.length ? act[this.cursor % act.length] : null;
    return {
      endpoint: origin + '/v1', model: this.cfg().model, key: this.mask(this.cfg().key), keyReady: !!this.cfg().key,
      next: this.nextNumber(), nextId: nextP ? nextP.id : '', activeCount: act.length, total: this.providers().length, history: this.recentHistory(60),
      providers: this.providers().map((p, i) => ({
        id: p.id, no: i + 1, name: p.name, preset: p.preset, baseUrl: p.baseUrl, keyMask: this.mask(p.apiKey), model: p.model, models: p.models || [], enabled: p.enabled,
        status: this.isCool(p.id) && p.status === 'ok' ? 'cooldown' : p.status, lastError: p.lastError, latency: p.latency, lastTested: p.lastTested,
        credits: p.credits, stats: p.stats, cooling: this.isCool(p.id), coolUntil: this.cool.get(p.id) || 0,
      })),
    };
  }
}
Gateway.PRESETS = PRESETS;
module.exports = Gateway;
