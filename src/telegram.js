'use strict';
// Telegram কন্ট্রোল: BotFather-এর টোকেন দিয়ে সেটিংসে কানেক্ট। প্রথমে পেয়ারিং কোড দিয়ে মালিক নির্ধারণ।
// লং-পোলিং (getUpdates), কোনো লাইব্রেরি লাগে না। কমান্ড: /mode /models /use /ask /image /status /problems /key /help
const API = (t) => `https://api.telegram.org/bot${t}`;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

class Telegram {
  constructor(store, gw, opts = {}) {
    this.store = store; this.gw = gw; this.running = false; this.offset = 0; this.onLog = opts.onLog || (() => {});
    this.pendingAsk = new Map();
  }
  cfg() { return (this.store.data.telegram ||= { token: '', ownerId: 0, pair: '', botName: '', enabled: false, alerts: true }); }
  canAlert() { const c = this.cfg(); return !!(c.token && c.ownerId && c.enabled && c.alerts); }
  async _call(method, body = {}, timeout = 40000) {
    const t = this.cfg().token; if (!t) throw new Error('টোকেন নেই');
    const r = await fetch(`${API(t)}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || ('HTTP ' + r.status));
    return j.result;
  }
  async connect(token) {
    const t = String(token || '').trim(); if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('BotFather-এর টোকেন সঠিক নয় (123456:ABC...)');
    const c = this.cfg(); c.token = t; c.pair = String(Math.floor(100000 + Math.random() * 900000)); c.ownerId = 0; c.enabled = true;
    const me = await this._call('getMe', {}, 15000); c.botName = me.username || ''; this.store.save();
    try { await this._call('setMyCommands', { commands: [{ command: 'help', description: 'সব কমান্ড' }, { command: 'mode', description: 'free / premium / all' }, { command: 'models', description: 'মডেল তালিকা' }, { command: 'ask', description: 'প্রশ্ন করুন' }, { command: 'image', description: 'ছবি বানান' }, { command: 'status', description: 'অবস্থা' }, { command: 'problems', description: 'সমস্যাগুলো' }] }, 15000); } catch { /* ignore */ }
    this.start();
    return { botName: c.botName, pair: c.pair };
  }
  disconnect() { const c = this.cfg(); c.token = ''; c.ownerId = 0; c.pair = ''; c.enabled = false; this.running = false; this.store.save(); }
  setAlerts(v) { this.cfg().alerts = !!v; this.store.save(); }
  async alert(text) { if (!this.canAlert()) return; await this._call('sendMessage', { chat_id: this.cfg().ownerId, text: String(text).slice(0, 3500), disable_web_page_preview: true }, 15000); }
  async _say(chat, text, extra = {}) { return this._call('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }, 20000).catch((e) => this.onLog('tg send: ' + e.message)); }
  start() {
    if (this.running || !this.cfg().token || !this.cfg().enabled) return;
    this.running = true; this._loop();
  }
  async _loop() {
    let backoff = 1000;
    while (this.running && this.cfg().token) {
      try {
        const ups = await this._call('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, 35000);
        backoff = 1000;
        for (const u of ups) { this.offset = u.update_id + 1; if (u.message && u.message.text) await this._handle(u.message).catch((e) => this.onLog('tg: ' + e.message)); }
      } catch (e) {
        if (/Unauthorized|token/i.test(e.message)) { this.onLog('tg: টোকেন বাতিল, সংযোগ বন্ধ'); this.running = false; return; }
        await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(60000, backoff * 2);
      }
    }
  }
  async _handle(m) {
    const chat = m.chat.id; const from = m.from && m.from.id; const text = String(m.text).trim(); const c = this.cfg();
    if (!c.ownerId) {
      if (text === '/start' || text === '/pair' || /^\d{6}$/.test(text)) {
        if (c.pair && text === c.pair) { c.ownerId = from; c.pair = ''; this.store.save(); return this._say(chat, '✅ যুক্ত হয়েছেন। এখন /help লিখুন।'); }
        return this._say(chat, 'এই বট ব্যক্তিগত। প্যানেলে দেখানো ৬ সংখ্যার কোডটি পাঠান।');
      }
      return;
    }
    if (from !== c.ownerId) return this._say(chat, 'আপনার অনুমতি নেই।');
    if (this.pendingAsk.has(chat) && !text.startsWith('/')) { this.pendingAsk.delete(chat); return this._ask(chat, text); }
    const [cmd, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
    const g = this.gw;
    switch (cmd.toLowerCase().split('@')[0]) {
      case '/start': case '/help': return this._say(chat, HELP);
      case '/mode': {
        const v = arg.toLowerCase();
        if (!v) return this._say(chat, `বর্তমান মোড: ${g.cfg().mode}\nবদলাতে: /mode free | premium | all`);
        if (!['free', 'premium', 'all'].includes(v)) return this._say(chat, 'মোড হবে free, premium বা all');
        g.setMode(v); return this._say(chat, `✅ মোড: ${v}`);
      }
      case '/models': {
        const list = g.merged(g.cfg().mode, 'llm').slice(0, 40);
        return this._say(chat, list.length ? list.map((x) => `• ${x.id} (${x.count} provider)`).join('\n') : 'এই মোডে কোনো মডেল নেই');
      }
      case '/use': { if (!arg) return this._say(chat, 'ব্যবহার: /use <model>'); g.cfg().model = arg.slice(0, 80); g.store.save(); return this._say(chat, `✅ ডিফল্ট মডেল নাম: ${arg}`); }
      case '/ask': {
        if (!arg) { this.pendingAsk.set(chat, true); return this._say(chat, 'প্রশ্নটি লিখুন:'); }
        return this._ask(chat, arg);
      }
      case '/image': {
        if (!arg) return this._say(chat, 'ব্যবহার: /image <বর্ণনা>');
        await this._say(chat, '🎨 ছবি বানানো হচ্ছে...');
        try {
          const r = await g.image({ prompt: arg, size: '1024x1024' }, { src: 'telegram' });
          const b64 = r.json.data[0].b64_json; const buf = Buffer.from(b64, 'base64');
          const fd = new FormData(); fd.append('chat_id', String(chat)); fd.append('caption', `${r.provider} · ${r.model}`.slice(0, 200)); fd.append('photo', new Blob([buf], { type: 'image/png' }), 'image.png');
          const rr = await fetch(`${API(this.cfg().token)}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
          if (!rr.ok) throw new Error('ছবি পাঠানো যায়নি');
        } catch (e) { return this._say(chat, '❌ ছবি হয়নি: ' + e.message); }
        return;
      }
      case '/status': {
        const cur = g.current(); const a = g.analytics().totals;
        return this._say(chat, `মোড: ${g.cfg().mode}\nবর্তমান: ${cur ? `${cur.provider} · ${cur.model} (#${cur.no})` : 'নেই'}\nসক্রিয় provider: ${g.active ? g.entries({ mode: g.cfg().mode }).filter((e) => !g.isCool(e)).length : 0}\n২৪ ঘণ্টা: ${a.req} অনুরোধ, ${a.ok} সফল, ${a.fail} ব্যর্থ`);
      }
      case '/problems': {
        const p = g.problems();
        return this._say(chat, p.length ? p.map((x) => `• ${x.name} [${x.tier}] — ${x.status}: ${x.error}`).join('\n') : 'এখন কোনো সমস্যা নেই ✅');
      }
      default: if (!text.startsWith('/')) return this._ask(chat, text); return this._say(chat, 'বুঝিনি। /help দেখুন।');
    }
  }
  async _ask(chat, text) {
    await this._say(chat, '⏳ উত্তর আসছে...');
    try {
      const r = await this.gw.chat({ messages: [{ role: 'user', content: text }] }, { src: 'telegram' });
      return this._say(chat, `${r.text}\n\n— ${r.provider} · ${r.model} · ${r.latency} ms${r.fallbacks ? ` · ফলব্যাক ${r.fallbacks}` : ''}`);
    } catch (e) { return this._say(chat, '❌ উত্তর হয়নি: ' + e.message); }
  }
}
const HELP = ['কমান্ড:', '/mode free | premium | all — কোন মোডে উত্তর', '/models — মডেল তালিকা', '/use <model> — ডিফল্ট মডেল নাম', '/ask <প্রশ্ন> — প্রশ্ন করুন (বা /ask লিখে পরে প্রশ্ন)', '/image <বর্ণনা> — ছবি বানান', '/status — অবস্থা', '/problems — সমস্যাগুলো', 'যেকোনো সাধারণ লেখা = প্রশ্ন।'].join('\n');
module.exports = Telegram;
