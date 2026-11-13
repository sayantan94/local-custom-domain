'use strict';
// The proxy server: http on port 80, and https on port 443 once it is set up.
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { CMD, PROXY_PORT, HTTPS_PORT, ADMIN_HOSTS, ROOT } = require('./config');
const { httpsOn, certFor, secureContextFor } = require('./https');
const { loadRoutes } = require('./store');
const { usesHttps } = require('./domains');
const { isLoopback } = require('./hosts');
const { errorPage, send, sendJson } = require('./respond');
const { hostnameOf, findDomain, loopbackLookup, upstreamHeader, proxyRequest } = require('./proxy');
const { handleConsole } = require('./console-api');

function serve() {
  const consoleFile = path.join(ROOT, 'console.html');

  const onRequest = (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return req.socket.destroy();
    const host = hostnameOf(req.headers.host);
    if (ADMIN_HOSTS.has(host)) {
      return handleConsole(req, res, consoleFile).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'something went wrong; see the proxy log' });
      });
    }
    const routes = loadRoutes();
    const domain = findDomain(host, routes);
    if (!domain) return send(res, 404, errorPage(`${host} is not set up`, 'No domain name with this address exists yet.'));

    // With https set up, a browser opening the http address is sent to the https one.
    // Only page navigations are redirected: programs calling http:// keep working as before.
    const navigating = req.headers['upgrade-insecure-requests'] === '1' || req.headers['sec-fetch-mode'] === 'navigate';
    if (!req.socket.encrypted && navigating && usesHttps(domain)) {
      const location = `https://${host}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}${req.url}`;
      return send(res, 308, '', 'text/plain', { location });
    }
    proxyRequest(req, res, domain, routes[domain]);
  };

  // WebSockets (hot reload etc.): replay the handshake to the service and splice the sockets
  const onUpgrade = (req, socket, head) => {
    if (!isLoopback(socket.remoteAddress)) return socket.destroy();
    const routes = loadRoutes();
    const port = routes[findDomain(hostnameOf(req.headers.host), routes)];
    if (!port) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');

    const upstream = net.connect({ host: 'localhost', port, lookup: loopbackLookup }, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${upstreamHeader(req.rawHeaders[i], req.rawHeaders[i + 1], req, port)}\r\n`;
      }
      raw += `X-Forwarded-Host: ${req.headers.host}\r\n`;
      upstream.write(raw + '\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  };

  // "::" accepts IPv4 and IPv6. macOS only lets non-root processes use ports 80 and 443 on
  // the wildcard address, so we bind wide and drop every non-loopback connection instead.
  const listen = (server, port, label) => {
    server.on('request', onRequest);
    server.on('upgrade', onUpgrade);
    server.on('error', (err) => {
      console.error(
        err.code === 'EADDRINUSE'
          ? `${CMD}: port ${port} is already in use (is ${CMD} already running? try "${CMD} ls")`
          : `${CMD}: cannot listen on port ${port}: ${err.message}`,
      );
      process.exit(1);
    });
    server.listen(port, '::', () => console.log(`${CMD} proxy listening on port ${port} (${label}, local connections only)`));
  };

  listen(http.createServer(), PROXY_PORT, 'http');

  if (httpsOn()) {
    // Each domain gets its own certificate, chosen by the name the browser asks for.
    const SNICallback = (servername, done) => {
      try {
        const host = hostnameOf(servername);
        const name = ADMIN_HOSTS.has(host) ? 'localhost' : findDomain(host, loadRoutes());
        if (!name) return done(new Error(`no domain name ${servername}`));
        done(null, secureContextFor(name));
      } catch (err) {
        done(err);
      }
    };
    listen(https.createServer({ ...certFor('localhost'), SNICallback }), HTTPS_PORT, 'https');
  }
}

module.exports = { serve };
