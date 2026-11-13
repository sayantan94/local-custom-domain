'use strict';
// Keeping the proxy running in the background (macOS launchd).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CMD, HOME, LABEL, PLIST, FILES, fail, esc, ROOT } = require('./config');
const { urlFor } = require('./domains');
const { serve } = require('./server');

function cmdInstall() {
  if (process.platform !== 'darwin') fail(`"install" only supports macOS (launchd). Elsewhere, run "${CMD} serve" from your own service manager.`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  // launchd agents may not read ~/Documents, ~/Desktop etc. (macOS privacy rules),
  // so the background proxy runs from a copy kept next to the routes file.
  if (path.resolve(ROOT) !== path.resolve(HOME)) {
    for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(HOME, f), { recursive: true });
  }
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

module.exports = { cmdInstall, cmdUninstall };
