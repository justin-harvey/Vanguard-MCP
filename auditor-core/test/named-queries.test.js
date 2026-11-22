/**
 * Named queries and automatic checks. Runs without the SQL parser: the runner
 * takes the guard as a parameter, and these tests pass a pass-through stand-in,
 * so they exercise everything else for real, the demo database, binding, the
 * checks, lineage and the hash-chained audit log. The real guard's treatment of
 * the same SQL is covered in custom-pipeline.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    compilePlaceholders,
    parseQueries,
    validateArgs,
    bindParams,
    evaluateChecks,
    NamedQueryError,
} from '../src/named-queries.js';
import { runNamedQuery } from '../src/named-run.js';
import { loadCustomWarehouse, CustomWarehouseInvalid, CUSTOM_ENV } from '../src/custom.js';
import { verify, readLog } from '../src/audit.js';
import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

/** Stand-in for the guard: passes SQL through unchanged. */
const passThroughGuard = (sql) => ({ sql, tables: ['stub'], columns: [], params: [], limitInjected: false });

function municipal(allowlistPath = MUNICIPAL_ALLOWLIST) {
    const dbPath = freshMunicipalDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: allowlistPath } });
}

function run(w, name, args = {}) {
    return runNamedQuery(w, name, args, { guard: passThroughGuard });
}

function writeAllowlist(mutate) {
    const doc = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));
    mutate(doc);
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-allow-')), 'allowlist.json');
    writeFileSync(path, JSON.stringify(doc));
    return path;
}

// ── placeholders ──────────────────────────────────────────────────────────

test('placeholders become positional markers, in order, repeats included', () => {
    const { sql, order } = compilePlaceholders('SELECT a FROM t WHERE (:x IS NULL OR a = :x) AND b = :y');
    assert.equal(sql, 'SELECT a FROM t WHERE (? IS NULL OR a = ?) AND b = ?');
    assert.deepEqual(order, ['x', 'x', 'y']);
});

test('colons inside strings, quoted identifiers and comments are left alone', () => {
    const src = `SELECT '12:30' AS t, "odd:col" FROM t -- :nope\nWHERE a = :real /* :also_not */ AND b = 'it''s :fine'`;
    const { sql, order } = compilePlaceholders(src);
    assert.deepEqual(order, ['real']);
    assert.match(sql, /'12:30'/);
    assert.match(sql, /"odd:col"/);
    assert.match(sql, /-- :nope/);
    assert.match(sql, /\/\* :also_not \*\//);
    assert.match(sql, /'it''s :fine'/);
});

test('positional markers and unterminated quotes are rejected', () => {
    assert.throws(() => compilePlaceholders('SELECT a FROM t WHERE a = ?'), NamedQueryError);
    assert.throws(() => compilePlaceholders("SELECT 'oops FROM t"), NamedQueryError);
    assert.throws(() => compilePlaceholders('SELECT a /* open'), NamedQueryError);
});

// ── definitions ───────────────────────────────────────────────────────────

test('parseQueries rejects malformed definitions', () => {
    const ok = { description: 'd', sql: 'SELECT 1 AS one' };
    assert.doesNotThrow(() => parseQueries({ q: ok }));
    const bad = [
        { Q: ok },
        { 'q q': ok },
        { q: { sql: 'SELECT 1' } },
        { q: { ...ok, sql: '' } },
        { q: { ...ok, sql: 'SELECT a FROM t WHERE a = :undeclared' } },
        { q: { ...ok, params: { x: { type: 'date' } } } },
        { q: { ...ok, params: { X: { type: 'string' } } } },
        { q: { ...ok, checks: {} } },
        { q: { ...ok, checks: [{ id: 'c', type: 'mystery' }] } },
        { q: { ...ok, checks: [{ id: 'c', type: 'unique' }] } },
        { q: { ...ok, checks: [{ id: 'c', type: 'compare', left: 'a', op: '<>', right: 'b' }] } },
        { q: { ...ok, checks: [{ id: 'c', type: 'total_matches', column: 'a', sql: 'SELECT :nope' }] } },
        { q: { ...ok, checks: [{ id: 'c', type: 'unique', columns: ['a'] }, { id: 'c', type: 'unique', columns: ['b'] }] } },
        { q: { ...ok, checks: [{ id: 'c', type: 'empty', key: 7 }] } },
    ];
    for (const queries of bad) assert.throws(() => parseQueries(queries), NamedQueryError, JSON.stringify(queries));
    assert.doesNotThrow(() => parseQueries({ q: { ...ok, checks: [{ id: 'c', type: 'empty' }] } }), 'empty needs no key');
    assert.throws(() => parseQueries({ q: { ...ok, checks: [{ id: 'c', type: 'mystery' }] } }), /unique, total_matches, compare, empty/);
});

// ── arguments ─────────────────────────────────────────────────────────────

test('validateArgs enforces declared parameters, types, enums and required', () => {
    const [def] = Object.values(
        parseQueries({
            q: {
                description: 'd',
                sql: 'SELECT 1 WHERE :s IS NULL AND :n IS NULL AND :e IS NULL',
                params: {
                    s: { type: 'string' },
                    n: { type: 'integer', required: true },
                    e: { type: 'string', enum: ['active', 'closed'] },
                },
            },
        }),
    );
    assert.deepEqual(validateArgs(def, { n: 2026 }), { s: null, n: 2026, e: null });
    assert.deepEqual(bindParams(def.order, validateArgs(def, { n: 1, s: 'x', e: 'closed' })), ['x', 1, 'closed']);
    assert.throws(() => validateArgs(def, {}), /requires parameter "n"/);
    assert.throws(() => validateArgs(def, { n: 1, extra: 1 }), /no parameter "extra"/);
    assert.throws(() => validateArgs(def, { n: 1.5 }), /integer/);
    assert.throws(() => validateArgs(def, { n: '2026' }), /integer/);
    assert.throws(() => validateArgs(def, { n: 1, s: 7 }), /string/);
    assert.throws(() => validateArgs(def, { n: 1, s: 'a\u0000b' }), /printable/);
    assert.throws(() => validateArgs(def, { n: 1, s: 'x'.repeat(201) }), /at most 200/);
    assert.throws(() => validateArgs(def, { n: 1, e: 'pending' }), /one of: active, closed/);
    assert.throws(() => validateArgs(def, [1]), /must be an object/);
});

// ── checks ────────────────────────────────────────────────────────────────

const CHECKS = parseQueries({
    q: {
        description: 'd',
        sql: 'SELECT 1',
        checks: [
            { id: 'u', type: 'unique', columns: ['k'] },
            { id: 't', type: 'total_matches', column: 'v', sql: 'SELECT 1' },
            { id: 'c', type: 'compare', left: 'v', op: '<=', right: 'cap', key: 'k', message: 'over cap' },
            { id: 'n', type: 'compare', left: 'v', op: '>=', right: 0 },
        ],
    },
}).q.checks;

test('clean rows pass every check', () => {
    const rows = [
        { k: 'a', v: 5, cap: 10 },
        { k: 'b', v: 10, cap: 10 },
    ];
    const r = evaluateChecks(CHECKS, rows, { totals: { t: 15 } });
    assert.equal(r.integrity, 'pass');
    assert.equal(r.findings, 0);
    assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
});

test('repeated keys and a mismatched total flag integrity; a broken rule is a finding', () => {
    const rows = [
        { k: 'a', v: 5, cap: 10 },
        { k: 'a', v: 5, cap: 10 },
        { k: 'b', v: 12, cap: 10 },
    ];
    const r = evaluateChecks(CHECKS, rows, { totals: { t: 17 } });
    assert.equal(r.integrity, 'flag');
    assert.equal(r.findings, 1);
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.deepEqual(byId.u.detail, { repeated: ['a'], count: 1 });
    assert.deepEqual(byId.t.detail, { resultTotal: 22, independentTotal: 17 });
    assert.equal(byId.c.status, 'flag');
    assert.equal(byId.c.message, 'over cap');
    assert.deepEqual(byId.c.detail, { rows: ['b'], count: 1 });
    assert.equal(byId.n.status, 'pass');
});

test('nulls are skipped by compare; truncation skips totals; a missing column is an error', () => {
    const rows = [{ k: 'a', v: null, cap: 10 }];
    const r = evaluateChecks(CHECKS, rows, { totals: { t: 0 }, truncated: true });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(byId.c.status, 'pass');
    assert.equal(byId.t.status, 'skipped');
    const missing = evaluateChecks(CHECKS, [{ k: 'a', v: 1 }], { totals: { t: 1 } });
    assert.equal(Object.fromEntries(missing.checks.map((c) => [c.id, c])).c.status, 'error');
    assert.equal(missing.integrity, 'pass', 'a broken finding rule does not fail integrity');
    const noTotal = evaluateChecks(CHECKS, [{ k: 'a', v: 1, cap: 2 }], {});
    assert.equal(noTotal.integrity, 'flag', 'an unavailable independent total is an integrity error');
});

test('an empty result passes: nothing repeats, totals of zero match', () => {
    const r = evaluateChecks(CHECKS, [], { totals: { t: 0 } });
    assert.equal(r.integrity, 'pass');
});

test('the empty check: a clean (empty) result passes, any row is a finding', () => {
    const [def] = Object.values(
        parseQueries({
            q: {
                description: 'd',
                sql: 'SELECT 1',
                checks: [{ id: 'e', type: 'empty', key: 'policy_id', message: 'variance detected' }],
            },
        }),
    );
    const clean = evaluateChecks(def.checks, []);
    assert.equal(clean.integrity, 'pass');
    assert.equal(clean.findings, 0);
    assert.equal(clean.checks[0].status, 'pass');

    const flagged = evaluateChecks(def.checks, [{ policy_id: 'P-1' }, { policy_id: 'P-2' }]);
    assert.equal(flagged.integrity, 'pass', 'a finding does not fail integrity');
    assert.equal(flagged.findings, 1);
    assert.equal(flagged.checks[0].status, 'flag');
    assert.equal(flagged.checks[0].message, 'variance detected');
    assert.deepEqual(flagged.checks[0].detail, { count: 2, rows: ['P-1', 'P-2'] });

    // key-less empty check: flags with a count, no row sample
    const [bare] = Object.values(parseQueries({ q: { description: 'd', sql: 'SELECT 1', checks: [{ id: 'e', type: 'empty' }] } }));
    const bareFlag = evaluateChecks(bare.checks, [{ x: 1 }]);
    assert.equal(bareFlag.checks[0].status, 'flag');
    assert.deepEqual(bareFlag.checks[0].detail, { count: 1 });

    // a key naming a column the result lacks is an error, not a silent pass
    const missing = evaluateChecks(def.checks, [{ other: 1 }]);
    assert.equal(missing.checks[0].status, 'error');
});

// ── the demo warehouse, end to end ────────────────────────────────────────

test('the demo allow-list loads its three named queries', () => {
    const w = municipal();
    assert.deepEqual(Object.keys(w.queries), ['grant-status', 'spending-by-vendor', 'budget-variance']);
});

test('grant-status: figures, a clean integrity result, and the paving-grant finding', () => {
    const w = municipal();
    const out = run(w, 'grant-status');
    assert.equal(out.query, 'municipal/grant-status');
    assert.equal(out.integrity, 'pass');
    const g402 = out.rows.find((r) => r.grant_id === 'G-402');
    assert.equal(g402.award_cents, 125_000_000);
    assert.equal(g402.paid_cents, 93_165_000); // the voided duplicate invoice is excluded
    assert.equal(g402.pending_cents, 9_880_000);
    assert.equal(g402.drawn_cents, 100_000_000);
    assert.equal(g402.remaining_cents, 31_835_000);
    assert.equal(g402.drawn_minus_paid_cents, 6_835_000);
    assert.equal(g402.pct_award_spent, 74.5);
    const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
    assert.equal(byId['paid-total-reconciles'].status, 'pass');
    assert.equal(byId['spending-within-award'].status, 'pass');
    assert.deepEqual(byId['cash-not-ahead-of-spending'].detail, { rows: ['G-402'], count: 1 });
    assert.equal(out.findings, 1);
});

test('grant-status with a filter returns one grant, and its total check uses the same filter', () => {
    const out = run(municipal(), 'grant-status', { grant_id: 'G-317' });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].paid_cents, 118_055_000);
    assert.equal(out.integrity, 'pass');
    assert.equal(out.findings, 0);
    const closed = run(municipal(), 'grant-status', { status: 'closed' });
    assert.deepEqual(closed.rows.map((r) => r.grant_id), ['G-288', 'G-366']);
    assert.equal(closed.integrity, 'pass');
});

test('spending-by-vendor for the paving grant', () => {
    const out = run(municipal(), 'spending-by-vendor', { grant_id: 'G-402' });
    assert.deepEqual(
        out.rows.map((r) => [r.vendor_name, r.paid_cents, r.invoice_count]),
        [
            ['Sampleton Asphalt & Paving Co.', 69_595_000, 4],
            ['Northline Engineering Group', 12_370_000, 2],
            ['Tri-County Aggregates', 11_200_000, 2],
        ],
    );
    assert.equal(out.integrity, 'pass');
});

test('spending-by-vendor by department and year reconciles to the independent total', () => {
    const out = run(municipal(), 'spending-by-vendor', { fiscal_year: 2026, dept_id: 'PW' });
    assert.equal(out.integrity, 'pass');
    const total = out.checks.find((c) => c.id === 'paid-total-reconciles');
    assert.equal(total.status, 'pass');
    assert.equal(total.detail.total, out.rows.reduce((s, r) => s + r.paid_cents, 0));
});

test('budget-variance flags the overspent winter-salt line', () => {
    const out = run(municipal(), 'budget-variance', { fiscal_year: 2026 });
    assert.equal(out.rows.length, 8);
    assert.equal(out.integrity, 'pass');
    const salt = out.rows.find((r) => r.line_id === 'BL-26-02');
    assert.equal(salt.paid_cents, 19_640_000);
    assert.equal(salt.remaining_cents, -1_640_000);
    const over = out.checks.find((c) => c.id === 'within-amended-budget');
    assert.deepEqual(over.detail, { rows: ['BL-26-02'], count: 1 });
});

test('a fan-out JOIN is caught by the integrity checks', () => {
    // Joining expenditures and drawdowns to grants multiplies rows: the classic
    // double-counting bug. Same column names as grant-status, wrong numbers.
    const allowlist = writeAllowlist((doc) => {
        doc.queries['bad-grant-status'] = {
            description: 'Deliberately wrong: joins two child tables at once.',
            sql:
                'SELECT g.grant_id, SUM(e.amount_cents) AS paid_cents FROM grants g ' +
                "JOIN expenditures e ON e.grant_id = g.grant_id AND e.status = 'paid' " +
                "JOIN grant_drawdowns d ON d.grant_id = g.grant_id AND d.status = 'received' " +
                'GROUP BY g.grant_id, d.drawdown_id ORDER BY g.grant_id',
            checks: [
                { id: 'one-row-per-grant', type: 'unique', columns: ['grant_id'] },
                {
                    id: 'paid-total-reconciles',
                    type: 'total_matches',
                    column: 'paid_cents',
                    sql: "SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e WHERE e.status = 'paid' AND e.grant_id IN (SELECT d.grant_id FROM grant_drawdowns d WHERE d.status = 'received')",
                },
            ],
        };
    });
    const out = run(municipal(allowlist), 'bad-grant-status');
    assert.equal(out.integrity, 'flag');
    const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
    assert.equal(byId['one-row-per-grant'].status, 'flag');
    assert.equal(byId['paid-total-reconciles'].status, 'flag');
    assert.ok(byId['paid-total-reconciles'].detail.resultTotal > byId['paid-total-reconciles'].detail.independentTotal);
});

test('each run is written to the warehouse audit log with its checks, and the chain verifies', () => {
    const w = municipal();
    run(w, 'grant-status');
    run(w, 'budget-variance', { fiscal_year: 2026 });
    const log = readLog(w.logPath);
    assert.equal(log.length, 2);
    assert.equal(log[0].namedQuery, 'municipal/grant-status');
    assert.equal(log[0].integrity, 'pass');
    assert.equal(log[0].findings, 1);
    assert.deepEqual(log[1].params, { fiscal_year: 2026, dept_id: null });
    assert.equal(verify(w.logPath).ok, true);
});

test('the same call twice gives the same result hash', () => {
    const w = municipal();
    const a = run(w, 'spending-by-vendor', { grant_id: 'G-402' });
    const b = run(w, 'spending-by-vendor', { grant_id: 'G-402' });
    assert.equal(a.lineage.resultHash, b.lineage.resultHash);
    assert.notEqual(a.entry.hash, b.entry.hash);
});

test('unknown queries and bad arguments are refused before any SQL runs', () => {
    const w = municipal();
    assert.throws(() => run(w, 'nope'), /Unknown query "municipal\/nope". Known: municipal\/grant-status/);
    assert.throws(() => run(w, 'grant-status', { grant: 'G-402' }), /no parameter "grant"/);
    assert.throws(() => run(w, 'grant-status', { status: 'pending' }), /one of: active, closed/);
    assert.equal(readLog(w.logPath).length, 0);
});

test('a named query that does not compile fails when the warehouse loads', () => {
    const allowlist = writeAllowlist((doc) => {
        doc.queries['grant-status'].sql = doc.queries['grant-status'].sql.replace('g.grant_name', 'g.grant_title');
    });
    assert.throws(() => municipal(allowlist), (e) => e instanceof CustomWarehouseInvalid && /grant-status.*grant_title/.test(e.message));
});

test('a named query using an undeclared parameter fails when the warehouse loads', () => {
    const allowlist = writeAllowlist((doc) => {
        doc.queries['budget-variance'].sql += ' AND :undeclared IS NULL';
    });
    assert.throws(() => municipal(allowlist), /:undeclared/);
});
