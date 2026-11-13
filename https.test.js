'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const CLI = path.join(__dirname, 'cli.js');
const HTTP_PORT = 18180;
const HTTPS_PORT = 18543;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcd-https-'));
const hostsFile = path.join(tmp, 'hosts');
fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
const home = path.join(tmp, 'home');
const env = { ...process.env, LCD_HOME: home, LCD_PORT: String(HTTP_PORT), LCD_HTTPS_PORT: String(HTTPS_PORT), LCD_HOSTS_FILE: hostsFile };
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function request(lib, port, host, urlPath = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: '127.0.0.1', port, path: urlPath, servername: host, ...options, headers: { host, ...options.headers } }, (res) => {
      let body = '';
      const cert = res.socket.getPeerCertificate?.();
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, cert }));
    });
    req.on('error', reject);
    req.end();
  });
}

let proxy, upstream, upstreamPort, ca;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/redir') return res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/next` }).end();
    res.end(`proto=${req.headers['x-forwarded-proto']} origin=${req.headers.origin}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  cli('https', '--no-trust'); // creates the certificate authority without touching the keychain
  ca = fs.readFileSync(path.join(home, 'https', 'ca.pem'));
  proxy = spawn(process.execPath, [CLI, 'serve'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => {
    let out = '';
    proxy.stdout.on('data', (d) => ((out += d), out.includes('https') && resolve()));
  });
  cli('add', 'shop.test', String(upstreamPort));
});

test.after(() => {
  proxy.kill();
  upstream.close();
  upstream.closeAllConnections();
});

test('domain names are listed with https addresses once https is on', () => {
  assert.match(cli('ls'), new RegExp(`https://shop\\.test:${HTTPS_PORT}`));
});

test('https reaches the service with a certificate for that domain, signed by the local authority', async () => {
  const res = await request(https, HTTPS_PORT, 'shop.test', '/', { ca, headers: { origin: 'https://shop.test' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, `proto=https origin=http://127.0.0.1:${upstreamPort}`);
  assert.match(res.cert.subjectaltname, /DNS:shop\.test/);
});

test('subdomains are covered by the same certificate', async () => {
  assert.strictEqual((await request(https, HTTPS_PORT, 'api.shop.test', '/', { ca })).status, 200);
});

test('the certificate is not accepted without trusting the local authority', async () => {
  await assert.rejects(request(https, HTTPS_PORT, 'shop.test', '/'));
});

test('redirects from the service come back as https', async () => {
  const res = await request(https, HTTPS_PORT, 'shop.test', '/redir', { ca });
  assert.strictEqual(res.headers.location, 'https://shop.test/next');
});

test('a browser opening the http address is sent to https; programs are not', async () => {
  const nav = await request(http, HTTP_PORT, 'shop.test', '/a?b=1', { headers: { 'upgrade-insecure-requests': '1' } });
  assert.strictEqual(nav.status, 308);
  assert.strictEqual(nav.headers.location, `https://shop.test:${HTTPS_PORT}/a?b=1`);
  const program = await request(http, HTTP_PORT, 'shop.test');
  assert.strictEqual(program.status, 200);
  assert.match(program.body, /^proto=http /);
});

test('unknown names get no certificate', async () => {
  await assert.rejects(request(https, HTTPS_PORT, 'nope.test', '/', { ca }));
});

test('the console still answers on http://localhost and reports https as on', async () => {
  const res = await request(http, HTTP_PORT, `localhost:${HTTP_PORT}`, '/api/domains');
  assert.strictEqual(JSON.parse(res.body).https, true);
});

test('a domain can be kept on http while https is on, and switched back', async () => {
  assert.match(cli('add', 'plain.test', String(upstreamPort), '--http'), new RegExp(`http://plain\\.test:${HTTP_PORT}`));
  const nav = await request(http, HTTP_PORT, 'plain.test', '/', { headers: { 'upgrade-insecure-requests': '1' } });
  assert.strictEqual(nav.status, 200); // not redirected
  assert.match(cli('add', 'shop.test', String(upstreamPort)), /https:\/\/shop\.test/); // re-adding keeps https
  assert.match(cli('ls'), new RegExp(`http://plain\\.test:${HTTP_PORT}`)); // and keeps the http choice of others
  assert.match(cli('add', 'plain.test', String(upstreamPort), '--https'), /https:\/\/plain\.test/);
});

test('the console API accepts a scheme per domain', async () => {
  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: HTTP_PORT, method: 'POST', path: '/api/domains', headers: { host: `localhost:${HTTP_PORT}`, origin: `http://localhost:${HTTP_PORT}`, 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  assert.strictEqual((await post({ domain: 'web.test', port: upstreamPort, scheme: 'http' })).body.scheme, 'http');
  assert.strictEqual((await post({ domain: 'web.test', port: upstreamPort })).body.scheme, 'http'); // unchanged when not given
  assert.strictEqual((await post({ domain: 'web.test', port: upstreamPort, scheme: 'https' })).body.scheme, 'https');
  assert.strictEqual((await post({ domain: 'web.test', port: upstreamPort, scheme: 'ftp' })).status, 400);
});

