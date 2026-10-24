'use strict';
// Google Drive ব্যাকআপ: OAuth (drive.file স্কোপ, শুধু এই অ্যাপের ফাইল), একটি নির্দিষ্ট ফোল্ডারে ব্যাকআপ
const crypto = require('crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'MC Host Backups';
const STATE_TTL = 15 * 60000;

class GDrive {
  constructor(store) { this.store = store; this.states = new Map(); this.access = null; this.accessExp = 0; this.busy = false; }

  cfg() {
    return (this.store.data.gdrive ||= { clientId: '', clientSecret: '', refresh: '', folderId: '', autoHours: 0, keep: 14, lastBackup: 0, lastSize: 0, lastError: '' });
  }
  connected() { const c = this.cfg(); return !!(c.clientId && c.clientSecret && c.refresh); }
  redirectUri(origin) { return String(origin).replace(/\/$/, '') + '/api/gdrive/callback'; }

  // ১) ক্লায়েন্ট তথ্য সেভ + লগইন লিংক
  setup(origin, clientId, clientSecret) {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Client ID সঠিক নয় (xxxx.apps.googleusercontent.com হওয়া উচিত)');
    if (clientSecret.length < 10) throw new Error('Client Secret দিন');
    const c = this.cfg();
    Object.assign(c, { clientId, clientSecret, refresh: '', folderId: '', lastError: '' });
    this.access = null; this.store.save();
    const state = crypto.randomBytes(16).toString('hex');
    this.states.set(state, Date.now());
    for (const [k, t] of this.states) if (Date.now() - t > STATE_TTL) this.states.delete(k);
    const authUrl = AUTH + '?' + new URLSearchParams({ client_id: clientId, redirect_uri: this.redirectUri(origin), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state }).toString();
    return { authUrl, redirectUri: this.redirectUri(origin) };
  }

  // ২) Google থেকে ফেরত আসা কোড বিনিময় করে refresh token সংরক্ষণ
  async callback(origin, code, state) {
    const t = this.states.get(state); this.states.delete(state);
    if (!t || Date.now() - t > STATE_TTL) throw new Error('লগইন লিংকের মেয়াদ শেষ, আবার সেটআপ করুন');
    const c = this.cfg();
    const r = await this._post(TOKEN, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: this.redirectUri(origin), grant_type: 'authorization_code' });
    if (!r.refresh_token) throw new Error('Refresh token আসেনি। Google-এর অ্যাপ অনুমতি বাতিল করে আবার চেষ্টা করুন');
    c.refresh = r.refresh_token; c.lastError = '';
    this.access = r.access_token; this.accessExp = Date.now() + (r.expires_in - 60) * 1000;
    this.store.save();
    await this.ensureFolder();
  }

  async _post(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Google: ' + (j.error_description || j.error || r.status));
    return j;
  }
  async token() {
    if (this.access && Date.now() < this.accessExp) return this.access;
    const c = this.cfg(); if (!c.refresh) throw new Error('Google Drive সংযুক্ত নেই');
    const r = await this._post(TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refresh, grant_type: 'refresh_token' });
    this.access = r.access_token; this.accessExp = Date.now() + (r.expires_in - 60) * 1000;
    return this.access;
  }
  async api(method, url, { body, headers = {}, raw = false } = {}) {
    const t = await this.token();
    const r = await fetch(url, { method, headers: { authorization: 'Bearer ' + t, ...headers }, body, signal: AbortSignal.timeout(90000) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('Drive: ' + ((j.error && j.error.message) || r.status)); }
    if (raw) return Buffer.from(await r.arrayBuffer());
    if (r.status === 204) return null;
    return r.json();
  }

  // ৩) ফোল্ডার: আগে থাকলে সেটাই, না থাকলে তৈরি
  async ensureFolder(name = FOLDER, key = 'folderId') {
    const c = this.cfg(); if (c[key]) return c[key];
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await this.api('GET', `${DRIVE}/files?q=${q}&fields=files(id,name)&spaces=drive`);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const f = await this.api('POST', `${DRIVE}/files`, { body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }), headers: { 'content-type': 'application/json' } });
      id = f.id;
    }
    c[key] = id; this.store.save();
    return id;
  }

  async upload(name, buf, { folderName = FOLDER, key = 'folderId', mime = 'application/json' } = {}) {
    const folder = await this.ensureFolder(folderName, key);
    const b = 'mch' + crypto.randomBytes(10).toString('hex');
    const meta = JSON.stringify({ name, parents: [folder], mimeType: mime });
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`),
      buf, Buffer.from(`\r\n--${b}--`),
    ]);
    return this.api('POST', `${UP}/files?uploadType=multipart&fields=id,name,size,createdTime`, { body, headers: { 'content-type': `multipart/related; boundary=${b}`, 'content-length': String(body.length) } });
  }

  async list() {
    const folder = await this.ensureFolder();
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const j = await this.api('GET', `${DRIVE}/files?q=${q}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=100`);
    return j.files || [];
  }
  download(id) { return this.api('GET', `${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, { raw: true }); }
  async remove(id) { await this.api('DELETE', `${DRIVE}/files/${encodeURIComponent(id)}`); }

  // ৪) পুরনো ব্যাকআপ সরানো: শুধু সর্বশেষ N টি রাখে
  async prune() {
    const keep = Math.max(1, Number(this.cfg().keep) || 14);
    const files = await this.list();
    let n = 0;
    for (const f of files.slice(keep)) { await this.remove(f.id); n++; }
    return n;
  }

  // ৫) ব্যাকআপ (একসাথে একটি)
  async backupNow(makeData, origin) {
    if (!this.connected()) throw new Error('আগে Google Drive সংযুক্ত করুন');
    if (this.busy) throw new Error('একটি ব্যাকআপ চলছে, একটু অপেক্ষা করুন');
    this.busy = true;
    try {
      const data = makeData();
      const buf = Buffer.from(JSON.stringify(data));
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
      const f = await this.upload(`mc-host-${stamp}.json`, buf);
      const c = this.cfg(); c.lastBackup = Date.now(); c.lastSize = buf.length; c.lastError = '';
      this.store.save();
      let pruned = 0; try { pruned = await this.prune(); } catch { /* ছাঁটাই ব্যর্থ হলেও ব্যাকআপ টিকে আছে */ }
      return { id: f.id, name: f.name, size: buf.length, pruned };
    } catch (e) {
      const c = this.cfg(); c.lastError = e.message.slice(0, 200); this.store.save();
      throw e;
    } finally { this.busy = false; }
  }

  // রিপোর্ট ফাইল: আলাদা ফোল্ডার (MC Host Reports), ব্যাকআপ-ফোল্ডার ছোঁয় না
  async uploadReport(name, buf, mime) {
    if (!this.connected()) throw new Error('আগে Google Drive সংযুক্ত করুন');
    const f = await this.upload(name, buf, { folderName: 'MC Host Reports', key: 'reportFolderId', mime });
    return { id: f.id, name: f.name, size: buf.length };
  }

  async disconnect() {
    const c = this.cfg(); const old = c.refresh;
    Object.assign(c, { refresh: '', folderId: '', clientSecret: '', lastError: '' });
    this.access = null; this.store.save();
    if (old) { try { await this._post(REVOKE, { token: old }); } catch { /* আগেই বাতিল হয়ে থাকতে পারে */ } }
  }

  status(origin) {
    const c = this.cfg();
    return { connected: this.connected(), clientId: c.clientId ? c.clientId.slice(0, 14) + '…' : '', redirectUri: origin ? this.redirectUri(origin) : '', autoHours: c.autoHours || 0, keep: c.keep || 14, lastBackup: c.lastBackup || 0, lastSize: c.lastSize || 0, lastError: c.lastError || '', busy: this.busy };
  }
}

module.exports = GDrive;
