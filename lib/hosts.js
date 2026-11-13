'use strict';
// Making names resolve: the hosts file and the optional root helper.
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { execFileSync } = require('child_process');
const { CMD, HOME, HOSTS_FILE, HOSTS_BEGIN, HOSTS_END, PLIST, LIST_FILE, HELPER_LABEL, HELPER_PLIST, HELPER_DIR, fail, esc, ROOT } = require('./config');
const { usesBuiltInDns } = require('./domains');
const { loadRoutes } = require('./store');

// True once "sudo lcd hosts --auto" has installed the helper that keeps the hosts file in step.
const autoSetupOn = () => !process.env.LCD_HOSTS_FILE && fs.existsSync(HELPER_PLIST);


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

// One-time setup: a small root helper that copies domains.list into the hosts file
// whenever it changes, so adding a domain never needs a password again.
// The helper is a root-owned shell script using only system tools; nothing the
// user account can modify is ever executed as root.
function installHelper() {
  if (process.platform !== 'darwin') fail('automatic setup only supports macOS');
  if (process.getuid() !== 0) fail(`this needs admin rights. Run:  sudo ${CMD} hosts --auto`);
  if (HOME.startsWith('/var/root')) fail(`could not tell whose domain names to use. Run:  sudo LCD_HOME="$HOME/.local-custom-domain" ${CMD} hosts --auto`);

  // make sure the list exists and still belongs to the user, not to root
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(LIST_FILE, Object.keys(loadRoutes()).sort().map((d) => d + '\n').join(''));
  if (process.env.SUDO_UID) {
    for (const f of [HOME, LIST_FILE]) fs.chownSync(f, Number(process.env.SUDO_UID), Number(process.env.SUDO_GID));
  }

  const script = path.join(HELPER_DIR, 'sync-hosts.sh');
  fs.mkdirSync(HELPER_DIR, { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(ROOT, 'sync-hosts.sh'), script);
  fs.chownSync(script, 0, 0);
  fs.chmodSync(script, 0o755);

  const str = (v) => `<string>${esc(v)}</string>`;
  fs.writeFileSync(
    HELPER_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${str(HELPER_LABEL)}
  <key>ProgramArguments</key><array>${str('/bin/sh')}${str(script)}${str(LIST_FILE)}</array>
  <key>WatchPaths</key><array>${str(LIST_FILE)}</array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
    { mode: 0o644 },
  );
  try {
    execFileSync('launchctl', ['bootout', `system/${HELPER_LABEL}`], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['bootstrap', 'system', HELPER_PLIST], { stdio: 'inherit' });
  console.log(`automatic setup is on: new domain names are added to ${HOSTS_FILE} by themselves.\nturn it off with:  sudo ${CMD} hosts --auto-off`);
}

function removeHelper() {
  if (process.getuid() !== 0) fail(`this needs admin rights. Run:  sudo ${CMD} hosts --auto-off`);
  try {
    execFileSync('launchctl', ['bootout', `system/${HELPER_LABEL}`], { stdio: 'ignore' });
  } catch {}
  fs.rmSync(HELPER_PLIST, { force: true });
  fs.rmSync(HELPER_DIR, { recursive: true, force: true });
  console.log(`automatic setup is off (entries already in ${HOSTS_FILE} are kept)`);
}

module.exports = { autoSetupOn, syncHosts, isDenied, isLoopback, dnsState, installHelper, removeHelper };
