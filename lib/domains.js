'use strict';
// What counts as a valid domain name and port.
const { CMD, PROXY_PORT, HTTPS_PORT, ADMIN_HOSTS, DNS_LABEL_RE, HTTPS_ONLY_TLDS, fail } = require('./config');
const { httpsOn } = require('./https');

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
// Domain names open over https once it is set up; the console stays on http://localhost.
function urlFor(domain) {
  if (domain !== 'localhost' && httpsOn()) return `https://${domain}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}`;
  return `http://${domain}${PROXY_PORT === 80 ? '' : ':' + PROXY_PORT}`;
}

module.exports = { normalizeDomain, checkPort, warningFor, usesBuiltInDns, urlFor };
