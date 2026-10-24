'use strict';
// Worker-এর স্মার্ট ইনসাইট: বাজেট, নীরবতা, স্পাইক, বারবার ত্রুটি, RAM সীমা, ঘুমন্ত Worker
const SEV = { bad: 0, warn: 1, info: 2, good: 3 };

function build({ workers, tzMin = 0 }) {
  const out = [];
  const add = (level, title, text, id) => out.push({ level, title, text, id: id || null });
  for (const w of workers.all()) {
    const v = workers.view(w); const a = workers.agg([w.id], tzMin); const lat = workers.latency(w.id);
    const hourAvg = a.d7.req / 168; const bu = w.budget || {};
    if (v.state === 'error') add('bad', `"${w.name}" ত্রুটিতে`, String(v.error || '').split('\n')[0].slice(0, 160), w.id);
    if (a.today.req >= 20 && a.today.err / a.today.req >= 0.05) add('warn', `"${w.name}": ত্রুটির হার ${(a.today.err / a.today.req * 100).toFixed(1)}%`, `আজ ${a.today.req} রিকোয়েস্টের ${a.today.err}টি 5xx।`, w.id);
    if (lat.n >= 20 && lat.p95 > 1000) add('warn', `"${w.name}" ধীর`, `p95 ${lat.p95}ms।`, w.id);
    if (bu.p95Ms && lat.n >= 20 && lat.p95 > bu.p95Ms) add('warn', `"${w.name}" বাজেট ছাড়িয়েছে (p95)`, `p95 ${lat.p95}ms, সীমা ${bu.p95Ms}ms।`, w.id);
    const errNow = a.today.req ? a.today.err / a.today.req * 100 : 0;
    if (bu.errPct && a.today.req >= 20 && errNow > bu.errPct) add('bad', `"${w.name}" ত্রুটির বাজেট ছাড়িয়েছে`, `আজ ${errNow.toFixed(1)}%, সীমা ${bu.errPct}%।`, w.id);
    if (typeof workers.recent === 'function') {
      const sig = {};
      for (const r of workers.recent(w.id)) if (r.status >= 500 && r.err) { const k = r.err.slice(0, 80); sig[k] = (sig[k] || 0) + 1; }
      const top = Object.entries(sig).sort((x, y) => y[1] - x[1])[0];
      if (top && top[1] >= 3) add('warn', `"${w.name}"-এ একই ত্রুটি বারবার`, `"${top[0]}" — ${top[1]} বার।`, w.id);
    }
    if (v.state === 'running' && hourAvg >= 2 && (a.hours || []).slice(-2).reduce((s, h) => s + h.req, 0) === 0) add('warn', `"${w.name}" হঠাৎ নীরব`, `গত ২ ঘণ্টায় কোনো রিকোয়েস্ট নেই; গড়ে ঘণ্টায় ${hourAvg.toFixed(1)}টি।`, w.id);
    const lastH = (a.hours || []).slice(-1)[0];
    if (lastH && lastH.req >= 20 && hourAvg > 0 && lastH.req > hourAvg * 5) add('info', `"${w.name}": অস্বাভাবিক স্পাইক`, `শেষ ঘণ্টায় ${lastH.req}টি, স্বাভাবিক গড় ${hourAvg.toFixed(1)}। বট/স্ক্যানার হতে পারে।`, w.id);
    if (v.ram && w.memoryMb && v.ram > w.memoryMb * 0.9) add('warn', `"${w.name}" RAM সীমার কাছে`, `${v.ram}MB ব্যবহার, সীমা ${w.memoryMb}MB। মেমরি লিক থাকতে পারে।`, w.id);
    if (v.state === 'sleeping') add('good', `"${w.name}" ঘুমিয়ে আছে`, 'কোনো রিকোয়েস্ট নেই, তাই RAM খরচ হচ্ছে না। প্রথম রিকোয়েস্টে জেগে উঠবে।', w.id);
    if (v.state === 'running' && a.d7.req === 0 && Date.now() - w.createdAt > 3 * 86400000) add('info', `"${w.name}" ৭ দিন ব্যবহার হয়নি`, 'দরকার না থাকলে বন্ধ করে RAM বাঁচান।', w.id);
  }
  const real = out.filter((x) => x.title).sort((a, b) => SEV[a.level] - SEV[b.level]);
  if (!real.some((x) => x.level === 'bad' || x.level === 'warn')) real.unshift({ level: 'good', title: 'সব ঠিক আছে', text: 'কোনো সমস্যা ধরা পড়েনি।', id: null });
  return real;
}
module.exports = { build };
