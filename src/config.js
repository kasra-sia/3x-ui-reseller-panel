'use strict';

/**
 * Loads and validates configuration from environment (.env via dotenv).
 * Also auto-detects the TLS cert/key filenames inside TLS_CERT_DIR.
 *
 * Nothing secret is ever logged here.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Bilingual fatal error: print both languages, then exit.
function fatal(en, fa) {
  console.error('\n[FATAL] ' + en);
  console.error('[خطای جدی] ' + fa + '\n');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  domain: process.env.APP_DOMAIN || 'localhost',
  port: int(process.env.APP_PORT, 8443),
  tlsMode: (process.env.TLS_MODE || 'self').toLowerCase(),
  certDir: process.env.TLS_CERT_DIR || path.join(ROOT, 'cert'),
  certFile: process.env.TLS_CERT_FILE || '',
  keyFile: process.env.TLS_KEY_FILE || '',

  panelBaseUrl: (process.env.PANEL_BASE_URL || '').replace(/\/+$/, ''),
  panelApiToken: process.env.PANEL_API_TOKEN || '',
  panelSubBaseUrl: (process.env.PANEL_SUB_BASE_URL || '').replace(/\/+$/, ''),
  // Many 3x-ui panels run on a custom port with a self-signed cert. Default to
  // NOT verifying the panel's TLS cert (server-to-server, operator-owned box).
  // Set PANEL_VERIFY_TLS=true if your panel has a valid public cert.
  panelVerifyTls: bool(process.env.PANEL_VERIFY_TLS, false),

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  sessionSecret: process.env.SESSION_SECRET || '',

  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  defaultLang: (process.env.DEFAULT_LANG || 'en').toLowerCase() === 'fa' ? 'fa' : 'en',

  dbFile: process.env.DB_FILE
    ? path.resolve(ROOT, process.env.DB_FILE)
    : path.join(ROOT, 'data', 'app.sqlite'),
};

// --- Validation ------------------------------------------------------------

if (config.port === 80 || config.port === 443) {
  fatal(
    `APP_PORT must not be ${config.port}. Pick a free high port (e.g. 8443) and set it in .env.`,
    `مقدار APP_PORT نباید ${config.port} باشد. یک پورت بالای آزاد (مثلاً ۸۴۴۳) انتخاب کنید و در فایل .env تنظیم کنید.`
  );
}

if (!config.sessionSecret || config.sessionSecret.length < 16) {
  fatal(
    'SESSION_SECRET is missing or too short. Generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" and put it in .env.',
    'مقدار SESSION_SECRET تنظیم نشده یا کوتاه است. یک مقدار تصادفی بسازید و در فایل .env قرار دهید.'
  );
}

/**
 * Auto-detect the TLS cert + key files inside certDir.
 * Honors explicit TLS_CERT_FILE / TLS_KEY_FILE overrides first.
 * Returns { cert, key } absolute paths, or throws a bilingual error.
 */
function detectTlsFiles() {
  if (config.certFile && config.keyFile) {
    const cert = path.resolve(ROOT, config.certFile);
    const key = path.resolve(ROOT, config.keyFile);
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      throw new Error(`TLS_CERT_FILE/TLS_KEY_FILE were set but not found (${cert} / ${key}).`);
    }
    return { cert, key };
  }

  const dir = path.resolve(ROOT, config.certDir);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `TLS cert directory not found: ${dir}. Put the cert + key for ${config.domain} there, or set TLS_MODE=proxy.`
    );
  }

  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());

  // Key candidates: privkey*.pem, *.key
  const keyCand = files.find((f) => /privkey.*\.pem$/i.test(f)) || files.find((f) => /\.key$/i.test(f));
  // Cert candidates: fullchain*.pem preferred, then *.crt/*.cert/*.pem (but not the key)
  const certCand =
    files.find((f) => /fullchain.*\.pem$/i.test(f)) ||
    files.find((f) => /\.(crt|cert|cer)$/i.test(f)) ||
    files.find((f) => /\.pem$/i.test(f) && f !== keyCand);

  if (!certCand || !keyCand) {
    throw new Error(
      `Could not auto-detect TLS cert/key in ${dir}. Found: [${files.join(', ') || 'nothing'}]. ` +
        `Expected a cert (fullchain.pem / *.crt) and a key (privkey.pem / *.key), or set TLS_CERT_FILE & TLS_KEY_FILE.`
    );
  }

  return { cert: path.join(dir, certCand), key: path.join(dir, keyCand) };
}

config.detectTlsFiles = detectTlsFiles;

module.exports = config;
