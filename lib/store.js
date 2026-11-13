'use strict';
// The saved list of domain names (routes.json).
const fs = require('fs');
const { HOME, ROUTES_FILE, LIST_FILE } = require('./config');

let cache = { mtime: -1, routes: {} };
function loadRoutes() {
  let mtime;
  try {
    mtime = fs.statSync(ROUTES_FILE).mtimeMs;
  } catch {
    return {};
  }
  if (mtime !== cache.mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
      const routes = {};
      // names saved by older versions had no dot: "home" means "home.localhost"
      for (const [name, port] of Object.entries(raw)) routes[name.includes('.') ? name : `${name}.localhost`] = port;
      cache = { mtime, routes };
    } catch {
      // half-written or corrupt file: keep serving the last good copy
    }
  }
  return cache.routes;
}

function saveRoutes(routes) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${ROUTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(routes, null, 2) + '\n');
  fs.renameSync(tmp, ROUTES_FILE);
  // Written in place (not renamed) so the helper's file watch keeps firing.
  fs.writeFileSync(LIST_FILE, Object.keys(routes).sort().map((d) => d + '\n').join(''));
}

module.exports = { loadRoutes, saveRoutes };
