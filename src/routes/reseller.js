'use strict';

const express = require('express');
const { db } = require('../db');
const { requireReseller, csrfProtect, setFlash } = require('../auth');
const panel = require('../panel');
const store = require('../store');
const format = require('../format');
const telegram = require('../telegram');

const router = express.Router();

router.use(requireReseller);
router.use(csrfProtect);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inbounds this reseller may use (only on enabled servers). */
function allowedInbounds(resellerId) {
  return db
    .prepare(
      `SELECT a.server_id, a.inbound_id, a.inbound_remark, a.inbound_protocol, a.inbound_port,
              s.name AS server_name
       FROM inbound_assignments a
       JOIN servers s ON s.id = a.server_id
       WHERE a.reseller_id = ? AND s.enabled = 1
       ORDER BY s.name, a.inbound_id`
    )
    .all(resellerId);
}

// --- Client list (sourced from the panel by group == username) -------------
router.get('/clients', async (req, res) => {
  const reseller = res.locals.user;
  const { clients, errors } = await store.listResellerClients(reseller);
  res.render('reseller/clients', {
    title: res.locals.t('clients_title'),
    active: 'clients',
    clients,
    panelErrors: errors,
    inbounds: allowedInbounds(reseller.id),
    plans: store.getEnabledPlans(reseller.id),
    fmt: format,
    isAdmin: false,
  });
});

// --- Create client ---------------------------------------------------------
router.post('/clients', async (req, res) => {
  const reseller = res.locals.user;
  const email = (req.body.email || '').trim();
  const [serverId, inboundId] = String(req.body.target || '').split(':').map((x) => Number(x));
  const plan = store.getPlan(reseller.id, req.body.plan_id);

  if (!email || !serverId || !inboundId || !plan) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/reseller/clients');
  }
  // Server-side enforcement: the inbound must be assigned to THIS reseller.
  if (!store.isInboundAssigned(reseller.id, serverId, inboundId)) {
    setFlash(req, 'error', res.locals.t('err_inbound_not_allowed'));
    return res.redirect('/reseller/clients');
  }
  const server = store.getServerById(serverId);
  const assignment = db
    .prepare('SELECT * FROM inbound_assignments WHERE reseller_id=? AND server_id=? AND inbound_id=?')
    .get(reseller.id, serverId, inboundId);
  if (!server || !assignment) {
    setFlash(req, 'error', res.locals.t('err_not_found'));
    return res.redirect('/reseller/clients');
  }

  const client = {
    email,
    uuid: panel.uuid(),
    subId: panel.uuid().replace(/-/g, '').slice(0, 16),
    totalBytes: format.gbToBytes(plan.traffic_gb),
    expiryTime: plan.days > 0 ? Date.now() + plan.days * DAY_MS : 0,
    limitIp: 0,
    enable: true,
    flow: '',
    protocol: assignment.inbound_protocol,
    group: reseller.username, // label the client with the reseller's group
  };

  try {
    await panel.addClient(server, inboundId, client);
  } catch (e) {
    setFlash(req, 'error', res.locals.t('err_panel', { msg: e.message }));
    return res.redirect('/reseller/clients');
  }

  // Keep a local audit row (listing itself is sourced from the panel group).
  db.prepare(
    `INSERT OR IGNORE INTO clients (reseller_id, server_id, inbound_id, email, uuid, sub_id, protocol, total_gb, expiry_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    reseller.id,
    serverId,
    inboundId,
    email,
    client.uuid,
    client.subId,
    client.protocol,
    client.totalBytes,
    client.expiryTime,
    Date.now()
  );

  store.addBill({
    resellerId: reseller.id,
    serverId,
    inboundId,
    email,
    action: 'create',
    price: plan.price,
    currency: plan.currency,
    note: plan.name,
  });
  telegram.notifyClientAction({
    action: 'create',
    resellerName: reseller.username,
    serverName: server.name,
    inboundRemark: assignment.inbound_remark || `#${inboundId}`,
    email,
    price: plan.price,
    currency: plan.currency,
  });

  setFlash(req, 'success', res.locals.t('client_created'));
  res.redirect('/reseller/clients');
});

// --- Renew client (by server + email) --------------------------------------
router.post('/clients/:serverId/renew', async (req, res) => {
  const reseller = res.locals.user;
  const email = (req.body.email || '').trim();
  const server = store.resellerServer(reseller.id, req.params.serverId);
  const plan = store.getPlan(reseller.id, req.body.plan_id);
  if (!server || !email || !plan) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/reseller/clients');
  }
  if (!(await store.ownsGroupClient(reseller, server, email))) {
    setFlash(req, 'error', res.locals.t('err_inbound_not_allowed'));
    return res.redirect('/reseller/clients');
  }

  try {
    await panel.renewClientByEmail(server, email, {
      addDays: plan.days,
      addBytes: format.gbToBytes(plan.traffic_gb),
    });
  } catch (e) {
    setFlash(req, 'error', res.locals.t('err_panel', { msg: e.message }));
    return res.redirect('/reseller/clients');
  }

  store.addBill({
    resellerId: reseller.id,
    serverId: server.id,
    inboundId: 0,
    email,
    action: 'renew',
    price: plan.price,
    currency: plan.currency,
    note: plan.name,
  });
  telegram.notifyClientAction({
    action: 'renew',
    resellerName: reseller.username,
    serverName: server.name,
    inboundRemark: '',
    email,
    price: plan.price,
    currency: plan.currency,
  });

  setFlash(req, 'success', res.locals.t('client_renewed'));
  res.redirect('/reseller/clients');
});

// --- Delete client (by server + email) -------------------------------------
router.post('/clients/:serverId/delete', async (req, res) => {
  const reseller = res.locals.user;
  const email = (req.body.email || '').trim();
  const server = store.resellerServer(reseller.id, req.params.serverId);
  if (!server || !email) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/reseller/clients');
  }
  if (!(await store.ownsGroupClient(reseller, server, email))) {
    setFlash(req, 'error', res.locals.t('err_inbound_not_allowed'));
    return res.redirect('/reseller/clients');
  }

  try {
    await panel.deleteClientByEmail(server, email);
  } catch (e) {
    setFlash(req, 'error', res.locals.t('err_panel', { msg: e.message }));
    return res.redirect('/reseller/clients');
  }

  db.prepare('DELETE FROM clients WHERE reseller_id=? AND server_id=? AND email=?').run(reseller.id, server.id, email);

  // Deletions are logged for the admin to see — NOT billed.
  store.addActivity({
    resellerId: reseller.id,
    resellerName: reseller.username,
    serverId: server.id,
    serverName: server.name,
    action: 'delete',
    email,
  });
  telegram.notifyClientAction({
    action: 'delete',
    resellerName: reseller.username,
    serverName: server.name,
    inboundRemark: '',
    email,
  });

  setFlash(req, 'success', res.locals.t('client_deleted'));
  res.redirect('/reseller/clients');
});

// --- Links (AJAX, by server + email) ---------------------------------------
router.get('/clients/:serverId/links', async (req, res) => {
  const reseller = res.locals.user;
  const email = (req.query.email || '').trim();
  const subId = (req.query.subId || '').trim();
  const server = store.resellerServer(reseller.id, req.params.serverId);
  if (!server || !email) return res.status(404).json({ success: false, msg: res.locals.t('err_not_found') });
  if (!(await store.ownsGroupClient(reseller, server, email))) {
    return res.status(403).json({ success: false, msg: res.locals.t('err_inbound_not_allowed') });
  }
  try {
    const payload = await store.clientLinksByEmailPayload(server, email, subId);
    res.json({ success: true, ...payload, email });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

// --- Billing ---------------------------------------------------------------
router.get('/billing', (req, res) => {
  const resellerId = res.locals.user.id;
  const rows = db
    .prepare(
      `SELECT b.*, s.name AS server_name
       FROM bill_ledger b LEFT JOIN servers s ON s.id = b.server_id
       WHERE b.reseller_id = ? ORDER BY b.created_at DESC`
    )
    .all(resellerId);
  const pendingTotal = rows.filter((r) => r.status === 'pending').reduce((sum, r) => sum + (r.price || 0), 0);
  res.render('reseller/billing', {
    title: res.locals.t('billing_title'),
    active: 'billing',
    rows,
    pendingTotal,
    isAdmin: false,
  });
});

router.post('/billing/:id/status', (req, res) => {
  const resellerId = res.locals.user.id;
  const status = req.body.status;
  if (!['pending', 'settled', 'cancelled'].includes(status)) return res.redirect('/reseller/billing');
  db.prepare('UPDATE bill_ledger SET status=?, updated_at=? WHERE id=? AND reseller_id=?').run(
    status,
    Date.now(),
    Number(req.params.id),
    resellerId
  );
  res.redirect('/reseller/billing');
});

module.exports = router;
