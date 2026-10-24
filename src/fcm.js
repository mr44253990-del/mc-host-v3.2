'use strict';
// Firebase Cloud Messaging (HTTP v1): Google service account JSON দিয়ে নিজে JWT সাই করে access token নেয়,
// তারপর device token-এ নোটিফিকেশন পাঠায়। বাইরের SDK লাগে না।
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const EVENTS = { down: true, up: true, errorrate: true, allfail: true, budget: true };
const b64u = (s) => Buffer.from(s).toString('base64url');

class FCM {
  constructor(store) { this.store = store; this.tok = null; this.exp = 0; this.sent = new Map(); }
  cfg() { return (this.store.data.fcm ||= { sa: null, tokens: [], events: { ...EVENTS } }); }

  setServiceAccount(raw) {
    let j; try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('JSON ফাইল পড়া যায়নি'); }
    if (!j || j.type !== 'service_account' || !j.project_id || !j.client_email || !/BEGIN PRIVATE KEY/.test(j.private_key || '')) throw new Error('এটি Google/Firebase service account JSON নয় (type: service_account লাগবে)');
    this.cfg().sa = { project_id: String(j.project_id), client_email: String(j.client_email), private_key: String(j.private_key) };
    this.tok = null; this.store.save();
    return { projectId: j.project_id, email: j.client_email };
  }
  clearServiceAccount() { this.cfg().sa = null; this.tok = null; this.store.save(); }
  addToken(token, name) {
    const t = String(token || '').trim();
    if (!/^[A-Za-z0-9_:\-]{100,400}$/.test(t)) throw new Error('FCM device token সঠিক নয় (অক্ষর, _ : - ব্যবহার হয়)');
    const c = this.cfg();
    if (c.tokens.some((x) => x.token === t)) throw new Error('এই token আগেই যোগ করা আছে');
    if (c.tokens.length >= 20) throw new Error('সর্বোচ্চ ২০টি device');
    c.tokens.push({ id: crypto.randomBytes(4).toString('hex'), token: t, name: String(name || 'Device').trim().slice(0, 40) || 'Device', addedAt: Date.now() });
    this.store.save();
  }
  removeToken(id) { const c = this.cfg(); c.tokens = c.tokens.filter((x) => x.id !== id); this.store.save(); }

  // JWT (RS256) সাইন -> Google OAuth token
  async accessToken(fetchFn = fetch) {
    if (this.tok && Date.now() < this.exp - 60000) return this.tok;
    const sa = this.cfg().sa; if (!sa) throw new Error('service account JSON আপলোড করুন');
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key, 'base64url');
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Google auth ব্যর্থ: ' + (j.error_description || j.error || r.status));
    this.tok = j.access_token; this.exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.tok;
  }

  // একটি বার্তা সব device-এ। key দিলে ৫ মিনিটের মধ্যে একই বার্তা আর যায় না (ঝড় ঠেকাতে)।
  async send(title, body, { key, data = {}, force = false, fetchFn = fetch } = {}) {
    const c = this.cfg();
    if (!c.sa || !c.tokens.length) return { sent: 0, failed: 0, skipped: 'not-configured' };
    if (key && !force) { const last = this.sent.get(key) || 0; if (Date.now() - last < 5 * 60000) return { sent: 0, failed: 0, skipped: 'throttled' }; this.sent.set(key, Date.now()); }
    const access = await this.accessToken(fetchFn);
    const url = `https://fcm.googleapis.com/v1/projects/${c.sa.project_id}/messages:send`;
    const T = String(title).slice(0, 120), B = String(body).slice(0, 400);
    let sent = 0, failed = 0; const dead = [];
    for (const d of c.tokens) {
      const msg = { message: { token: d.token, notification: { title: T, body: B }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'high', notification: { sound: 'default' } }, webpush: { notification: { title: T, body: B, icon: '/icon.svg' } } } };
      const r = await fetchFn(url, { method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(20000) });
      if (r.ok) sent++;
      else {
        failed++;
        const j = await r.json().catch(() => ({}));
        const code = JSON.stringify(j.error || {});
        if (/UNREGISTERED|NOT_FOUND/.test(code)) dead.push(d.id); // অ্যাপ আনইনস্টল হলে token সরানো
      }
    }
    if (dead.length) { c.tokens = c.tokens.filter((x) => !dead.includes(x.id)); this.store.save(); }
    return { sent, failed, removed: dead.length };
  }
  async notify(event, title, body, key, fetchFn) {
    const c = this.cfg();
    if (c.events && c.events[event] === false) return { skipped: 'event-off' };
    return this.send(title, body, { key: key || event + ':' + title, data: { type: event }, fetchFn }).catch((e) => ({ error: e.message }));
  }
  setEvents(ev) { const c = this.cfg(); c.events = { ...EVENTS, ...(c.events || {}) }; for (const k of Object.keys(EVENTS)) if (typeof ev[k] === 'boolean') c.events[k] = ev[k]; this.store.save(); }
  status() {
    const c = this.cfg();
    return { configured: !!c.sa, projectId: c.sa ? c.sa.project_id : '', clientEmail: c.sa ? c.sa.client_email : '', tokens: c.tokens.map((t) => ({ id: t.id, name: t.name, masked: t.token.slice(0, 10) + '…' + t.token.slice(-6), addedAt: t.addedAt })), events: { ...EVENTS, ...(c.events || {}) } };
  }
}
module.exports = FCM;
