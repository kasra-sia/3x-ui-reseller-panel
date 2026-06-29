'use strict';

/**
 * Minimal Telegram admin notifications via the Bot API (global fetch, no deps).
 * Best-effort: failures are logged and swallowed so they never break a panel
 * action. Bot token / chat id come from .env.
 */

const config = require('./config');

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
}

async function notify(text) {
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;
  if (!token || !chatId) return false; // not configured
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.warn('[telegram] sendMessage HTTP', res.status);
    return res.ok;
  } catch (e) {
    console.warn('[telegram] notify failed:', e.message);
    return false;
  }
}

const ACTION_ICON = { create: '🟢', renew: '🔄', delete: '🔴' };
const ACTION_LABEL = { create: 'Created', renew: 'Renewed', delete: 'Deleted' };

/** Build + send a notification for a reseller's client action. */
function notifyClientAction({ action, resellerName, serverName, inboundRemark, email, price, currency }) {
  const icon = ACTION_ICON[action] || 'ℹ️';
  const label = ACTION_LABEL[action] || action;
  const lines = [
    `${icon} <b>Client ${label}</b>`,
    `👤 Reseller: <b>${esc(resellerName)}</b>`,
    `🖥 Server: ${esc(serverName)}`,
    `📥 Inbound: ${esc(inboundRemark)}`,
    `✉️ Client: <code>${esc(email)}</code>`,
  ];
  if (price != null && action !== 'delete') {
    lines.push(`💰 Price: ${esc(price)} ${esc(currency || '')}`);
  }
  lines.push(`🕒 ${new Date().toLocaleString()}`);
  return notify(lines.join('\n'));
}

module.exports = { notify, notifyClientAction };
