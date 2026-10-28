'use strict';
// নোটিফিকেশন কেন্দ্র: ঘটনা -> FCM ও Telegram। কোন ঘটনা যাবে তা বাছা যায়; লগে প্রতিটির ফলাফল ও ত্রুটি থাকে।
const EVENTS = {
  provider_error: { label: 'Provider ত্রুটি / রেট লিমিট / সময় শেষ', def: true },
  nocredit: { label: 'ক্রেডিট বা কোটা শেষ', def: true },
  invalid_key: { label: 'API key ভুল বা বাতিল', def: true },
  empty: { label: 'মডেল খালি উত্তর দিয়েছে', def: true },
  model_missing: { label: 'মডেল পাওয়া যায়নি', def: true },
  allfail: { label: 'সব provider ব্যর্থ', def: true },
  stream_cut: { label: 'স্ট্রিম মাঝপথে কেটে গেছে', def: true },
  slow: { label: 'অনেক ধীর উত্তর', def: false },
  recovered: { label: 'Provider আবার সক্রিয়', def: true },
  down: { label: 'Worker বন্ধ বা ত্রুটি', def: true },
  up: { label: 'Worker আবার চালু', def: true },
  errorrate: { label: 'Worker-এ ত্রুটির হার বেশি', def: true },
  test: { label: 'টেস্ট', def: true },
};

class Notifier {
  constructor(store, fcm) { this.store = store; this.fcm = fcm; this.tg = null; this.sent = new Map(); }
  cfg() { const c = (this.store.data.notify ||= { events: {}, channels: { fcm: true, tg: true }, log: [] }); c.channels ||= { fcm: true, tg: true }; c.events ||= {}; c.log ||= []; return c; }
  isOn(type) { const v = this.cfg().events[type]; return v === undefined ? !(EVENTS[type] && EVENTS[type].def === false) : !!v; }
  setEvents(ev) { const c = this.cfg(); for (const k of Object.keys(EVENTS)) if (typeof (ev || {})[k] === 'boolean') c.events[k] = ev[k]; this.store.save(); }
  setChannels(ch) { const c = this.cfg(); for (const k of ['fcm', 'tg']) if (typeof (ch || {})[k] === 'boolean') c.channels[k] = ch[k]; this.store.save(); }
  async send(type, title, body, key, { force = false } = {}) {
    if (!force && !this.isOn(type)) return { skipped: 'event-off' };
    if (!force) { const k = key || type + ':' + title; const last = this.sent.get(k) || 0; if (Date.now() - last < 5 * 60000) return { skipped: 'throttled' }; this.sent.set(k, Date.now()); if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value); }
    const c = this.cfg(); const entry = { t: Date.now(), type, title: String(title).slice(0, 140), body: String(body).slice(0, 300) };
    if (c.channels.fcm && this.fcm && this.fcm.cfg().sa) entry.fcm = await this.fcm.send(entry.title, entry.body, { data: { type } }).catch((e) => ({ sent: 0, failed: 1, results: [{ ok: false, error: e.message }] }));
    if (c.channels.tg && this.tg && this.tg.canAlert()) entry.tg = await this.tg.alert(`🔔 ${entry.title}\n${entry.body}`).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
    c.log.unshift(entry); if (c.log.length > 60) c.log.length = 60;
    this.store.save();
    return entry;
  }
  status() { const c = this.cfg(); return { events: Object.fromEntries(Object.keys(EVENTS).map((k) => [k, this.isOn(k)])), labels: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label])), channels: c.channels, log: c.log.slice(0, 40) }; }
}
Notifier.EVENTS = EVENTS;
module.exports = Notifier;
