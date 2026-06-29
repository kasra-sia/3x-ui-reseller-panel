'use strict';

/**
 * Tiny SQLite adapter so the app runs on any VPS regardless of Node version:
 *
 *   1. Prefer `better-sqlite3` if it installed/built (normal on LTS Node via
 *      prebuilt binaries) — fast, battle-tested.
 *   2. Otherwise fall back to Node's built-in `node:sqlite` (Node >= 22.5),
 *      which needs no native compilation at all — ideal for the small RAM box.
 *
 * Both expose the same surface we use: db.exec(sql) and
 * db.prepare(sql).run/get/all(...positional params). We only ever bind
 * positional `?` params and integers for booleans, which both back-ends accept.
 */

function openDatabase(file) {
  // 1) better-sqlite3 (optional dependency)
  try {
    const Database = require('better-sqlite3');
    const impl = new Database(file);
    impl.pragma('journal_mode = WAL');
    impl.pragma('foreign_keys = ON');
    return wrap(impl, 'better-sqlite3');
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') {
      // It installed but failed to load (e.g. ABI mismatch) — note and fall back.
      console.warn('[db] better-sqlite3 unavailable, falling back to node:sqlite:', e.message);
    }
  }

  // 2) Built-in node:sqlite
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    console.error(
      '[FATAL] No SQLite backend available. Install build tools so better-sqlite3 can build, ' +
        'or use Node 22.5+ which includes node:sqlite.'
    );
    console.error(
      '[خطای جدی] هیچ پایگاه‌داده SQLite در دسترس نیست. ابزار ساخت را نصب کنید تا better-sqlite3 ساخته شود، ' +
        'یا از Node نسخه ۲۲٫۵ به بالا که شامل node:sqlite است استفاده کنید.'
    );
    process.exit(1);
  }
  const impl = new DatabaseSync(file);
  impl.exec('PRAGMA journal_mode = WAL');
  impl.exec('PRAGMA foreign_keys = ON');
  return wrap(impl, 'node:sqlite');
}

function wrap(impl, backend) {
  return {
    backend,
    exec: (sql) => impl.exec(sql),
    prepare: (sql) => impl.prepare(sql),
    // Uniform transaction helper (better-sqlite3's db.transaction has a
    // different shape; node:sqlite has none). Plain BEGIN/COMMIT/ROLLBACK
    // works identically on both.
    tx(fn) {
      impl.exec('BEGIN');
      try {
        const result = fn();
        impl.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          impl.exec('ROLLBACK');
        } catch (_) {
          /* ignore rollback error */
        }
        throw err;
      }
    },
    close: () => impl.close(),
  };
}

module.exports = { openDatabase };
