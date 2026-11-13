# local-custom-domain

Custom domain names for the services on your own computer.

```
lcd add shop.test 3000
```

Now `http://shop.test` opens whatever runs on port 3000.

## How it works

A small proxy runs on **port 80** of your computer. Each domain name points at `127.0.0.1`, so the browser reaches the proxy, which passes the request to your service's port. Nothing else may be using port 80. To run the proxy on another port, start it with `LCD_PORT=8080 lcd serve` and open `http://shop.test:8080`.

## Setup

Needs Node 20+ and macOS.

```
git clone https://github.com/sayantan94/local-custom-domain && cd local-custom-domain
./setup.sh
```

## Use

Open `http://localhost` to add, change and remove domain names in the browser, or use the command:

```
lcd add shop.test 3000            # any domain: http://shop.test -> 127.0.0.1:3000
lcd add shop 3000                 # one word means shop.localhost (no password needed)
lcd run api.test -- npm run dev   # picks a free port, passes it as $PORT
lcd run web.test -- vite --port {port}
lcd ls                            # domain names, and whether the proxy is up
lcd rm shop.test
```

## Good to know

- Works with any HTTP service, WebSockets included. Nothing to configure in the service.
- A new domain is written to `/etc/hosts`, which asks for your password once. `.localhost` names skip this in browsers and curl; run `sudo lcd hosts` if other programs need them too.
- Use `.test` for made-up names. Browsers force https on `.dev` and `.app`, so those won't open.
- HTTP only. The proxy listens on port 80 and accepts connections from your machine only.
- `lcd uninstall` stops the background proxy.

## Develop

`cli.js` has no dependencies. The console at `http://localhost` is built with [UI SDK](https://github.com/vercel-labs/ui) web components from `src/` into `console.html`:

```
npm install
npm run build
npm test
```

MIT
