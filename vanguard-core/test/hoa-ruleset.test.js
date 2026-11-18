/**
 * The HOA board-review ruleset (hoa-v1), driven end to end through the real
 * guard against the shipped HOA demo warehouse.
 *
 * The three controls:
 *   reserve-transfers-unapproved  empty:   no reserve withdrawal without approval
 *   budget-variance               compare: no operating line over its budget
 *   delinquent-assessments        empty:   no unpaid assessment aged past threshold
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation
 * (or, for the threshold, a parameter), so the flag paths are real, not
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
import { freshHoaDb, HOA_ALLOWLIST } from './hoa-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'hoa', 'ruleset.hoa-v1.json');

function warehouse(mutate) {
    const dbPath = freshHoaDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: HOA_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the hoa ruleset parses and declares its three controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'hoa');
    assert.equal(r.version, 'hoa-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'reserve-transfers-unapproved',
        'budget-variance',
        'delinquent-assessments',
    ]);
});

test('every hoa query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // three query SQLs, no total_matches check SQL = three guarded statements
    assert.equal(validateNamedQueries(w, guard), 3);
    assert.equal(w.ruleset.version, 'hoa-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all three controls pass', () => {
    const w = warehouse();

    const budget = run(w, 'budget-variance', { fiscal_year: 2026 });
    assert.equal(budget.integrity, 'pass');
    assert.equal(budget.findings, 0);
    assert.equal(budget.rows.length, 3, 'one row per budget line');

    for (const name of ['reserve-transfers-unapproved', 'delinquent-assessments']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
    }
});

// ── each control tripped ─────────────────────────────────────────────────────

test('reserve-transfers-unapproved flags a reserve withdrawal with no approval on record', () => {
    // Strip the minutes reference from the reserve-to-operating transfer.
    const w = warehouse((db) => db.exec("UPDATE reserve_transfers SET board_approval_id = NULL WHERE transfer_id = 'RT-1'"));
    const out = run(w, 'reserve-transfers-unapproved');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-unapproved-reserve-transfers');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['RT-1']);
});

test('a reserve CONTRIBUTION with no approval is not a finding', () => {
    // RT-2 moves money INTO reserve with a null approval; that is allowed, so the
    // clean seed still passes even though RT-2 has no board_approval_id.
    const w = warehouse();
    assert.equal(run(w, 'reserve-transfers-unapproved').findings, 0);
});

test('budget-variance flags an operating line spent over its adopted budget', () => {
    // Push Landscaping (BL-1) to 650,000 spent against its 500,000 budget.
    const w = warehouse((db) => db.exec("INSERT INTO operating_expenses (expense_id, line_id, amount_cents, expense_date) VALUES ('E-99', 'BL-1', 200000, '2026-06-20')"));
    const out = run(w, 'budget-variance', { fiscal_year: 2026 });
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'spending-within-budget');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['BL-1']);
    const row = out.rows.find((r) => r.line_id === 'BL-1');
    assert.equal(row.spent_cents, 650000);
    assert.equal(row.adopted_cents, 500000);
});

test('delinquent-assessments flags an aged unpaid assessment at a tighter threshold', () => {
    // A-3 (unit U-103, due 2026-05-15) is 17 days past the latest due date
    // (2026-06-01); the 60 default clears it, a 10-day threshold surfaces it.
    // A-4 (due 2026-06-01, 0 days) stays clean. No mutation.
    const w = warehouse();
    assert.equal(run(w, 'delinquent-assessments').findings, 0, 'clean at the 60 default');
    const out = run(w, 'delinquent-assessments', { days_past_due: 10 });
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'no-aged-delinquencies').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.assessment_id), ['A-3']);
    assert.equal(out.rows[0].days_overdue, 17);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled hoa ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed hoa ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'budget-variance');
    assert.equal(out.entry.ruleset.version, 'hoa-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
