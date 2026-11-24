/**
 * The "import your own ledger" demo: a third in-browser engine, bundled to
 * site/assets/import-engine-bundle.js by scripts/build-demo.js.
 *
 * A visitor drops (or picks) a real municipal expenditure CSV. It is parsed in
 * the browser, the agent proposes a column mapping, the visitor confirms or
 * edits it, and a Canonical Municipal Schema v1 ledger is built entirely in
 * memory (WASM SQLite). The three named queries then run through the real guard
 * / lineage / audit pipeline and come back as hashed answers with an audit
 * chain — the same path a buyer runs with the Node package
 * (test/import-browser-parity.test.js pins that the hashes match).
 *
 * The file never leaves the machine: FileReader reads the bytes locally, they
 * are parsed here, and nothing is uploaded. There is no network call.
 *
 * It is self-contained (its own render helpers, element ids and audit store) so
 * it adds nothing to, and cannot break, the other two demo bundles.
 */

import { proposeImport, buildImportEngine, ImportError } from './import-engine.js';
import allowlist from '../../../skills/civic-chain-auditor/assets/sample_allowlist.json';

const STORE_KEY = 'civic-chain-import-audit-v1';

// A small, synthetic sample so the page works before a visitor picks a file.
// It tells a story: the two Pine Ridge Paving lines together ($84,000) overrun
// the $60,000 road-resurfacing line, so budget-variance flags it.
const SAMPLE_CSV = `Payment Date,Vendor Name,Department,Fund,Account Code,Account Description,Line Budget,Amount,Payment Status
2026-03-02,Pine Ridge Paving,Public Works,Highway & Streets Fund,5410,Road resurfacing,"60,000.00","42,000.00",paid
2026-03-16,Pine Ridge Paving,Public Works,Highway & Streets Fund,5410,Road resurfacing,"60,000.00","42,000.00",paid
2026-03-11,Bay State Office Supply,Administration,General Fund,5100,Office supplies,"5,000.00","1,875.00",paid
2026-04-01,Northline Fuel Co,Fleet Services,General Fund,5300,Vehicle fuel,"30,000.00","9,100.00",paid
2026-04-04,Northline Fuel Co,Fleet Services,General Fund,5300,Vehicle fuel,"30,000.00","18,200.00",paid
2026-05-15,Greenfield Lawn Care,Parks & Recreation,General Fund,5600,Grounds maintenance,"12,000.00","7,400.00",paid
2026-06-02,Harbor Light Electric,Public Works,General Fund,5420,Street lighting,"18,000.00","4,250.00",pending`;

// ── audit store (localStorage, with an in-memory fallback) ──────────────────
function makeStore() {
    let mem = [];
    const usable = (() => {
        try {
            window.localStorage.setItem('__cc_import_probe__', '1');
            window.localStorage.removeItem('__cc_import_probe__');
            return true;
        } catch { return false; }
    })();
    if (!usable) return { load: () => mem, save: (e) => { mem = e; } };
    return {
        load() { try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; } },
        save(entries) { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(entries)); } catch { mem = entries; } },
    };
}

// ── formatting + rendering ──────────────────────────────────────────────────
function titleize(key) {
    return key.replace(/_cents$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmtCell(key, value) {
    if (value === null || value === undefined) return '—';
    if (/_cents$/.test(key)) return '$' + (Number(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (/^pct/.test(key)) return Number(value).toLocaleString('en-US') + '%';
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

function $(id) { return document.getElementById(id); }
function setStatus(msg) { const el = $('imp-status'); if (el) el.textContent = msg || ''; }

// ── state ─────────────────────────────────────────────────────────────────
let SQL = null;            // loaded sql.js module
const store = makeStore();
let csvText = '';          // current file text
let proposal = null;       // { headers, rowCount, mapping, fields, ... }
let engine = null;         // built engine, once the mapping is confirmed
let QUERIES = {};          // name -> query definition

// ── step 1: read a file / the sample ────────────────────────────────────────
function loadCsv(text, sourceLabel) {
    csvText = text;
    engine = null;
    $('imp-run-wrap').hidden = true;
    $('imp-result').innerHTML = '';
    renderVerify(null);
    try {
        proposal = proposeImport(csvText);
    } catch (e) {
        proposal = null;
        $('imp-map').innerHTML = '';
        $('imp-build-btn').disabled = true;
        setStatus((e instanceof ImportError ? 'Could not read that CSV: ' : 'Error: ') + e.message);
        return;
    }
    setStatus(`Read ${proposal.rowCount} row${proposal.rowCount === 1 ? '' : 's'} and ${proposal.headers.length} column${proposal.headers.length === 1 ? '' : 's'} from ${sourceLabel}. Confirm the column mapping below.`);
    renderMapping();
}

function readFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setStatus('That file is larger than 8 MB; this in-browser demo keeps everything in memory, so please try a smaller export.'); return; }
    const reader = new FileReader();
    reader.onload = () => loadCsv(String(reader.result), file.name);
    reader.onerror = () => setStatus('Could not read that file.');
    reader.readAsText(file);
}

// ── step 2: the proposed mapping (editable) ─────────────────────────────────
function renderMapping() {
    const host = $('imp-map');
    const headerOptions = (chosen) =>
        ['<option value="">— not mapped —</option>']
            .concat(proposal.headers.map((h) => `<option value="${esc(h)}"${h === chosen ? ' selected' : ''}>${esc(h)}</option>`))
            .join('');

    const rows = proposal.fields.map((f) => {
        const req = f.required ? '<span class="req" title="required">required</span>' : '';
        return '<tr>' +
            '<td class="fld"><code>' + esc(f.field) + '</code> ' + req + '<div class="fdesc">' + esc(f.description) + '</div></td>' +
            '<td class="map-sel"><select data-field="' + esc(f.field) + '">' + headerOptions(f.header) + '</select></td>' +
            '</tr>';
    }).join('');

    host.innerHTML =
        '<table class="maptbl"><thead><tr><th>Canonical field</th><th>Your column</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="muted maphint">The agent proposed this mapping from your headers. Change any row, then confirm. Columns you do not map are simply ignored — a tax-id or address column never enters the ledger.</p>';

    host.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', validateMappingUi));
    validateMappingUi();
}

function currentMapping() {
    const mapping = {};
    $('imp-map').querySelectorAll('select').forEach((sel) => {
        const field = sel.getAttribute('data-field');
        if (sel.value) mapping[field] = sel.value;
    });
    return mapping;
}

function validateMappingUi() {
    const mapping = currentMapping();
    const required = proposal.fields.filter((f) => f.required).map((f) => f.field);
    const missing = required.filter((f) => !mapping[f]);
    const btn = $('imp-build-btn');
    if (missing.length) {
        btn.disabled = true;
        $('imp-build-note').textContent = 'Map the required field' + (missing.length === 1 ? '' : 's') + ': ' + missing.join(', ') + '.';
    } else {
        btn.disabled = false;
        $('imp-build-note').textContent = 'Ready. Confirm to build the ledger in your browser.';
    }
}

// ── step 3: build + run ─────────────────────────────────────────────────────
function build() {
    if (!SQL) { setStatus('The in-browser engine is still loading; try again in a moment.'); return; }
    const mapping = currentMapping();
    try {
        const built = buildImportEngine({ makeDb: () => new SQL.Database(), csvText, mapping, allowlist, store });
        engine = built.engine;
        const c = built.counts;
        $('imp-counts').innerHTML =
            '<span class="verdict ok">ledger built</span>' +
            '<span class="muted">' + c.rowCount + ' expenditures · ' + c.vendors + ' vendors · ' +
            c.budgetLines + ' budget lines · ' + c.funds + ' funds' + (c.grants ? ' · ' + c.grants + ' grants' : '') + '</span>';
        QUERIES = {};
        for (const def of engine.listQueries()) QUERIES[def.name] = def;
        populateQueries();
        $('imp-run-wrap').hidden = false;
        setStatus('Built in your browser. Ask one of the audit queries below.');
    } catch (e) {
        engine = null;
        $('imp-run-wrap').hidden = true;
        setStatus((e instanceof ImportError ? 'Import refused: ' : 'Error: ') + e.message);
    }
}

function populateQueries() {
    const sel = $('imp-query');
    sel.innerHTML = '';
    for (const name of Object.keys(QUERIES)) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        sel.appendChild(o);
    }
    renderParams(sel.value);
}

function renderParams(name) {
    const def = QUERIES[name];
    const host = $('imp-params');
    host.innerHTML = '';
    $('imp-q-blurb').textContent = def.description || '';
    for (const [pname, spec] of Object.entries(def.params || {})) {
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
        input.id = 'imp-p-' + pname;
        input.setAttribute('data-type', spec.type);
        wrap.appendChild(input);
        host.appendChild(wrap);
    }
}

function collectArgs(name) {
    const args = {};
    for (const pname of Object.keys(QUERIES[name].params || {})) {
        const el = $('imp-p-' + pname);
        const raw = el && el.value.trim();
        if (!raw) continue;
        const type = el.getAttribute('data-type');
        args[pname] = type === 'integer' || type === 'number' ? Number(raw) : raw;
    }
    return args;
}

function renderResult(out) {
    const host = $('imp-result');
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
    $('imp-verify-wrap').hidden = false;
}

function renderVerify(out) {
    const host = $('imp-verify-out');
    if (!host) return;
    if (!out) { host.innerHTML = ''; return; }
    host.innerHTML = '<span class="verdict ' + (out.ok ? 'ok' : 'flag') + '">chain ' + (out.ok ? 'INTACT' : 'BROKEN') + '</span>' +
        '<span class="muted">' + esc(out.entries) + ' entr' + (out.entries === 1 ? 'y' : 'ies') +
        (out.brokenAt != null ? ' · first break at #' + esc(out.brokenAt) : '') +
        (out.reason ? ' · ' + esc(out.reason) : '') + '</span>';
}

// ── wiring ──────────────────────────────────────────────────────────────────
function wire() {
    const file = $('imp-file');
    if (file) file.addEventListener('change', () => readFile(file.files && file.files[0]));

    const drop = $('imp-drop');
    if (drop) {
        ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; readFile(f); });
        drop.addEventListener('click', () => file && file.click());
    }

    const sample = $('imp-sample');
    if (sample) sample.addEventListener('click', () => loadCsv(SAMPLE_CSV, 'the sample ledger'));

    const buildBtn = $('imp-build-btn');
    if (buildBtn) buildBtn.addEventListener('click', build);

    const qsel = $('imp-query');
    if (qsel) qsel.addEventListener('change', () => renderParams(qsel.value));

    const runBtn = $('imp-run-btn');
    if (runBtn) runBtn.addEventListener('click', () => {
        if (!engine) return;
        renderVerify(null);
        $('imp-verify-wrap').hidden = true;
        const name = qsel.value;
        try {
            renderResult(engine.runNamed(name, collectArgs(name)));
        } catch (e) {
            setStatus('Refused: ' + e.message);
        }
    });

    const verifyBtn = $('imp-verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', () => { if (engine) renderVerify(engine.verifyChain()); });
    const tamperBtn = $('imp-tamper-btn');
    if (tamperBtn) tamperBtn.addEventListener('click', () => {
        if (!engine) return;
        if (!engine.tamperFirstEntry()) { renderVerify({ ok: true, entries: 0, brokenAt: null, reason: 'nothing to tamper with yet — run a query first' }); return; }
        renderVerify(engine.verifyChain());
    });
    const resetBtn = $('imp-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { store.save([]); renderVerify({ ok: true, entries: 0, brokenAt: null, reason: 'chain cleared' }); });
}

async function boot() {
    wire();
    // Start with the sample loaded so the mapping step is visible immediately.
    try {
        proposal = proposeImport(SAMPLE_CSV);
        csvText = SAMPLE_CSV;
        renderMapping();
        setStatus('Showing a sample ledger. Drop your own CSV above to replace it — it never leaves your browser.');
    } catch { /* ignore; the UI still works once a file is chosen */ }

    try {
        if (typeof window.initSqlJs !== 'function') throw new Error('sql.js loader missing');
        const base = new URL('.', import.meta.url);
        SQL = await window.initSqlJs({ locateFile: (f) => new URL(f, base).href });
    } catch (e) {
        setStatus('The in-browser engine could not start (' + e.message + '); the mapping preview still works, but building a ledger needs WebAssembly.');
        const b = $('imp-build-btn');
        if (b) b.disabled = true;
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
