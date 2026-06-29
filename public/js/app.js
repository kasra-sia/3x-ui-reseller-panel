'use strict';

(function () {
  function csrf() {
    var m = document.querySelector('meta[name="csrf"]');
    return m ? m.getAttribute('content') : '';
  }
  function t(key) {
    var el = document.getElementById('i18n');
    return (el && el.dataset[key]) || key;
  }

  // --- Theme toggle (dark / light), persisted in a cookie -----------------
  window.toggleTheme = function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.cookie = 'theme=' + next + ';path=/;max-age=' + 365 * 24 * 60 * 60 + ';samesite=lax';
    var btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
  };

  // --- Modals --------------------------------------------------------------
  window.openModal = function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');
  };
  window.closeModal = function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  };
  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-back')) {
      e.target.classList.remove('open');
    }
  });

  // --- Confirm-on-submit ---------------------------------------------------
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.dataset && f.dataset.confirm) {
      if (!window.confirm(f.dataset.confirm)) e.preventDefault();
    }
  });

  // --- Copy buttons --------------------------------------------------------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    var sel = btn.getAttribute('data-copy');
    var input = document.querySelector(sel);
    var text = input ? input.value : btn.getAttribute('data-copy-text') || '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = t('copied');
      setTimeout(function () {
        btn.textContent = old;
      }, 1200);
    });
  });

  // --- Renew modal: prefill ------------------------------------------------
  window.openRenew = function (serverId, email) {
    var form = document.getElementById('renewForm');
    if (form) form.action = '/reseller/clients/' + serverId + '/renew';
    var emailField = document.getElementById('renewEmail');
    if (emailField) emailField.value = email;
    var title = document.getElementById('renewTitle');
    if (title) title.textContent = title.dataset.tpl.replace('{email}', email);
    openModal('renewModal');
  };

  // --- Get-link modal ------------------------------------------------------
  window.getLinks = function (url) {
    var body = document.getElementById('linkBody');
    body.innerHTML = '<p class="muted">' + t('loading') + '</p>';
    openModal('linkModal');
    fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) {
          body.innerHTML = '<div class="flash error">' + (d.msg || t('error')) + '</div>';
          return;
        }
        var html = '';
        if (d.subLink) {
          html += linkBlock(t('subscription_link'), d.subLink, d.subQr);
        } else {
          html += '<div class="hint">' + t('no_sublink_hint') + '</div>';
        }
        if (d.directLinks && d.directLinks.length) {
          d.directLinks.forEach(function (l) {
            html += linkBlock(t('direct_link') + (l.remark ? ' — ' + escapeHtml(l.remark) : ''), l.link, l.qr);
          });
        } else if (!d.subLink) {
          html += '<div class="hint">' + t('no_links') + '</div>';
        }
        body.innerHTML = html;
      })
      .catch(function () {
        body.innerHTML = '<div class="flash error">' + t('error') + '</div>';
      });
  };

  function linkBlock(label, link, qr) {
    var id = 'lk' + Math.random().toString(36).slice(2, 8);
    var h = '<div class="linkblock">';
    h += '<div class="lh">' + label + '</div>';
    h += '<div class="lrow">';
    h += '<input type="text" id="' + id + '" readonly value="' + escapeAttr(link) + '">';
    h += '<button class="btn sm ghost" data-copy="#' + id + '">' + t('copy') + '</button>';
    h += '</div>';
    if (qr) h += '<div class="qr"><img alt="QR" src="' + qr + '"></div>';
    h += '</div>';
    return h;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  // --- Server test connection ---------------------------------------------
  window.testConnection = function (btn) {
    var form = document.getElementById('serverForm');
    var out = document.getElementById('testResult');
    if (!form) return;
    var data = {
      id: form.dataset.serverId || '',
      base_url: val(form, 'base_url'),
      api_token: val(form, 'api_token'),
      sub_base_url: val(form, 'sub_base_url'),
      api_style: val(form, 'api_style'),
      username: val(form, 'username'),
      password: val(form, 'password'),
    };
    out.innerHTML = '<span class="muted">' + t('loading') + '</span>';
    btn.disabled = true;
    fetch('/admin/servers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify(data),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        out.innerHTML = '<div class="flash ' + (d.success ? 'success' : 'error') + '">' + escapeHtml(d.msg || '') + '</div>';
      })
      .catch(function () {
        out.innerHTML = '<div class="flash error">' + t('error') + '</div>';
      })
      .finally(function () {
        btn.disabled = false;
      });
  };

  function val(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : '';
  }

  // --- TLS settings: validate cert/key paths (Settings page) ---------------
  window.testTls = function (btn) {
    var form = document.getElementById('tlsForm');
    var out = document.getElementById('tlsTestResult');
    if (!form || !out) return;
    var data = { tls_cert_path: val(form, 'tls_cert_path'), tls_key_path: val(form, 'tls_key_path') };
    out.innerHTML = '<span class="muted">' + t('loading') + '</span>';
    btn.disabled = true;
    fetch('/admin/settings/tls-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify(data),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        out.innerHTML = '<div class="flash ' + (d.success ? 'success' : 'error') + '">' + escapeHtml(d.msg || '') + '</div>';
      })
      .catch(function () {
        out.innerHTML = '<div class="flash error">' + t('error') + '</div>';
      })
      .finally(function () {
        btn.disabled = false;
      });
  };
})();
