#!/usr/bin/env node
'use strict';
// local-custom-domain: custom domain names for services on your own computer.
//   lcd add shop.test 3000   ->   http://shop.test reaches 127.0.0.1:3000
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const CMD = 'lcd';
const HOME = process.env.LCD_HOME || path.join(os.homedir(), '.local-custom-domain');
const ROUTES_FILE = path.join(HOME, 'routes.json');
const PROXY_PORT = Number(process.env.LCD_PORT || 80);
const HOSTS_FILE = process.env.LCD_HOSTS_FILE || '/etc/hosts';
const HOSTS_BEGIN = '# >>> local-custom-domain >>>';
const HOSTS_END = '# <<< local-custom-domain <<<';
const LABEL = 'com.local-custom-domain.proxy';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const FILES = ['cli.js', 'console.html']; // everything the background proxy needs
const ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Browsers refuse plain http:// on these endings (they are on the HSTS preload list).
const HTTPS_ONLY_TLDS = new Set(['dev', 'app', 'page', 'new', 'day', 'foo', 'zip', 'mov']);

// An error the user caused (bad input); shown without a stack trace.
function fail(message, field) {
  const err = new Error(message);
  err.expected = true;
  err.field = field; // which form field the message belongs to, for the console
  throw err;
}

// ---------- domains ----------

// "shop" -> "shop.localhost"; "Shop.Test" / "http://shop.test/x" -> "shop.test"
function normalizeDomain(input) {
  let d = String(input ?? '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  if (!d) fail('enter a domain name, for example shop.test', 'domain');
  if (ADMIN_HOSTS.has(d) || /^\d+(\.\d+){3}$/.test(d)) fail(`"${d}" is reserved; choose a name such as shop.test`, 'domain');
  if (!d.includes('.')) d += '.localhost';
  if (d.length > 253 || !d.split('.').every((label) => DNS_LABEL_RE.test(label))) {
    fail(`"${input}" is not a valid domain name (use letters, digits, dashes and dots, e.g. shop.test)`, 'domain');
  }
  return d;
}

function checkPort(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`"${input}" is not a valid port (1 to 65535)`, 'port');
  if (n === PROXY_PORT) fail(`port ${n} is used by ${CMD} itself`, 'port');
  return n;
}

function warningFor(domain) {
  const tld = domain.split('.').pop();
  if (HTTPS_ONLY_TLDS.has(tld)) return `Browsers only allow https:// on .${tld} names, so http://${domain} will not open. Use .test instead.`;
  if (tld === 'local') return 'macOS uses .local for network discovery, which makes these names slow to open. Use .test instead.';
  return null;
}

const usesBuiltInDns = (domain) => domain.endsWith('.localhost');
const urlFor = (domain) => `http://${domain}${PROXY_PORT === 80 ? '' : ':' + PROXY_PORT}`;

// ---------- store ----------

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
}

// ---------- name resolution (/etc/hosts) ----------

// Rewrites our block in the hosts file. Returns true if the file changed; throws EACCES without admin rights.
function syncHosts() {
  const domains = Object.keys(loadRoutes()).sort();
  const block = domains.length ? [HOSTS_BEGIN, ...domains.map((d) => `127.0.0.1 ${d}`), HOSTS_END].join('\n') + '\n' : '';
  const current = fs.readFileSync(HOSTS_FILE, 'utf8');
  const b = current.indexOf(HOSTS_BEGIN);
  const e = current.indexOf(HOSTS_END);
  const next =
    b !== -1 && e > b
      ? current.slice(0, b) + block + current.slice(e + HOSTS_END.length).replace(/^\n/, '')
      : current + (current.endsWith('\n') || !current ? '' : '\n') + block;
  if (next === current) return false;
  fs.writeFileSync(HOSTS_FILE, next);
  return true;
}

const isDenied = (err) => err.code === 'EACCES' || err.code === 'EPERM';

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// 'available'  every program on this computer resolves the name
// 'browser'    a .localhost name: browsers and curl resolve it themselves, other programs don't
// 'pending'    nothing resolves it yet; needs "sudo lcd hosts"
async function dnsState(domain) {
  const lookup = dns.promises.lookup(domain, { all: true }).catch(() => []);
  const timeout = new Promise((resolve) => setTimeout(resolve, 1000, []));
  const addresses = await Promise.race([lookup, timeout]);
  if (addresses.some((a) => isLoopback(a.address))) return 'available';
  return usesBuiltInDns(domain) ? 'browser' : 'pending';
}

// ---------- proxy ----------

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
function upstreamHeader(key, value, req, port) {
  const k = key.toLowerCase();
  if (k === 'host') return `127.0.0.1:${port}`;
  if (k === 'origin' && value === `http://${req.headers.host}`) return `http://127.0.0.1:${port}`;
  return value;
}

// ...and redirects the service issues to its own address come back under the domain name.
function publicLocation(location, req, port) {
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(?=\/|$)/.exec(location);
  return m && Number(m[2]) === port ? `http://${req.headers.host}${location.slice(m[0].length)}` : location;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function errorPage(title, detail) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.25rem;color:#0f141a;background:#fff}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#424650}a{color:#006ce0}code{background:#f3f3f7;padding:.1em .35em;border-radius:4px}
@media(prefers-color-scheme:dark){body{color:#dedee3;background:#161d26}p{color:#b4b4bb}a{color:#42b4ff}code{background:#232b37}}</style>
<h1>${esc(title)}</h1><p>${detail}</p><p><a href="${urlFor('localhost')}">Manage domain names</a></p></html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');

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
        'x-forwarded-proto': 'http',
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

// ---------- console (http://localhost) ----------

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
      return sendJson(res, 200, { domains: await describeDomains(routes), command: CMD, proxyPort: PROXY_PORT });
    }
    return send(res, 404, errorPage('Page not found', 'There is nothing at this address.'));
  }

  // Changes must come from this console itself, never from another website open in the browser.
  if (req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'requests from other sites are refused' });

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

// ---------- server ----------

function serve() {
  const consoleFile = path.join(__dirname, 'console.html');

  const server = http.createServer((req, res) => {
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
    proxyRequest(req, res, domain, routes[domain]);
  });

  // WebSockets (hot reload etc.): replay the handshake to the service and splice the sockets
  server.on('upgrade', (req, socket, head) => {
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
  });

  server.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `${CMD}: port ${PROXY_PORT} is already in use (is ${CMD} already running? try "${CMD} ls")`
        : `${CMD}: cannot listen on port ${PROXY_PORT}: ${err.message}`,
    );
    process.exit(1);
  });
  // "::" accepts IPv4 and IPv6. macOS only lets non-root processes use port 80 on the
  // wildcard address, so we bind wide and drop every non-loopback connection instead.
  server.listen(PROXY_PORT, '::', () => {
    console.log(`${CMD} proxy listening on port ${PROXY_PORT} (local connections only)`);
  });
}

// ---------- commands ----------

function proxyIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/__lcd', timeout: 500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body === CMD));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

async function noteIfProxyDown() {
  if (!(await proxyIsUp())) console.log(`note: the proxy is not running. Start it with "${CMD} install" (always on) or "${CMD} serve".`);
}

// Make the name resolve for every program. Needs admin rights, so ask for them when we can.
function ensureResolves(domain) {
  try {
    if (syncHosts()) console.log(`${HOSTS_FILE} updated`);
    return;
  } catch (err) {
    if (!isDenied(err)) throw err;
  }
  if (process.stdin.isTTY) {
    console.log(`Adding ${domain} to ${HOSTS_FILE} needs your password:`);
    const r = spawnSync('sudo', ['env', `LCD_HOME=${HOME}`, process.execPath, __filename, 'hosts'], { stdio: 'inherit' });
    if (r.status === 0) return;
  }
  console.log(`one more step, so this computer knows the name:  sudo ${CMD} hosts`);
}

async function cmdAdd(args) {
  if (args.length !== 2) fail(`usage: ${CMD} add <domain> <port>`);
  const domain = normalizeDomain(args[0]);
  const port = checkPort(args[1]);
  saveRoutes({ ...loadRoutes(), [domain]: port });
  console.log(`${urlFor(domain)}  ->  127.0.0.1:${port}`);
  const warning = warningFor(domain);
  if (warning) console.log(`warning: ${warning}`);
  if (!usesBuiltInDns(domain)) ensureResolves(domain);
  await noteIfProxyDown();
}

function cmdRm(args) {
  if (args.length !== 1) fail(`usage: ${CMD} rm <domain>`);
  const domain = normalizeDomain(args[0]);
  const routes = { ...loadRoutes() };
  if (!(domain in routes)) fail(`${domain} does not exist`);
  delete routes[domain];
  saveRoutes(routes);
  console.log(`removed ${domain}`);
  try {
    syncHosts();
  } catch (err) {
    if (!isDenied(err)) throw err;
    console.log(`to also clear it from ${HOSTS_FILE}:  sudo ${CMD} hosts`);
  }
}

async function cmdLs() {
  const list = await describeDomains(loadRoutes());
  if (!list.length) console.log(`no domain names yet. Try: ${CMD} add shop.test 3000`);
  const width = Math.max(0, ...list.map((d) => d.url.length));
  for (const d of list) {
    const notes = [d.answering ? null : 'not answering', d.dns === 'pending' ? `needs "sudo ${CMD} hosts"` : null].filter(Boolean);
    console.log(`${d.url.padEnd(width)}  ->  127.0.0.1:${d.port}${notes.length ? `   (${notes.join(', ')})` : ''}`);
  }
  const up = await proxyIsUp();
  console.log(`\nproxy: ${up ? `running, manage at ${urlFor('localhost')}` : `NOT running ("${CMD} install" or "${CMD} serve")`}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// lcd run <domain> [--port N] -- <command...>
async function cmdRun(args) {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) fail(`usage: ${CMD} run <domain> [--port N] -- <command...>`);
  const opts = args.slice(0, sep);
  const command = args.slice(sep + 1);
  const domain = normalizeDomain(opts[0]);
  const portFlag = opts.indexOf('--port');
  const port = portFlag === -1 ? await freePort() : checkPort(opts[portFlag + 1]);

  const before = loadRoutes()[domain];
  saveRoutes({ ...loadRoutes(), [domain]: port });
  console.log(`${urlFor(domain)}  ->  127.0.0.1:${port}`);
  if (!usesBuiltInDns(domain)) ensureResolves(domain);
  await noteIfProxyDown();

  // The service learns its port from $PORT, or from "{port}" anywhere in the command.
  const [bin, ...rest] = command.map((a) => a.replaceAll('{port}', String(port)));
  const child = spawn(bin, rest, { stdio: 'inherit', env: { ...process.env, PORT: String(port) } });

  const restore = () => {
    const routes = { ...loadRoutes() };
    if (routes[domain] !== port) return; // someone re-pointed it meanwhile; leave it
    if (before === undefined) delete routes[domain];
    else routes[domain] = before;
    saveRoutes(routes);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    restore();
    console.error(`${CMD}: cannot start "${bin}": ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    restore();
    process.exit(signal ? 1 : code);
  });
}

function cmdInstall() {
  if (process.platform !== 'darwin') fail(`"install" only supports macOS (launchd). Elsewhere, run "${CMD} serve" from your own service manager.`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  // launchd agents may not read ~/Documents, ~/Desktop etc. (macOS privacy rules),
  // so the background proxy runs from a copy kept next to the routes file.
  for (const f of FILES) fs.copyFileSync(path.join(__dirname, f), path.join(HOME, f));
  const log = path.join(HOME, 'proxy.log');
  const str = (s) => `<string>${esc(s)}</string>`;
  fs.writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key><array>${str(process.execPath)}${str(path.join(HOME, 'cli.js'))}${str('serve')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict></plist>
`,
  );
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: 'inherit' });
  console.log(`installed: the proxy now starts at login and restarts if it stops.\nmanage your domain names at ${urlFor('localhost')}`);
}

function cmdUninstall() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  fs.rmSync(PLIST, { force: true });
  console.log('uninstalled the background proxy (your domain names are kept)');
}

function cmdHosts() {
  try {
    console.log(syncHosts() ? `${HOSTS_FILE} updated` : `${HOSTS_FILE} is already up to date`);
  } catch (err) {
    if (!isDenied(err)) throw err;
    fail(`${HOSTS_FILE} needs admin rights. Run:  sudo ${CMD} hosts`);
  }
}

function cmdOpen() {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [urlFor('localhost')], { stdio: 'ignore', detached: true }).unref();
}

const HELP = `${CMD} (local-custom-domain) - custom domain names for services on your computer

  ${CMD} add <domain> <port>          http://<domain> -> 127.0.0.1:<port>
                                   any domain works (shop.test, api.myapp.test);
                                   a bare name like "shop" means shop.localhost
  ${CMD} rm <domain>                  remove a domain name
  ${CMD} ls                           list domain names and proxy status
  ${CMD} open                         open the console at http://localhost
  ${CMD} run <domain> -- <command>    start a service on a free port under <domain>
                                   (port is passed as $PORT and replaces {port})
  ${CMD} serve                        run the proxy in the foreground
  ${CMD} install | uninstall          keep the proxy running in the background (macOS)
  ${CMD} hosts                        write all names to /etc/hosts (needs sudo)

examples
  ${CMD} add shop.test 3000           then open http://shop.test
  ${CMD} add shop 3000                then open http://shop.localhost (no password needed)
  ${CMD} run api.test -- npm run dev
  ${CMD} run web.test -- vite --port {port}
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'add': return cmdAdd(args);
    case 'rm': case 'remove': return cmdRm(args);
    case 'ls': case 'list': return cmdLs();
    case 'open': return cmdOpen();
    case 'run': return cmdRun(args);
    case 'serve': return serve();
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'hosts': return cmdHosts();
    case undefined: case 'help': case '-h': case '--help': return void process.stdout.write(HELP);
    default: fail(`unknown command "${cmd}" (try "${CMD} help")`);
  }
}

main().catch((err) => {
  console.error(err.expected ? `${CMD}: ${err.message}` : err);
  process.exit(1);
});
