<p align="center"><img src="assets/logo.svg" alt="local custom domain" width="460"></p>

Custom domain names for the services on your own computer, with https.

```
lcd add shop.test 3000
```

Now `https://shop.test` opens whatever runs on port 3000.

## How it works

A small proxy runs on **ports 80 (http) and 443 (https)** of your computer. Each domain name points at `127.0.0.1`, so the browser reaches the proxy, which passes the request to your service's port. Nothing else may be using those ports. To use other ports, start it with `LCD_PORT=8080 LCD_HTTPS_PORT=8443 lcd serve` and open `https://shop.test:8443`.

## Setup

Needs Node 20+ and macOS.

```
npm install -g local-custom-domain
lcd setup
```

`lcd setup` starts the background proxy and then asks for your password twice: once for macOS to trust the local certificate authority (https), once to let new domain names set themselves up. Either step can be skipped and run later (`lcd https`, `sudo lcd hosts --auto`).

From a clone of this repo, run `./setup.sh` instead.

## Use

Open `http://localhost` to add, change and remove domain names in the browser, or use the command:

```
lcd add shop.test 3000            # any domain: https://shop.test -> 127.0.0.1:3000
lcd add shop 3000                 # one word means shop.localhost (no password needed)
lcd run api.test -- npm run dev   # picks a free port, passes it as $PORT
lcd run web.test -- vite --port {port}
lcd ls                            # domain names, and whether the proxy is up
lcd rm shop.test
```

## https

Browsers mark plain http pages "Not secure". `lcd https` (part of `lcd setup`) fixes that:

1. It creates a certificate authority that exists only on your computer and asks macOS to trust it.
2. The proxy then makes a certificate for each domain the first time it is opened, and renews it before it expires.
3. Opening `http://shop.test` in a browser moves you to `https://shop.test`. Your service keeps speaking plain http to the proxy, so nothing changes in it.

`lcd https --off` removes the authority and its certificates.

## Good to know

- Works with any HTTP service, WebSockets included. Nothing to configure in the service.
- A domain that doesn't end in `.localhost` has to be written to `/etc/hosts`, which needs admin rights. Run `sudo lcd hosts --auto` once and every name you add later sets itself up within a few seconds (`sudo lcd hosts --auto-off` undoes it). Without it, run `sudo lcd hosts` after adding names.
- The automatic setup installs a small root helper that copies your list of names into `/etc/hosts`, always pointing at `127.0.0.1`. It runs only a root-owned shell script, never anything your user account can change.
- `.localhost` names need no setup in browsers and curl.
- **https:** `lcd https` creates a certificate authority that exists only on this computer, asks macOS to trust it, and from then on every domain gets its own certificate automatically. Chrome, Safari and Edge accept them. Firefox, Node, curl and Python keep their own lists; point them at `~/.local-custom-domain/https/ca.pem` if they need https. `lcd https --off` removes it all.
- The authority's private key stays in your home folder. Anything running as your user could use it to make certificates your browser trusts, the same trade-off as `mkcert`. Don't share that folder.
- Your services keep speaking plain http to the proxy; nothing changes in them. Programs that call `http://shop.test` keep working too; only browser page loads are moved to https.
- Use `.test` for made-up names. `.dev` and `.app` only work with https on.
- The proxy accepts connections from your machine only.
- `lcd uninstall` stops the background proxy.

## Develop

`cli.js` has no dependencies. The console at `http://localhost` is built with [UI SDK](https://github.com/vercel-labs/ui) web components from `src/` into `console.html`:

```
npm install
npm run build
npm test
```

MIT
