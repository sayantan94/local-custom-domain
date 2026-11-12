#!/bin/sh
# Puts porttag on your PATH and starts the background proxy.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "porttag needs Node 20 or newer: https://nodejs.org"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || { echo "porttag needs Node 20 or newer (found $(node -v))"; exit 1; }

npm link --silent
porttag install

echo
echo "Ready. Try:  porttag add home 3000   then open http://home.localhost"
