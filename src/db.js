'use strict';

/**
 * SQLite (better-sqlite3) data layer: schema creation + first-run seeding.
 * One small file holds the whole schema; there is no migration framework on
 * purpose — `CREATE TABLE IF NOT EXISTS` keeps this lightweight.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { openDatabase } = require('./sqlite');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = openDatabase(config.dbFile);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resellers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  api_token    TEXT NOT NULL DEFAULT '',
  username     TEXT NOT NULL DEFAULT '',
  password     TEXT NOT NULL DEFAULT '',
  api_style    TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'classic' | 'new'
  sub_base_url TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_assignments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id      INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  inbound_id       INTEGER NOT NULL,
  inbound_remark   TEXT NOT NULL DEFAULT '',
  inbound_protocol TEXT NOT NULL DEFAULT '',
  inbound_port     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(reseller_id, server_id, inbound_id)
);

CREATE TABLE IF NOT EXISTS price_lists (
  reseller_id  INTEGER PRIMARY KEY REFERENCES resellers(id) ON DELETE CASCADE,
  price_create REAL NOT NULL DEFAULT 0,
  price_renew  REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD'
);

-- Per-reseller sale plans. A reseller creates/renews a client by picking a
-- plan, which sets the client's traffic + duration and the billed price.
CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  days        INTEGER NOT NULL DEFAULT 0,    -- 0 = no expiry
  traffic_gb  REAL NOT NULL DEFAULT 0,       -- 0 = unlimited
  price       REAL NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'تومان',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_reseller ON plans(reseller_id);

-- Local record of which client (on the real panel) belongs to which reseller.
-- The 3x-ui panel has no concept of resellers, so we track ownership here.
CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  inbound_id  INTEGER NOT NULL,
  email       TEXT NOT NULL,
  uuid        TEXT NOT NULL DEFAULT '',
  sub_id      TEXT NOT NULL DEFAULT '',
  protocol    TEXT NOT NULL DEFAULT '',
  total_gb    INTEGER NOT NULL DEFAULT 0,    -- bytes (0 = unlimited)
  expiry_time INTEGER NOT NULL DEFAULT 0,    -- epoch ms (0 = unlimited)
  created_at  INTEGER NOT NULL,
  UNIQUE(server_id, email)
);

CREATE TABLE IF NOT EXISTS bill_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id  INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  server_id    INTEGER NOT NULL,
  inbound_id   INTEGER NOT NULL,
  client_email TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,                -- 'create' | 'renew' | 'delete'
  price        REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'settled' | 'cancelled'
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Audit log shown to the admin (e.g. a reseller deleting a client). These are
-- NOT billed — they are a record of activity, separate from bill_ledger.
CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id   INTEGER NOT NULL DEFAULT 0,
  reseller_name TEXT NOT NULL DEFAULT '',
  server_id     INTEGER NOT NULL DEFAULT 0,
  server_name   TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,
  client_email  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

CREATE INDEX IF NOT EXISTS idx_clients_reseller ON clients(reseller_id);
CREATE INDEX IF NOT EXISTS idx_ledger_reseller ON bill_ledger(reseller_id);
CREATE INDEX IF NOT EXISTS idx_assign_reseller ON inbound_assignments(reseller_id);
`;

function init() {
  db.exec(SCHEMA);
  seed();
}

function seed() {
  const now = Date.now();

  // First-run admin from env.
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (adminCount === 0) {
    const username = config.adminUsername;
    const password = config.adminPassword;
    if (!password) {
      console.error(
        '[FATAL] No admin exists yet and ADMIN_PASSWORD is empty in .env. ' +
          'Set ADMIN_USERNAME/ADMIN_PASSWORD and run init again.'
      );
      console.error(
        '[خطای جدی] هنوز هیچ مدیری وجود ندارد و ADMIN_PASSWORD در .env خالی است. ' +
          'مقدار ADMIN_USERNAME/ADMIN_PASSWORD را تنظیم کنید و دوباره راه‌اندازی کنید.'
      );
      process.exit(1);
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?,?,?)').run(
      username,
      hash,
      now
    );
    console.log(`[init] Created admin account "${username}". Change the password after first login.`);
  }

  // Optional: seed a first server from env (if provided and none exist yet).
  const serverCount = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
  if (serverCount === 0 && config.panelBaseUrl && config.panelApiToken) {
    db.prepare(
      `INSERT INTO servers (name, base_url, api_token, sub_base_url, api_style, enabled, created_at)
       VALUES (?,?,?,?,?,1,?)`
    ).run('Default panel', config.panelBaseUrl, config.panelApiToken, config.panelSubBaseUrl, 'auto', now);
    console.log('[init] Seeded a "Default panel" server from .env (PANEL_BASE_URL).');
  }

  // Default app settings.
  const setIfAbsent = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  setIfAbsent.run('default_lang', config.defaultLang);
}

module.exports = { db, init };
