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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcd-'));
const hostsFile = path.join(tmp, 'hosts');
fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
const env = { ...process.env, LCD_HOME: path.join(tmp, 'home'), LCD_PORT: String(PROXY_PORT), LCD_HOSTS_FILE: hostsFile };
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function request(method, host, urlPath = '/', { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PROXY_PORT, method, path: urlPath, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (host, urlPath, headers) => request('GET', host, urlPath, { headers });
const ADMIN = `localhost:${PROXY_PORT}`;
const sameOrigin = { origin: `http://${ADMIN}`, 'content-type': 'application/json' };

let proxy, upstream, upstreamPort;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/redir') return res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/next` }).end();
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
  cli('add', 'shop.test', String(upstreamPort));
});

test.after(() => {
  proxy.kill();
  upstream.close();
  upstream.closeAllConnections();
});

test('a custom domain reaches the service, addressed as 127.0.0.1:<port>', async () => {
  const res = await get('shop.test', '/a/b?x=1');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, new RegExp(`^hello /a/b\\?x=1 host=127.0.0.1:${upstreamPort} xfh=shop.test `));
});

test('adding a custom domain writes it to the hosts file; removing clears it', () => {
  assert.match(fs.readFileSync(hostsFile, 'utf8'), /^127\.0\.0\.1 shop\.test$/m);
  cli('add', 'gone.test', '4000');
  cli('rm', 'gone.test');
  const hosts = fs.readFileSync(hostsFile, 'utf8');
  assert.doesNotMatch(hosts, /gone\.test/);
  assert.match(hosts, /^127\.0\.0\.1 localhost$/m);
});

test('a bare name means <name>.localhost', async () => {
  assert.match(cli('add', 'home', String(upstreamPort)), /http:\/\/home\.localhost/);
  assert.strictEqual((await get('home.localhost')).status, 200);
});

test('subdomains of a domain reach the same service', async () => {
  assert.strictEqual((await get('api.shop.test')).status, 200);
});

test('same-origin Origin is translated, cross-origin is left alone', async () => {
  const same = await get('shop.test', '/', { origin: 'http://shop.test' });
  assert.match(same.body, new RegExp(`origin=http://127.0.0.1:${upstreamPort}$`));
  const cross = await get('shop.test', '/', { origin: 'http://evil.example' });
  assert.match(cross.body, /origin=http:\/\/evil\.example$/);
});

test('redirects to the service address come back under the domain', async () => {
  assert.strictEqual((await get('shop.test', '/redir')).headers.location, 'http://shop.test/next');
});

test('unknown domains are 404 and a dead service is 502', async () => {
  assert.strictEqual((await get('nope.test')).status, 404);
  cli('add', 'dead.test', '1');
  assert.strictEqual((await get('dead.test')).status, 502);
});

test('websocket upgrades pass through', async () => {
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: shop.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
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

test('console page and domain list are served on localhost', async () => {
  assert.match((await get(ADMIN, '/')).body, /<title>Local custom domain<\/title>/);
  const { domains } = JSON.parse((await get(ADMIN, '/api/domains')).body);
  const shop = domains.find((d) => d.domain === 'shop.test');
  assert.deepStrictEqual({ port: shop.port, answering: shop.answering }, { port: upstreamPort, answering: true });
  assert.strictEqual(domains.find((d) => d.domain === 'dead.test').answering, false);
});

test('console can add, edit and delete a domain', async () => {
  const add = (body) => request('POST', ADMIN, '/api/domains', { headers: sameOrigin, body: JSON.stringify(body) });
  assert.strictEqual((await add({ domain: 'New.Test', port: upstreamPort, create: true })).status, 200);
  assert.strictEqual((await get('new.test')).status, 200);
  assert.strictEqual((await add({ domain: 'new.test', port: 1, create: true })).status, 400); // already exists
  assert.strictEqual((await add({ domain: 'new.test', port: 1 })).status, 200); // edit
  assert.strictEqual((await get('new.test')).status, 502);
  const bad = await add({ domain: 'bad_name', port: 3000 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse(bad.body).field, 'domain');
  assert.strictEqual((await add({ domain: 'x.test', port: 99999 })).status, 400);
  const del = await request('DELETE', ADMIN, '/api/domains/new.test', { headers: sameOrigin });
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await get('new.test')).status, 404);
});

test('console refuses changes from other websites', async () => {
  const body = JSON.stringify({ domain: 'evil.test', port: 3000 });
  const cross = await request('POST', ADMIN, '/api/domains', { headers: { ...sameOrigin, origin: 'http://evil.example' }, body });
  assert.strictEqual(cross.status, 403);
  const noOrigin = await request('DELETE', ADMIN, '/api/domains/shop.test');
  assert.strictEqual(noOrigin.status, 403);
  // a proxied site cannot reach the console API through its own domain
  assert.doesNotMatch((await get('shop.test', '/api/domains')).body, /"domains"/);
});

test('run picks a port, passes it as $PORT and {port}, and cleans up', () => {
  const out = cli('run', 'tmp', '--', process.execPath, '-e', 'console.log(process.env.PORT, "{port}")');
  const [, a, b] = out.match(/\n(\d+) (\d+)\n/);
  assert.strictEqual(a, b);
  assert.doesNotMatch(cli('ls'), /tmp\.localhost/);
});

test('bad domains and ports are rejected; https-only endings warn', () => {
  assert.throws(() => cli('add', 'bad_name', '3000'));
  assert.throws(() => cli('add', 'localhost', '3000'));
  assert.throws(() => cli('add', 'ok.test', '99999'));
  assert.match(cli('add', 'site.dev', '3000'), /warning: .*https/);
});

test('the root helper only copies plain domain names into the hosts file', () => {
  const list = path.join(tmp, 'helper.list');
  const hosts = path.join(tmp, 'helper.hosts');
  const run = () => execFileSync('/bin/sh', [path.join(__dirname, 'sync-hosts.sh'), list, hosts]);
  fs.writeFileSync(hosts, '127.0.0.1 localhost\n::1 localhost\n');
  fs.writeFileSync(list, 'shop.test\napi.myapp.test\nevil.test 10.0.0.1\n10.0.0.1 bank.test\nUPPER.test\n../etc\nnodot\n# >>> x\n');
  run();
  assert.strictEqual(
    fs.readFileSync(hosts, 'utf8'),
    '127.0.0.1 localhost\n::1 localhost\n# >>> local-custom-domain >>>\n127.0.0.1 api.myapp.test\n127.0.0.1 shop.test\n# <<< local-custom-domain <<<\n',
  );
  run(); // running again changes nothing
  assert.strictEqual(fs.readFileSync(hosts, 'utf8').match(/shop\.test/g).length, 1);
  fs.writeFileSync(list, '');
  run();
  assert.strictEqual(fs.readFileSync(hosts, 'utf8'), '127.0.0.1 localhost\n::1 localhost\n');
});

test('saving domains keeps the helper list in step', () => {
  const list = fs.readFileSync(path.join(env.LCD_HOME, 'domains.list'), 'utf8').split('\n');
  assert.ok(list.includes('shop.test'));
});

