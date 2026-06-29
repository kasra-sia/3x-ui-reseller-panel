# 3x-ui Reseller Panel

A small, self-hosted web app that sits **in front of** an existing
[3x-ui](https://github.com/MHSanaei/3x-ui) panel and lets the panel owner
("Admin") delegate **limited, controlled** access to multiple "Resellers"
— without giving them the real 3x-ui panel.

Resellers can only create / renew / delete clients on the **inbounds the Admin
explicitly assigned** to them. Every action is recorded in a local billing
ledger, mirrored to the real panel via its API, and announced to the Admin on
Telegram.

Built to be **lightweight**: Node.js + Express + SQLite, server-rendered EJS,
no build step, comfortably under ~400 MB RAM. Fully **bilingual** (English +
Persian/فارسی) with RTL support.

---

## 0. Quick start (one-line install)

On a fresh **Ubuntu/Debian** server, as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/kasra-sia/3x-ui-reseller-panel/main/install.sh)
```

The installer installs Node.js, fetches the panel, then **asks you for** your
3x-ui panel URL, its API token, an admin username + password, and a port. It
generates the session secret, creates the database + admin account, installs a
`systemd` service, and brings the panel up on **`http://<server-ip>:<port>`**.

Log in there. To serve it over HTTPS on a domain instead, go to **Settings →
Domain & HTTPS** and enter the paths to your domain's TLS certificate and key
(just like the 3x-ui panel) — the panel restarts and comes up on
`https://<domain>:<port>`. See §11.

Prefer to install by hand? Follow §3–§6.

---

## 1. What it does

- **Admin** (one account): registers one or more 3x-ui panels ("Servers"),
  creates Resellers, assigns specific inbounds to each Reseller, defines sale
  plans (duration + traffic + price) per Reseller, sees every Reseller's billing
  ledger, and changes
  status (settled / cancelled). Gets a Telegram notification on every reseller
  action.
- **Reseller**: sees only assigned inbounds; creates / renews / deletes clients
  there; sees their own client list with colored usage bars; opens a "Get link"
  popup with the **subscription link** + **direct link** as text and **QR
  codes**; sees and flags their own bill.

All inbound access is enforced **server-side on every action**, never just in
the UI.

## 2. Requirements

- A Linux VPS reached over SSH (root). No Docker needed.
- **Node.js 18+** (Node **22.5+** recommended — it includes a built-in SQLite,
  so no native module needs to compile; on older Node the app uses
  `better-sqlite3` prebuilt binaries automatically).
- An existing, running 3x-ui panel with an **API token** (Panel Settings → API).
  The app auto-detects whether your panel uses the classic
  (`/panel/api/inbounds/*`, v2.x–v3.0.x) or new (`/panel/api/clients/*`,
  v3.2.0+) client API — you don't need to know which.

## 3. Install

```bash
git clone <your-repo-url> reseller-panel
cd reseller-panel
npm install
```

`npm install` is lean (Express, EJS, SQLite, cookie-session, bcryptjs,
qrcode, dotenv). `better-sqlite3` is an **optional** dependency — if it can't
build/download on your box, the app falls back to Node's built-in SQLite, so
the install never hard-fails on it.

## 4. Configure (`.env`)

Copy the template and fill it **by hand on the server**. Never commit `.env`.

```bash
cp .env.example .env
nano .env
```

Key variables (full list + comments in [.env.example](.env.example)):

| Variable | Meaning |
|---|---|
| `APP_DOMAIN` | Public domain, e.g. `manage.keguard.top` |
| `APP_PORT` | Internal port to listen on. **Must NOT be 80/443 or any busy port.** Default **8443**. |
| `TLS_MODE` | `self` = Node terminates HTTPS with your certs (default). `proxy` = plain HTTP behind a reverse proxy. |
| `TLS_CERT_DIR` | Folder holding the cert + key for `APP_DOMAIN` (default `./cert`). Filenames are **auto-detected**. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Optional explicit overrides if auto-detection guesses wrong. |
| `PANEL_BASE_URL` | 3x-ui base URL **including custom port + path**, e.g. `https://edge1.viqora.top:6985/baghlava`. Optional — seeds a first Server row; you can add panels in the UI instead. |
| `PANEL_API_TOKEN` | API token for that panel (sent as `Authorization: Bearer`). |
| `PANEL_SUB_BASE_URL` | Subscription server base, used to build sub links: `{base}/{subId}`, e.g. `https://edge1.viqora.top:2096/sub`. |
| `PANEL_VERIFY_TLS` | `false` (default) tolerates a self-signed panel cert. Set `true` if the panel has a valid public cert. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Admin notifications. Leave blank to disable. |
| `SESSION_SECRET` | Random secret for signing session cookies (**required**). |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First-run admin account (created once on DB init). |
| `DEFAULT_LANG` | `fa` (default, RTL) or `en`. |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Pick a free port

Before starting, confirm `APP_PORT` is free (don't collide with the 3x-ui
panel or anything else):

```bash
ss -ltnp | grep ":8443" || echo "port 8443 is free"
```

### TLS certificates

In `TLS_MODE=self` (default) the Node app serves HTTPS itself using the certs
in `TLS_CERT_DIR` (default `./cert`). **Put your cert + key in that folder** and
the app **auto-detects** the filenames at startup:

- cert: `fullchain*.pem`, then `*.crt` / `*.cert`, then any `*.pem`
- key: `privkey*.pem`, then `*.key`

So `cert/fullchain.pem` + `cert/privkey.pem`, or `cert/manage.keguard.top.crt` +
`cert/manage.keguard.top.key`, both work. If detection picks wrong, set
`TLS_CERT_FILE` / `TLS_KEY_FILE`. On startup the app prints which files it used,
and fails with a clear bilingual message if none are found.

If a reverse proxy already terminates TLS, set `TLS_MODE=proxy` and the app
listens on plain HTTP on `APP_PORT`.

## 5. Initialize the database

Creates the SQLite schema (in `./data/app.sqlite`) and the first admin account
from `.env`:

```bash
npm run init-db
```

Safe to run again later (idempotent). The `data/` folder is gitignored.

## 6. Run (tmux)

```bash
tmux new -s panel
cd /path/to/reseller-panel
node server.js
# detach: Ctrl-b then d   ·   reattach: tmux attach -t panel
```

You should see:

```
[server] TLS cert: fullchain.pem  key: privkey.pem
[server] Reseller panel listening on https://0.0.0.0:8443
```

Then open `https://manage.keguard.top:8443` (or behind your proxy).

### Or with pm2

```bash
npm install -g pm2
pm2 start server.js --name reseller-panel
pm2 save
pm2 startup    # optional: start on boot
```

## 7. First steps in the UI

1. Log in as the admin you set in `.env`. Change the password in **Settings**.
2. **Servers** → add your 3x-ui panel (base URL + API token + subscription base
   URL). Click **Test connection** — it verifies auth and auto-detects the API
   style (classic/new) and inbound count.
3. **Resellers** → create a reseller (username + password).
4. On that reseller: **Inbound access** → pick the server, tick the inbounds
   they may use, save. **Plans** → add one or more sale plans (name, duration in
   days, traffic in GB, price, currency) for that reseller.
5. The reseller logs in and creates/renews clients on the allowed inbounds by
   **picking a plan** (which sets traffic + expiry and bills the plan price).

## 8. How it talks to 3x-ui

All panel communication is isolated in [`src/panel.js`](src/panel.js) — the one
file to touch if the panel API ever changes. It:

- Authenticates with `Authorization: Bearer <api_token>` (falls back to
  username/password session login if a server has no token).
- **Auto-detects** per server whether to use the classic
  `/panel/api/inbounds/addClient` family or the new `/panel/api/clients/*`
  family, and caches the result. You can also force `classic` / `new` per
  server.
- Records a bill row **only after** the panel call actually succeeds; panel
  errors are surfaced in the UI in both languages.

## 9. Project layout

```
server.js              entry: config, TLS, Express wiring, start
scripts/init-db.js     create schema + seed admin
src/
  config.js            env loading + validation + TLS auto-detect
  sqlite.js            SQLite adapter (better-sqlite3 → node:sqlite fallback)
  db.js                schema + first-run seed
  panel.js             ALL 3x-ui API calls (classic + new, auto-detect)
  store.js             shared queries, bill writes, traffic/QR enrichment
  auth.js              sessions, CSRF, role guards, flash
  telegram.js          admin notifications
  i18n.js + locales/   en.json / fa.json dictionaries
  format.js            bytes / dates / usage-bar helpers
  routes/              auth.js, admin.js, reseller.js
views/                 EJS (server-rendered, RTL-aware)
public/                css/style.css, js/app.js
cert/                  TLS cert + key (you provide; gitignored)
data/                  SQLite db (created at runtime; gitignored)
```

## 10. Notes & limits

- No payment processing — the ledger is a shared running tally with status
  flags only. Reconcile/settle out of band.
- Telegram + secrets are configured via `.env`, never stored in the DB.
- Resellers create simple clients (no XTLS flow set). The subscription link is
  the authoritative share method; a best-effort direct vless/vmess/trojan link
  is also generated.
- Session cookies are signed + httpOnly. Serve over HTTPS in production.

## 11. Domain & HTTPS from the panel UI

A fresh install (via `install.sh`) serves the panel over **plain HTTP on the
server IP**, so you can reach it immediately at `http://<ip>:<port>`. To move it
onto a domain over HTTPS — without editing files on the server — open
**Settings → Domain & HTTPS** and fill in:

- **Domain** — e.g. `manage.example.com` (used to build the HTTPS address; must
  match the certificate).
- **Certificate file path (fullchain)** — absolute path on the server, e.g.
  `/root/cert/manage.example.com/fullchain.pem`.
- **Private key file path** — e.g. `/root/cert/manage.example.com/privkey.pem`.

Click **Validate** to check the pair, then **Save & apply**. The panel verifies
the certificate, restarts (via systemd), and comes back up on
`https://<domain>:<port>`. An invalid certificate is rejected (nothing changes),
and if a saved certificate later becomes unreadable the panel falls back to HTTP
instead of refusing to start — so you can't lock yourself out. To return to HTTP
on the IP, clear both paths and save.

> Obtain the certificate however you like (`acme.sh` / `certbot`), point the
> domain's DNS at the server first, then give the panel the cert + key paths.
> These settings live in the database, not in `.env`.
