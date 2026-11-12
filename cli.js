#!/usr/bin/env node
'use strict';
// porttag: give local ports names.  http://home.localhost -> localhost:3000
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const HOME = process.env.PORTTAG_HOME || path.join(os.homedir(), '.porttag');
const ROUTES_FILE = path.join(HOME, 'routes.json');
const PROXY_PORT = Number(process.env.PORTTAG_PORT || 80);
const LABEL = 'com.porttag.proxy';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const HOSTS_FILE = '/etc/hosts';
const HOSTS_BEGIN = '# >>> porttag >>>';
const HOSTS_END = '# <<< porttag <<<';
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED = new Set(['localhost', '__porttag']);

// ---------- routes store ----------

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
      cache = { mtime, routes: JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')) };
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

function checkName(name) {
  name = String(name || '').toLowerCase();
  if (!NAME_RE.test(name) || RESERVED.has(name)) {
    die(`invalid name "${name}" (use letters, digits and dashes, e.g. "home" or "my-api")`);
  }
  return name;
}

function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) die(`invalid port "${port}"`);
  if (n === PROXY_PORT) die(`port ${n} is the proxy's own port`);
  return n;
}

function die(msg) {
  console.error(`porttag: ${msg}`);
  process.exit(1);
}

const urlFor = (name) =>
  `http://${name}.localhost${PROXY_PORT === 80 ? '' : ':' + PROXY_PORT}`;

// ---------- proxy ----------

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// "home.localhost:80" -> "home"; "localhost" -> null (the index/redirect host)
function nameFromHost(hostHeader, routes) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host.endsWith('.localhost')) return null;
  const prefix = host.slice(0, -'.localhost'.length);
  if (routes[prefix]) return prefix;
  // api.home.localhost -> home (lets apps use their own subdomains)
  return prefix.split('.').pop();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:root{--paper:#edf2f0;--ink:#12304a;--muted:#5b7285;--rule:#c5d3d6;--live:#1a6f5a;--down:#b5362a}
@media(prefers-color-scheme:dark){:root{--paper:#0f2535;--ink:#e6eef0;--muted:#8fa6b5;--rule:#27455a;--live:#5cc4a6;--down:#f08172}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.5 "Avenir Next",Avenir,"Century Gothic",system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:clamp(2rem,8vh,5rem) 1.25rem 4rem}
header{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:2.5rem;color:var(--muted)}
header b{color:var(--ink);font-weight:600;letter-spacing:.01em}
h1{font:500 clamp(1.6rem,5vw,2.4rem)/1.15 Futura,"Avenir Next",system-ui,sans-serif;margin:0 0 .75rem}
p{margin:0 0 2rem;max-width:34rem;color:var(--muted)}
ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
li{border-bottom:1px solid var(--rule)}
li a{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem 2rem;flex-wrap:wrap;padding:1.1rem 0;color:inherit;text-decoration:none}
.name{font:500 clamp(1.9rem,7vw,3.25rem)/1.1 Futura,"Avenir Next",system-ui,sans-serif;letter-spacing:-.01em;overflow-wrap:anywhere}
.name span{color:var(--muted)}
li a:hover .name,li a:focus-visible .name{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.15em}
li a:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.to{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.state{display:block;font-size:.875rem}
.state::before{content:"";display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.4rem;background:currentColor}
.up{color:var(--live)}.down{color:var(--down)}
footer{margin-top:2.5rem;color:var(--muted)}
code{font:.9em ui-monospace,Menlo,monospace;color:var(--ink);background:color-mix(in srgb,var(--rule) 45%,transparent);padding:.15em .4em;border-radius:.25rem}
@media(max-width:30rem){.to{text-align:left}}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>
<main><header><b>porttag</b><span>Local services by name</span></header>${body}
<footer>Add a name with <code>porttag add home 3000</code></footer></main></html>`;
}

// Is anything accepting connections on this port right now?
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

async function routesList(routes) {
  const names = Object.keys(routes).sort();
  if (!names.length) return '<p>No names yet.</p>';
  const up = await Promise.all(names.map((n) => isAnswering(routes[n])));
  return `<ul>${names
    .map(
      (n, i) => `<li><a href="${esc(urlFor(n))}"><span class="name">${esc(n)}<span>.localhost</span></span>
<span class="to">127.0.0.1:${routes[n]}<span class="state ${up[i] ? 'up' : 'down'}">${up[i] ? 'answering' : 'not answering'}</span></span></a></li>`,
    )
    .join('')}</ul>`;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

// Connect to 127.0.0.1 first; fall back to ::1 for services that only listen on IPv6.
function loopbackLookup(_hostname, options, callback) {
  const all = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  if (options.all) return callback(null, all);
  callback(null, all[0].address, all[0].family);
}

// Services often refuse hosts they don't know (DNS-rebinding guards, dev-server allow
// lists). So the service is addressed exactly as if opened directly: Host becomes
// "127.0.0.1:<port>", and a same-origin Origin header is translated to match. Cross-origin
// Origins are passed through untouched, so the service's own CSRF checks still mean
// what they say. The public name is still available in X-Forwarded-Host.
function upstreamHeader(key, value, req, port) {
  const k = key.toLowerCase();
  if (k === 'host') return `127.0.0.1:${port}`;
  if (k === 'origin' && value === `http://${req.headers.host}`) return `http://127.0.0.1:${port}`;
  return value;
}

// ...and redirects the service issues to its own address come back under the public name.
function publicLocation(location, req, port) {
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(?=\/|$)/.exec(location);
  return m && Number(m[2]) === port ? `http://${req.headers.host}${location.slice(m[0].length)}` : location;
}

async function handleRequest(req, res) {
  if (!isLoopback(req.socket.remoteAddress)) return req.socket.destroy();
  const routes = loadRoutes();
  const name = nameFromHost(req.headers.host, routes);

  if (name === null) {
    // plain http://localhost/...  ->  index page, or bitly-style redirect
    const url = new URL(req.url, 'http://localhost');
    const [, first, ...rest] = url.pathname.split('/');
    if (first === '__porttag') return send(res, 200, 'porttag', { 'content-type': 'text/plain' });
    if (!first) return send(res, 200, page('porttag', await routesList(routes)));
    if (routes[first.toLowerCase()]) {
      const location = `${urlFor(first.toLowerCase())}/${rest.join('/')}${url.search}`;
      return send(res, 302, '', { location });
    }
    return send(res, 404, page(`No name "${first}"`, `<h1>Nothing is called “${esc(first)}”</h1><p>These are the names that exist.</p>${await routesList(routes)}`));
  }

  const port = routes[name];
  if (!port) return send(res, 404, page(`No name "${name}"`, `<h1>Nothing is called “${esc(name)}”</h1><p>These are the names that exist.</p>${await routesList(routes)}`));

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
    send(
      res,
      502,
      page(`${name}.localhost is not answering`, `<h1>${esc(name)}.localhost is not answering</h1><p>Nothing responded on <code>127.0.0.1:${port}</code> (${esc(err.code || err.message)}). Start the service, then reload.</p>`),
    );
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

// WebSockets (hot reload etc.): replay the handshake to the upstream and splice the sockets
function handleUpgrade(req, socket, head) {
  if (!isLoopback(socket.remoteAddress)) return socket.destroy();
  const routes = loadRoutes();
  const port = routes[nameFromHost(req.headers.host, routes)];
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
}

function serve() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') die(`port ${PROXY_PORT} is already in use (is porttag already running? try "porttag ls")`);
    die(`cannot listen on port ${PROXY_PORT}: ${err.message}`);
  });
  // "::" accepts IPv4 and IPv6. macOS only lets non-root processes use port 80 on the
  // wildcard address, so we bind wide and drop every non-loopback connection instead.
  server.listen(PROXY_PORT, '::', () => {
    console.log(`porttag proxy listening on port ${PROXY_PORT} (local connections only)`);
  });
  return server;
}

// ---------- commands ----------

function proxyIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: '/__porttag', timeout: 500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body === 'porttag'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

async function warnIfDown() {
  if (!(await proxyIsUp())) {
    console.log('note: the proxy is not running. Start it with "porttag serve", or "porttag install" to keep it always on.');
  }
}

async function cmdAdd(args) {
  if (args.length !== 2) die('usage: porttag add <name> <port>');
  const name = checkName(args[0]);
  const port = checkPort(args[1]);
  saveRoutes({ ...loadRoutes(), [name]: port });
  console.log(`${urlFor(name)}  ->  127.0.0.1:${port}`);
  await warnIfDown();
}

function cmdRm(name) {
  name = checkName(name);
  const routes = { ...loadRoutes() };
  if (!(name in routes)) die(`no such name "${name}"`);
  delete routes[name];
  saveRoutes(routes);
  console.log(`removed ${name}`);
}

async function cmdLs() {
  const routes = loadRoutes();
  const names = Object.keys(routes).sort();
  if (!names.length) console.log('no names yet. Try: porttag add home 3000');
  const width = Math.max(0, ...names.map((n) => urlFor(n).length));
  for (const n of names) console.log(`${urlFor(n).padEnd(width)}  ->  127.0.0.1:${routes[n]}`);
  console.log(`\nproxy: ${(await proxyIsUp()) ? 'running' : 'NOT running ("porttag serve" or "porttag install")'}`);
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

// porttag run <name> [--port N] -- <command...>
async function cmdRun(args) {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) die('usage: porttag run <name> [--port N] -- <command...>');
  const opts = args.slice(0, sep);
  const command = args.slice(sep + 1);
  const name = checkName(opts[0]);
  const portFlag = opts.indexOf('--port');
  const port = portFlag === -1 ? await freePort() : checkPort(opts[portFlag + 1]);

  const before = loadRoutes()[name];
  saveRoutes({ ...loadRoutes(), [name]: port });
  console.log(`${urlFor(name)}  ->  127.0.0.1:${port}`);
  await warnIfDown();

  // The service learns its port from $PORT, or from "{port}" anywhere in the command.
  const [bin, ...rest] = command.map((a) => a.replaceAll('{port}', String(port)));
  const child = spawn(bin, rest, { stdio: 'inherit', env: { ...process.env, PORT: String(port) } });

  const restore = () => {
    const routes = { ...loadRoutes() };
    if (routes[name] !== port) return; // someone re-pointed it meanwhile; leave it
    if (before === undefined) delete routes[name];
    else routes[name] = before;
    saveRoutes(routes);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    restore();
    die(`cannot start "${bin}": ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    restore();
    process.exit(signal ? 1 : code);
  });
}

function cmdInstall() {
  if (process.platform !== 'darwin') die('"install" only supports macOS (launchd). Elsewhere, run "porttag serve" from your own service manager.');
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const log = path.join(HOME, 'proxy.log');
  // launchd agents may not read ~/Documents, ~/Desktop etc. (macOS privacy rules),
  // so the background proxy runs from a copy kept next to the routes file.
  const script = path.join(HOME, 'cli.js');
  fs.copyFileSync(__filename, script);
  const str = (s) => `<string>${esc(s)}</string>`;
  fs.writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key><array>${str(process.execPath)}${str(script)}${str('serve')}</array>
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
  console.log(`installed: the proxy now starts at login and restarts if it stops.\nlog: ${log}`);
}

function cmdUninstall() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  fs.rmSync(PLIST, { force: true });
  console.log('uninstalled the background proxy (your names are kept)');
}

// Browsers and curl resolve *.localhost by themselves. Everything else (node, python,
// java, Safari...) asks the OS, which needs /etc/hosts entries.
function cmdHosts() {
  const names = Object.keys(loadRoutes()).sort();
  const block = names.length
    ? [HOSTS_BEGIN, ...names.map((n) => `127.0.0.1 ${n}.localhost`), HOSTS_END].join('\n') + '\n'
    : '';
  const current = fs.readFileSync(HOSTS_FILE, 'utf8');
  const b = current.indexOf(HOSTS_BEGIN);
  const e = current.indexOf(HOSTS_END);
  let next;
  if (b !== -1 && e > b) {
    next = current.slice(0, b) + block + current.slice(e + HOSTS_END.length).replace(/^\n/, '');
  } else {
    next = current + (current.endsWith('\n') ? '' : '\n') + block;
  }
  if (next === current) return console.log(`${HOSTS_FILE} is already up to date`);
  try {
    fs.writeFileSync(HOSTS_FILE, next);
    console.log(`${HOSTS_FILE} updated with ${names.length} name(s)`);
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    die(`${HOSTS_FILE} needs admin rights. Run:\n  sudo "${process.execPath}" "${fs.realpathSync(__filename)}" hosts`);
  }
}

const HELP = `porttag - names instead of port numbers for local services

  porttag add <name> <port>            http://<name>.localhost -> 127.0.0.1:<port>
  porttag rm <name>                    remove a name
  porttag ls                           list names and proxy status
  porttag run <name> -- <command...>   start a service on a free port under <name>
                                   (port is passed as $PORT and replaces {port})
  porttag serve                        run the proxy in the foreground
  porttag install | uninstall          keep the proxy running in the background (macOS)
  porttag hosts                        write names to /etc/hosts for non-browser tools

examples
  porttag add home 3000                then open http://home.localhost
  porttag run api -- npm run dev       for tools that read $PORT
  porttag run web -- vite --port {port}
  http://localhost/home            short link, redirects to http://home.localhost
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'add': return cmdAdd(args);
    case 'rm': case 'remove': return cmdRm(args[0]);
    case 'ls': case 'list': return cmdLs();
    case 'run': return cmdRun(args);
    case 'serve': return void serve();
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'hosts': return cmdHosts();
    case undefined: case 'help': case '-h': case '--help': return void process.stdout.write(HELP);
    default: die(`unknown command "${cmd}" (try "porttag help")`);
  }
}

if (require.main === module) main().catch((err) => die(err.message));
