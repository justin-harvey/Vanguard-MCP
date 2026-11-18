/**
 * The School Districts ruleset, driven end to end through the real guard against
 * the shipped schools demo warehouse.
 *
 * The five controls:
 *   activity-negative-balances        empty:   no activity account overdrawn
 *   activity-deposits-late            empty:   no collection deposited late / undeposited
 *   activity-unapproved-disbursements empty:   no disbursement missing an approval
 *   federal-outside-period            empty:   no federal cost outside its award period
 *   budget-variance                   compare: paid <= amended budget; total_matches tie
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation
 * (or, for the deposit window, a parameter), so the flag paths are real, not
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
import { freshSchoolsDb, SCHOOLS_ALLOWLIST } from './schools-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'schools', 'ruleset.schools-v1.json');

function warehouse(mutate) {
    const dbPath = freshSchoolsDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: SCHOOLS_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the schools ruleset parses and declares its five controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'schools');
    assert.equal(r.version, 'schools-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'activity-negative-balances',
        'activity-deposits-late',
        'activity-unapproved-disbursements',
        'federal-outside-period',
        'budget-variance',
    ]);
});

test('every schools query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // five query SQLs + one total_matches check SQL (budget-variance) = six guarded statements
    assert.equal(validateNamedQueries(w, guard), 6);
    assert.equal(w.ruleset.version, 'schools-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all five controls pass', () => {
    const w = warehouse();

    for (const name of [
        'activity-negative-balances',
        'activity-deposits-late',
        'activity-unapproved-disbursements',
        'federal-outside-period',
    ]) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
        assert.equal(out.rows.length, 0, `${name} returns no offending rows`);
    }

    const budget = run(w, 'budget-variance');
    assert.equal(budget.integrity, 'pass');
    assert.equal(budget.findings, 0);
    assert.equal(budget.rows.length, 3, 'one row per budget line');
    assert.equal(budget.checks.find((c) => c.id === 'paid-total-reconciles').detail.total, 9800000);
});

// ── each control tripped ─────────────────────────────────────────────────────

test('activity-negative-balances flags an overdrawn activity account', () => {
    // A 2,000,000 disbursement overdraws the Drama Club (balance 1,100,000).
    const w = warehouse((db) =>
        db.exec(
            "INSERT INTO activity_disbursements (disbursement_id, account_id, fiscal_year, amount_cents, disbursement_date, advisor_approved, principal_approved) " +
                "VALUES ('DIS-X', 'ACT-DRAMA', 2026, 200000, '2026-06-10', 1, 1)",
        ),
    );
    const out = run(w, 'activity-negative-balances');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-negative-activity-balance');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['ACT-DRAMA']);
    assert.equal(out.rows.find((r) => r.account_id === 'ACT-DRAMA').balance_cents, -90000);
});

test('activity-deposits-late flags a collection deposited past the window', () => {
    // Deposit COL-1 ten days after collection; the default window is one day.
    const w = warehouse((db) => db.exec("UPDATE activity_collections SET deposited_date = '2026-03-12' WHERE collection_id = 'COL-1'"));
    const out = run(w, 'activity-deposits-late');
    assert.equal(out.findings, 1);
    const row = out.rows.find((r) => r.collection_id === 'COL-1');
    assert.equal(row.reason, 'LATE');
    assert.equal(row.days_to_deposit, 10);
});

test('activity-deposits-late flags cash never deposited, and a wider window clears a late one', () => {
    // COL-2 is never deposited: flagged regardless of deposit_days.
    const w = warehouse((db) => db.exec("UPDATE activity_collections SET deposited_date = NULL WHERE collection_id = 'COL-2'"));
    const undeposited = run(w, 'activity-deposits-late', { deposit_days: 30 });
    assert.equal(undeposited.findings, 1);
    assert.equal(undeposited.rows.find((r) => r.collection_id === 'COL-2').reason, 'UNDEPOSITED');

    // A collection deposited 5 days out is clean when the policy window is 7.
    const w2 = warehouse((db) => db.exec("UPDATE activity_collections SET deposited_date = '2026-03-07' WHERE collection_id = 'COL-1'"));
    assert.equal(run(w2, 'activity-deposits-late', { deposit_days: 7 }).findings, 0, 'inside a 7-day window');
    assert.equal(run(w2, 'activity-deposits-late', { deposit_days: 3 }).findings, 1, 'outside a 3-day window');
});

test('activity-unapproved-disbursements flags a payment missing an approval', () => {
    const w = warehouse((db) => db.exec("UPDATE activity_disbursements SET principal_approved = 0 WHERE disbursement_id = 'DIS-1'"));
    const out = run(w, 'activity-unapproved-disbursements');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'disbursements-approved');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['DIS-1']);
    assert.equal(out.rows.find((r) => r.disbursement_id === 'DIS-1').reason, 'MISSING_PRINCIPAL');
});

test('federal-outside-period flags a cost charged before the award period', () => {
    // FCOST-1 charged 2025-06-15, before the Title I period start of 2025-07-01.
    const w = warehouse((db) => db.exec("UPDATE federal_costs SET charge_date = '2025-06-15' WHERE cost_id = 'FCOST-1'"));
    const out = run(w, 'federal-outside-period');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'costs-within-period');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['FCOST-1']);
    assert.equal(out.rows.find((r) => r.cost_id === 'FCOST-1').reason, 'BEFORE_PERIOD');
});

test('budget-variance flags an overspent line while the paid total still ties', () => {
    // Raise BL-INSTR paid spending to 6,000,000, over its 5,500,000 amended budget.
    const w = warehouse((db) => db.exec("UPDATE expenditures SET amount_cents = 6000000 WHERE expenditure_id = 'EXP-1'"));
    const out = run(w, 'budget-variance');
    assert.equal(out.integrity, 'pass', 'the paid total still reconciles');
    assert.equal(out.checks.find((c) => c.id === 'paid-total-reconciles').status, 'pass');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'within-amended-budget');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['BL-INSTR']);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled schools ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed schools ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'activity-negative-balances');
    assert.equal(out.entry.ruleset.version, 'schools-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
