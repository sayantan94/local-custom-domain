'use strict';
// What counts as a valid domain name and port.
const { CMD, PROXY_PORT, HTTPS_PORT, ADMIN_HOSTS, DNS_LABEL_RE, HTTPS_ONLY_TLDS, fail } = require('./config');
const { httpsOn } = require('./https');
const { loadHttpOnly } = require('./store');

// "shop" -> "shop.localhost"; "Shop.Test" / "http://shop.test/x" -> "shop.test"
function normalizeDomain(input) {
  let d = String(input ?? '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  if (!d) fail('enter a domain name, for example shop.test', 'domain');
  if (ADMIN_HOSTS.has(d) || /^\d+(\.\d+){3}$/.test(d)) fail(`"${d}" is reserved; choose a name such as shop.test`, 'domain');
  if (!d.includes('.')) d += '.localhost';
  if (d.length > 253 || !d.split('.').every((label) => DNS_LABEL_RE.test(label))) {
    fail(`"${input}" is not a valid domain name (use letters, digits, dashes and dots, e.g. shop.test)`, 'domain');
  }
  return d;
}

function checkPort(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`"${input}" is not a valid port (1 to 65535)`, 'port');
  if (n === PROXY_PORT) fail(`port ${n} is used by ${CMD} itself`, 'port');
  return n;
}

function warningFor(domain) {
  const tld = domain.split('.').pop();
  if (HTTPS_ONLY_TLDS.has(tld) && !httpsOn()) return `Browsers only allow https:// on .${tld} names, so http://${domain} will not open. Use .test, or turn on https with "${CMD} https".`;
  if (tld === 'local') return 'macOS uses .local for network discovery, which makes these names slow to open. Use .test instead.';
  return null;
}

const usesBuiltInDns = (domain) => domain.endsWith('.localhost');
// A domain opens over https once https is set up, unless it was added as http.
const usesHttps = (domain) => httpsOn() && !loadHttpOnly().has(domain);

// "http", "https" or nothing; https needs the one-time setup first.
function checkScheme(input) {
  if (input === undefined || input === null || input === '') return undefined;
  if (input !== 'http' && input !== 'https') fail(`"${input}" is not a scheme; use http or https`, 'domain');
  if (input === 'https' && !httpsOn()) fail(`https is not set up yet. Run "${CMD} https" in a terminal first, or choose http.`, 'domain');
  return input;
}

// The console stays on http://localhost.
function urlFor(domain) {
  if (domain !== 'localhost' && usesHttps(domain)) return `https://${domain}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}`;
  return `http://${domain}${PROXY_PORT === 80 ? '' : ':' + PROXY_PORT}`;
}

module.exports = { usesHttps, checkScheme, normalizeDomain, checkPort, warningFor, usesBuiltInDns, urlFor };
