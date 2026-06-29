'use strict';

/** Small view-formatting helpers (no dependencies). */

const GB = 1024 * 1024 * 1024;

function gbToBytes(gb) {
  const n = Number(gb);
  return Number.isFinite(n) && n > 0 ? Math.round(n * GB) : 0;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i < 2 ? 0 : 1)} ${units[i]}`;
}

/** Percentage of the limit used (0..100+). total<=0 means unlimited -> 0. */
function usagePercent(used, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.min(999, Math.round((Number(used || 0) / t) * 100));
}

/** Threshold-based color for the usage bar (green -> yellow -> red). */
function usageColor(percent) {
  if (percent >= 90) return '#e5484d'; // red
  if (percent >= 70) return '#f5a623'; // orange
  if (percent >= 45) return '#e8c400'; // yellow
  return '#30a46c'; // green
}

/** Days left until an epoch-ms expiry. null = no expiry. */
function daysLeft(expiryMs) {
  const e = Number(expiryMs) || 0;
  if (e <= 0) return null;
  return Math.ceil((e - Date.now()) / (24 * 60 * 60 * 1000));
}

function formatDate(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDateTime(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = {
  GB,
  gbToBytes,
  formatBytes,
  usagePercent,
  usageColor,
  daysLeft,
  formatDate,
  formatDateTime,
};
