/**
 * The Nonprofit Restricted Funds ruleset, driven end to end through the real
 * guard against the shipped nonprofit demo warehouse.
 *
 * The five controls:
 *   restricted-spending        empty:   no restricted-fund expense outside its purpose/window
 *   releases-vs-spending       compare: released <= qualifying spending
 *   functional-expense-tie     total_matches: grid ties to total; compare: no negative cell
 *   restricted-cash-coverage   compare: liquid assets >= net assets with donor restrictions
 *   single-audit-threshold     compare: federal spending < the Single Audit trigger
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
import { freshNonprofitDb, NONPROFIT_ALLOWLIST } from './nonprofit-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'nonprofit', 'ruleset.nonprofit-v1.json');

function warehouse(mutate) {
    const dbPath = freshNonprofitDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: NONPROFIT_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the nonprofit ruleset parses and declares its five controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'nonprofit');
    assert.equal(r.version, 'nonprofit-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'restricted-spending',
        'releases-vs-spending',
        'functional-expense-tie',
        'restricted-cash-coverage',
        'single-audit-threshold',
    ]);
});

test('every nonprofit query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // five query SQLs + two total_matches check SQLs = seven guarded statements
    assert.equal(validateNamedQueries(w, guard), 7);
    assert.equal(w.ruleset.version, 'nonprofit-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all five controls pass', () => {
    const w = warehouse();

    const restricted = run(w, 'restricted-spending');
    assert.equal(restricted.integrity, 'pass');
    assert.equal(restricted.findings, 0);
    assert.equal(restricted.rows.length, 0, 'no restricted-fund expense is misspent');

    const grid = run(w, 'functional-expense-tie');
    assert.equal(grid.integrity, 'pass');
    assert.equal(grid.findings, 0);
    assert.equal(grid.rows.length, 7, 'one row per nature x function cell');
    assert.equal(grid.checks.find((c) => c.id === 'grid-ties-total').detail.total, 20200000);

    for (const name of ['releases-vs-spending', 'restricted-cash-coverage', 'single-audit-threshold']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
    }
});

test('restricted-cash-coverage reports the liquid assets and restricted net assets', () => {
    const w = warehouse();
    const out = run(w, 'restricted-cash-coverage');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].liquid_cents, 25000000); // cash 15,000,000 + investments 10,000,000
    assert.equal(out.rows[0].restricted_na_cents, 20000000);
    assert.equal(out.checks.find((c) => c.id === 'liquid-covers-restricted').status, 'pass');
});

// ── each control tripped ─────────────────────────────────────────────────────

test('restricted-spending flags an expense charged outside the fund purpose', () => {
    // Recode a scholarship-fund expense to a program other than SCHOLARSHIP.
    const w = warehouse((db) => db.exec("UPDATE expenses SET program_code = 'TRAVEL' WHERE expense_id = 'EXP-1'"));
    const out = run(w, 'restricted-spending');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-restricted-misspending');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['EXP-1']);
    assert.equal(out.rows.find((r) => r.expense_id === 'EXP-1').reason, 'OUT_OF_PURPOSE');
});

test('restricted-spending flags an expense dated outside the fund window', () => {
    // Date a scholarship-fund expense before the fund's 2026-01-01 window start.
    const w = warehouse((db) => db.exec("UPDATE expenses SET expense_date = '2025-12-15' WHERE expense_id = 'EXP-2'"));
    const out = run(w, 'restricted-spending');
    assert.equal(out.findings, 1);
    assert.equal(out.rows.find((r) => r.expense_id === 'EXP-2').reason, 'OUT_OF_WINDOW');
});

test('releases-vs-spending flags a restriction released ahead of spending', () => {
    // Release 9,000,000 from the scholarship fund against 6,500,000 qualifying.
    const w = warehouse((db) => db.exec("UPDATE restriction_releases SET released_cents = 9000000 WHERE release_id = 'REL-1'"));
    const out = run(w, 'releases-vs-spending');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'release-within-spending');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['FND-SCHOL']);
    const row = out.rows.find((r) => r.fund_id === 'FND-SCHOL');
    assert.equal(row.released_cents, 9000000);
    assert.equal(row.qualifying_spending_cents, 6500000);
});

test('functional-expense-tie flags a negative grid cell while the grid still ties', () => {
    // A -600,000 reversal in SUPPLIES/PROGRAM takes that cell to -100,000. The
    // grid still ties (the reversal is in both the grid and the independent
    // total), so only the finding flags, not the integrity recompute.
    const w = warehouse((db) =>
        db.exec(
            "INSERT INTO expenses (expense_id, fiscal_year, fund_id, program_code, nature_code, function_class, amount_cents, expense_date) " +
                "VALUES ('EXP-REV', 2026, 'FND-GEN', 'GENERAL', 'SUPPLIES', 'PROGRAM', -600000, '2026-09-01')",
        ),
    );
    const out = run(w, 'functional-expense-tie');
    assert.equal(out.integrity, 'pass', 'the grid still ties to total expenses');
    assert.equal(out.checks.find((c) => c.id === 'grid-ties-total').status, 'pass');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-negative-cell');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['SUPPLIES/PROGRAM']);
    assert.equal(out.rows.find((r) => r.cell === 'SUPPLIES/PROGRAM').amount_cents, -100000);
});

test('restricted-cash-coverage flags when liquid assets fall below restricted net assets', () => {
    // Drop investments so liquid (15,000,000) is under restricted net assets (20,000,000).
    const w = warehouse((db) => db.exec("UPDATE account_balances SET balance_cents = 1000000 WHERE balance_id = 'AB-2'"));
    const out = run(w, 'restricted-cash-coverage');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'liquid-covers-restricted').status, 'flag');
    assert.equal(out.rows[0].liquid_cents, 16000000);
    assert.equal(out.rows[0].restricted_na_cents, 20000000);
    assert.equal(out.checks.find((c) => c.id === 'restricted-na-recompute').status, 'pass');
});

test('single-audit-threshold flags the year at a tighter threshold with no mutation', () => {
    // Federal spending is 75,000,000 ($750,000): under the $1,000,000 default,
    // over a $500,000 threshold passed as a parameter.
    const w = warehouse();
    assert.equal(run(w, 'single-audit-threshold').findings, 0, 'clean at the $1,000,000 default');
    const out = run(w, 'single-audit-threshold', { threshold_cents: 50000000 });
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'below-single-audit-threshold').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.fiscal_year), [2026]);
    assert.equal(out.rows[0].federal_expended_cents, 75000000);
});

test('single-audit-threshold flags when federal spending crosses the default trigger', () => {
    // Add an award that pushes the year over $1,000,000.
    const w = warehouse((db) =>
        db.exec(
            "INSERT INTO federal_awards (award_id, fiscal_year, program_name, cfda_number, expended_cents) " +
                "VALUES ('FA-3', 2026, 'Weatherization Assistance', '81.042', 40000000)",
        ),
    );
    const out = run(w, 'single-audit-threshold');
    assert.equal(out.findings, 1);
    assert.equal(out.rows[0].federal_expended_cents, 115000000);
    assert.equal(out.checks.find((c) => c.id === 'below-single-audit-threshold').status, 'flag');
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled nonprofit ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed nonprofit ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'restricted-spending');
    assert.equal(out.entry.ruleset.version, 'nonprofit-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
