'use strict';

/**
 * Runtime settings stored in the SQLite `settings` table (key/value), plus the
 * "effective TLS" decision used at startup.
 *
 * TLS precedence (first match wins):
 *   1. DB settings tls_cert_path + tls_key_path (set from the admin UI) — both
 *      present and the files exist  -> HTTPS on the domain.
 *   2. Legacy env TLS_MODE=self with auto-detectable certs in TLS_CERT_DIR
 *      -> HTTPS (back-compat with older deployments).
 *   3. Otherwise -> plain HTTP on the server IP (the fresh-install default).
 *
 * This keeps a brand-new install reachable over http://<ip>:<port> immediately,
 * and lets the admin switch to https://<domain>:<port> later from Settings,
 * exactly like the 3x-ui panel's own certificate fields.
 */

const fs = require('fs');
const { db } = require('./db');
const config = require('./config');

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? '' : String(value));
}

/** The domain + cert/key paths the admin configured (may be empty strings). */
function getTlsSettings() {
  return {
    domain: getSetting('site_domain', ''),
    certPath: getSetting('tls_cert_path', ''),
    keyPath: getSetting('tls_key_path', ''),
  };
}

function readable(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Decide how to serve. Returns:
 *   { mode: 'https', certFile, keyFile, domain }  or  { mode: 'http', domain }
 */
function effectiveTls() {
  const s = getTlsSettings();
  const domain = s.domain || config.domain || '';

  // 1) UI-configured certificate.
  if (s.certPath && s.keyPath && readable(s.certPath) && readable(s.keyPath)) {
    return { mode: 'https', certFile: s.certPath, keyFile: s.keyPath, domain };
  }

  // 2) Legacy env self-mode (detectTlsFiles throws if not found -> fall through).
  if (config.tlsMode === 'self') {
    try {
      const { cert, key } = config.detectTlsFiles();
      return { mode: 'https', certFile: cert, keyFile: key, domain };
    } catch (_) {
      /* no usable env certs -> http */
    }
  }

  // 3) Plain HTTP on the IP.
  return { mode: 'http', domain };
}

module.exports = { getSetting, setSetting, getTlsSettings, effectiveTls };
