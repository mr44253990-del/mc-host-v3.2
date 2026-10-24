'use strict';
// একটি JSON ফাইল (অ্যাটমিক লেখা); শুধু Worker, সেটিং, টোকেন ও হুকের ডাটা
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

class Store {
  constructor() {
    this.dir = DIR; this.file = path.join(DIR, 'state.json');
    this.data = { workers: [], settings: {}, tokens: [], hooks: [] };
    this.dirty = false; this.mode = 'local';
  }
  init() {
    fs.mkdirSync(DIR, { recursive: true });
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* নতুন */ }
    for (const k of ['workers', 'tokens', 'hooks']) this.data[k] ||= [];
    this.data.settings ||= {};
    this.timer = setInterval(() => this.flush(), 2000); this.timer.unref();
    return Promise.resolve();
  }
  save() { this.dirty = true; }
  flush() {
    if (!this.dirty) return;
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); this.dirty = false; }
    catch (e) { console.error('[store]', e.message); }
  }
  flushAll() { this.flush(); }
  setting(k, d = '') { return this.data.settings[k] ?? d; }
  setSetting(k, v) { this.data.settings[k] = v; this.save(); }
  mem(key) { const m = (this.data.aiMem ||= {}); return (m[key] ||= { notes: [], chat: [] }); }
}
module.exports = new Store();
