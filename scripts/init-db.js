'use strict';

/**
 * Initializes (or upgrades) the SQLite schema and seeds the first-run admin.
 * Safe to run multiple times — uses CREATE TABLE IF NOT EXISTS.
 *
 *   node scripts/init-db.js     (or: npm run init-db)
 */

const { db, init } = require('../src/db');

init();
console.log(`[init] Database ready (backend: ${db.backend}).`);
process.exit(0);
