'use strict';
// The console at http://localhost: its page and its JSON API.
const fs = require('fs');
const { CMD, PROXY_PORT, fail } = require('./config');
const { normalizeDomain, checkPort, warningFor, urlFor } = require('./domains');
const { loadRoutes, saveRoutes } = require('./store');
const { autoSetupOn, syncHosts, dnsState } = require('./hosts');
const { errorPage, send, sendJson } = require('./respond');
const { isAnswering, schemeOf } = require('./proxy');
const { httpsOn } = require('./https');

async function describeDomains(routes) {
  const domains = Object.keys(routes).sort();
  return Promise.all(
    domains.map(async (domain) => ({
      domain,
      port: routes[domain],
      url: urlFor(domain),
      dns: await dnsState(domain),
      answering: await isAnswering(routes[domain]),
      warning: warningFor(domain),
    })),
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(Object.assign(new Error('request too large'), { expected: true }));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { expected: true }));
      }
    });
    req.on('error', reject);
  });
}

function trySyncHosts() {
  try {
    syncHosts();
  } catch {
    // no admin rights from here; the console shows the command to run instead
  }
}

async function handleConsole(req, res, consoleFile) {
  const url = new URL(req.url, 'http://localhost');
  const routes = loadRoutes();

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/') return send(res, 200, fs.readFileSync(consoleFile));
    if (url.pathname === '/__lcd') return send(res, 200, CMD, 'text/plain');
    if (url.pathname === '/api/domains') {
      return sendJson(res, 200, { domains: await describeDomains(routes), command: CMD, proxyPort: PROXY_PORT, autoSetup: autoSetupOn(), https: httpsOn() });
    }
    return send(res, 404, errorPage('Page not found', 'There is nothing at this address.'));
  }

  // Changes must come from this console itself, never from another website open in the browser.
  if (req.headers.origin !== `${schemeOf(req)}://${req.headers.host}`) return sendJson(res, 403, { error: 'requests from other sites are refused' });

  try {
    if (req.method === 'POST' && url.pathname === '/api/domains') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) fail('send JSON');
      const body = await readJson(req);
      const domain = normalizeDomain(body.domain);
      const port = checkPort(body.port);
      if (body.create && routes[domain]) fail(`${domain} already exists`, 'domain');
      saveRoutes({ ...routes, [domain]: port });
      trySyncHosts();
      return sendJson(res, 200, { domain, port, warning: warningFor(domain) });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/domains/')) {
      const domain = decodeURIComponent(url.pathname.slice('/api/domains/'.length));
      if (!routes[domain]) return sendJson(res, 404, { error: `${domain} does not exist` });
      const next = { ...routes };
      delete next[domain];
      saveRoutes(next);
      trySyncHosts();
      return sendJson(res, 200, { domain });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err.expected) return sendJson(res, 400, { error: err.message, field: err.field });
    throw err;
  }
}

module.exports = { describeDomains, readJson, trySyncHosts, handleConsole };
