/**
 * The Excise Tax ruleset, driven end to end through the real guard against the
 * shipped excise demo warehouse.
 *
 * The five controls:
 *   liability-vs-remitted     compare: tax paid >= taxable removals x rate
 *   inventory-rollforward     compare: opening + produced - removed - loss = closing
 *   report-vs-return          compare: report removed = return reported barrels
 *   missing-or-late-filings   empty:   no period missing a return or filed late
 *   loss-variance             empty:   no period's loss rate over tolerance
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation
 * (or, for the thresholds, a parameter), so the flag paths are real, not
 * asserted. The ruleset is also validated statement by statement (every query
 * and check SQL passes the guard).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicKey } from 'node:crypto';
import { parseRuleset, loadRuleset, CIVIC_CHAIN_PUBKEY_PATH } from '../src/ruleset.js';
import { keyIdOf } from '../src/signing.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { runNamedQuery, validateNamedQueries } from '../src/named-run.js';
import { guard } from '../src/guard.js';
import { freshExciseDb, EXCISE_ALLOWLIST } from './excise-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'excise', 'ruleset.excise-v1.json');

function warehouse(mutate) {
    const dbPath = freshExciseDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: EXCISE_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the excise ruleset parses and declares its five controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'excise');
    assert.equal(r.version, 'excise-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'liability-vs-remitted',
        'inventory-rollforward',
        'report-vs-return',
        'missing-or-late-filings',
        'loss-variance',
    ]);
});

test('every excise query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // five query SQLs + one total_matches check SQL = six guarded statements
    assert.equal(validateNamedQueries(w, guard), 6);
    assert.equal(w.ruleset.version, 'excise-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all five controls pass', () => {
    const w = warehouse();

    const liability = run(w, 'liability-vs-remitted');
    assert.equal(liability.integrity, 'pass');
    assert.equal(liability.findings, 0);
    assert.equal(liability.rows.length, 2, 'one row per period');

    for (const name of ['inventory-rollforward', 'report-vs-return', 'missing-or-late-filings', 'loss-variance']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
    }
});

test('liability uses the rate in force for the period, not the stale or largest rate', () => {
    // tax_rates holds the old 700-cents rate and the 2026 350-cents rate; the
    // 2026 periods must resolve to 350. At 700 the expected tax would double
    // and the >= check would flag, so a clean pass is proof of the right pick.
    const w = warehouse();
    const out = run(w, 'liability-vs-remitted', { period: '2026-01' });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].taxable_barrels, 400);
    assert.equal(out.rows[0].rate_cents_per_barrel, 350);
    assert.equal(out.rows[0].expected_tax_cents, 140000);
    assert.equal(out.rows[0].tax_paid_cents, 140000);
    assert.equal(out.checks.find((c) => c.id === 'tax-paid-covers-liability').status, 'pass');
});

// ── each control tripped ─────────────────────────────────────────────────────

test('liability-vs-remitted flags an underpaid return', () => {
    // Pay only 100,000 for 2026-01 against an expected 140,000.
    const w = warehouse((db) => db.exec("UPDATE tax_returns SET tax_paid_cents = 100000 WHERE return_id = 'TR-2026-01'"));
    const out = run(w, 'liability-vs-remitted');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'tax-paid-covers-liability');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['2026-01']);
    // The integrity recompute still agrees with the query's own removals total.
    assert.equal(out.checks.find((c) => c.id === 'removals-recompute').status, 'pass');
});

test('inventory-rollforward flags a report that does not balance', () => {
    // Overstate 2026-01 closing so opening+produced-removed-loss (140) != closing.
    const w = warehouse((db) => db.exec("UPDATE operations_reports SET closing_barrels = 999 WHERE report_id = 'OR-2026-01'"));
    const out = run(w, 'inventory-rollforward');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'rollforward-balances');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['2026-01']);
    const row = out.rows.find((r) => r.period === '2026-01');
    assert.equal(row.computed_closing_barrels, 140);
    assert.equal(row.closing_barrels, 999);
});

test('report-vs-return flags a report and return that disagree', () => {
    // The 2026-01 return reports 380 barrels; the operations report removed 400.
    const w = warehouse((db) => db.exec("UPDATE tax_returns SET barrels_reported = 380 WHERE return_id = 'TR-2026-01'"));
    const out = run(w, 'report-vs-return');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'report-ties-return').status, 'flag');
    const row = out.rows.find((r) => r.period === '2026-01');
    assert.equal(row.reported_removed_barrels, 400);
    assert.equal(row.return_barrels, 380);
});

test('missing-or-late-filings flags a return filed after its due date', () => {
    const w = warehouse((db) => db.exec("UPDATE tax_returns SET filed_date = '2026-03-01' WHERE return_id = 'TR-2026-01'"));
    const out = run(w, 'missing-or-late-filings');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'no-missing-or-late').status, 'flag');
    const row = out.rows.find((r) => r.period === '2026-01');
    assert.equal(row.issue, 'LATE');
});

test('missing-or-late-filings flags a period with activity and no return', () => {
    const w = warehouse((db) => db.exec("DELETE FROM tax_returns WHERE return_id = 'TR-2026-02'"));
    const out = run(w, 'missing-or-late-filings');
    assert.equal(out.findings, 1);
    const row = out.rows.find((r) => r.period === '2026-02');
    assert.equal(row.issue, 'MISSING');
    assert.equal(row.return_id, null);
});

test('loss-variance flags a period over tolerance at a tighter threshold', () => {
    // 2026-01 loss is 10/450 = 222 bps; the 300 default clears it, a 200-bps
    // threshold surfaces it (2026-02 at 192 bps stays clean). No mutation.
    const w = warehouse();
    assert.equal(run(w, 'loss-variance').findings, 0, 'clean at the 300 default');
    const out = run(w, 'loss-variance', { max_loss_bps: 200 });
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'losses-within-tolerance').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.period), ['2026-01']);
    assert.equal(out.rows[0].loss_bps, 222);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled excise ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed excise ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'missing-or-late-filings');
    assert.equal(out.entry.ruleset.version, 'excise-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
