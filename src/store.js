'use strict';

/**
 * Shared data-access + cross-cutting helpers used by both the admin and
 * reseller route files (bill writes, live traffic enrichment, link/QR payloads).
 */

const QRCode = require('qrcode');
const { db } = require('./db');
const panel = require('./panel');

function getServerById(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function getResellerById(id) {
  return db.prepare('SELECT id, username, enabled, created_at FROM resellers WHERE id = ?').get(id);
}

/** Price list for a reseller, with zero defaults. */
function getPrice(resellerId) {
  const row = db.prepare('SELECT * FROM price_lists WHERE reseller_id = ?').get(resellerId);
  return row || { reseller_id: resellerId, price_create: 0, price_renew: 0, currency: 'USD' };
}

/** All plans for a reseller (admin view), newest first. */
function getPlans(resellerId) {
  return db.prepare('SELECT * FROM plans WHERE reseller_id = ? ORDER BY enabled DESC, days, price').all(resellerId);
}

/** Only enabled plans (reseller create/renew dropdown). */
function getEnabledPlans(resellerId) {
  return db
    .prepare('SELECT * FROM plans WHERE reseller_id = ? AND enabled = 1 ORDER BY days, price')
    .all(resellerId);
}

/** A single plan scoped to a reseller (null if not theirs). */
function getPlan(resellerId, planId) {
  return db.prepare('SELECT * FROM plans WHERE id = ? AND reseller_id = ?').get(Number(planId), resellerId);
}

/** Inbound assignments for a reseller (joined with server info). */
function assignmentsForReseller(resellerId) {
  return db
    .prepare(
      `SELECT a.*, s.name AS server_name, s.base_url, s.enabled AS server_enabled
       FROM inbound_assignments a
       JOIN servers s ON s.id = a.server_id
       WHERE a.reseller_id = ?
       ORDER BY s.name, a.inbound_id`
    )
    .all(resellerId);
}

/** True if this reseller may operate on (server, inbound). */
function isInboundAssigned(resellerId, serverId, inboundId) {
  const row = db
    .prepare(
      'SELECT 1 FROM inbound_assignments WHERE reseller_id = ? AND server_id = ? AND inbound_id = ?'
    )
    .get(resellerId, Number(serverId), Number(inboundId));
  return !!row;
}

/** Append a bill ledger row. */
function addBill({ resellerId, serverId, inboundId, email, action, price, currency, note }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bill_ledger
       (reseller_id, server_id, inbound_id, client_email, action, price, currency, status, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`
  ).run(resellerId, serverId, Number(inboundId), email || '', action, price || 0, currency || 'USD', note || '', now, now);
}

function pendingTotalsByReseller() {
  return db
    .prepare(
      `SELECT reseller_id, currency, SUM(price) AS total
       FROM bill_ledger WHERE status = 'pending' GROUP BY reseller_id, currency`
    )
    .all();
}

/**
 * Enrich local client rows with live usage from the panel.
 * Returns a new array; on panel failure a client keeps zeroed usage and an
 * `error` flag so the UI can still render.
 */
async function enrichTraffic(clientRows) {
  const serverCache = new Map();
  const out = [];
  for (const c of clientRows) {
    let server = serverCache.get(c.server_id);
    if (!server) {
      server = getServerById(c.server_id);
      serverCache.set(c.server_id, server);
    }
    const enriched = { ...c, used: 0, total: c.total_gb || 0, live_enable: true, live_expiry: c.expiry_time, error: false };
    if (server) {
      try {
        const tr = await panel.getClientTraffic(server, c.email);
        if (tr) {
          enriched.used = (tr.up || 0) + (tr.down || 0);
          if (tr.total) enriched.total = tr.total;
          enriched.live_enable = tr.enable;
          if (tr.expiryTime) enriched.live_expiry = tr.expiryTime;
        }
      } catch (e) {
        enriched.error = true;
      }
    } else {
      enriched.error = true;
    }
    out.push(enriched);
  }
  return out;
}

/** Build the link payload (sub link + direct links) with QR data URLs. */
async function clientLinksPayload(clientRow) {
  const server = getServerById(clientRow.server_id);
  if (!server) return { subLink: '', directLinks: [], subQr: '', error: true };

  // Normalize the DB row (snake_case) to the shape the panel client expects.
  const client = {
    email: clientRow.email,
    uuid: clientRow.uuid,
    subId: clientRow.sub_id,
    protocol: clientRow.protocol,
    inbound_id: clientRow.inbound_id,
  };
  const { subLink, directLinks } = await panel.getClientLinks(server, client);
  const qrOpts = { margin: 1, width: 240 };

  const subQr = subLink ? await QRCode.toDataURL(subLink, qrOpts) : '';
  const direct = [];
  for (const d of directLinks) {
    direct.push({ remark: d.remark || '', link: d.link, qr: await QRCode.toDataURL(d.link, qrOpts) });
  }
  return { subLink, subQr, directLinks: direct, error: false };
}

/** The (enabled) server rows a reseller has any assignment on. */
function resellerServers(resellerId) {
  return db
    .prepare(
      `SELECT DISTINCT s.* FROM inbound_assignments a
       JOIN servers s ON s.id = a.server_id
       WHERE a.reseller_id = ? AND s.enabled = 1
       ORDER BY s.name`
    )
    .all(resellerId);
}

/** A specific server IF the reseller is assigned on it (else null). */
function resellerServer(resellerId, serverId) {
  return db
    .prepare(
      `SELECT s.* FROM servers s
       WHERE s.id = ? AND s.enabled = 1
         AND EXISTS (SELECT 1 FROM inbound_assignments a WHERE a.reseller_id = ? AND a.server_id = s.id)`
    )
    .get(Number(serverId), resellerId);
}

/**
 * The reseller's clients, sourced from the PANEL by group (group == username)
 * for new-API servers, falling back to the local table for classic servers.
 * Returns { clients: [...], errors: [serverName,...] }.
 */
async function listResellerClients(reseller) {
  const servers = resellerServers(reseller.id);
  const clients = [];
  const errors = [];
  for (const server of servers) {
    let style = 'new';
    try {
      style = await panel.getServerStyle(server);
    } catch (_) {
      style = 'new';
    }
    if (style === 'new') {
      try {
        const items = await panel.listGroupClients(server, reseller.username);
        for (const it of items) {
          clients.push({
            server_id: server.id,
            server_name: server.name,
            email: it.email,
            sub_id: it.subId,
            used: it.used,
            total: it.totalBytes,
            live_enable: it.enable,
            live_expiry: it.expiryTime,
            inbound_id: (it.inboundIds && it.inboundIds[0]) || 0,
            error: false,
          });
        }
      } catch (e) {
        errors.push(server.name);
      }
    } else {
      const rows = db
        .prepare(
          `SELECT c.*, s.name AS server_name FROM clients c JOIN servers s ON s.id = c.server_id
           WHERE c.reseller_id = ? AND c.server_id = ?`
        )
        .all(reseller.id, server.id);
      const enriched = await enrichTraffic(rows);
      for (const e of enriched) {
        clients.push({
          server_id: e.server_id,
          server_name: e.server_name,
          email: e.email,
          sub_id: e.sub_id,
          used: e.used,
          total: e.total,
          live_enable: e.live_enable,
          live_expiry: e.live_expiry,
          inbound_id: e.inbound_id,
          error: e.error,
        });
      }
    }
  }
  return { clients, errors };
}

/** All clients across every reseller's group (admin view), tagged with owner. */
async function listAllClients(filters = {}) {
  const servers = db.prepare('SELECT * FROM servers WHERE enabled = 1 ORDER BY name').all();
  const resellers = db.prepare('SELECT id, username FROM resellers ORDER BY username').all();
  const clients = [];
  const errors = [];
  const inboundSet = new Map(); // inbound id -> remark (for the filter dropdown)

  for (const server of servers) {
    let style = 'new';
    try {
      style = await panel.getServerStyle(server);
    } catch (_) {
      style = 'new';
    }

    if (style !== 'new') {
      // Classic servers: fall back to locally-tracked clients.
      const rows = db
        .prepare(
          `SELECT c.*, r.username AS owner FROM clients c JOIN resellers r ON r.id = c.reseller_id WHERE c.server_id = ?`
        )
        .all(server.id);
      const enriched = await enrichTraffic(rows);
      for (const e of enriched) {
        clients.push({
          server_id: e.server_id,
          server_name: server.name,
          email: e.email,
          sub_id: e.sub_id,
          used: e.used,
          total: e.total,
          live_enable: e.live_enable,
          live_expiry: e.live_expiry,
          inbound_id: e.inbound_id,
          inbound_ids: [e.inbound_id],
          reseller_id: e.reseller_id,
          owner: e.owner,
          error: e.error,
        });
      }
      continue;
    }

    // Build email -> owner (reseller) map from group memberships.
    const ownerByEmail = new Map();
    for (const r of resellers) {
      try {
        const emails = await panel.groupEmails(server, r.username);
        for (const em of emails) ownerByEmail.set(em, { reseller_id: r.id, owner: r.username });
      } catch (_) {
        /* skip this reseller's group */
      }
    }
    // Inbound remarks for the filter labels.
    try {
      const inbs = await panel.listInbounds(server);
      for (const ib of inbs) inboundSet.set(ib.id, ib.remark || `#${ib.id}`);
    } catch (_) {
      /* ignore */
    }

    try {
      const all = await panel.listPanelClients(server);
      for (const it of all) {
        const o = ownerByEmail.get(it.email) || { reseller_id: 0, owner: '—' };
        clients.push({
          server_id: server.id,
          server_name: server.name,
          email: it.email,
          sub_id: it.subId,
          used: it.used,
          total: it.totalBytes,
          live_enable: it.enable,
          live_expiry: it.expiryTime,
          inbound_id: (it.inboundIds && it.inboundIds[0]) || 0,
          inbound_ids: it.inboundIds || [],
          reseller_id: o.reseller_id,
          owner: o.owner,
          error: false,
        });
      }
    } catch (e) {
      errors.push(server.name);
    }
  }

  // Apply filters.
  let filtered = clients;
  if (filters.owner === 'none') {
    filtered = filtered.filter((c) => !c.reseller_id);
  } else if (filters.owner && filters.owner !== 'all') {
    const oid = Number(filters.owner);
    if (Number.isFinite(oid) && oid > 0) filtered = filtered.filter((c) => c.reseller_id === oid);
  }
  if (filters.inbound && filters.inbound !== 'all') {
    const iid = Number(filters.inbound);
    if (Number.isFinite(iid) && iid > 0) {
      filtered = filtered.filter((c) => (c.inbound_ids && c.inbound_ids.includes(iid)) || c.inbound_id === iid);
    }
  }
  if (filters.q) {
    const q = String(filters.q).toLowerCase().trim();
    if (q) filtered = filtered.filter((c) => (c.email || '').toLowerCase().includes(q));
  }

  const inbounds = [...inboundSet.entries()].map(([id, remark]) => ({ id, remark })).sort((a, b) => a.id - b.id);
  return { clients: filtered, errors, resellers, inbounds, total: clients.length };
}

/** Append an admin-visible activity record (e.g. a reseller deletion). Not billed. */
function addActivity({ resellerId, resellerName, serverId, serverName, action, email }) {
  db.prepare(
    `INSERT INTO activity_log (reseller_id, reseller_name, server_id, server_name, action, client_email, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(resellerId || 0, resellerName || '', serverId || 0, serverName || '', action, email || '', Date.now());
}

function listActivity(limit = 200) {
  return db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(Number(limit) || 200);
}

/** True if `email` belongs to this reseller's group on `server`. */
async function ownsGroupClient(reseller, server, email) {
  let style = 'new';
  try {
    style = await panel.getServerStyle(server);
  } catch (_) {
    style = 'new';
  }
  if (style === 'new') {
    const emails = await panel.groupEmails(server, reseller.username);
    return emails.includes(email);
  }
  const row = db
    .prepare('SELECT 1 FROM clients WHERE reseller_id = ? AND server_id = ? AND email = ?')
    .get(reseller.id, server.id, email);
  return !!row;
}

/** Link payload (sub + direct) with QR for a client by email. */
async function clientLinksByEmailPayload(server, email, subId) {
  const { subLink, directLinks } = await panel.clientLinksByEmail(server, email, subId);
  const qrOpts = { margin: 1, width: 240 };
  const subQr = subLink ? await QRCode.toDataURL(subLink, qrOpts) : '';
  const direct = [];
  for (const d of directLinks) {
    direct.push({ remark: d.remark || '', link: d.link, qr: await QRCode.toDataURL(d.link, qrOpts) });
  }
  return { subLink, subQr, directLinks: direct };
}

module.exports = {
  getServerById,
  getResellerById,
  getPrice,
  getPlans,
  getEnabledPlans,
  getPlan,
  resellerServers,
  resellerServer,
  listResellerClients,
  listAllClients,
  addActivity,
  listActivity,
  ownsGroupClient,
  clientLinksByEmailPayload,
  assignmentsForReseller,
  isInboundAssigned,
  addBill,
  pendingTotalsByReseller,
  enrichTraffic,
  clientLinksPayload,
};
