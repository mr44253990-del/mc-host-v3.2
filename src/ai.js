'use strict';
// Worker AI সহায়ক (Mistral). শুধু Worker-এর ফাইল, লগ, ত্রুটি ও ENV-এর নাম দেখে; ENV-এর মান কখনো পাঠানো হয় না।
const vm = require('vm');

const API = 'https://api.mistral.ai/v1';
const FALLBACK = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'codestral-latest', 'open-mistral-nemo'];
const SYSTEM = `You are "Worker Assistant", an expert in a Cloudflare-Workers-like runtime. Reply in the user's language (usually Bengali), concise.
Runtime: a Worker is a project folder. Entry (default worker.js) exports export default { async fetch(request, env, ctx) {...}, async scheduled(event, env, ctx) {...} }.
Files import each other with relative ESM paths including extension. Only Node built-ins and Web APIs are available (no npm install).
env has the user's variables (env.KEY), env.KV (persistent key-value), env.DB (SQLite, D1-like), env.ASSETS (static files from public/), env.CACHE (in-memory cache with ttl), env.NOTIFY(message) (sends to NOTIFY_URL).
Never invent or print secret values; refer to variables by name only.
When changing files, output EACH changed or new file COMPLETELY in this format, one block per file:
\`\`\`file:path/relative/to/project.js
<full content>
\`\`\`
Explain briefly first (2-5 lines). Include only files that change. Pure questions get no file blocks.`;

const validate = (code) => { try { new vm.Script(code); return null; } catch (e) { return e.message; } };
const cleanHist = (arr) => arr.slice(-12).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));

class Ai {
  constructor(store, workers) { this.store = store; this.workers = workers; this.pending = new Map(); }
  key() { return this.store.setting('mistralKey') || process.env.MISTRAL_API_KEY || ''; }
  model() { return this.store.setting('mistralModel') || process.env.MISTRAL_MODEL || 'mistral-small-latest'; }
  ready() {
  return !!this.key() ||
    !!(
      this.gateway &&
      typeof this.gateway.hasProviders === "function" &&
      this.gateway.hasProviders()
    );
}

  async _fetch(p, opts = {}) {
    if (!this.ready()) throw new Error('Mistral API key সেট নেই। সেটিংসে দিন।');
    let r;
    try { r = await fetch(API + p, { ...opts, headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(opts.timeout || 60000) }); }
    catch (e) { throw new Error(e.name === 'TimeoutError' ? 'Mistral দেরি করছে, আবার চেষ্টা করুন' : 'Mistral-এ যাওয়া যায়নি: ' + e.message); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (r.status === 401) throw new Error('API key ভুল বা বাতিল'); if (r.status === 429) throw new Error('Mistral রেট লিমিট, একটু পরে চেষ্টা করুন'); throw new Error(`Mistral ত্রুটি ${r.status}`); }
    return j;
  }
  async models() {
    try { const j = await this._fetch('/models', { timeout: 15000 }); const list = [...new Set((j.data || []).filter((m) => !m.capabilities || m.capabilities.completion_chat).map((m) => m.id))].sort(); return list.length ? list : FALLBACK; }
    catch (e) { if (!this.ready()) throw e; return FALLBACK; }
  }
  async complete(messages, { temperature = 0.3, max_tokens = 3000 } = {}) {
    if (this.gateway && this.gateway.hasProviders()) return (await this.gateway.chat(messages, { max_tokens, temperature, src: 'worker-ai' })).text;
    const j = await this._fetch('/chat/completions', { method: 'POST', body: JSON.stringify({ model: this.model(), messages, temperature, max_tokens }) });
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  context(w) {
    const files = this.workers.listFiles(w.id); const entry = this.workers.entryOf(w); const v = this.workers.view(w);
    const err = this.workers.recent(w.id).filter((r) => r.status >= 500).slice(0, 5).map((r) => `${r.method} ${r.path} -> ${r.status} ${r.err || ''}`).join('\n');
    let budget = 14000; const parts = [];
    for (const f of [...files].sort((a, b) => (b.path === entry) - (a.path === entry) || a.size - b.size)) {
      if (budget <= 0) { parts.push(`--- ${f.path} (বাদ: কনটেক্সট সীমা)`); continue; }
      let r; try { r = this.workers.readFile(w.id, f.path); } catch { continue; }
      if (!r.text) { parts.push(`--- ${f.path} (বাইনারি/বড়)`); continue; }
      const t = r.text.slice(0, Math.min(budget, 6000)); budget -= t.length;
      parts.push(`--- ${f.path}\n${t}`);
    }
    const notes = this.store.mem('w:' + w.id).notes.map((n) => '- ' + n).join('\n');
    return [
      `Worker: ${w.name} | slug=${w.slug} | entry=${entry} | state=${v.state} | files=${files.length} | memory=${w.memoryMb || 64}MB`,
      `ENV names: ${(w.env || []).map((e) => e.key + (e.secret ? '(secret)' : '')).join(', ') || '(none)'}`,
      v.error ? `Current error: ${v.error.slice(0, 400)}` : 'Current error: none',
      `Recent 5xx:\n${err || '(none)'}`, `Recent logs:\n${this.workers.logs(w.id).slice(-20).join('\n') || '(empty)'}`,
      `Memory notes:\n${notes || '(none)'}`, `Project files:\n${parts.join('\n')}`,
    ].join('\n');
  }
  static parseFiles(text) { const out = []; const re = /```file:([^\n`]+)\n([\s\S]*?)```/g; let m; while ((m = re.exec(String(text)))) out.push({ path: m[1].trim(), content: m[2].replace(/\n$/, '') }); return out; }
  store_mem(w) { return this.store.mem('w:' + w.id); }

  async chat(w, text, clientHistory) {
    const mem = this.store_mem(w); const local = Array.isArray(clientHistory);
    const messages = [{ role: 'system', content: SYSTEM + '\n\n' + this.context(w) }, ...(local ? cleanHist(clientHistory).slice(-10) : mem.chat.slice(-10)), { role: 'user', content: String(text).slice(0, 4000) }];
    const reply = await this.complete(messages, { max_tokens: 6000 });
    const blocks = Ai.parseFiles(reply);
    const existing = new Set(this.workers.listFiles(w.id).map((f) => f.path));
    const changes = [];
    for (const b of blocks.slice(0, 20)) {
      let p; try { p = this.workers.safeRel(b.path); } catch (e) { changes.push({ path: b.path, content: '', error: e.message, isNew: true }); continue; }
      const syn = this.workers.syntaxCheck(p, b.content);
      changes.push({ path: p, content: b.content, isNew: !existing.has(p), error: syn, size: Buffer.byteLength(b.content) });
    }
    const shown = reply.replace(/```file:([^\n`]+)\n[\s\S]*?```/g, (_, p) => `[ফাইল: ${p.trim()}]`);
    if (!local) { mem.chat.push({ role: 'user', content: String(text).slice(0, 1500) }, { role: 'assistant', content: shown.slice(0, 1500) }); if (mem.chat.length > 30) mem.chat.splice(0, mem.chat.length - 20); this.store.save(); }
    const good = changes.filter((c) => !c.error);
    if (good.length) this.pending.set(w.id, good); else this.pending.delete(w.id);
    return { reply: shown, changes };
  }
  takePending(id) { const c = this.pending.get(id); this.pending.delete(id); return c || []; }
  async review(w) {
    const files = this.workers.listFiles(w.id).filter((f) => /\.(m?js|cjs|json)$/.test(f.path) && f.size < 60000).slice(0, 8);
    const code = files.map((f) => `--- ${f.path}\n${this.workers.readFile(w.id, f.path).text || ''}`).join('\n').slice(0, 14000);
    return this.complete([
      { role: 'system', content: 'Review this Worker code (Node/Web APIs). Reply in the user language, max 8 short lines: security (secrets in code, injection, open proxy), bugs, performance, then "রায়: ঠিক আছে" or "রায়: ঝুঁকি আছে".' },
      { role: 'user', content: code || '(কোনো JS ফাইল নেই)' },
    ], { max_tokens: 700 });
  }
}
Ai.validate = validate;
Ai.cleanHist = cleanHist;
Ai.FALLBACK = FALLBACK;
module.exports = Ai;
