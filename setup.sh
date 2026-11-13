#!/bin/sh
# Puts the lcd command on your PATH and starts the background proxy.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "local-custom-domain needs Node 20 or newer: https://nodejs.org"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || { echo "local-custom-domain needs Node 20 or newer (found $(node -v))"; exit 1; }

npm link --silent --omit=dev
lcd install

echo
echo "Ready. Open http://localhost, or try:  lcd add shop.test 3000"
