'use strict';
// Small helpers for sending HTTP responses.
const { esc } = require('./config');
const { urlFor } = require('./domains');

function errorPage(title, detail) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.25rem;color:#0f141a;background:#fff}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#424650}a{color:#006ce0}code{background:#f3f3f7;padding:.1em .35em;border-radius:4px}
@media(prefers-color-scheme:dark){body{color:#dedee3;background:#161d26}p{color:#b4b4bb}a{color:#42b4ff}code{background:#232b37}}</style>
<h1>${esc(title)}</h1><p>${detail}</p><p><a href="${urlFor('localhost')}">Manage domain names</a></p></html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');

module.exports = { errorPage, send, sendJson };
