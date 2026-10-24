'use strict';
module.exports = [
  {
    key: 'hello', name: 'Hello World', desc: 'সবচেয়ে সহজ Worker',
    code: `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return new Response('Hello from MC Host Worker!\\nPath: ' + url.pathname + '\\nMethod: ' + request.method, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
`,
  },
  {
    key: 'json-api', name: 'JSON API', desc: 'রাউটিং, JSON, ENV ব্যবহার',
    code: `// ENV: GREETING (ঐচ্ছিক)
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (url.pathname === '/') return json({ ok: true, message: env.GREETING || 'Hello', time: new Date().toISOString() });
    if (url.pathname === '/echo') {
      const body = request.method === 'POST' ? await request.text() : null;
      return json({ method: request.method, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers), body });
    }
    return json({ ok: false, error: 'Not found' }, 404);
  },
};
`,
  },
  {
    key: 'kv-counter', name: 'KV ভিজিটর কাউন্টার', desc: 'env.KV দিয়ে স্থায়ী ডাটা, scheduled উদাহরণসহ',
    code: `export default {
  async fetch(request, env) {
    const n = Number((await env.KV.get('visits')) || 0) + 1;
    await env.KV.put('visits', String(n));
    return new Response('ভিজিট নম্বর: ' + n, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  // সেটিংসে Cron মিনিট দিলে এটি নির্দিষ্ট সময় পরপর চলে
  async scheduled(event, env) {
    console.log('scheduled চলেছে, ভিজিট =', await env.KV.get('visits'));
  },
};
`,
  },
  {
    key: 'proxy', name: 'রিভার্স প্রক্সি (CORS)', desc: 'ENV: TARGET_URL এ ফরওয়ার্ড করে CORS যোগ করে',
    code: `// ENV: TARGET_URL = https://api.example.com
export default {
  async fetch(request, env) {
    if (!env.TARGET_URL) return new Response('TARGET_URL ENV সেট করুন', { status: 500 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const u = new URL(request.url);
    const target = new URL(u.pathname + u.search, env.TARGET_URL);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstream = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
    const out = new Response(upstream.body, upstream);
    out.headers.set('access-control-allow-origin', '*');
    return out;
  },
};
`,
  },

  {
    key: 'multi-api', name: 'মাল্টি-ফাইল API (router + utils)', desc: 'একাধিক ফাইল, import, ENV ও KV একসাথে',
    files: [
      { path: 'worker.js', content: `import { route } from './lib/router.js';
import { json } from './lib/utils.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('ত্রুটি:', e.message);
      return json({ ok: false, error: 'internal error' }, 500);
    }
  },
};
` },
      { path: 'lib/router.js', content: `import { json, cors } from './utils.js';

export async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  switch (url.pathname) {
    case '/':
      return json({ ok: true, name: 'multi-file worker', routes: ['/hello?name=', '/env', '/count'] });
    case '/hello':
      return json({ message: 'Hello ' + (url.searchParams.get('name') || env.DEFAULT_NAME || 'world') });
    case '/env': // শুধু নাম দেখায়, ভ্যালু নয়
      return json({ keys: Object.keys(env).filter((k) => k !== 'KV' && k !== 'ASSETS') });
    case '/count': {
      const n = Number((await env.KV.get('count')) || 0) + 1;
      await env.KV.put('count', String(n));
      return json({ count: n });
    }
    default:
      return json({ ok: false, error: 'Not found' }, 404);
  }
}
` },
      { path: 'lib/utils.js', content: `export const cors = (res) => { res.headers.set('access-control-allow-origin', '*'); res.headers.set('access-control-allow-headers', '*'); return res; };

export const json = (data, status = 200) => cors(new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
}));
` },
    ],
  },
  {
    key: 'static-site', name: 'স্ট্যাটিক সাইট + API (ASSETS)', desc: 'public/ ফোল্ডারের HTML/CSS/JS সার্ভ করে, সাথে /api/time',
    files: [
      { path: 'worker.js', content: `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/time') {
      return new Response(JSON.stringify({ time: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
    }
    const res = await env.ASSETS.fetch(request);       // public/ ফোল্ডার থেকে
    if (res.status === 404 && !url.pathname.includes('.')) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url))); // SPA fallback
    }
    return res;
  },
};
` },
      { path: 'public/index.html', content: `<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>আমার সাইট</title><link rel="stylesheet" href="style.css"></head>
<body><main><h1>স্বাগতম</h1><p id="t">লোড হচ্ছে...</p></main><script src="app.js"></script></body></html>
` },
      { path: 'public/style.css', content: `body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b1020;color:#eef}
main{padding:32px 40px;border-radius:20px;background:rgba(255,255,255,.07);backdrop-filter:blur(12px);text-align:center}
` },
      { path: 'public/app.js', content: `fetch('api/time').then((r) => r.json()).then((d) => { document.getElementById('t').textContent = 'সার্ভারের সময়: ' + d.time; });
` },
    ],
  },

  {
    key: 'sqlite-notes', name: 'SQLite নোট অ্যাপ (env.DB)', desc: 'স্থায়ী ডাটাবেস: যোগ, দেখা, মোছা (D1-এর মতো API)',
    code: `// env.DB = বিল্ট-ইন SQLite (Node 22.5+)। ডাটা ডিস্কে স্থায়ী থাকে।
const json = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function init(env) {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created INTEGER NOT NULL)');
}

export default {
  async fetch(request, env) {
    await init(env);
    const url = new URL(request.url);
    if (url.pathname === '/notes' && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, text, created FROM notes ORDER BY id DESC LIMIT 50').all();
      return json(rows.results);
    }
    if (url.pathname === '/notes' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.text) return json({ ok: false, error: 'text দিন' }, 400);
      const r = await env.DB.prepare('INSERT INTO notes (text, created) VALUES (?, ?)').bind(String(body.text).slice(0, 500), Date.now()).run();
      return json({ ok: true, id: r.meta.last_row_id }, 201);
    }
    const m = url.pathname.match(/^\\/notes\\/(\\d+)$/);
    if (m && request.method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(Number(m[1])).run();
      return json({ ok: r.meta.changes > 0 });
    }
    return json({ ok: true, routes: ['GET /notes', 'POST /notes {"text":"..."}', 'DELETE /notes/:id'] });
  },
};
`,
  },
];
