'use strict';

/**
 * Session, auth guards, CSRF and flash helpers.
 * Sessions are stored in a signed cookie (cookie-session) — no DB session
 * store needed, which keeps the memory footprint tiny.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const i18n = require('./i18n');
const format = require('./format');
const config = require('./config');

// Bumped on every process start → busts browser caches of /public assets
// after each deploy (systemd restarts the process).
const ASSET_VER = Date.now();

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch (_) {
    return false;
  }
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

/**
 * Per-request locals: language, translator, current user, CSRF token, flash.
 * Mounted before routes.
 */
function attachLocals(req, res, next) {
  // Language: ?lang override is handled by the /lang route; here read cookie.
  const cookieLang = req.cookies && req.cookies.lang;
  const lang = i18n.normalize(cookieLang || config.defaultLang);

  if (!req.session) req.session = {};

  // CSRF token (created once per session).
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }

  // Flash (one-shot).
  const flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;

  // Theme preference (dark default), read from a plain cookie like lang.
  const cookieTheme = req.cookies && req.cookies.theme;
  res.locals.theme = cookieTheme === 'light' ? 'light' : 'dark';

  res.locals.lang = lang;
  res.locals.dir = i18n.dir(lang);
  res.locals.t = (key, vars) => i18n.t(lang, key, vars);
  res.locals.fmt = format;
  res.locals.csrf = req.session.csrf;
  res.locals.assetVer = ASSET_VER;
  res.locals.flash = flash;
  res.locals.appName = i18n.t(lang, 'app_name');
  res.locals.currentPath = req.path;
  res.locals.user = currentUser(req);
  next();
}

function currentUser(req) {
  const s = req.session || {};
  if (!s.uid || !s.role) return null;
  if (s.role === 'admin') {
    const row = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(s.uid);
    return row ? { id: row.id, username: row.username, role: 'admin' } : null;
  }
  if (s.role === 'reseller') {
    const row = db.prepare('SELECT id, username, enabled FROM resellers WHERE id = ?').get(s.uid);
    if (!row || !row.enabled) return null;
    return { id: row.id, username: row.username, role: 'reseller' };
  }
  return null;
}

function setFlash(req, type, msg) {
  if (!req.session) req.session = {};
  req.session.flash = { type, msg };
}

/** Reject POSTs whose CSRF token doesn't match the session. */
function csrfProtect(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const token = (req.body && req.body._csrf) || req.get('X-CSRF-Token');
  if (!token || !req.session || token !== req.session.csrf) {
    if (req.accepts(['html', 'json']) === 'json' || req.xhr) {
      return res.status(403).json({ success: false, msg: res.locals.t('err_csrf') });
    }
    setFlash(req, 'error', res.locals.t('err_csrf'));
    return res.redirect('back');
  }
  next();
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role !== 'admin') {
    res.status(403);
    return res.render('error', { code: 403, message: res.locals.t('err_not_authorized') });
  }
  next();
}

function requireReseller(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role !== 'reseller') {
    res.status(403);
    return res.render('error', { code: 403, message: res.locals.t('err_not_authorized') });
  }
  next();
}

module.exports = {
  verifyPassword,
  hashPassword,
  attachLocals,
  setFlash,
  csrfProtect,
  requireAuth,
  requireAdmin,
  requireReseller,
};
