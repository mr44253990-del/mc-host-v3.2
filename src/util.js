'use strict';
const crypto = require('crypto');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const genId = () => crypto.randomBytes(4).toString('hex');
function fmtDur(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d) return `${d}দিন ${h}ঘ`; if (h) return `${h}ঘ ${m}মি`; if (m) return `${m}মি ${s}সে`; return `${s}সে`;
}
module.exports = { esc, genId, fmtDur };
