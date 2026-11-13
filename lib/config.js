'use strict';
// Paths, names and small shared helpers.
const os = require('os');
const path = require('path');

const CMD = 'lcd';
const HOME = process.env.LCD_HOME || path.join(os.homedir(), '.local-custom-domain');
const ROUTES_FILE = path.join(HOME, 'routes.json');
const PROXY_PORT = Number(process.env.LCD_PORT || 80);
const HTTPS_PORT = Number(process.env.LCD_HTTPS_PORT || 443);
const HTTPS_DIR = path.join(HOME, 'https');
const HOSTS_FILE = process.env.LCD_HOSTS_FILE || '/etc/hosts';
const HOSTS_BEGIN = '# >>> local-custom-domain >>>';
const HOSTS_END = '# <<< local-custom-domain <<<';
const LABEL = 'com.local-custom-domain.proxy';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const FILES = ['cli.js', 'lib', 'console.html', 'sync-hosts.sh']; // everything the installed copy needs
const LIST_FILE = path.join(HOME, 'domains.list'); // one domain per line, read by the root helper
const HELPER_LABEL = 'com.local-custom-domain.hosts';
const HELPER_PLIST = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`;
const HELPER_DIR = '/Library/Application Support/local-custom-domain';
const ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Browsers refuse plain http:// on these endings (they are on the HSTS preload list).
const HTTPS_ONLY_TLDS = new Set(['dev', 'app', 'page', 'new', 'day', 'foo', 'zip', 'mov']);

// An error the user caused (bad input); shown without a stack trace.
function fail(message, field) {
  const err = new Error(message);
  err.expected = true;
  err.field = field; // which form field the message belongs to, for the console
  throw err;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = { ROOT, CLI, HTTPS_PORT, HTTPS_DIR, CMD, HOME, ROUTES_FILE, PROXY_PORT, HOSTS_FILE, HOSTS_BEGIN, HOSTS_END, LABEL, PLIST, FILES, LIST_FILE, HELPER_LABEL, HELPER_PLIST, HELPER_DIR, ADMIN_HOSTS, DNS_LABEL_RE, HTTPS_ONLY_TLDS, fail, esc };
