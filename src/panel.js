'use strict';

/**
 * 3x-ui panel API client — the ONLY file that talks to the real panel.
 * If the panel's API changes, this is the single place to update.
 *
 * Auth:   Authorization: Bearer <api_token>  (primary; works on 3x-ui v3.0+)
 *         Falls back to username/password session login when no token is set.
 *
 * API style is auto-detected per server (the panel's client API was refactored
 * at ~v3.1/v3.2):
 *   - "classic" (v2.x .. v3.0.x): client ops live under /panel/api/inbounds/*
 *       addClient / updateClient/:uuid / :id/delClient/:uuid /
 *       :id/resetClientTraffic/:email / getClientTraffics/:email
 *   - "new" (v3.2.0+):            client ops live under /panel/api/clients/*
 *       add / update/:email / del/:email / resetTraffic/:email / traffic/:email
 *
 * Each server row provides: { id, base_url, api_token, username, password,
 *                             api_style ('auto'|'classic'|'new'), sub_base_url }
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const config = require('./config');

// In-memory caches keyed by server id (cleared on restart).
const detectedStyle = new Map(); // serverId -> 'classic' | 'new'
const sessionCookie = new Map(); // serverId -> 'cookie string'
const subBaseCache = new Map(); // serverId -> subscription base URL (no trailing slash)

function uuid() {
  return crypto.randomUUID();
}

/**
 * Low-level HTTP request to the panel. Returns { status, body, text }.
 * `body` is the parsed JSON when possible, else null.
 */
function rawRequest(server, method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(server.base_url.replace(/\/+$/, '') + pathname);
    } catch (e) {
      return reject(new Error('Invalid panel base URL: ' + server.base_url));
    }

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = { Accept: 'application/json' };
    if (server.api_token) headers['Authorization'] = 'Bearer ' + server.api_token;
    if (opts.cookie) headers['Cookie'] = opts.cookie;

    let payload = null;
    if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json));
      headers['Content-Type'] = 'application/json';
    } else if (opts.form !== undefined) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString());
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (payload) headers['Content-Length'] = payload.length;

    const reqOptions = {
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      timeout: 15000,
    };
    if (isHttps) reqOptions.rejectUnauthorized = config.panelVerifyTls;

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (_) {
          body = null;
        }
        resolve({ status: res.statusCode, body, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Panel request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Establish a session cookie via username/password login (fallback auth). */
async function ensureSession(server) {
  if (server.api_token) return null; // token auth needs no cookie
  if (!server.username) throw new Error('No api_token and no username configured for this server');
  if (sessionCookie.has(server.id)) return sessionCookie.get(server.id);

  const res = await rawRequest(server, 'POST', '/login', {
    form: { username: server.username, password: server.password || '' },
  });
  if (res.status !== 200 || !res.body || res.body.success !== true) {
    throw new Error('Panel login failed (check username/password)');
  }
  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  sessionCookie.set(server.id, cookie);
  return cookie;
}

/** Request helper that attaches auth (token header or session cookie). */
async function api(server, method, pathname, opts = {}) {
  const cookie = await ensureSession(server);
  const res = await rawRequest(server, method, pathname, { ...opts, cookie });
  // If a cached cookie went stale, drop it so the next call re-logs in.
  if (!server.api_token && res.status === 401) sessionCookie.delete(server.id);
  return res;
}

function assertOk(res, what) {
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Panel auth rejected (${res.status}). Check the API token / credentials.`);
  }
  if (res.status === 404) {
    throw new Error(`Panel endpoint not found (404) for ${what}. Wrong base URL or API style?`);
  }
  if (res.status >= 500) {
    throw new Error(`Panel server error (${res.status}) for ${what}.`);
  }
  if (res.body && res.body.success === false) {
    throw new Error(res.body.msg || `Panel rejected ${what}.`);
  }
  if (res.status >= 400) {
    throw new Error(`Panel returned ${res.status} for ${what}.`);
  }
}

/** Decide which API style a server uses (auto-detect + cache). */
async function getStyle(server) {
  if (server.api_style === 'classic' || server.api_style === 'new') return server.api_style;
  if (detectedStyle.has(server.id)) return detectedStyle.get(server.id);

  // Probe a route that ONLY exists in the new API. Classic returns 404.
  const probe = await api(server, 'GET', '/panel/api/clients/traffic/__detect__');
  const style = probe.status === 404 ? 'classic' : 'new';
  detectedStyle.set(server.id, style);
  return style;
}

// --------------------------------------------------------------------------
// Public operations
// --------------------------------------------------------------------------

/** Verify connectivity + auth, and report the detected API style. */
async function testConnection(server) {
  const res = await api(server, 'GET', '/panel/api/inbounds/list');
  assertOk(res, 'inbounds list');
  if (!res.body || res.body.success !== true) {
    throw new Error(res.body && res.body.msg ? res.body.msg : 'Unexpected response from panel');
  }
  // Clear any stale cached detection, then detect fresh.
  detectedStyle.delete(server.id);
  const style = await getStyle(server);
  const count = Array.isArray(res.body.obj) ? res.body.obj.length : 0;
  return { ok: true, style, inboundCount: count };
}

/** List inbounds, normalized to { id, remark, protocol, port }. */
async function listInbounds(server) {
  const res = await api(server, 'GET', '/panel/api/inbounds/list');
  assertOk(res, 'inbounds list');
  const arr = (res.body && res.body.obj) || [];
  return arr.map((ib) => ({
    id: ib.id,
    remark: ib.remark || '',
    protocol: ib.protocol || '',
    port: ib.port || 0,
  }));
}

/** Fetch a single inbound's full detail (used for classic link building). */
async function getInbound(server, inboundId) {
  const res = await api(server, 'GET', `/panel/api/inbounds/get/${inboundId}`);
  assertOk(res, 'get inbound');
  return (res.body && res.body.obj) || null;
}

/**
 * Build the model.Client-shaped object shared by both API styles.
 * `c` = { email, uuid, subId, totalBytes, expiryTime(ms), limitIp, enable, flow, protocol }
 */
function buildClientObject(c) {
  const obj = {
    email: c.email,
    enable: c.enable !== false,
    limitIp: c.limitIp || 0,
    totalGB: c.totalBytes || 0, // field is named totalGB but holds BYTES
    expiryTime: c.expiryTime || 0,
    tgId: 0,
    subId: c.subId || '',
    group: c.group || '', // logical group label (we set it to the reseller's username)
    reset: 0,
    comment: '',
    flow: c.flow || '',
  };
  // Identifier field depends on protocol: vless/vmess use `id`, trojan/ss use `password`.
  const proto = (c.protocol || '').toLowerCase();
  if (proto === 'trojan' || proto === 'shadowsocks') {
    obj.password = c.uuid;
    obj.id = c.uuid;
  } else {
    obj.id = c.uuid;
    obj.password = c.uuid;
  }
  return obj;
}

/** Create a client on the given inbound. Returns the created identity. */
async function addClient(server, inboundId, c) {
  const style = await getStyle(server);
  const clientObj = buildClientObject(c);

  if (style === 'new') {
    const res = await api(server, 'POST', '/panel/api/clients/add', {
      json: { client: clientObj, inboundIds: [Number(inboundId)] },
    });
    assertOk(res, 'add client');
  } else {
    const res = await api(server, 'POST', '/panel/api/inbounds/addClient', {
      json: { id: Number(inboundId), settings: JSON.stringify({ clients: [clientObj] }) },
    });
    assertOk(res, 'add client');
  }
  return { email: c.email, uuid: c.uuid, subId: c.subId };
}

/** Update/renew a client (extend expiry / traffic / toggle enable). */
async function updateClient(server, inboundId, c) {
  const style = await getStyle(server);
  const clientObj = buildClientObject(c);

  if (style === 'new') {
    const res = await api(server, 'POST', `/panel/api/clients/update/${encodeURIComponent(c.email)}`, {
      json: clientObj,
    });
    assertOk(res, 'update client');
  } else {
    const res = await api(server, 'POST', `/panel/api/inbounds/updateClient/${encodeURIComponent(c.uuid)}`, {
      json: { id: Number(inboundId), settings: JSON.stringify({ clients: [clientObj] }) },
    });
    assertOk(res, 'update client');
  }
  return true;
}

/** Delete a client. */
async function deleteClient(server, inboundId, c) {
  const style = await getStyle(server);
  if (style === 'new') {
    const res = await api(server, 'POST', `/panel/api/clients/del/${encodeURIComponent(c.email)}`);
    assertOk(res, 'delete client');
  } else {
    const res = await api(
      server,
      'POST',
      `/panel/api/inbounds/${Number(inboundId)}/delClient/${encodeURIComponent(c.uuid)}`
    );
    assertOk(res, 'delete client');
  }
  return true;
}

/** Reset a client's traffic counters. */
async function resetClientTraffic(server, inboundId, c) {
  const style = await getStyle(server);
  if (style === 'new') {
    const res = await api(server, 'POST', `/panel/api/clients/resetTraffic/${encodeURIComponent(c.email)}`);
    assertOk(res, 'reset traffic');
  } else {
    const res = await api(
      server,
      'POST',
      `/panel/api/inbounds/${Number(inboundId)}/resetClientTraffic/${encodeURIComponent(c.email)}`
    );
    assertOk(res, 'reset traffic');
  }
  return true;
}

/**
 * Per-client traffic stats. Returns { up, down, total, expiryTime, enable } in bytes,
 * or null if the panel has no stats row yet.
 */
async function getClientTraffic(server, email) {
  const style = await getStyle(server);
  const path =
    style === 'new'
      ? `/panel/api/clients/traffic/${encodeURIComponent(email)}`
      : `/panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`;
  const res = await api(server, 'GET', path);
  if (res.status === 404) return null;
  assertOk(res, 'client traffic');
  const o = res.body && res.body.obj;
  if (!o) return null;
  return {
    up: o.up || 0,
    down: o.down || 0,
    total: o.total || 0,
    expiryTime: o.expiryTime || 0,
    enable: o.enable !== false,
  };
}

/**
 * Links for a client. Returns { subLink, directLinks: [{ remark, link }] }.
 *  - subLink: {sub_base_url}/{subId}  (universal, both styles)
 *  - directLinks: from the new API endpoint when available, else built locally
 *    from the inbound config for the classic style.
 */
async function getClientLinks(server, c) {
  const subBase = await getSubBaseUrl(server);
  const subLink = subBase && c.subId ? `${subBase}/${c.subId}` : '';

  let directLinks = [];
  const style = await getStyle(server);
  if (style === 'new') {
    try {
      const res = await api(server, 'GET', `/panel/api/clients/links/${encodeURIComponent(c.email)}`);
      if (res.body && res.body.obj) directLinks = normalizeLinks(res.body.obj);
    } catch (_) {
      /* best effort */
    }
  } else {
    try {
      const inbound = await getInbound(server, c.inbound_id);
      const link = buildClassicLink(server, inbound, c);
      if (link) directLinks = [{ remark: c.email, link }];
    } catch (_) {
      /* best effort */
    }
  }
  return { subLink, directLinks };
}

function normalizeLinks(obj) {
  // The new API may return an array of strings or of {remark, link/uri}.
  if (!Array.isArray(obj)) return [];
  return obj
    .map((item) => {
      if (typeof item === 'string') return { remark: '', link: item };
      if (item && (item.link || item.uri))
        return { remark: item.remark || item.email || '', link: item.link || item.uri };
      return null;
    })
    .filter(Boolean);
}

/**
 * Best-effort classic-style direct link builder for the big three protocols.
 * Reads the inbound's protocol/port + streamSettings to assemble a share URI.
 * Not every exotic transport/security combo is covered — the subscription
 * link is the authoritative source; this is a convenience.
 */
function buildClassicLink(server, inbound, c) {
  if (!inbound) return null;
  const proto = (inbound.protocol || '').toLowerCase();
  const host = hostFromBaseUrl(server.base_url);
  const port = inbound.port;
  const remark = encodeURIComponent(c.email || inbound.remark || '');
  let stream = {};
  try {
    stream = inbound.streamSettings ? JSON.parse(inbound.streamSettings) : {};
  } catch (_) {
    stream = {};
  }
  const net = stream.network || 'tcp';
  const security = stream.security || 'none';
  const params = new URLSearchParams();
  params.set('type', net);
  params.set('security', security);

  // Transport-specific params
  if (net === 'ws') {
    const ws = stream.wsSettings || {};
    if (ws.path) params.set('path', ws.path);
    if (ws.host || (ws.headers && ws.headers.Host)) params.set('host', ws.host || ws.headers.Host);
  } else if (net === 'grpc') {
    const g = stream.grpcSettings || {};
    if (g.serviceName) params.set('serviceName', g.serviceName);
  }

  // Security-specific params
  if (security === 'reality') {
    const r = stream.realitySettings || {};
    const rs = r.settings || {};
    if (r.serverNames && r.serverNames[0]) params.set('sni', r.serverNames[0]);
    if (rs.publicKey) params.set('pbk', rs.publicKey);
    if (r.shortIds && r.shortIds[0]) params.set('sid', r.shortIds[0]);
    if (rs.fingerprint) params.set('fp', rs.fingerprint);
    if (rs.spiderX) params.set('spx', rs.spiderX);
  } else if (security === 'tls') {
    const t = stream.tlsSettings || {};
    if (t.serverName) params.set('sni', t.serverName);
    if (t.settings && t.settings.fingerprint) params.set('fp', t.settings.fingerprint);
  }
  if (c.flow) params.set('flow', c.flow);

  if (proto === 'vless') {
    return `vless://${c.uuid}@${host}:${port}?${params.toString()}#${remark}`;
  }
  if (proto === 'trojan') {
    return `trojan://${c.uuid}@${host}:${port}?${params.toString()}#${remark}`;
  }
  if (proto === 'vmess') {
    // vmess uses a base64-encoded JSON blob
    const vmess = {
      v: '2',
      ps: c.email || inbound.remark || '',
      add: host,
      port: String(port),
      id: c.uuid,
      aid: '0',
      net,
      type: 'none',
      host: params.get('host') || '',
      path: params.get('path') || '',
      tls: security === 'tls' ? 'tls' : '',
      sni: params.get('sni') || '',
    };
    return 'vmess://' + Buffer.from(JSON.stringify(vmess)).toString('base64');
  }
  return null;
}

function hostFromBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch (_) {
    return '';
  }
}

// --------------------------------------------------------------------------
// Group-based operations (new API only — v3.2.0+)
// --------------------------------------------------------------------------

/** Style of a server, exposed for callers that branch on classic/new. */
async function getServerStyle(server) {
  return getStyle(server);
}

/**
 * Subscription base URL for a server, e.g. https://sub.host:2096/path
 * Priority: explicit server.sub_base_url override → else auto-detected from the
 * panel's own settings (defaultSettings.subURI). Cached per server.
 */
async function getSubBaseUrl(server) {
  if (server.sub_base_url) return server.sub_base_url.replace(/\/+$/, '');
  if (subBaseCache.has(server.id)) return subBaseCache.get(server.id);
  let base = '';
  try {
    const style = await getStyle(server);
    if (style === 'new') {
      const res = await api(server, 'POST', '/panel/api/setting/defaultSettings');
      const obj = (res.body && res.body.obj) || {};
      if (obj.subEnable && obj.subURI) base = String(obj.subURI).replace(/\/+$/, '');
    }
  } catch (_) {
    /* best effort — sub link just won't show */
  }
  subBaseCache.set(server.id, base);
  return base;
}

/** Emails of all clients in a group. New API only; classic returns []. */
async function groupEmails(server, groupName) {
  const style = await getStyle(server);
  if (style !== 'new') return [];
  const res = await api(server, 'GET', `/panel/api/clients/groups/${encodeURIComponent(groupName)}/emails`);
  if (res.status === 404) return [];
  assertOk(res, 'group emails');
  return Array.isArray(res.body && res.body.obj) ? res.body.obj : [];
}

/**
 * All clients belonging to a group, with live usage, normalized to:
 *   { email, subId, totalBytes, used, expiryTime, enable, inboundIds }
 * New API only (uses the paged client list which carries traffic inline).
 */
async function listPanelClients(server) {
  const style = await getStyle(server);
  if (style !== 'new') return [];
  const out = [];
  const pageSize = 500;
  let page = 1;
  let total = Infinity;
  let fetched = 0;
  while (fetched < total && page <= 400) {
    const res = await api(server, 'GET', `/panel/api/clients/list/paged?page=${page}&pageSize=${pageSize}`);
    assertOk(res, 'client list');
    const obj = (res.body && res.body.obj) || {};
    const items = obj.items || [];
    total = obj.total != null ? obj.total : items.length;
    fetched += items.length;
    for (const it of items) {
      const tr = it.traffic || {};
      out.push({
        email: it.email,
        subId: it.subId || '',
        totalBytes: it.totalGB || 0,
        used: (tr.up || 0) + (tr.down || 0),
        expiryTime: it.expiryTime || 0,
        enable: it.enable !== false,
        inboundIds: it.inboundIds || [],
      });
    }
    if (items.length === 0) break;
    page += 1;
  }
  return out;
}

/** Clients in a group (subset of listPanelClients filtered by the group's emails). */
async function listGroupClients(server, groupName) {
  const emails = new Set(await groupEmails(server, groupName));
  if (emails.size === 0) return [];
  const all = await listPanelClients(server);
  return all.filter((c) => emails.has(c.email));
}

/** Full client record by email: { client, inboundIds, usedTraffic }. New API. */
async function getClientRecord(server, email) {
  const res = await api(server, 'GET', `/panel/api/clients/get/${encodeURIComponent(email)}`);
  if (res.status === 404) return null;
  // The panel answers a missing client with 200 + success:false ("record not found").
  if (res.body && res.body.success === false) return null;
  assertOk(res, 'get client');
  return (res.body && res.body.obj) || null;
}

/**
 * Renew a client by email: extend expiry by addDays and/or add addBytes to the
 * traffic limit, re-enable it, preserving everything else (subId, group, flow…).
 * New API. Returns true on success.
 */
async function renewClientByEmail(server, email, { addDays = 0, addBytes = 0 }) {
  const rec = await getClientRecord(server, email);
  if (!rec || !rec.client) throw new Error('Client not found on panel');
  const c = rec.client;
  const used = rec.usedTraffic || 0;
  const limit = c.totalGB || 0;

  // Days: the period RESETS to the plan's length, counted from now (so "days
  // remaining" becomes exactly the plan's days, e.g. 31).
  let newExpiry = c.expiryTime || 0;
  if (addDays > 0) newExpiry = Date.now() + addDays * 24 * 60 * 60 * 1000;

  // Traffic: carry over the leftover, add the plan, and RESET the usage counter.
  //   new limit = max(limit - used, 0) + plan   (used -> 0)
  // So the client's remaining becomes old-remaining + plan, with a fresh meter.
  let newTotal = limit;
  if (limit > 0) newTotal = Math.max(limit - used, 0) + addBytes;
  // if currently unlimited (0), leave it unlimited

  // Reset the consumed traffic (up/down -> 0) first. If this fails, nothing
  // else has changed yet, so the renew errors cleanly.
  const resetRes = await api(server, 'POST', `/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`);
  assertOk(resetRes, 'reset traffic');

  const updated = {
    id: c.uuid || '',
    email: c.email,
    password: c.password || '',
    flow: c.flow || '',
    security: c.security || '',
    limitIp: c.limitIp || 0,
    totalGB: newTotal,
    expiryTime: newExpiry,
    enable: true,
    tgId: c.tgId || 0,
    subId: c.subId || '',
    group: c.group || '',
    comment: c.comment || '',
    reset: c.reset || 0,
  };
  const res = await api(server, 'POST', `/panel/api/clients/update/${encodeURIComponent(email)}`, { json: updated });
  assertOk(res, 'renew client');
  return { subId: updated.subId };
}

/** Delete a client by email (new API). */
async function deleteClientByEmail(server, email) {
  const res = await api(server, 'POST', `/panel/api/clients/del/${encodeURIComponent(email)}`);
  assertOk(res, 'delete client');
  return true;
}

/** Direct + sub links for a client by email (new API). */
async function clientLinksByEmail(server, email, subId) {
  const subBase = await getSubBaseUrl(server);
  const subLink = subBase && subId ? `${subBase}/${subId}` : '';
  let directLinks = [];
  try {
    const res = await api(server, 'GET', `/panel/api/clients/links/${encodeURIComponent(email)}`);
    if (res.body && res.body.obj) directLinks = normalizeLinks(res.body.obj);
  } catch (_) {
    /* best effort */
  }
  return { subLink, directLinks };
}

module.exports = {
  uuid,
  testConnection,
  listInbounds,
  getInbound,
  addClient,
  updateClient,
  deleteClient,
  resetClientTraffic,
  getClientTraffic,
  getClientLinks,
  getServerStyle,
  getSubBaseUrl,
  groupEmails,
  listGroupClients,
  listPanelClients,
  getClientRecord,
  renewClientByEmail,
  deleteClientByEmail,
  clientLinksByEmail,
  _clearCaches: (serverId) => {
    detectedStyle.delete(serverId);
    sessionCookie.delete(serverId);
    subBaseCache.delete(serverId);
  },
};
