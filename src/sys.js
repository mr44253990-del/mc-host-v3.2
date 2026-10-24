'use strict';
// হোস্টের RAM/CPU ও প্রতিটি Worker প্রসেসের RAM (Linux /proc থেকে; অন্য OS-এ 0)
const os = require('os');
const fs = require('fs');

let last = Date.now(); const lags = [];
const t = setInterval(() => { const now = Date.now(); lags.push(Math.max(0, now - last - 1000)); if (lags.length > 10) lags.shift(); last = now; }, 1000);
t.unref();

function rssOf(pid) {
  if (!pid) return 0;
  try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/); return m ? Math.round(Number(m[1]) / 1024) : 0; }
  catch { return 0; }
}
function host() {
  const mu = process.memoryUsage();
  const total = Math.round(os.totalmem() / 1048576), free = Math.round(os.freemem() / 1048576);
  return {
    load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
    totalMem: total, freeMem: free, usedMem: total - free,
    panelRss: Math.round(mu.rss / 1048576), panelHeap: Math.round(mu.heapUsed / 1048576),
    lag: Math.max(0, ...lags), uptime: Math.round(process.uptime() * 1000), node: process.version, platform: process.platform,
  };
}
module.exports = { host, rssOf };
