'use strict';
// The lcd subcommands.
const net = require('net');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { CMD, HOME, PROXY_PORT, HOSTS_FILE, LABEL, fail, CLI } = require('./config');
const { CA_CERT, httpsOn, createAuthority, trustAuthority, authorityTrusted, removeAuthority } = require('./https');
const { cmdInstall } = require('./service');
const { normalizeDomain, checkPort, warningFor, usesBuiltInDns, urlFor } = require('./domains');
const { loadRoutes, saveRoutes } = require('./store');
const { autoSetupOn, syncHosts, isDenied, installHelper, removeHelper } = require('./hosts');
const { describeDomains } = require('./console-api');
const { serve } = require('./server');

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
  if (autoSetupOn()) return console.log(`${domain} will open in a few seconds (automatic setup is on)`);
  try {
    if (syncHosts()) console.log(`${HOSTS_FILE} updated`);
    return;
  } catch (err) {
    if (!isDenied(err)) throw err;
  }
  if (process.stdin.isTTY) {
    console.log(`Adding ${domain} to ${HOSTS_FILE} needs your password:`);
    const r = spawnSync('sudo', ['env', `LCD_HOME=${HOME}`, process.execPath, CLI, 'hosts'], { stdio: 'inherit' });
    if (r.status === 0) return;
  }
  console.log(`one more step, so this computer knows the name:  sudo ${CMD} hosts\n(or once and for all:  sudo ${CMD} hosts --auto)`);
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

function cmdHosts(args) {
  if (args[0] === '--auto') return installHelper();
  if (args[0] === '--auto-off') return removeHelper();
  if (args.length) fail(`usage: ${CMD} hosts [--auto | --auto-off]`);
  try {
    console.log(syncHosts() ? `${HOSTS_FILE} updated` : `${HOSTS_FILE} is already up to date`);
  } catch (err) {
    if (!isDenied(err)) throw err;
    fail(`${HOSTS_FILE} needs admin rights. Run:  sudo ${CMD} hosts`);
  }
}

// Restart the background proxy, if it is installed, so it picks up a change.
function restartBackgroundProxy() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// lcd https [--off] [--no-trust]
function cmdHttps(args) {
  const unknown = args.find((a) => !['--off', '--no-trust'].includes(a));
  if (unknown) fail(`usage: ${CMD} https [--off]`);
  if (args.includes('--off')) {
    removeAuthority();
    restartBackgroundProxy();
    return console.log('https is off; domain names open over http again');
  }
  if (!httpsOn()) createAuthority();
  if (!args.includes('--no-trust') && !authorityTrusted()) {
    console.log('Trusting the local certificate authority. macOS will ask for your password...');
    trustAuthority();
  }
  const restarted = restartBackgroundProxy();
  console.log(`https is on: your domain names now open as https://<name>${restarted ? '' : `\nrestart the proxy to apply it ("${CMD} install", or stop and start "${CMD} serve")`}`);
  console.log(`Firefox and programs such as Node or curl keep their own list of trusted authorities; point them at ${CA_CERT} if they need https.`);
}

// lcd setup: everything a new install needs, in one go.
function cmdSetup() {
  cmdInstall();

  console.log('\nStep 1 of 2: https, so browsers don\'t say "Not secure".');
  try {
    cmdHttps([]);
  } catch (err) {
    if (!err.expected) throw err;
    console.log(`Skipped: ${err.message}`);
  }

  console.log('\nStep 2 of 2: automatic name setup, so any domain you add works without further steps.');
  if (autoSetupOn()) {
    console.log('already on');
  } else {
    const r = spawnSync('sudo', ['env', `LCD_HOME=${HOME}`, process.execPath, CLI, 'hosts', '--auto'], { stdio: 'inherit' });
    if (r.status !== 0) console.log(`Skipped. Run "sudo ${CMD} hosts --auto" later to turn it on.`);
  }

  console.log(`\nReady. Open ${urlFor('localhost')}, or try:  ${CMD} add shop.test 3000`);
}

function cmdOpen() {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [urlFor('localhost')], { stdio: 'ignore', detached: true }).unref();
}

module.exports = { cmdHttps, cmdSetup, proxyIsUp, noteIfProxyDown, ensureResolves, cmdAdd, cmdRm, cmdLs, freePort, cmdRun, cmdHosts, cmdOpen };
