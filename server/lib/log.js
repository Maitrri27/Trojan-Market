/* Structured logging + latency observability. No PII, no tokens. */
const counters = {};
const timings = {};

function bump(name, n) { counters[name] = (counters[name] || 0) + (n === undefined ? 1 : n); }

function observe(name, ms) {
  const t = timings[name] || (timings[name] = { n: 0, total: 0, max: 0, samples: [] });
  t.n++; t.total += ms; t.max = Math.max(t.max, ms);
  t.samples.push(ms);
  if (t.samples.length > 500) t.samples.shift();
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function timer(name) {
  const t0 = Date.now();
  return () => { const ms = Date.now() - t0; observe(name, ms); return ms; };
}

function info(scope, msg, extra) {
  console.log('[' + scope + '] ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
}

function warn(scope, msg, extra) {
  bump('warn.' + scope);
  console.warn('[' + scope + '] WARN ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
}

function error(scope, msg, err) {
  bump('error.' + scope);
  console.error('[' + scope + '] ERROR ' + msg + (err ? ' ' + (err.stack || err.message || err) : ''));
}

function snapshot() {
  const out = { counters: Object.assign({}, counters), latency: {} };
  Object.keys(timings).forEach((k) => {
    const t = timings[k];
    out.latency[k] = { count: t.n, avg_ms: Math.round(t.total / t.n), p50_ms: pct(t.samples, 50), p95_ms: pct(t.samples, 95), max_ms: t.max };
  });
  return out;
}

module.exports = { bump, observe, timer, info, warn, error, snapshot };
