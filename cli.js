#!/usr/bin/env node
'use strict';
// local-custom-domain: custom domain names for services on your own computer.
//   lcd add shop.test 3000   ->   http://shop.test reaches 127.0.0.1:3000
// This file is only the entry point; the work is in lib/.
const { CMD, fail } = require('./lib/config');
const { serve } = require('./lib/server');
const { cmdInstall, cmdUninstall } = require('./lib/service');
const { cmdAdd, cmdRm, cmdLs, cmdRun, cmdHosts, cmdOpen, cmdHttps, cmdSetup } = require('./lib/commands');

const HELP = `${CMD} (local-custom-domain) - custom domain names for services on your computer

  ${CMD} add <domain> <port>          http://<domain> -> 127.0.0.1:<port>
                                   any domain works (shop.test, api.myapp.test);
                                   a bare name like "shop" means shop.localhost
  ${CMD} rm <domain>                  remove a domain name
  ${CMD} ls                           list domain names and proxy status
  ${CMD} open                         open the console at http://localhost
  ${CMD} run <domain> -- <command>    start a service on a free port under <domain>
                                   (port is passed as $PORT and replaces {port})
  ${CMD} setup                        first-time setup: background proxy, https and
                                   automatic name setup (asks for your password)
  ${CMD} serve                        run the proxy in the foreground
  ${CMD} install | uninstall          keep the proxy running in the background (macOS)
  ${CMD} hosts                        write all names to /etc/hosts (needs sudo)
  ${CMD} hosts --auto                 one-time setup (sudo): names you add later set
                                   themselves up; undo with --auto-off
  ${CMD} https                        one-time setup: open your domain names over https
                                   so browsers stop saying "Not secure"; undo with --off

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
    case 'setup': return cmdSetup();
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'hosts': return cmdHosts(args);
    case 'https': return cmdHttps(args);
    case undefined: case 'help': case '-h': case '--help': return void process.stdout.write(HELP);
    default: fail(`unknown command "${cmd}" (try "${CMD} help")`);
  }
}

main().catch((err) => {
  console.error(err.expected ? `${CMD}: ${err.message}` : err);
  process.exit(1);
});
