/* Table-driven router. Modules export routes; nothing knows about each other. */
const http = require('./http');
const log = require('./log');

class Router {
  constructor() { this.routes = []; }

  /** pattern: '/api/listings' or /^\/api\/listings\/([\w-]+)$/ */
  add(method, pattern, handler, opts) {
    this.routes.push({ method: method, pattern: pattern, handler: handler, opts: opts || {} });
  }

  use(module) {
    (module.routes || []).forEach((r) => this.add(r.method, r.path, r.handler, r.opts));
    return this;
  }

  match(method, pathname) {
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      if (r.method !== method && r.method !== 'ALL') continue;
      if (typeof r.pattern === 'string') {
        if (r.pattern === pathname) return { route: r, params: [] };
      } else {
        const m = pathname.match(r.pattern);
        if (m) return { route: r, params: m.slice(1) };
      }
    }
    return null;
  }

  async handle(ctx) {
    const hit = this.match(ctx.method, ctx.pathname);
    if (!hit) return http.notFound(ctx.res, 'Unknown endpoint ' + ctx.method + ' ' + ctx.pathname);
    ctx.params = hit.params;
    const o = hit.route.opts;
    if (o.auth && !ctx.user) return http.unauthorized(ctx.res);
    if (o.admin && !(ctx.user && ctx.isAdmin)) return http.forbidden(ctx.res, 'Admin access required.');
    const done = log.timer('route ' + ctx.method + ' ' + (typeof hit.route.pattern === 'string' ? hit.route.pattern : String(hit.route.pattern)));
    try {
      await hit.route.handler(ctx);
    } finally { done(); }
  }
}

module.exports = Router;
