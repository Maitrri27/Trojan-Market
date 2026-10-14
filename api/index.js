/* Vercel serverless entry. vercel.json rewrites every /api/* request here and
   passes the original path as `__path`; static files in public/ are served by
   Vercel directly and never reach this function. */
const app = require('../server/app');

/** Restore the original /api/... URL when the platform hands over the rewrite target. */
function originalUrl(raw) {
  const url = new URL(raw || '/', 'http://localhost');
  const rewritten = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  const isTarget = url.pathname === '/api/index' || !url.pathname.startsWith('/api/');
  const pathname = isTarget ? '/api/' + String(rewritten || '').replace(/^\/+/, '') : url.pathname;
  const query = url.searchParams.toString();
  return pathname + (query ? '?' + query : '');
}

module.exports = async function handler(req, res) {
  req.url = originalUrl(req.url);
  await app.ready;
  return app.handleServerless(req, res);
};

module.exports.originalUrl = originalUrl;
