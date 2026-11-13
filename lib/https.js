'use strict';
// HTTPS for local domain names: a private certificate authority that lives on this
// computer, and one certificate per domain signed by it. Browsers accept the
// certificates once the authority is trusted ("lcd https").
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { CMD, HTTPS_DIR, fail } = require('./config');

const CA_CERT = path.join(HTTPS_DIR, 'ca.pem');
const CA_KEY = path.join(HTTPS_DIR, 'ca-key.pem');
const CERTS_DIR = path.join(HTTPS_DIR, 'certs');
const CA_NAME = `local-custom-domain (${os.userInfo().username}@${os.hostname()})`;
const OPENSSL = fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl';
const KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

const httpsOn = () => fs.existsSync(CA_CERT) && fs.existsSync(CA_KEY);

function openssl(args) {
  try {
    execFileSync(OPENSSL, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    fail(`openssl failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function newKey(file) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}

function createAuthority() {
  fs.mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });
  const conf = path.join(HTTPS_DIR, 'ca.cnf');
  fs.writeFileSync(
    conf,
    '[req]\ndistinguished_name = dn\n[dn]\n[v3_ca]\nbasicConstraints = critical,CA:TRUE,pathlen:0\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n',
  );
  newKey(CA_KEY);
  openssl(['req', '-x509', '-new', '-key', CA_KEY, '-sha256', '-days', '3650', '-subj', `/O=local-custom-domain/CN=${CA_NAME}`, '-config', conf, '-extensions', 'v3_ca', '-out', CA_CERT]);
  fs.rmSync(conf);
}

// Key and certificate for one name, made on first use and renewed a month before expiry.
function certFor(name) {
  const keyFile = path.join(CERTS_DIR, `${name}.key`);
  const certFile = path.join(CERTS_DIR, `${name}.pem`);
  const fresh = () => {
    try {
      return new crypto.X509Certificate(fs.readFileSync(certFile)).validToDate.getTime() - Date.now() > RENEW_BEFORE_MS;
    } catch {
      return false;
    }
  };
  if (!fresh()) {
    fs.mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });
    const csr = path.join(CERTS_DIR, `${name}.csr`);
    const ext = path.join(CERTS_DIR, `${name}.ext`);
    const names = name === 'localhost' ? 'DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1' : `DNS:${name},DNS:*.${name}`;
    fs.writeFileSync(
      ext,
      `[req]\ndistinguished_name = dn\n[dn]\n[leaf]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = ${names}\nauthorityKeyIdentifier = keyid\n`,
    );
    newKey(keyFile);
    openssl(['req', '-new', '-key', keyFile, '-subj', `/CN=${name}`, '-config', ext, '-out', csr]);
    // 397 days: browsers reject longer-lived certificates
    openssl(['x509', '-req', '-in', csr, '-CA', CA_CERT, '-CAkey', CA_KEY, '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`, '-days', '397', '-sha256', '-extfile', ext, '-extensions', 'leaf', '-out', certFile]);
    fs.rmSync(csr);
    fs.rmSync(ext);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const contexts = new Map();
function secureContextFor(name) {
  const hit = contexts.get(name);
  if (hit && hit.expires - Date.now() > RENEW_BEFORE_MS) return hit.context;
  const { key, cert } = certFor(name);
  const context = tls.createSecureContext({ key, cert });
  contexts.set(name, { context, expires: new crypto.X509Certificate(cert).validToDate.getTime() });
  return context;
}

// Adds the authority to this user's keychain so browsers accept its certificates.
// macOS shows its own password dialog for this.
function trustAuthority() {
  if (process.platform !== 'darwin') {
    return console.log(`add ${CA_CERT} to your system's trusted certificate authorities to finish`);
  }
  try {
    execFileSync('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-k', KEYCHAIN, CA_CERT], { stdio: 'inherit' });
  } catch {
    fail(`the certificate was not trusted (was the password dialog cancelled?). Run "${CMD} https" again to retry.`);
  }
}

function authorityTrusted() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/security', ['verify-cert', '-c', CA_CERT], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function removeAuthority() {
  if (process.platform === 'darwin' && fs.existsSync(CA_CERT)) {
    for (const args of [['remove-trusted-cert', CA_CERT], ['delete-certificate', '-c', CA_NAME, KEYCHAIN]]) {
      try {
        execFileSync('/usr/bin/security', args, { stdio: 'ignore' });
      } catch {}
    }
  }
  fs.rmSync(HTTPS_DIR, { recursive: true, force: true });
}

module.exports = { CA_CERT, authorityTrusted, httpsOn, createAuthority, certFor, secureContextFor, trustAuthority, removeAuthority };
