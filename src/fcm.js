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

  hint(code, msg) {
    const s = `${code} ${msg}`;
    if (/SENDER_ID_MISMATCH/.test(s)) return 'এই device token অন্য Firebase প্রজেক্টের। যে প্রজেক্টের service account দিয়েছেন, অ্যাপটিও সেই প্রজেক্টে নিবন্ধিত হতে হবে।';
    if (/UNREGISTERED|NOT_FOUND/.test(s)) return 'token মেয়াদোত্তীর্ণ বা অ্যাপ আনইনস্টল করা। অ্যাপ থেকে নতুন token নিন।';
    if (/INVALID_ARGUMENT/.test(s)) return 'token বা বার্তার ফরম্যাট ভুল। পুরো token ঠিকমতো কপি করেছেন কিনা দেখুন।';
    if (/PERMISSION_DENIED|has not been used|disabled|API.*not.*enabled/i.test(s)) return 'Google Cloud-এ "Firebase Cloud Messaging API (V1)" চালু করুন এবং service account-এ "Firebase Cloud Messaging API Admin" ভূমিকা দিন।';
    if (/UNAUTHENTICATED|invalid_grant|Invalid JWT/i.test(s)) return 'service account JSON ভুল বা বাতিল। Firebase Console থেকে নতুন private key নামিয়ে আবার আপলোড করুন।';
    if (/QUOTA|UNAVAILABLE|INTERNAL/.test(s)) return 'Google সাময়িক সমস্যায়; একটু পরে আবার চেষ্টা করুন।';
    return '';
  }

  // একটি বার্তা সব device-এ; প্রতিটির ফলাফল ও কারণ ফেরত দেয় (এবং শেষ ফলাফল সংরক্ষণ করে)
  async send(title, body, { data = {}, fetchFn = fetch } = {}) {
    const c = this.cfg();
    if (!c.sa) return { sent: 0, failed: 0, skipped: 'not-configured', results: [] };
    if (!c.tokens.length) return { sent: 0, failed: 0, skipped: 'no-device', results: [] };
    let access;
    try { access = await this.accessToken(fetchFn); }
    catch (e) { const out = { sent: 0, failed: c.tokens.length, results: [{ name: '-', ok: false, code: 'AUTH', error: e.message, hint: this.hint('UNAUTHENTICATED', e.message) }] }; c.last = { t: Date.now(), ...out }; this.store.save(); return out; }
    const url = `https://fcm.googleapis.com/v1/projects/${c.sa.project_id}/messages:send`;
    const T = String(title).slice(0, 120), B = String(body).slice(0, 400);
    let sent = 0, failed = 0; const dead = []; const results = [];
    for (const d of c.tokens) {
      const msg = { message: { token: d.token, notification: { title: T, body: B }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'high', notification: { sound: 'default' } }, webpush: { notification: { title: T, body: B, icon: '/icon.svg' } } } };
      try {
        const r = await fetchFn(url, { method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(20000) });
        if (r.ok) { sent++; results.push({ name: d.name, ok: true }); continue; }
        failed++;
        const j = await r.json().catch(() => ({})); const err = j.error || {};
        const code = (err.details || []).map((x) => x.errorCode).filter(Boolean).join(',') || err.status || String(r.status);
        results.push({ name: d.name, ok: false, code, error: String(err.message || '').slice(0, 240), hint: this.hint(code, err.message || '') });
        if (/UNREGISTERED|NOT_FOUND/.test(code)) dead.push(d.id);
        if (r.status === 401) this.tok = null;
      } catch (e) { failed++; results.push({ name: d.name, ok: false, code: 'NETWORK', error: e.message, hint: 'ইন্টারনেট বা Google-এ সংযোগ হয়নি।' }); }
    }
    if (dead.length) c.tokens = c.tokens.filter((x) => !dead.includes(x.id));
    const out = { sent, failed, removed: dead.length, results };
    c.last = { t: Date.now(), ...out }; this.store.save();
    return out;
  }
  configured() { const c = this.cfg(); return !!(c.sa && c.tokens.length); }
  setEvents(ev) { const c = this.cfg(); c.events = { ...EVENTS, ...(c.events || {}) }; for (const k of Object.keys(EVENTS)) if (typeof ev[k] === 'boolean') c.events[k] = ev[k]; this.store.save(); }
  status() {
    const c = this.cfg();
    return { configured: !!c.sa, projectId: c.sa ? c.sa.project_id : '', clientEmail: c.sa ? c.sa.client_email : '', tokens: c.tokens.map((t) => ({ id: t.id, name: t.name, masked: t.token.slice(0, 10) + '…' + t.token.slice(-6), addedAt: t.addedAt })), last: c.last || null };
  }
}
module.exports = FCM;
