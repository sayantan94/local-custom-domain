'use strict';
// Passing a request for a domain name on to the service behind it.
const net = require('net');
const http = require('http');
const { esc } = require('./config');
const { errorPage, send } = require('./respond');

// "Shop.Test:80" -> "shop.test", "[::1]:80" -> "[::1]"
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

// Exact match first, then parent domains: api.shop.test reaches shop.test.
function findDomain(host, routes) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (routes[candidate]) return candidate;
  }
  return null;
}

// Connect to 127.0.0.1 first; fall back to ::1 for services that only listen on IPv6.
function loopbackLookup(_hostname, options, callback) {
  const all = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  if (options.all) return callback(null, all);
  callback(null, all[0].address, all[0].family);
}

function isAnswering(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: 'localhost', port, lookup: loopbackLookup });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(300, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// Services often refuse hosts they don't know (DNS-rebinding guards, dev-server allow
// lists). So the service is addressed exactly as if opened directly: Host becomes
// "127.0.0.1:<port>", and a same-origin Origin header is translated to match. Cross-origin
// Origins pass through untouched, so the service's own CSRF checks still mean what they
// say. The public name stays available in X-Forwarded-Host.
const schemeOf = (req) => (req.socket.encrypted ? 'https' : 'http');

function upstreamHeader(key, value, req, port) {
  const k = key.toLowerCase();
  if (k === 'host') return `127.0.0.1:${port}`;
  if (k === 'origin' && value === `${schemeOf(req)}://${req.headers.host}`) return `http://127.0.0.1:${port}`;
  return value;
}

// ...and redirects the service issues to its own address come back under the domain name.
function publicLocation(location, req, port) {
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(?=\/|$)/.exec(location);
  return m && Number(m[2]) === port ? `${schemeOf(req)}://${req.headers.host}${location.slice(m[0].length)}` : location;
}

function proxyRequest(req, res, domain, port) {
  const upstream = http.request(
    {
      host: 'localhost',
      lookup: loopbackLookup,
      port,
      method: req.method,
      path: req.url,
      headers: {
        ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, upstreamHeader(k, v, req, port)])),
        'x-forwarded-host': req.headers.host,
        'x-forwarded-proto': schemeOf(req),
        'x-forwarded-for': '127.0.0.1',
      },
    },
    (upRes) => {
      const raw = [...upRes.rawHeaders];
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i].toLowerCase() === 'location') raw[i + 1] = publicLocation(raw[i + 1], req, port);
      }
      res.writeHead(upRes.statusCode, upRes.statusMessage, raw);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    send(res, 502, errorPage(`${domain} is not answering`, `Nothing responded on <code>127.0.0.1:${port}</code> (${esc(err.code || err.message)}). Start the service, then reload.`));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

module.exports = { schemeOf, hostnameOf, findDomain, loopbackLookup, isAnswering, upstreamHeader, publicLocation, proxyRequest };
