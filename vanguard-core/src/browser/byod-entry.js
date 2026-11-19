/**
 * The "bring your own expenditures" demo: a second in-browser engine, bundled to
 * site/assets/byod-engine.js by scripts/build-demo.js.
 *
 * Unlike the municipal demo (demo-entry.js), the *data* here is the visitor's:
 * two small, editable CSV "bricks" (a list of expenditures and a list of budget
 * caps) are parsed in the browser into a fresh WASM SQLite database, and three
 * fixed named queries run over it through the real guard / lineage / audit
 * pipeline. Because the schema is fixed and we own it, the actual integrity and
 * finding checks (overspend, duplicate payment, totals reconcile) fire on the
 * visitor's own numbers. Nothing is uploaded; everything runs on this page.
 *
 * It is deliberately self-contained (its own render helpers, its own audit
 * store) so it adds nothing to, and cannot break, the municipal demo bundle.
 */

import { createDemoEngine } from './engine.js';
import { sqljsAdapter } from './sqlite-adapter.js';

const STORE_KEY = 'civic-chain-byod-audit-v1';

// ── the fixed sandbox schema and its named queries ──────────────────────────
// The visitor edits the rows, never the schema, so these real checks always
// line up with the columns.
const ALLOWLIST = {
    name: 'sandbox',
    description: 'Your own expenditures and budget caps, parsed in the browser. All money in integer cents.',
    domain: 'expenditure and budget data',
    tables: {
        expenditures: ['expenditure_id', 'txn_date', 'vendor', 'category', 'amount_cents', 'budget_code'],
        budgets: ['budget_code', 'cap_cents'],
    },
    notes: ['All money columns end in _cents and hold INTEGER CENTS.'],
    queries: {
        'budget-overspend': {
            description: 'Each budget code: its cap, spend to date and remaining budget; flags any code over its cap.',
            params: {},
            sql: 'SELECT b.budget_code, b.cap_cents, COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS amount_cents, b.cap_cents - COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS remaining_cents FROM budgets b ORDER BY b.budget_code',
            checks: [
                { id: 'one-row-per-code', type: 'unique', columns: ['budget_code'] },
                { id: 'within-budget', type: 'compare', left: 'amount_cents', op: '<=', right: 'cap_cents', key: 'budget_code', message: 'Spending against this budget code exceeds its cap.' },
            ],
        },
        'duplicate-invoices': {
            description: 'Exact-duplicate payments: the same vendor paid the same amount against the same budget code more than once.',
            params: {},
            sql: 'SELECT e.vendor, e.category, e.budget_code, e.amount_cents, COUNT(e.expenditure_id) AS copies FROM expenditures e GROUP BY e.vendor, e.category, e.budget_code, e.amount_cents HAVING COUNT(e.expenditure_id) > 1 ORDER BY e.amount_cents DESC, e.vendor',
            checks: [
                { id: 'no-duplicate-payments', type: 'empty', key: 'vendor', message: 'This vendor was paid the same amount against the same budget code more than once; confirm it is not a duplicate payment.' },
            ],
        },
        'spend-by-category': {
            description: 'Total spend and invoice count per category.',
            params: {},
            sql: 'SELECT e.category, COUNT(e.expenditure_id) AS invoice_count, SUM(e.amount_cents) AS amount_cents FROM expenditures e GROUP BY e.category ORDER BY SUM(e.amount_cents) DESC, e.category',
            checks: [
                { id: 'one-row-per-category', type: 'unique', columns: ['category'] },
                { id: 'total-reconciles', type: 'total_matches', column: 'amount_cents', sql: 'SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e' },
            ],
        },
    },
};

// Default bricks. Designed to tell a story: the two identical $42,000 Acme
// Paving lines are both a duplicate payment and the reason roads-26 is over cap.
const DEFAULT_EXPENDITURES = `date, vendor, category, amount, budget
2026-03-02, Acme Paving, roads, 42000, roads-26
2026-03-09, Acme Paving, roads, 42000, roads-26
2026-03-11, Bay Office Supply, admin, 1875, admin-26
2026-04-01, North Fuel, fleet, 9100, fleet-26
2026-04-04, North Fuel, fleet, 18200, fleet-26`;

const DEFAULT_BUDGETS = `budget, cap
roads-26, 60000
admin-26, 5000
fleet-26, 30000`;

// ── CSV parsing (dependency-free; the bricks are tiny and comma-delimited) ───
class ParseError extends Error {}

function splitRows(text) {
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(',').map((c) => c.trim()));
}
function toCents(raw, lineNo) {
    const n = Number(String(raw).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) throw new ParseError(`Line ${lineNo}: "${raw}" is not a dollar amount.`);
    return Math.round(n * 100);
}
function looksNumeric(raw) {
    return raw != null && raw !== '' && Number.isFinite(Number(String(raw).replace(/[$,\s]/g, '')));
}

function parseExpenditures(text) {
    const rows = splitRows(text);
    const out = [];
    rows.forEach((cells, i) => {
        // Skip a header row (its amount column, index 3, is not a number).
        if (i === 0 && !looksNumeric(cells[3])) return;
        if (cells.length < 5) throw new ParseError(`Line ${i + 1}: expected date, vendor, category, amount, budget.`);
        const [txn_date, vendor, category, amount, budget_code] = cells;
        out.push({ txn_date, vendor, category, amount_cents: toCents(amount, i + 1), budget_code });
    });
    if (out.length === 0) throw new ParseError('Add at least one expenditure line.');
    return out;
}
function parseBudgets(text) {
    const rows = splitRows(text);
    const out = [];
    rows.forEach((cells, i) => {
        if (i === 0 && !looksNumeric(cells[1])) return; // header
        if (cells.length < 2) throw new ParseError(`Budget line ${i + 1}: expected budget, cap.`);
        out.push({ budget_code: cells[0], cap_cents: toCents(cells[1], i + 1) });
    });
    return out;
}

function sqlStr(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
}
function buildSeedSql(expenditures, budgets) {
    const lines = [
        'CREATE TABLE expenditures (expenditure_id INTEGER PRIMARY KEY, txn_date TEXT, vendor TEXT, category TEXT, amount_cents INTEGER, budget_code TEXT);',
        'CREATE TABLE budgets (budget_code TEXT PRIMARY KEY, cap_cents INTEGER);',
    ];
    expenditures.forEach((e, i) => {
        lines.push(`INSERT INTO expenditures VALUES (${i + 1}, ${sqlStr(e.txn_date)}, ${sqlStr(e.vendor)}, ${sqlStr(e.category)}, ${e.amount_cents}, ${sqlStr(e.budget_code)});`);
    });
    budgets.forEach((b) => {
        lines.push(`INSERT INTO budgets VALUES (${sqlStr(b.budget_code)}, ${b.cap_cents});`);
    });
    return lines.join('\n');
}

// ── audit store (localStorage, with an in-memory fallback) ──────────────────
function makeStore() {
    let mem = [];
    const usable = (() => {
        try {
            window.localStorage.setItem('__cc_byod_probe__', '1');
            window.localStorage.removeItem('__cc_byod_probe__');
            return true;
        } catch { return false; }
    })();
    if (!usable) return { load: () => mem, save: (e) => { mem = e; } };
    return {
        load() { try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; } },
        save(entries) { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(entries)); } catch { mem = entries; } },
    };
}

// ── formatting + rendering (scoped to this section's own element ids) ───────
function titleize(key) {
    return key.replace(/_cents$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmtCell(key, value) {
    if (value === null || value === undefined) return '—';
    if (/_cents$/.test(key)) return '$' + (Number(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return String(value);
}
function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function rowsTable(rows) {
    if (!rows.length) return '<p class="muted">No rows matched — nothing to flag.</p>';
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
    const host = document.getElementById('byo-result');
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
    const sqlBlock = out.sql ? '<div class="sec">Executed SQL</div><pre class="sql">' + esc(out.sql) + '</pre>' : '';
    host.innerHTML =
        '<div class="res-head">' + integrity + '<span class="muted">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' · ' + esc(out.findings || 0) + ' finding' + ((out.findings || 0) === 1 ? '' : 's') + '</span></div>' +
        rowsTable(rows) +
        '<div class="sec">Automatic checks</div><ul class="checks">' + checks + '</ul>' +
        sqlBlock +
        '<div class="sec">Provenance</div>' + prov;
    document.getElementById('byo-verify-wrap').hidden = false;
}
function renderVerify(out) {
    const host = document.getElementById('byo-verify-out');
    if (!out) { host.innerHTML = ''; return; }
    host.innerHTML = '<span class="verdict ' + (out.ok ? 'ok' : 'flag') + '">chain ' + (out.ok ? 'INTACT' : 'BROKEN') + '</span>' +
        '<span class="muted">' + esc(out.entries) + ' entr' + (out.entries === 1 ? 'y' : 'ies') +
        (out.brokenAt != null ? ' · first break at #' + esc(out.brokenAt) : '') +
        (out.reason ? ' · ' + esc(out.reason) : '') + '</span>';
}
function setStatus(msg) {
    const el = document.getElementById('byo-status');
    if (el) el.textContent = msg || '';
}

// ── engine lifecycle ────────────────────────────────────────────────────────
let SQL = null;            // the loaded sql.js module
const store = makeStore();

function buildEngine() {
    const expenditures = parseExpenditures(document.getElementById('byo-data').value);
    const budgets = parseBudgets(document.getElementById('byo-budgets').value);
    const seedSql = buildSeedSql(expenditures, budgets);
    const sqlite = sqljsAdapter(new SQL.Database());
    try {
        return createDemoEngine({ sqlite, seedSql, allowlist: ALLOWLIST, store });
    } catch (e) {
        // Most likely a duplicate budget code (PRIMARY KEY) in the caps brick.
        throw new ParseError('Could not load the data: ' + e.message);
    }
}

function ask(name) {
    renderVerify(null);
    document.getElementById('byo-verify-wrap').hidden = true;
    try {
        const engine = buildEngine();
        setStatus('Ran through the guarded, read-only pipeline — locally.');
        renderResult(engine.runNamed(name, {}));
    } catch (e) {
        setStatus(e instanceof ParseError ? e.message : ('Refused: ' + e.message));
        document.getElementById('byo-result').innerHTML = '';
    }
}

function wire() {
    for (const btn of document.querySelectorAll('[data-byo-q]')) {
        btn.addEventListener('click', () => ask(btn.getAttribute('data-byo-q')));
    }
    const verifyBtn = document.getElementById('byo-verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', () => { try { renderVerify(buildEngine().verifyChain()); } catch { renderVerify(store ? { ok: true, entries: store.load().length } : null); } });
    const tamperBtn = document.getElementById('byo-tamper-btn');
    if (tamperBtn) tamperBtn.addEventListener('click', () => {
        let engine; try { engine = buildEngine(); } catch { return; }
        if (!engine.tamperFirstEntry()) { renderVerify({ ok: true, entries: 0, brokenAt: null, reason: 'nothing to tamper with yet — ask a question first' }); return; }
        renderVerify(engine.verifyChain());
    });
    const resetBtn = document.getElementById('byo-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { store.save([]); renderVerify({ ok: true, entries: 0, brokenAt: null, reason: 'chain cleared' }); });
    const restoreBtn = document.getElementById('byo-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', () => {
        document.getElementById('byo-data').value = DEFAULT_EXPENDITURES;
        document.getElementById('byo-budgets').value = DEFAULT_BUDGETS;
        setStatus('Sample lines restored.');
    });
}

async function boot() {
    const data = document.getElementById('byo-data');
    const budgets = document.getElementById('byo-budgets');
    if (data && !data.value.trim()) data.value = DEFAULT_EXPENDITURES;
    if (budgets && !budgets.value.trim()) budgets.value = DEFAULT_BUDGETS;
    wire();
    try {
        if (typeof window.initSqlJs !== 'function') throw new Error('sql.js loader missing');
        const base = new URL('.', import.meta.url);
        SQL = await window.initSqlJs({ locateFile: (f) => new URL(f, base).href });
        setStatus('Edit the lines, then ask a question.');
    } catch (e) {
        setStatus('The in-browser engine could not start (' + e.message + ').');
        for (const btn of document.querySelectorAll('[data-byo-q]')) btn.disabled = true;
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
