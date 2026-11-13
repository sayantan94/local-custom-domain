#!/bin/sh
# Installs local-custom-domain: copies it to ~/.local-custom-domain, puts the lcd
# command on your PATH, starts the background proxy, and does the two one-time
# steps that need your password (https certificates and automatic name setup).
set -e
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "local-custom-domain needs Node 20 or newer: https://nodejs.org"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || { echo "local-custom-domain needs Node 20 or newer (found $(node -v))"; exit 1; }

# The command runs from the copy in your home folder, not from this checkout, so it
# keeps working wherever this folder lives (macOS restricts Documents, Desktop, Downloads).
node cli.js install
bin="$(npm prefix -g)/bin"
mkdir -p "$bin"
ln -sf "$HOME/.local-custom-domain/cli.js" "$bin/lcd"

echo
echo "Step 1 of 2: https, so browsers don't say \"Not secure\"."
echo "This creates a certificate authority on this computer and asks macOS to trust it."
lcd https || echo "Skipped. Run \"lcd https\" later to turn it on."

echo
echo "Step 2 of 2: automatic name setup, so any domain you add works without further steps."
sudo lcd hosts --auto || echo "Skipped. Run \"sudo lcd hosts --auto\" later to turn it on."

echo
echo "Ready. Open http://localhost, or try:  lcd add shop.test 3000"
echo "Re-run ./setup.sh after updating this folder."
