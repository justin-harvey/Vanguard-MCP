/**
 * The broker/property-manager trust ruleset (property-trust-v1), driven end to
 * end through the real guard against the shipped broker-trust demo warehouse.
 *
 * The four controls:
 *   trust-vs-liability        compare: reconciled bank >= itemized trust liability
 *   negative-owner-balances   empty:   no owner ledger overdrawn
 *   deposits-held-vs-owed     empty:   every active lease's deposit held in full
 *   deposit-return-overdue    empty:   no ended lease past its return deadline
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
import { freshPropertyDb, PROPERTY_ALLOWLIST } from './property-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'property', 'ruleset.property-trust-v1.json');

function warehouse(mutate) {
    const dbPath = freshPropertyDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: PROPERTY_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the property ruleset parses and declares its four controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'property');
    assert.equal(r.version, 'property-trust-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'trust-vs-liability',
        'negative-owner-balances',
        'deposits-held-vs-owed',
        'deposit-return-overdue',
    ]);
});

test('every property query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // four query SQLs + one total_matches check SQL = five guarded statements
    assert.equal(validateNamedQueries(w, guard), 5);
    assert.equal(w.ruleset.version, 'property-trust-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all four controls pass', () => {
    const w = warehouse();

    const trust = run(w, 'trust-vs-liability');
    assert.equal(trust.integrity, 'pass');
    assert.equal(trust.findings, 0);
    assert.equal(trust.rows.length, 1);
    assert.equal(trust.rows[0].reconciled_bank_cents, 320000);
    assert.equal(trust.rows[0].trust_liability_cents, 320000);

    for (const name of ['negative-owner-balances', 'deposits-held-vs-owed', 'deposit-return-overdue']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
    }
});

// ── each control tripped ─────────────────────────────────────────────────────

test('trust-vs-liability flags a short trust account', () => {
    // Drop the latest bank statement so the reconciled balance (280,000) falls
    // below the 320,000 trust liability.
    const w = warehouse((db) => db.exec("UPDATE trust_bank_snapshots SET bank_statement_balance_cents = 300000 WHERE snapshot_id = 'S-02'"));
    const out = run(w, 'trust-vs-liability');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'bank-covers-liability').status, 'flag');
    // The integrity recompute of the liability still ties to the query's figure.
    assert.equal(out.checks.find((c) => c.id === 'liability-recompute').status, 'pass');
    assert.equal(out.rows[0].reconciled_bank_cents, 280000);
});

test('negative-owner-balances flags an overdrawn owner ledger', () => {
    // Disburse 100,000 more for OWNER-100 than the 50,000 held, so its balance
    // goes to -50,000.
    const w = warehouse((db) => db.exec("INSERT INTO trust_ledger (entry_id, ledger_id, ledger_type, property_id, lease_id, entry_type, amount_cents, entry_date) VALUES ('L-0099', 'OWNER-100', 'OWNER', 'P-1', NULL, 'OUT', 100000, '2026-06-15')"));
    const out = run(w, 'negative-owner-balances');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-negative-owner-balances');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['OWNER-100']);
    assert.equal(out.rows.find((r) => r.ledger_id === 'OWNER-100').balance_cents, -50000);
});

test('deposits-held-vs-owed flags an active lease whose deposit is not held in full', () => {
    // Pull 30,000 out of the L-001 deposit ledger; 90,000 held against 120,000 owed.
    const w = warehouse((db) => db.exec("INSERT INTO trust_ledger (entry_id, ledger_id, ledger_type, property_id, lease_id, entry_type, amount_cents, entry_date) VALUES ('L-0098', 'DEP-L-001', 'DEPOSIT', 'P-1', 'L-001', 'OUT', 30000, '2026-06-15')"));
    const out = run(w, 'deposits-held-vs-owed');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'all-deposits-held').status, 'flag');
    const row = out.rows.find((r) => r.lease_id === 'L-001');
    assert.equal(row.owed_cents, 120000);
    assert.equal(row.held_cents, 90000);
});

test('deposit-return-overdue flags an ended lease whose deposit was not returned', () => {
    // Undo the L-003 return; move-out was 2026-05-01, 41 days before the latest
    // ledger entry (2026-06-11), so it is past the 30-day default.
    const w = warehouse((db) => db.exec("UPDATE leases SET deposit_returned_date = NULL WHERE lease_id = 'L-003'"));
    const out = run(w, 'deposit-return-overdue');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-overdue-returns');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['L-003']);
    assert.equal(out.rows.find((r) => r.lease_id === 'L-003').days_since_moveout, 41);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled property ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed property ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'negative-owner-balances');
    assert.equal(out.entry.ruleset.version, 'property-trust-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
