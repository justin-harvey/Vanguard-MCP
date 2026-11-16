/*
 * Live municipal demo client for the Civic-Chain Grant & Budget Auditor.
 *
 * The browser only ever talks to the Supabase edge proxy, which forwards to the
 * isolated engine server-to-server. Set the proxy URL once, either here or via
 * window.CIVIC_PROXY_URL before this script loads:
 *
 *   window.CIVIC_PROXY_URL = "https://<project>.functions.supabase.co/query";
 *
 * With no proxy configured the page still demonstrates, using a baked-in sample
 * response clearly labelled "sample" so the static site is never blank.
 *
 * Everything served here is SYNTHETIC data for the fictional Town of Sampleton.
 * Nothing here is a professional audit opinion.
 */
(function () {
  'use strict';

  var PROXY_URL = (typeof window !== 'undefined' && window.CIVIC_PROXY_URL) || '';
  var AUTH = (typeof window !== 'undefined' && window.CIVIC_AUTH_TOKEN) || '';

  // The three named municipal queries and the parameters each accepts.
  var QUERIES = {
    'grant-status': {
      label: 'Grant status',
      blurb: 'Award, paid and pending spending, cash drawn down, remaining balance and percent spent, per grant.',
      params: [
        { name: 'grant_id', kind: 'text', label: 'Grant ID', placeholder: 'e.g. G-402 (blank = all grants)' },
        { name: 'status', kind: 'select', label: 'Status', options: ['', 'active', 'closed'] }
      ]
    },
    'spending-by-vendor': {
      label: 'Spending by vendor',
      blurb: 'Paid spending and invoice count per vendor, optionally for one grant, fiscal year or department.',
      params: [
        { name: 'grant_id', kind: 'text', label: 'Grant ID', placeholder: 'e.g. G-402 (optional)' },
        { name: 'fiscal_year', kind: 'select', label: 'Fiscal year', options: ['', '2026', '2027'] },
        { name: 'dept_id', kind: 'select', label: 'Department', options: ['', 'PW', 'PR', 'LIB', 'PD', 'SR', 'FIN'] }
      ]
    },
    'budget-variance': {
      label: 'Budget variance',
      blurb: 'Adopted and amended budget against paid and pending spending, remaining budget and percent used, per line.',
      params: [
        { name: 'fiscal_year', kind: 'select', label: 'Fiscal year', options: ['', '2026', '2027'] },
        { name: 'dept_id', kind: 'select', label: 'Department', options: ['', 'PW', 'PR', 'LIB', 'PD', 'SR', 'FIN'] }
      ]
    }
  };

  // A real engine response (grant-status, G-402), used when no proxy is wired so
  // the static page still shows the shape of a verified answer.
  var SAMPLE = {
    sample: true,
    query: 'municipal/grant-status',
    params: { grant_id: 'G-402', status: null },
    rows: [{
      grant_id: 'G-402', grant_name: 'Municipal Paving Program 2026',
      grantor: 'State Department of Transportation', status: 'active',
      award_cents: 125000000, paid_cents: 93165000, pending_cents: 9880000,
      drawn_cents: 100000000, remaining_cents: 31835000,
      drawn_minus_paid_cents: 6835000, pct_award_spent: 74.5
    }],
    integrity: 'pass',
    findings: 1,
    checks: [
      { id: 'one-row-per-grant', type: 'unique', severity: 'integrity', status: 'pass' },
      { id: 'paid-total-reconciles', type: 'total_matches', severity: 'integrity', status: 'pass' },
      { id: 'spending-within-award', type: 'compare', severity: 'finding', status: 'pass', rule: 'paid_cents <= award_cents' },
      { id: 'cash-not-ahead-of-spending', type: 'compare', severity: 'finding', status: 'flag', rule: 'drawn_cents <= paid_cents', message: 'More grant cash has been drawn down than has been spent; the excess is grantor money held in advance.', detail: { rows: ['G-402'], count: 1 } }
    ],
    provenance: {
      resultHash: '48c6ee7a162877906c2c3cb7a9775fb95c9b0934fa8cee844d8ffa7637bc608e',
      auditSeq: 0,
      auditHash: 'abac86a7f24dbcd3cf2f6afebde7c72da69a216a3a22108a6b1ba85dc87c812f',
      complianceTags: ['named-query', 'checked', 'reproducible']
    }
  };

  // ── formatting ────────────────────────────────────────────────────────────
  function titleize(key) {
    return key.replace(/_cents$/, '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function fmtCell(key, value) {
    if (value === null || value === undefined) return '—';
    if (/_cents$/.test(key)) {
      return '$' + (Number(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (/^pct_/.test(key)) return Number(value).toLocaleString('en-US') + '%';
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return String(value);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── network ───────────────────────────────────────────────────────────────
  async function callProxy(tool, args) {
    if (!PROXY_URL) throw new Error('not-configured');
    var headers = { 'content-type': 'application/json' };
    if (AUTH) headers.authorization = 'Bearer ' + AUTH;
    var res = await fetch(PROXY_URL, {
      method: 'POST', headers, body: JSON.stringify({ tool: tool, args: args })
    });
    var data = await res.json();
    if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    return data.result;
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function renderParams(queryKey) {
    var q = QUERIES[queryKey];
    var host = document.getElementById('params');
    host.innerHTML = '';
    document.getElementById('q-blurb').textContent = q.blurb;
    q.params.forEach(function (p) {
      var wrap = document.createElement('label');
      wrap.className = 'field';
      wrap.innerHTML = '<span>' + esc(p.label) + '</span>';
      var input;
      if (p.kind === 'select') {
        input = document.createElement('select');
        p.options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o; opt.textContent = o === '' ? 'Any' : o;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        if (p.placeholder) input.placeholder = p.placeholder;
      }
      input.id = 'p-' + p.name;
      input.setAttribute('data-param', p.name);
      wrap.appendChild(input);
      host.appendChild(wrap);
    });
  }

  function collectArgs(queryKey) {
    var args = {};
    QUERIES[queryKey].params.forEach(function (p) {
      var el = document.getElementById('p-' + p.name);
      var v = el && el.value.trim();
      if (!v) return;
      args[p.name] = p.name === 'fiscal_year' ? Number(v) : v;
    });
    return args;
  }

  function renderResult(out) {
    var host = document.getElementById('result');
    var rows = out.rows || [];
    var cols = rows.length ? Object.keys(rows[0]) : [];

    var table = rows.length
      ? '<div class="tbl-wrap"><table class="rows"><thead><tr>' +
          cols.map(function (c) { return '<th>' + esc(titleize(c)) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + cols.map(function (c) {
              var money = /_cents$/.test(c);
              return '<td class="' + (money ? 'num' : '') + '">' + esc(fmtCell(c, r[c])) + '</td>';
            }).join('') + '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<p class="muted">No rows matched.</p>';

    var intact = out.integrity === 'pass';
    var integrity = '<span class="verdict ' + (intact ? 'ok' : 'flag') + '">integrity: ' + esc(out.integrity) + '</span>';

    var checks = (out.checks || []).map(function (c) {
      var cls = c.status === 'flag' ? 'flag' : (c.status === 'pass' ? 'ok' : 'warn');
      return '<li class="chk ' + cls + '"><span class="chk-id">' + esc(c.id) + '</span>' +
        '<span class="chk-sev">' + esc(c.severity) + '</span>' +
        '<span class="chk-st">' + esc(c.status) + '</span>' +
        (c.message ? '<div class="chk-msg">' + esc(c.message) + '</div>' : '') + '</li>';
    }).join('');

    var p = out.provenance || {};
    var prov = '<div class="prov">' +
      '<div class="row"><span class="k">result hash </span>' + esc(p.resultHash || '—') + '</div>' +
      '<div class="row"><span class="k">audit entry </span>#' + esc(p.auditSeq) + ' &nbsp; ' + esc((p.auditHash || '').slice(0, 24)) + '… &nbsp; <span class="pill">appended</span></div>' +
      (p.complianceTags ? '<div class="row"><span class="k">tags        </span>' + esc(p.complianceTags.join(' · ')) + '</div>' : '') +
      '</div>';

    host.innerHTML =
      (out.sample ? '<div class="disc" style="margin-bottom:14px"><b>Sample response.</b> The live engine is not wired to this page yet, so this is a baked-in example of a verified answer. Set the proxy URL to run it for real.</div>' : '') +
      '<div class="res-head">' + integrity + '<span class="muted">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' · ' + esc(out.findings || 0) + ' finding' + ((out.findings || 0) === 1 ? '' : 's') + '</span></div>' +
      table +
      '<div class="sec">Automatic checks</div><ul class="checks">' + checks + '</ul>' +
      '<div class="sec">Provenance</div>' + prov;
    document.getElementById('verify-wrap').hidden = false;
  }

  function renderVerify(out) {
    var host = document.getElementById('verify-out');
    if (!out) { host.innerHTML = ''; return; }
    var ok = out.ok;
    host.innerHTML = '<span class="verdict ' + (ok ? 'ok' : 'flag') + '">chain ' + (ok ? 'INTACT' : 'BROKEN') + '</span>' +
      '<span class="muted">' + esc(out.entries) + ' entr' + (out.entries === 1 ? 'y' : 'ies') +
      (out.brokenAt != null ? ' · first break at #' + esc(out.brokenAt) : '') + '</span>';
  }

  function setStatus(msg, busy) {
    var el = document.getElementById('run-status');
    el.textContent = msg || '';
    document.getElementById('run-btn').disabled = !!busy;
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function init() {
    var sel = document.getElementById('query');
    Object.keys(QUERIES).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = QUERIES[k].label;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { renderParams(sel.value); });
    renderParams(sel.value);

    if (!PROXY_URL) {
      document.getElementById('live-note').innerHTML =
        'Engine not wired yet — showing a <b>sample</b> response. (Set the Supabase proxy URL to run live.)';
    }

    document.getElementById('run-btn').addEventListener('click', async function () {
      var queryKey = sel.value;
      var args = collectArgs(queryKey);
      renderVerify(null);
      document.getElementById('verify-wrap').hidden = true;
      setStatus('Running through the guarded, read-only pipeline…', true);
      try {
        var out = PROXY_URL
          ? await callProxy('run_canonical', { name: 'municipal/' + queryKey, args: args })
          : SAMPLE;
        renderResult(out);
        setStatus('', false);
      } catch (e) {
        if (e.message === 'not-configured') { renderResult(SAMPLE); setStatus('', false); return; }
        setStatus('Failed: ' + e.message, false);
      }
    });

    document.getElementById('verify-btn').addEventListener('click', async function () {
      renderVerify(null);
      var el = document.getElementById('verify-out');
      el.textContent = 'Verifying…';
      try {
        var out = PROXY_URL
          ? await callProxy('verify_audit', { warehouse: 'municipal' })
          : { ok: true, entries: 1, brokenAt: null };
        renderVerify(out);
      } catch (e) {
        el.textContent = 'Verify failed: ' + e.message;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
