'use strict';

/**
 * Entry point. Initializes the DB, wires up Express (server-rendered EJS),
 * sessions and routes, then serves over HTTPS (self-terminating, default) or
 * plain HTTP behind a reverse proxy (TLS_MODE=proxy).
 */

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const cookieSession = require('cookie-session');

const config = require('./src/config');
const { db, init } = require('./src/db');
const auth = require('./src/auth');
const settings = require('./src/settings');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const resellerRoutes = require('./src/routes/reseller');

// Ensure schema + first-run seed before serving.
init();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.tlsMode === 'proxy');

// Minimal cookie parser (for the `lang` preference) — avoids an extra dep.
app.use((req, res, next) => {
  const header = req.headers.cookie || '';
  req.cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      try {
        req.cookies[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (_) {
        req.cookies[k] = part.slice(i + 1).trim();
      }
    }
  }
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: 'rpsess',
    keys: [config.sessionSecret],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    // Cookies are not flagged Secure so login works in both self-HTTPS and
    // proxy(HTTP) modes without lockouts; they remain signed + httpOnly.
    secure: false,
  })
);

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// Locals (lang, t, user, csrf, flash) for every request.
app.use(auth.attachLocals);

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/reseller', resellerRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('error', { code: 404, message: res.locals.t('err_not_found'), title: '404' });
});

// 500
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  res.status(500);
  const message = res.locals && res.locals.t ? res.locals.t('err_server') : 'Server error';
  if (res.headersSent) return;
  try {
    res.render('error', { code: 500, message, title: '500' });
  } catch (_) {
    res.send(message);
  }
});

// --- Start server ----------------------------------------------------------
function onListening(scheme, domain) {
  const host = scheme === 'https' && domain ? domain : '0.0.0.0';
  console.log(`[server] ${config.appName || 'Reseller panel'} listening on ${scheme}://${host}:${config.port}`);
  console.log(`[server]   DB backend: ${db.backend}, default language: ${config.defaultLang}`);
  if (scheme === 'http') {
    console.log(`[server]   Reach it at http://<SERVER_IP>:${config.port} — add a domain certificate in Settings to enable HTTPS.`);
  } else {
    console.log(`[server]   Serving HTTPS for domain: ${domain || '(unset)'}`);
  }
}

function handleListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\n[FATAL] Port ${config.port} is already in use. Pick a different free APP_PORT in .env ` +
        `(must NOT be 80/443 or the 3x-ui panel's port).`
    );
    console.error(
      `[خطای جدی] پورت ${config.port} در حال استفاده است. یک APP_PORT آزاد دیگر در .env انتخاب کنید ` +
        `(نباید ۸۰/۴۴۳ یا پورت پنل 3x-ui باشد).\n`
    );
  } else if (err && err.code === 'EACCES') {
    console.error(`\n[FATAL] No permission to bind port ${config.port}. Use a high port (>1024).\n`);
  } else {
    console.error('[FATAL] Server failed to start:', err);
  }
  process.exit(1);
}

const tlsCfg = settings.effectiveTls();
let srv;
let scheme = 'http';
if (tlsCfg.mode === 'https') {
  try {
    const creds = { cert: fs.readFileSync(tlsCfg.certFile), key: fs.readFileSync(tlsCfg.keyFile) };
    srv = https.createServer(creds, app);
    scheme = 'https';
    console.log(`[server] TLS cert: ${path.basename(tlsCfg.certFile)}  key: ${path.basename(tlsCfg.keyFile)}`);
  } catch (e) {
    console.warn(`[server] Could not enable HTTPS (${e.message}). Falling back to HTTP on the server IP.`);
    srv = http.createServer(app);
    scheme = 'http';
  }
} else {
  srv = http.createServer(app);
}
srv.on('error', handleListenError);
srv.listen(config.port, () => onListening(scheme, tlsCfg.domain));
