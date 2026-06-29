#!/usr/bin/env bash
#
# 3x-ui Reseller Panel — one-shot installer / updater.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/kasra-sia/3x-ui-reseller-panel/main/install.sh)
#
# What it does:
#   - installs Node.js 22 + git (Debian/Ubuntu),
#   - clones the panel into /opt/reseller-panel and runs `npm install`,
#   - asks you for: 3x-ui panel URL, API token, admin username/password, port,
#   - generates SESSION_SECRET, writes .env and creates the SQLite DB + admin,
#   - installs a systemd service and brings the panel up on  http://<IP>:<port>.
#
# Then open the panel, log in, and (optionally) set your domain's TLS
# certificate paths under Settings to switch it to https://<domain>:<port>.
#
set -u

# ---- settings (override via env if you like) ------------------------------
REPO_OWNER="${REPO_OWNER:-kasra-sia}"
REPO_NAME="${REPO_NAME:-3x-ui-reseller-panel}"
REPO_BRANCH="${REPO_BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/reseller-panel}"
SERVICE_NAME="${SERVICE_NAME:-reseller-panel}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# ---- pretty output --------------------------------------------------------
c_reset=$'\033[0m'; c_b=$'\033[1m'; c_g=$'\033[32m'; c_y=$'\033[33m'; c_r=$'\033[31m'; c_c=$'\033[36m'
info()  { printf '%s\n' "${c_c}==>${c_reset} $*"; }
ok()    { printf '%s\n' "${c_g}✓${c_reset} $*"; }
warn()  { printf '%s\n' "${c_y}!${c_reset} $*"; }
die()   { printf '%s\n' "${c_r}✗ $*${c_reset}" >&2; exit 1; }

# ---- interactive helpers (read from the terminal, even under curl|bash) ----
TTY=/dev/tty
[ -r "$TTY" ] || die "No terminal available for prompts. Run:  bash <(curl -fsSL ${REPO_URL%.git}/raw/${REPO_BRANCH}/install.sh)"

ask() { # ask VAR "Prompt" "default"
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=''
  if [ -n "$__default" ]; then printf '%s [%s]: ' "$__prompt" "$__default" >"$TTY"
  else printf '%s: ' "$__prompt" >"$TTY"; fi
  read -r __ans <"$TTY" || true
  [ -z "$__ans" ] && __ans="$__default"
  printf -v "$__var" '%s' "$__ans"
}
ask_secret() { # ask_secret VAR "Prompt"
  local __var="$1" __prompt="$2" __ans=''
  printf '%s: ' "$__prompt" >"$TTY"
  read -rs __ans <"$TTY" || true
  printf '\n' >"$TTY"
  printf -v "$__var" '%s' "$__ans"
}

# ---- preflight ------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Please run as root (sudo)."
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu (apt) only."

info "Installing base packages (curl, git, ca-certificates)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || warn "apt-get update reported issues; continuing."
apt-get install -y curl ca-certificates git >/dev/null 2>&1 || die "Failed to install base packages."

# ---- Node.js --------------------------------------------------------------
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  info "Installing Node.js ${NODE_MAJOR}.x via NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 || die "NodeSource setup failed."
  apt-get install -y nodejs >/dev/null 2>&1 || die "Failed to install Node.js."
fi
NODE_BIN="$(command -v node)"
ok "Node.js $(node -v) at ${NODE_BIN}"

# ---- fetch / update code --------------------------------------------------
if [ -d "${INSTALL_DIR}/.git" ]; then
  info "Updating existing install in ${INSTALL_DIR}…"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 || warn "git fetch failed; using current files."
  git -C "$INSTALL_DIR" reset --hard "origin/${REPO_BRANCH}" >/dev/null 2>&1 || warn "git reset failed; using current files."
elif [ -e "$INSTALL_DIR" ]; then
  warn "${INSTALL_DIR} exists but is not a git checkout — using the files already there."
else
  info "Cloning ${REPO_URL} → ${INSTALL_DIR}…"
  git clone --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 \
    || die "git clone failed. Is the repository public and the URL correct? (${REPO_URL})"
fi
cd "$INSTALL_DIR" || die "Cannot enter ${INSTALL_DIR}."

info "Installing dependencies (npm install)…"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || warn "npm install reported issues (the app may still run via the built-in SQLite)."
ok "Dependencies ready."

# ---- configure (.env) -----------------------------------------------------
RECONFIG=1
if [ -f "${INSTALL_DIR}/.env" ]; then
  ask KEEP_ENV "An .env already exists. Reconfigure it? (y/N)" "N"
  case "$KEEP_ENV" in y|Y|yes|YES) RECONFIG=1 ;; *) RECONFIG=0 ;; esac
fi

if [ "$RECONFIG" -eq 1 ]; then
  printf '\n%s\n' "${c_b}— Panel configuration —${c_reset}" >"$TTY"

  PANEL_BASE_URL=''
  while [ -z "$PANEL_BASE_URL" ]; do
    ask PANEL_BASE_URL "3x-ui panel base URL (incl. port + path, e.g. https://host:6985/abc)" ""
    case "$PANEL_BASE_URL" in http://*|https://*) ;; *) warn "Must start with http:// or https://"; PANEL_BASE_URL='' ;; esac
  done
  ask    PANEL_API_TOKEN    "3x-ui API token (Settings → API; recommended, can be blank)" ""
  ask    PANEL_SUB_BASE_URL "Subscription base URL (optional, e.g. https://host:2096/sub)" ""

  ask    ADMIN_USERNAME     "Admin username for THIS panel" "admin"
  ADMIN_PASSWORD=''
  while [ -z "$ADMIN_PASSWORD" ]; do
    ask_secret ADMIN_PASSWORD "Admin password (blank = generate a strong one)"
    if [ -z "$ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')"
      GEN_PW=1
      warn "Generated admin password: ${c_b}${ADMIN_PASSWORD}${c_reset}  (save it now!)"
      break
    fi
    ask_secret ADMIN_PASSWORD2 "Repeat admin password"
    [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] || { warn "Passwords did not match, try again."; ADMIN_PASSWORD=''; }
  done

  APP_PORT=''
  while [ -z "$APP_PORT" ]; do
    ask APP_PORT "Port to serve the panel on" "8444"
    case "$APP_PORT" in
      ''|*[!0-9]*) warn "Port must be a number."; APP_PORT='' ;;
      80|443) warn "Port must not be 80 or 443."; APP_PORT='' ;;
      *) if [ "$APP_PORT" -lt 1 ] || [ "$APP_PORT" -gt 65535 ]; then warn "Port out of range."; APP_PORT=''
         elif ss -ltn 2>/dev/null | grep -q ":${APP_PORT}\b"; then warn "Port ${APP_PORT} is already in use, pick another."; APP_PORT=''; fi ;;
    esac
  done

  ask    APP_DOMAIN "Domain (optional now — you can set HTTPS later in the panel)" ""
  ask    DEFAULT_LANG "Default language: fa or en" "fa"
  case "$DEFAULT_LANG" in en|EN) DEFAULT_LANG=en ;; *) DEFAULT_LANG=fa ;; esac

  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"

  info "Writing .env…"
  umask 077
  cat > "${INSTALL_DIR}/.env" <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
APP_DOMAIN=${APP_DOMAIN}
APP_PORT=${APP_PORT}
# Panel starts on plain HTTP on the server IP. Set a domain certificate in
# the panel's Settings page to switch to HTTPS on your domain.
TLS_MODE=http
PANEL_BASE_URL=${PANEL_BASE_URL}
PANEL_API_TOKEN=${PANEL_API_TOKEN}
PANEL_SUB_BASE_URL=${PANEL_SUB_BASE_URL}
PANEL_VERIFY_TLS=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USERNAME=${ADMIN_USERNAME}
DEFAULT_LANG=${DEFAULT_LANG}
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  ok ".env written (admin password is NOT stored in it)."

  info "Creating database + admin account…"
  # Admin password is passed only for this one run, never persisted to .env.
  ADMIN_PASSWORD="$ADMIN_PASSWORD" "$NODE_BIN" scripts/init-db.js \
    || die "Database initialization failed."
  ok "Database ready."
else
  info "Keeping existing .env. Ensuring database schema is present…"
  "$NODE_BIN" scripts/init-db.js || warn "init-db reported an issue."
  # Pull the port back from the kept .env so we can show the right URL.
  APP_PORT="$(grep -E '^APP_PORT=' "${INSTALL_DIR}/.env" | head -1 | cut -d= -f2)"
  APP_PORT="${APP_PORT:-8444}"
fi

# ---- systemd service ------------------------------------------------------
info "Installing systemd service '${SERVICE_NAME}'…"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=3x-ui Reseller Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE_NAME}"

# ---- firewall (best effort) ----------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
  ufw allow "${APP_PORT}/tcp" >/dev/null 2>&1 && ok "Opened port ${APP_PORT} in ufw."
fi

# ---- verify + summary -----------------------------------------------------
sleep 2
SERVER_IP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
SERVER_IP="${SERVER_IP:-<SERVER_IP>}"

printf '\n'
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "Service '${SERVICE_NAME}' is running."
  printf '\n%s\n' "${c_g}${c_b}Reseller panel is up!${c_reset}"
  printf '   %s  %s\n' "URL:" "${c_b}http://${SERVER_IP}:${APP_PORT}${c_reset}"
  [ "${RECONFIG:-0}" -eq 1 ] && printf '   %s  %s\n' "User:" "${ADMIN_USERNAME}"
  [ "${GEN_PW:-0}" = "1" ]   && printf '   %s  %s\n' "Pass:" "${c_b}${ADMIN_PASSWORD}${c_reset} (generated — save it!)"
  printf '\n%s\n' "Next: log in, then Settings → set your domain's certificate paths to enable HTTPS."
  printf '%s\n' "Manage:  systemctl {status,restart,stop} ${SERVICE_NAME}   ·   logs: journalctl -u ${SERVICE_NAME} -f"
else
  warn "Service is not active yet. Check logs:  journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi
