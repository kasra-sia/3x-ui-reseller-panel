'use strict';

const express = require('express');
const { db } = require('../db');
const { verifyPassword, setFlash } = require('../auth');
const i18n = require('../i18n');

const router = express.Router();

function homeFor(role) {
  return role === 'admin' ? '/admin' : '/reseller/clients';
}

// Root: send to the right place.
router.get('/', (req, res) => {
  if (res.locals.user) return res.redirect(homeFor(res.locals.user.role));
  res.redirect('/login');
});

// Language toggle: /lang/fa or /lang/en, then back.
router.get('/lang/:lang', (req, res) => {
  const lang = i18n.normalize(req.params.lang);
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false, sameSite: 'lax' });
  const back = req.get('Referer') || '/';
  res.redirect(back);
});

router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect(homeFor(res.locals.user.role));
  res.render('login', { title: res.locals.t('login') });
});

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  // Try admin first, then reseller.
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && verifyPassword(password, admin.password_hash)) {
    req.session.uid = admin.id;
    req.session.role = 'admin';
    return res.redirect('/admin');
  }

  const reseller = db.prepare('SELECT * FROM resellers WHERE username = ?').get(username);
  if (reseller && verifyPassword(password, reseller.password_hash)) {
    if (!reseller.enabled) {
      setFlash(req, 'error', res.locals.t('err_account_disabled'));
      return res.redirect('/login');
    }
    req.session.uid = reseller.id;
    req.session.role = 'reseller';
    return res.redirect('/reseller/clients');
  }

  setFlash(req, 'error', res.locals.t('err_invalid_credentials'));
  res.redirect('/login');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
