'use strict';
// অ্যাক্সেস কন্ট্রোল: ভূমিকা (admin/operator/viewer), পাসওয়ার্ড হ্যাশিং, API টোকেন
const crypto = require('crypto');

const ROLES = ['operator', 'viewer'];

// পাসওয়ার্ড: scrypt + র‍্যান্ডম salt, "salt:hash" ফরম্যাটে
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function verifyPw(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hex] = stored.split(':');
  const want = Buffer.from(hex, 'hex');
  const got = crypto.scryptSync(String(pw), salt, want.length);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => 'mcht_' + crypto.randomBytes(24).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// কাস্টম ডোমেইন: শুধু সাধারণ hostname, localhost/IP নয়
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const validDomain = (d) => DOMAIN_RE.test(String(d || '')) && !/^(localhost|.*\.local)$/.test(d);

module.exports = { ROLES, hashPw, verifyPw, sha256, newToken, safeEq, validDomain };
