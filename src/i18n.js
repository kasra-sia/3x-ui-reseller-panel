'use strict';

/**
 * Tiny i18n helper. Two flat JSON dictionaries (en/fa), a t(lang,key,vars)
 * lookup with {placeholder} interpolation, and a dir() for RTL/LTR.
 */

const en = require('./locales/en.json');
const fa = require('./locales/fa.json');

const dicts = { en, fa };
const LANGS = ['fa', 'en'];

function normalize(lang) {
  return lang === 'en' ? 'en' : 'fa';
}

function t(lang, key, vars) {
  const d = dicts[normalize(lang)] || fa;
  let s = d[key];
  if (s === undefined) s = en[key]; // fall back to English
  if (s === undefined) s = key; // last resort: show the key
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    }
  }
  return s;
}

function dir(lang) {
  return normalize(lang) === 'fa' ? 'rtl' : 'ltr';
}

module.exports = { t, dir, LANGS, normalize };
