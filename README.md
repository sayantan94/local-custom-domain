# porttag

Local services by name, not port number.

```
porttag add home 3000
```

Now `http://home.localhost` opens whatever runs on port 3000.

## Setup

Needs Node 20+ and macOS.

```
git clone https://github.com/sayantan94/porttag && cd porttag
./setup.sh
```

## Use

```
porttag add api 8080               # http://api.localhost -> 127.0.0.1:8080
porttag run web -- npm run dev     # picks a free port, passes it as $PORT
porttag run web -- vite --port {port}
porttag ls                         # names, and whether the proxy is up
porttag rm api
```

`http://localhost` lists every name. `http://localhost/api` is a short link to `http://api.localhost`.

## Good to know

- Works with any HTTP service, WebSockets included. No config, no dependencies.
- Browsers and curl resolve `*.localhost` on their own. For other tools (Node, Python, Safari) run `sudo porttag hosts` after adding names.
- HTTP only. The proxy listens on port 80 and accepts connections from your machine only.
- `porttag uninstall` stops the background proxy.

MIT
