'use strict';
// The saved list of domain names (routes.json).
const fs = require('fs');
const { HOME, ROUTES_FILE, LIST_FILE } = require('./config');

// routes.json maps each domain to its port. A domain kept on plain http while https is
// set up is stored as { "port": 3000, "http": true }.
let cache = { mtime: -1, routes: {}, httpOnly: new Set() };
function load() {
  let mtime;
  try {
    mtime = fs.statSync(ROUTES_FILE).mtimeMs;
  } catch {
    return { routes: {}, httpOnly: new Set() };
  }
  if (mtime !== cache.mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
      const routes = {};
      const httpOnly = new Set();
      for (const [name, value] of Object.entries(raw)) {
        // names saved by older versions had no dot: "home" means "home.localhost"
        const domain = name.includes('.') ? name : `${name}.localhost`;
        routes[domain] = typeof value === 'object' ? value.port : value;
        if (typeof value === 'object' && value.http) httpOnly.add(domain);
      }
      cache = { mtime, routes, httpOnly };
    } catch {
      // half-written or corrupt file: keep serving the last good copy
    }
  }
  return cache;
}

const loadRoutes = () => load().routes;
const loadHttpOnly = () => load().httpOnly;

// httpOnly defaults to the current choices, so callers that only change ports keep them.
function saveRoutes(routes, httpOnly = loadHttpOnly()) {
  fs.mkdirSync(HOME, { recursive: true });
  const out = {};
  for (const [domain, port] of Object.entries(routes)) out[domain] = httpOnly.has(domain) ? { port, http: true } : port;
  const tmp = `${ROUTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, ROUTES_FILE);
  // Written in place (not renamed) so the helper's file watch keeps firing.
  fs.writeFileSync(LIST_FILE, Object.keys(routes).sort().map((d) => d + '\n').join(''));
}

// Save one domain. scheme is "http", "https", or undefined to keep the current choice.
function saveDomain(domain, port, scheme) {
  const httpOnly = new Set(loadHttpOnly());
  if (scheme === 'http') httpOnly.add(domain);
  if (scheme === 'https') httpOnly.delete(domain);
  saveRoutes({ ...loadRoutes(), [domain]: port }, httpOnly);
}

module.exports = { loadRoutes, loadHttpOnly, saveRoutes, saveDomain };
