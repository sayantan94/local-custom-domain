'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const CLI = path.join(__dirname, 'cli.js');
const PROXY_PORT = 18080;
const env = { ...process.env, PORTTAG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'porttag-')), PORTTAG_PORT: String(PROXY_PORT) };
const porttag = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

function get(host, urlPath = '/', extra = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PROXY_PORT, path: urlPath, headers: { host, ...extra } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

let proxy, upstream, upstreamPort;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/redir') return res.writeHead(302, { location: `http://localhost:${upstreamPort}/next` }).end();
    res.end(`hello ${req.url} host=${req.headers.host} xfh=${req.headers['x-forwarded-host']} origin=${req.headers.origin}`);
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d}`));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  proxy = spawn(process.execPath, [CLI, 'serve'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => proxy.stdout.once('data', r));
  porttag('add', 'home', String(upstreamPort));
});

test.after(() => {
  proxy.kill();
  upstream.close();
  upstream.closeAllConnections();
});

test('name.localhost proxies to the port, addressed as 127.0.0.1:<port>', async () => {
  const res = await get('home.localhost', '/a/b?x=1');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, new RegExp(`^hello /a/b\\?x=1 host=127.0.0.1:${upstreamPort} xfh=home.localhost `));
});

test('same-origin Origin is translated, cross-origin is left alone', async () => {
  const same = await get('home.localhost', '/', { origin: 'http://home.localhost' });
  assert.match(same.body, new RegExp(`origin=http://127.0.0.1:${upstreamPort}$`));
  const cross = await get('home.localhost', '/', { origin: 'http://evil.example' });
  assert.match(cross.body, /origin=http:\/\/evil\.example$/);
});

test('redirects to the service address come back under the name', async () => {
  const res = await get('home.localhost', '/redir');
  assert.strictEqual(res.headers.location, 'http://home.localhost/next');
});

test('subdomains of a name reach the same service', async () => {
  const res = await get('api.home.localhost');
  assert.strictEqual(res.status, 200);
});

test('localhost/name redirects to name.localhost', async () => {
  const res = await get('localhost', '/home/a?x=1');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, `http://home.localhost:${PROXY_PORT}/a?x=1`);
});

test('index lists names; unknown names are 404', async () => {
  assert.match((await get('localhost')).body, /home\.localhost/);
  assert.strictEqual((await get('nope.localhost')).status, 404);
  assert.strictEqual((await get('localhost', '/nope')).status, 404);
});

test('a dead upstream gives 502', async () => {
  porttag('add', 'dead', '1');
  assert.strictEqual((await get('dead.localhost')).status, 502);
  porttag('rm', 'dead');
  assert.strictEqual((await get('dead.localhost')).status, 404);
});

test('websocket upgrades pass through', async () => {
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: home.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('101') && !buf.includes('echo:')) s.write('ping');
      if (buf.includes('echo:ping')) {
        s.destroy();
        resolve(buf);
      }
    });
    s.on('error', reject);
  });
  assert.match(reply, /101 Switching Protocols/);
});

test('run picks a port, passes it as $PORT and {port}, and cleans up', async () => {
  const out = porttag('run', 'tmp', '--', process.execPath, '-e', 'console.log(process.env.PORT, "{port}")');
  const [, a, b] = out.match(/\n(\d+) (\d+)\n/);
  assert.strictEqual(a, b);
  assert.doesNotMatch(porttag('ls'), /tmp\.localhost/);
});

test('bad names and ports are rejected', () => {
  assert.throws(() => porttag('add', 'bad_name', '3000'));
  assert.throws(() => porttag('add', 'ok', '99999'));
});
