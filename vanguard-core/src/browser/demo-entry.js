/**
 * The in-browser demo: engine + page controller, bundled to
 * site/assets/demo-engine.js by scripts/build-demo.js.
 *
 * It assembles the real engine (guard, named queries, lineage, audit chain)
 * over a WASM SQLite database built in memory from the inlined seed SQL, wires
 * it to the page, and runs everything locally. There is no server, no proxy,
 * and no network request after the page and its assets load.
 *
 * The seed SQL and the allow-list are inlined from the skill assets at build
 * time, so the browser serves exactly the fixture the Node tests use.
 */

import { createDemoEngine } from './engine.js';
import { sqljsAdapter } from './sqlite-adapter.js';
import seedSql from '../../../skills/civic-chain-auditor/assets/sample_municipal_budget.sql';
import allowlist from '../../../skills/civic-chain-auditor/assets/sample_allowlist.json';

const STORE_KEY = 'civic-chain-demo-audit-v1';

// A baked-in example of a verified answer, shown only if WASM fails to load so
// the page is never blank. Clearly labelled "sample".
const SAMPLE = {
    sample: true,
    query: 'municipal/grant-status',
    sql: "SELECT g.grant_id, … FROM grants g WHERE g.grant_id = 'G-402'",
    rows: [{
        grant_id: 'G-402', grant_name: 'Municipal Paving Program 2026',
        grantor: 'State Department of Transportation', status: 'active',
        award_cents: 125000000, paid_cents: 93165000, pending_cents: 9880000,
        drawn_cents: 100000000, remaining_cents: 31835000,
        drawn_minus_paid_cents: 6835000, pct_award_spent: 74.5,
    }],
    integrity: 'pass',
    findings: 1,
    checks: [
        { id: 'one-row-per-grant', type: 'unique', severity: 'integrity', status: 'pass' },
        { id: 'paid-total-reconciles', type: 'total_matches', severity: 'integrity', status: 'pass' },
        { id: 'spending-within-award', type: 'compare', severity: 'finding', status: 'pass', rule: 'paid_cents <= award_cents' },
        { id: 'cash-not-ahead-of-spending', type: 'compare', severity: 'finding', status: 'flag', rule: 'drawn_cents <= paid_cents', message: 'More grant cash has been drawn down than has been spent; the excess is grantor money held in advance.' },
    ],
    provenance: {
        resultHash: '(sample — run locally for a real hash)',
        auditSeq: 0,
        auditHash: '(sample)',
        complianceTags: ['named-query', 'checked', 'reproducible'],
    },
};

// ── audit store (localStorage, with an in-memory fallback) ──────────────────
function makeStore() {
    let mem = [];
    const usable = (() => {
        try {
            const probe = '__cc_probe__';
            window.localStorage.setItem(probe, '1');
            window.localStorage.removeItem(probe);
            return true;
        } catch {
            return false; // storage disabled (private mode, blocked); keep working in memory
        }
    })();
    if (!usable) {
        return { load: () => mem, save: (e) => { mem = e; } };
    }
    return {
        load() {
            try {
                return JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]');
            } catch {
                return [];
            }
        },
        save(entries) {
            try {
                window.localStorage.setItem(STORE_KEY, JSON.stringify(entries));
            } catch {
                mem = entries; // fall back silently if the write fails mid-session
            }
        },
    };
}

// ── formatting ──────────────────────────────────────────────────────────────
function titleize(key) {
    return key.replace(/_cents$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmtCell(key, value) {
    if (value === null || value === undefined) return '—';
    if (/_cents$/.test(key)) {
        return '$' + (Number(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (/^pct/.test(key)) return Number(value).toLocaleString('en-US') + '%';
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return String(value);
}
function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── rendering ─────────────────────────────────────────────────────────────
function rowsTable(rows) {
    if (!rows.length) return '<p class="muted">No rows matched.</p>';
    const cols = Object.keys(rows[0]);
    return '<div class="tbl-wrap"><table class="rows"><thead><tr>' +
        cols.map((c) => '<th>' + esc(titleize(c)) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + cols.map((c) => {
            const money = /_cents$/.test(c);
            return '<td class="' + (money ? 'num' : '') + '">' + esc(fmtCell(c, r[c])) + '</td>';
        }).join('') + '</tr>').join('') +
        '</tbody></table></div>';
}

function renderResult(out) {
    const host = document.getElementById('result');
    const rows = out.rows || [];
    const intact = out.integrity === 'pass';
    const integrity = '<span class="verdict ' + (intact ? 'ok' : 'flag') + '">integrity: ' + esc(out.integrity) + '</span>';

    const checks = (out.checks || []).map((c) => {
        const cls = c.status === 'flag' ? 'flag' : (c.status === 'pass' ? 'ok' : 'warn');
        return '<li class="chk ' + cls + '"><span class="chk-id">' + esc(c.id) + '</span>' +
            '<span class="chk-sev">' + esc(c.severity) + '</span>' +
            '<span class="chk-st">' + esc(c.status) + '</span>' +
            (c.message ? '<div class="chk-msg">' + esc(c.message) + '</div>' : '') + '</li>';
    }).join('');

    const p = out.provenance || {};
    const prov = '<div class="prov">' +
        '<div class="row"><span class="k">result hash </span>' + esc(p.resultHash || '—') + '</div>' +
        '<div class="row"><span class="k">audit entry </span>#' + esc(p.auditSeq) + ' &nbsp; ' + esc(String(p.auditHash || '').slice(0, 24)) + '… &nbsp; <span class="pill">appended locally</span></div>' +
        (p.complianceTags ? '<div class="row"><span class="k">tags        </span>' + esc(p.complianceTags.join(' · ')) + '</div>' : '') +
        '</div>';

    const sqlBlock = out.sql
        ? '<div class="sec">Executed SQL</div><pre class="sql">' + esc(out.sql) + '</pre>'
        : '';

    host.innerHTML =
        (out.sample ? '<div class="disc" style="margin-bottom:14px"><b>Sample response.</b> The in-browser engine could not load (WebAssembly may be blocked), so this is a baked-in example. Everything else on this page needs the engine.</div>' : '') +
        '<div class="res-head">' + integrity + '<span class="muted">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' · ' + esc(out.findings || 0) + ' finding' + ((out.findings || 0) === 1 ? '' : 's') + '</span></div>' +
        rowsTable(rows) +
        '<div class="sec">Automatic checks</div><ul class="checks">' + checks + '</ul>' +
        sqlBlock +
        '<div class="sec">Provenance</div>' + prov;
    document.getElementById('verify-wrap').hidden = false;
}

function renderVerify(out) {
    const host = document.getElementById('verify-out');
    if (!out) { host.innerHTML = ''; return; }
    const ok = out.ok;
    host.innerHTML = '<span class="verdict ' + (ok ? 'ok' : 'flag') + '">chain ' + (ok ? 'INTACT' : 'BROKEN') + '</span>' +
        '<span class="muted">' + esc(out.entries) + ' entr' + (out.entries === 1 ? 'y' : 'ies') +
        (out.brokenAt != null ? ' · first break at #' + esc(out.brokenAt) : '') +
        (out.reason ? ' · ' + esc(out.reason) : '') + '</span>';
}

function setStatus(msg, busy) {
    document.getElementById('run-status').textContent = msg || '';
    const btn = document.getElementById('run-btn');
    if (btn) btn.disabled = !!busy;
}

// ── parameter UI, derived from the query definitions ────────────────────────
let QUERIES = {}; // name -> definition (from engine.listQueries())

function renderParams(name) {
    const def = QUERIES[name];
    const host = document.getElementById('params');
    host.innerHTML = '';
    document.getElementById('q-blurb').textContent = def.description;

    for (const [pname, spec] of Object.entries(def.params)) {
        const wrap = document.createElement('label');
        wrap.className = 'field';
        wrap.innerHTML = '<span>' + esc(pname.replace(/_/g, ' ')) + '</span>';
        let input;
        if (Array.isArray(spec.enum)) {
            input = document.createElement('select');
            for (const o of ['', ...spec.enum]) {
                const opt = document.createElement('option');
                opt.value = o;
                opt.textContent = o === '' ? 'Any' : o;
                input.appendChild(opt);
            }
        } else {
            input = document.createElement('input');
            input.type = spec.type === 'integer' || spec.type === 'number' ? 'number' : 'text';
            input.placeholder = spec.description || (spec.required ? 'required' : 'optional');
        }
        input.id = 'p-' + pname;
        input.setAttribute('data-param', pname);
        input.setAttribute('data-type', spec.type);
        wrap.appendChild(input);
        host.appendChild(wrap);
    }
}

function collectArgs(name) {
    const args = {};
    for (const pname of Object.keys(QUERIES[name].params)) {
        const el = document.getElementById('p-' + pname);
        const raw = el && el.value.trim();
        if (!raw) continue;
        const type = el.getAttribute('data-type');
        args[pname] = type === 'integer' || type === 'number' ? Number(raw) : raw;
    }
    return args;
}

// ── engine load ─────────────────────────────────────────────────────────────
async function loadEngine() {
    if (typeof window.initSqlJs !== 'function') throw new Error('sql.js loader missing');
    const base = new URL('.', import.meta.url); // this module lives in /assets/
    const SQL = await window.initSqlJs({ locateFile: (f) => new URL(f, base).href });
    const sqlite = sqljsAdapter(new SQL.Database());
    return createDemoEngine({ sqlite, seedSql, allowlist, store: makeStore() });
}

// ── wiring ────────────────────────────────────────────────────────────────
function init(engine) {
    for (const def of engine.listQueries()) QUERIES[def.name] = def;

    const sel = document.getElementById('query');
    for (const name of Object.keys(QUERIES)) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        sel.appendChild(o);
    }
    sel.addEventListener('change', () => renderParams(sel.value));
    renderParams(sel.value);

    document.getElementById('run-btn').addEventListener('click', () => {
        const name = sel.value;
        renderVerify(null);
        document.getElementById('verify-wrap').hidden = true;
        setStatus('Running through the guarded, read-only pipeline — locally…', true);
        try {
            renderResult(engine.runNamed(name, collectArgs(name)));
            setStatus('', false);
        } catch (e) {
            setStatus('Refused: ' + e.message, false);
        }
    });

    document.getElementById('verify-btn').addEventListener('click', () => {
        renderVerify(engine.verifyChain());
    });

    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        engine.resetChain();
        renderVerify(engine.verifyChain());
    });

    const tamperBtn = document.getElementById('tamper-btn');
    if (tamperBtn) tamperBtn.addEventListener('click', () => {
        if (!engine.tamperFirstEntry()) {
            renderVerify({ ok: true, entries: 0, brokenAt: null, reason: 'nothing to tamper with yet — run a query first' });
            return;
        }
        renderVerify(engine.verifyChain());
    });

    const sqlBtn = document.getElementById('trysql-btn');
    if (sqlBtn) sqlBtn.addEventListener('click', () => {
        const box = document.getElementById('trysql-input');
        const outHost = document.getElementById('trysql-out');
        const res = engine.tryRawSql(box.value);
        if (res.ok) {
            outHost.innerHTML = '<span class="verdict ok">allowed</span>' + rowsTable(res.rows);
        } else {
            outHost.innerHTML = '<span class="verdict flag">refused: ' + esc(res.reason) + '</span>' +
                '<p class="muted">' + esc(res.message) + '</p>';
        }
    });
}

async function boot() {
    setStatus('Loading the engine in your browser…', true);
    try {
        const engine = await loadEngine();
        init(engine);
        setStatus('', false);
        const note = document.getElementById('live-note');
        if (note) note.innerHTML = 'Running entirely in your browser. Nothing on this page is sent to Civic-Chain or anyone else.';
    } catch (e) {
        // WASM blocked or failed: fall back to the labelled sample so the page
        // is never blank, and disable the interactive controls.
        setStatus('', false);
        const note = document.getElementById('live-note');
        if (note) note.textContent = 'The in-browser engine could not start (' + e.message + '); showing a sample.';
        renderResult(SAMPLE);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
