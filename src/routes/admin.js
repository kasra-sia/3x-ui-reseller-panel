'use strict';

const express = require('express');
const fs = require('fs');
const tlsLib = require('tls');
const { db } = require('../db');
const { requireAdmin, csrfProtect, setFlash, hashPassword, verifyPassword } = require('../auth');
const config = require('../config');
const panel = require('../panel');
const store = require('../store');
const settings = require('../settings');
const format = require('../format');

const router = express.Router();

router.use(requireAdmin);
router.use(csrfProtect);

// --- Overview --------------------------------------------------------------
router.get('/', (req, res) => {
  const stats = {
    resellers: db.prepare('SELECT COUNT(*) AS c FROM resellers').get().c,
    servers: db.prepare('SELECT COUNT(*) AS c FROM servers').get().c,
    clients: db.prepare('SELECT COUNT(*) AS c FROM clients').get().c,
    pending: db.prepare("SELECT COALESCE(SUM(price),0) AS s FROM bill_ledger WHERE status='pending'").get().s,
  };
  res.render('admin/overview', { title: res.locals.t('overview_title'), active: 'overview', stats });
});

// --- Resellers -------------------------------------------------------------
router.get('/resellers', (req, res) => {
  const resellers = db
    .prepare(
      `SELECT r.*,
        (SELECT COUNT(*) FROM clients c WHERE c.reseller_id = r.id) AS client_count
       FROM resellers r ORDER BY r.username`
    )
    .all();
  res.render('admin/resellers', { title: res.locals.t('resellers_title'), active: 'resellers', resellers });
});

router.post('/resellers', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/admin/resellers');
  }
  const exists = db.prepare('SELECT 1 FROM resellers WHERE username = ?').get(username);
  if (exists) {
    setFlash(req, 'error', res.locals.t('err_username_taken'));
    return res.redirect('/admin/resellers');
  }
  const enabled = req.body.enabled ? 1 : 0;
  db.prepare('INSERT INTO resellers (username, password_hash, enabled, created_at) VALUES (?,?,?,?)').run(
    username,
    hashPassword(password),
    enabled,
    Date.now()
  );
  setFlash(req, 'success', res.locals.t('reseller_created'));
  res.redirect('/admin/resellers');
});

router.post('/resellers/:id/update', (req, res) => {
  const id = Number(req.params.id);
  const reseller = store.getResellerById(id);
  if (!reseller) {
    setFlash(req, 'error', res.locals.t('err_not_found'));
    return res.redirect('/admin/resellers');
  }
  const enabled = req.body.enabled ? 1 : 0;
  db.prepare('UPDATE resellers SET enabled = ? WHERE id = ?').run(enabled, id);
  if (req.body.password) {
    db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
  }
  setFlash(req, 'success', res.locals.t('reseller_updated'));
  res.redirect('/admin/resellers');
});

router.post('/resellers/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM resellers WHERE id = ?').run(id);
  setFlash(req, 'success', res.locals.t('reseller_deleted'));
  res.redirect('/admin/resellers');
});

// --- Inbound assignments ---------------------------------------------------
router.get('/resellers/:id/assignments', async (req, res) => {
  const id = Number(req.params.id);
  const reseller = store.getResellerById(id);
  if (!reseller) return res.redirect('/admin/resellers');

  const servers = db.prepare('SELECT * FROM servers ORDER BY name').all();
  const selectedServerId = req.query.server ? Number(req.query.server) : servers[0] && servers[0].id;
  const server = selectedServerId ? store.getServerById(selectedServerId) : null;

  let inbounds = [];
  let panelError = null;
  if (server) {
    try {
      inbounds = await panel.listInbounds(server);
    } catch (e) {
      panelError = e.message;
    }
  }

  const assignedRows = server
    ? db
        .prepare('SELECT inbound_id FROM inbound_assignments WHERE reseller_id = ? AND server_id = ?')
        .all(id, server.id)
    : [];
  const assignedSet = new Set(assignedRows.map((r) => r.inbound_id));

  res.render('admin/assignments', {
    title: res.locals.t('assign_for', { name: reseller.username }),
    active: 'resellers',
    reseller,
    servers,
    server,
    inbounds,
    assignedSet,
    panelError,
  });
});

router.post('/resellers/:id/assignments', (req, res) => {
  const id = Number(req.params.id);
  const serverId = Number(req.body.server_id);
  if (!store.getResellerById(id) || !store.getServerById(serverId)) {
    setFlash(req, 'error', res.locals.t('err_not_found'));
    return res.redirect('/admin/resellers');
  }

  // meta = JSON of all inbounds shown [{id,remark,protocol,port}]
  let meta = [];
  try {
    meta = JSON.parse(req.body.meta || '[]');
  } catch (_) {
    meta = [];
  }
  const metaById = new Map(meta.map((m) => [String(m.id), m]));

  let checked = req.body.inbounds || [];
  if (!Array.isArray(checked)) checked = [checked];
  checked = checked.map((x) => Number(x)).filter((n) => Number.isFinite(n));

  db.tx(() => {
    db.prepare('DELETE FROM inbound_assignments WHERE reseller_id = ? AND server_id = ?').run(id, serverId);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO inbound_assignments
         (reseller_id, server_id, inbound_id, inbound_remark, inbound_protocol, inbound_port)
       VALUES (?,?,?,?,?,?)`
    );
    for (const inboundId of checked) {
      const m = metaById.get(String(inboundId)) || {};
      ins.run(id, serverId, inboundId, m.remark || '', m.protocol || '', Number(m.port) || 0);
    }
  });

  setFlash(req, 'success', res.locals.t('assignments_saved'));
  res.redirect(`/admin/resellers/${id}/assignments?server=${serverId}`);
});

// --- Plans (per-reseller pricing) ------------------------------------------
router.get('/resellers/:id/pricing', (req, res) => {
  const id = Number(req.params.id);
  const reseller = store.getResellerById(id);
  if (!reseller) return res.redirect('/admin/resellers');
  res.render('admin/plans', {
    title: res.locals.t('plans_for', { name: reseller.username }),
    active: 'resellers',
    reseller,
    plans: store.getPlans(id),
  });
});

function planFromBody(b) {
  return {
    name: (b.name || '').trim(),
    days: parseInt(b.days, 10) || 0,
    traffic_gb: parseFloat(b.traffic_gb) || 0,
    price: parseFloat(b.price) || 0,
    currency: (b.currency || 'تومان').trim().slice(0, 12) || 'تومان',
    enabled: b.enabled ? 1 : 0,
  };
}

router.post('/resellers/:id/plans', (req, res) => {
  const id = Number(req.params.id);
  if (!store.getResellerById(id)) return res.redirect('/admin/resellers');
  const p = planFromBody(req.body);
  if (!p.name) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect(`/admin/resellers/${id}/pricing`);
  }
  db.prepare(
    `INSERT INTO plans (reseller_id, name, days, traffic_gb, price, currency, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, p.name, p.days, p.traffic_gb, p.price, p.currency, p.enabled, Date.now());
  setFlash(req, 'success', res.locals.t('plan_created'));
  res.redirect(`/admin/resellers/${id}/pricing`);
});

router.post('/resellers/:id/plans/:planId/update', (req, res) => {
  const id = Number(req.params.id);
  const planId = Number(req.params.planId);
  if (!store.getPlan(id, planId)) return res.redirect(`/admin/resellers/${id}/pricing`);
  const p = planFromBody(req.body);
  if (!p.name) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect(`/admin/resellers/${id}/pricing`);
  }
  db.prepare(
    'UPDATE plans SET name=?, days=?, traffic_gb=?, price=?, currency=?, enabled=? WHERE id=? AND reseller_id=?'
  ).run(p.name, p.days, p.traffic_gb, p.price, p.currency, p.enabled, planId, id);
  setFlash(req, 'success', res.locals.t('plan_updated'));
  res.redirect(`/admin/resellers/${id}/pricing`);
});

router.post('/resellers/:id/plans/:planId/delete', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM plans WHERE id=? AND reseller_id=?').run(Number(req.params.planId), id);
  setFlash(req, 'success', res.locals.t('plan_deleted'));
  res.redirect(`/admin/resellers/${id}/pricing`);
});

// --- Servers ---------------------------------------------------------------
router.get('/servers', (req, res) => {
  const servers = db.prepare('SELECT * FROM servers ORDER BY name').all();
  res.render('admin/servers', { title: res.locals.t('servers_title'), active: 'servers', servers });
});

function serverFromBody(b) {
  return {
    name: (b.name || '').trim(),
    base_url: (b.base_url || '').trim().replace(/\/+$/, ''),
    api_token: (b.api_token || '').trim(),
    username: (b.username || '').trim(),
    password: b.password || '',
    api_style: ['auto', 'classic', 'new'].includes(b.api_style) ? b.api_style : 'auto',
    sub_base_url: (b.sub_base_url || '').trim().replace(/\/+$/, ''),
    enabled: b.enabled ? 1 : 0,
  };
}

router.post('/servers', (req, res) => {
  const s = serverFromBody(req.body);
  if (!s.name || !s.base_url) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/admin/servers');
  }
  db.prepare(
    `INSERT INTO servers (name, base_url, api_token, username, password, api_style, sub_base_url, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(s.name, s.base_url, s.api_token, s.username, s.password, s.api_style, s.sub_base_url, s.enabled, Date.now());
  setFlash(req, 'success', res.locals.t('server_created'));
  res.redirect('/admin/servers');
});

router.post('/servers/:id/update', (req, res) => {
  const id = Number(req.params.id);
  const existing = store.getServerById(id);
  if (!existing) return res.redirect('/admin/servers');
  const s = serverFromBody(req.body);
  // Keep existing token/password if the field was left blank (so they aren't wiped).
  const api_token = s.api_token || existing.api_token;
  const password = s.password || existing.password;
  db.prepare(
    `UPDATE servers SET name=?, base_url=?, api_token=?, username=?, password=?, api_style=?, sub_base_url=?, enabled=?
     WHERE id=?`
  ).run(s.name, s.base_url, api_token, s.username, password, s.api_style, s.sub_base_url, s.enabled, id);
  panel._clearCaches(id);
  setFlash(req, 'success', res.locals.t('server_updated'));
  res.redirect('/admin/servers');
});

router.post('/servers/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  panel._clearCaches(id);
  setFlash(req, 'success', res.locals.t('server_deleted'));
  res.redirect('/admin/servers');
});

// Test connection (AJAX). Uses the values in the form (may be unsaved).
router.post('/servers/test', express.json(), async (req, res) => {
  const b = req.body || {};
  // If an existing server id is given and token/password are blank, fill from DB.
  let token = (b.api_token || '').trim();
  let password = b.password || '';
  if (b.id) {
    const existing = store.getServerById(Number(b.id));
    if (existing) {
      if (!token) token = existing.api_token;
      if (!password) password = existing.password;
    }
  }
  const temp = {
    id: 0,
    base_url: (b.base_url || '').trim().replace(/\/+$/, ''),
    api_token: token,
    username: (b.username || '').trim(),
    password,
    api_style: ['auto', 'classic', 'new'].includes(b.api_style) ? b.api_style : 'auto',
  };
  if (!temp.base_url) return res.json({ success: false, msg: res.locals.t('err_missing_fields') });
  try {
    panel._clearCaches(0);
    const r = await panel.testConnection(temp);
    res.json({ success: true, msg: res.locals.t('test_ok', { style: r.style, count: r.inboundCount }) });
  } catch (e) {
    res.json({ success: false, msg: res.locals.t('test_failed', { msg: e.message }) });
  } finally {
    panel._clearCaches(0);
  }
});

// --- Clients (group-aware, across all resellers) ---------------------------
router.get('/clients', async (req, res) => {
  const filters = {
    owner: req.query.owner || 'all',
    inbound: req.query.inbound || 'all',
    q: req.query.q || '',
  };
  const { clients, errors, resellers, inbounds } = await store.listAllClients(filters);
  const t = res.locals.t;
  const planLabel = (p) => {
    const dur = p.days > 0 ? t('days_n', { n: p.days }) : t('no_expiry');
    const tr = p.traffic_gb > 0 ? p.traffic_gb + ' GB' : t('unlimited');
    return `${p.name} — ${dur} · ${tr} · ${Number(p.price).toLocaleString()} ${p.currency}`;
  };
  const plansByReseller = {};
  for (const r of db.prepare('SELECT id FROM resellers').all()) {
    plansByReseller[r.id] = store.getEnabledPlans(r.id).map((p) => ({ id: p.id, label: planLabel(p) }));
  }
  res.render('admin/clients', {
    title: res.locals.t('clients_title'),
    active: 'clients',
    clients,
    panelErrors: errors,
    plansByReseller,
    resellers,
    inbounds,
    filters,
    isAdmin: true,
  });
});

// Admin can act on ANY client (no group restriction), keyed by server + email.
router.get('/clients/:serverId/links', async (req, res) => {
  const server = store.getServerById(Number(req.params.serverId));
  const email = (req.query.email || '').trim();
  const subId = (req.query.subId || '').trim();
  if (!server || !email) return res.status(404).json({ success: false, msg: res.locals.t('err_not_found') });
  try {
    const payload = await store.clientLinksByEmailPayload(server, email, subId);
    res.json({ success: true, ...payload, email });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

router.post('/clients/:serverId/renew', async (req, res) => {
  const server = store.getServerById(Number(req.params.serverId));
  const email = (req.body.email || '').trim();
  const resellerId = Number(req.body.reseller_id);
  const plan = store.getPlan(resellerId, req.body.plan_id);
  if (!server || !email || !plan) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/admin/clients');
  }
  try {
    await panel.renewClientByEmail(server, email, { addDays: plan.days, addBytes: format.gbToBytes(plan.traffic_gb) });
  } catch (e) {
    setFlash(req, 'error', res.locals.t('err_panel', { msg: e.message }));
    return res.redirect('/admin/clients');
  }
  store.addBill({
    resellerId,
    serverId: server.id,
    inboundId: 0,
    email,
    action: 'renew',
    price: plan.price,
    currency: plan.currency,
    note: plan.name + ' (admin)',
  });
  setFlash(req, 'success', res.locals.t('client_renewed'));
  res.redirect('/admin/clients');
});

router.post('/clients/:serverId/delete', async (req, res) => {
  const server = store.getServerById(Number(req.params.serverId));
  const email = (req.body.email || '').trim();
  const resellerId = Number(req.body.reseller_id) || 0;
  if (!server || !email) {
    setFlash(req, 'error', res.locals.t('err_missing_fields'));
    return res.redirect('/admin/clients');
  }
  try {
    await panel.deleteClientByEmail(server, email);
  } catch (e) {
    setFlash(req, 'error', res.locals.t('err_panel', { msg: e.message }));
    return res.redirect('/admin/clients');
  }
  db.prepare('DELETE FROM clients WHERE server_id=? AND email=?').run(server.id, email);
  // Record as activity (admin acted), not as a bill entry.
  store.addActivity({
    resellerId: 0,
    resellerName: 'admin',
    serverId: server.id,
    serverName: server.name,
    action: 'delete',
    email,
  });
  setFlash(req, 'success', res.locals.t('client_deleted'));
  res.redirect('/admin/clients');
});

// --- Billing ---------------------------------------------------------------
router.get('/billing', (req, res) => {
  const resellers = db.prepare('SELECT id, username FROM resellers ORDER BY username').all();
  const filter = req.query.reseller ? Number(req.query.reseller) : 0;
  let rows;
  if (filter) {
    rows = db
      .prepare(
        `SELECT b.*, r.username AS reseller_name, s.name AS server_name
         FROM bill_ledger b JOIN resellers r ON r.id = b.reseller_id
         LEFT JOIN servers s ON s.id = b.server_id
         WHERE b.reseller_id = ? ORDER BY b.created_at DESC`
      )
      .all(filter);
  } else {
    rows = db
      .prepare(
        `SELECT b.*, r.username AS reseller_name, s.name AS server_name
         FROM bill_ledger b JOIN resellers r ON r.id = b.reseller_id
         LEFT JOIN servers s ON s.id = b.server_id
         ORDER BY b.created_at DESC`
      )
      .all();
  }
  const pendingTotal = rows
    .filter((r) => r.status === 'pending')
    .reduce((sum, r) => sum + (r.price || 0), 0);
  res.render('admin/billing', {
    title: res.locals.t('billing_title'),
    active: 'billing',
    rows,
    resellers,
    filter,
    pendingTotal,
    activity: store.listActivity(100),
    isAdmin: true,
  });
});

router.post('/billing/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!['pending', 'settled', 'cancelled'].includes(status)) {
    return res.redirect('/admin/billing');
  }
  db.prepare('UPDATE bill_ledger SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  setFlash(req, 'success', res.locals.t('success'));
  res.redirect(req.get('Referer') || '/admin/billing');
});

// Admin can permanently delete a ledger entry.
router.post('/billing/:id/delete', (req, res) => {
  db.prepare('DELETE FROM bill_ledger WHERE id = ?').run(Number(req.params.id));
  setFlash(req, 'success', res.locals.t('bill_deleted'));
  res.redirect(req.get('Referer') || '/admin/billing');
});

// --- Settings --------------------------------------------------------------
router.get('/settings', (req, res) => {
  const telegramOn = !!(config.telegramBotToken && config.telegramChatId);
  const tlsCfg = settings.getTlsSettings();
  const eff = settings.effectiveTls();
  res.render('admin/settings', {
    title: res.locals.t('settings_title'),
    active: 'settings',
    telegramOn,
    tlsCfg,
    scheme: eff.mode,
    domain: eff.domain || tlsCfg.domain || (req.headers.host || '').split(':')[0],
    port: config.port,
  });
});

router.post('/settings/password', (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(res.locals.user.id);
  const { current_password, new_password, confirm_password } = req.body;
  if (!admin || !verifyPassword(current_password || '', admin.password_hash)) {
    setFlash(req, 'error', res.locals.t('wrong_current_password'));
    return res.redirect('/admin/settings');
  }
  if (!new_password || new_password !== confirm_password) {
    setFlash(req, 'error', res.locals.t('password_mismatch'));
    return res.redirect('/admin/settings');
  }
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), admin.id);
  setFlash(req, 'success', res.locals.t('password_changed'));
  res.redirect('/admin/settings');
});

// --- TLS / domain (HTTPS) --------------------------------------------------
// Validate that the given cert + key files exist and form a usable TLS pair.
function validateCertPaths(certPath, keyPath) {
  if (!certPath || !keyPath) return { ok: false, msg: 'Both certificate and key paths are required.' };
  let cert, key;
  try {
    cert = fs.readFileSync(certPath);
  } catch (e) {
    return { ok: false, msg: `certificate not readable: ${certPath}` };
  }
  try {
    key = fs.readFileSync(keyPath);
  } catch (e) {
    return { ok: false, msg: `private key not readable: ${keyPath}` };
  }
  try {
    tlsLib.createSecureContext({ cert, key });
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  return { ok: true };
}

// Exit so the supervisor (systemd, Restart=always) starts a fresh process that
// re-reads the TLS settings. This is how applying a domain certificate "takes".
function scheduleRestart() {
  setTimeout(() => {
    console.log('[server] Restarting to apply TLS/domain change…');
    process.exit(0);
  }, 1200);
}

// Validate cert/key paths without saving (AJAX, used by the "Validate" button).
router.post('/settings/tls-test', express.json(), (req, res) => {
  const v = validateCertPaths((req.body.tls_cert_path || '').trim(), (req.body.tls_key_path || '').trim());
  if (v.ok) return res.json({ success: true, msg: res.locals.t('tls_valid') });
  res.json({ success: false, msg: res.locals.t('tls_invalid', { msg: v.msg }) });
});

// Save domain + cert/key paths, then restart so the new scheme takes effect.
router.post('/settings/tls', (req, res) => {
  const certPath = (req.body.tls_cert_path || '').trim();
  const keyPath = (req.body.tls_key_path || '').trim();
  const domain = (req.body.site_domain || '').trim();
  const disabling = !certPath && !keyPath;

  // Reject a broken certificate up front so we never restart into a bad state.
  if (!disabling) {
    const v = validateCertPaths(certPath, keyPath);
    if (!v.ok) {
      setFlash(req, 'error', res.locals.t('tls_invalid', { msg: v.msg }));
      return res.redirect('/admin/settings');
    }
  }

  settings.setSetting('tls_cert_path', certPath);
  settings.setSetting('tls_key_path', keyPath);
  settings.setSetting('site_domain', domain);

  const eff = settings.effectiveTls();
  const host = eff.mode === 'https' ? domain || eff.domain : (req.headers.host || '').split(':')[0];
  const newUrl = `${eff.mode}://${host}:${config.port}/admin/settings`;
  const t = res.locals.t;

  scheduleRestart();

  // Self-contained interstitial: the panel is about to restart (and the scheme
  // may change), so don't rely on /public assets or the current connection.
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="${res.locals.lang}" dir="${res.locals.dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="7;url=${newUrl}">
<title>${t('tls_restarting_title')}</title>
<style>
  body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;background:#0b0e14;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .box{max-width:540px;padding:34px;text-align:center;background:#141925;border:1px solid #232a3a;border-radius:14px}
  .sp{width:34px;height:34px;border:3px solid #2b3650;border-top-color:#4c8bf5;border-radius:50%;margin:0 auto 18px;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  a{color:#7aa7ff;word-break:break-all} .m{color:#9aa4b2;font-size:.92rem;margin:12px 0}
</style></head>
<body><div class="box">
  <div class="sp"></div>
  <h2>${t('tls_restarting_title')}</h2>
  <p class="m">${disabling ? t('tls_disabled_restarting') : t('tls_saved_restarting')}</p>
  <p>${t('tls_reconnect_at')}:<br><a href="${newUrl}">${newUrl}</a></p>
</div>
<script>setTimeout(function(){location.href=${JSON.stringify(newUrl)};},7000);</script>
</body></html>`);
});

module.exports = router;
