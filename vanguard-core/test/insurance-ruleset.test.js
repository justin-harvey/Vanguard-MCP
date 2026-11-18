/**
 * The Insurance & Fiduciary ruleset (II2), driven end to end through the real
 * guard against the shipped insurance demo warehouse.
 *
 * The three controls:
 *   trust-account-solvency      compare: bank balance >= net trust liability
 *   commission-variance-audit   empty:   no active policy varies from contract
 *   eo-unbound-exposure         empty:   no client premium held unbound
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation,
 * so the EXCEPTION/FLAG paths are real, not asserted. The ruleset is also
 * validated statement by statement (every query and check SQL passes the guard).
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
import { freshInsuranceDb, INSURANCE_ALLOWLIST } from './insurance-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'insurance', 'ruleset.insurance-v1.json');

function warehouse(mutate) {
    const dbPath = freshInsuranceDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: INSURANCE_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the insurance ruleset parses and declares its three controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'insurance');
    assert.equal(r.version, 'insurance-v1');
    assert.deepEqual(Object.keys(r.queries), ['trust-account-solvency', 'commission-variance-audit', 'eo-unbound-exposure']);
});

test('every insurance query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // three query SQLs + one total_matches check SQL = four guarded statements
    assert.equal(validateNamedQueries(w, guard), 4);
    assert.equal(w.ruleset.version, 'insurance-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all three controls pass', () => {
    const w = warehouse();

    const solvency = run(w, 'trust-account-solvency');
    assert.equal(solvency.integrity, 'pass');
    assert.equal(solvency.findings, 0);
    assert.equal(solvency.rows[0].net_trust_liability_cents, 67500);
    assert.equal(solvency.rows[0].bank_balance_cents, 70000, 'reads the latest snapshot, not the largest');

    const variance = run(w, 'commission-variance-audit');
    assert.equal(variance.findings, 0);
    assert.equal(variance.rows.length, 0);

    const eo = run(w, 'eo-unbound-exposure');
    assert.equal(eo.findings, 0);
    assert.equal(eo.rows.length, 0);
});

// ── each control tripped by a targeted mutation ──────────────────────────────

test('trust-account-solvency flags a fiduciary shortfall', () => {
    // Drop the latest bank snapshot below the 67,500 net liability.
    const w = warehouse((db) => db.exec("UPDATE trust_bank_snapshots SET actual_bank_balance_cents = 40000 WHERE snapshot_id = 'S-02'"));
    const out = run(w, 'trust-account-solvency');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'trust-solvent');
    assert.equal(check.status, 'flag');
    assert.match(check.message, /shortfall/i);
});

test('commission-variance-audit flags a materially underpaid policy', () => {
    // P-1002 contracted commission is 100,000; pay only 90,000 (variance 10,000).
    const w = warehouse((db) => db.exec("UPDATE commission_receipts SET paid_comm_cents = 90000 WHERE receipt_id = 'R-5003'"));
    const out = run(w, 'commission-variance-audit');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-commission-variance');
    assert.equal(check.status, 'flag');
    assert.equal(check.detail.count, 1);
    assert.deepEqual(check.detail.rows, ['P-1002']);
    assert.deepEqual(out.rows.map((r) => r.policy_id), ['P-1002']);
    assert.equal(out.rows[0].variance_cents, -10000);
});

test('the materiality threshold parameter suppresses a sub-threshold variance', () => {
    const w = warehouse((db) => db.exec("UPDATE commission_receipts SET paid_comm_cents = 90000 WHERE receipt_id = 'R-5003'"));
    // A 10,000 variance is below a 20,000 threshold, so nothing is reported.
    const out = run(w, 'commission-variance-audit', { min_variance_cents: 20000 });
    assert.equal(out.findings, 0);
    assert.equal(out.rows.length, 0);
});

test('eo-unbound-exposure flags client premium held against an unconfirmed binder', () => {
    // Un-confirm P-1004's binder while it still holds client premium.
    const w = warehouse((db) => db.exec("UPDATE binders SET carrier_confirmed = 0 WHERE policy_id = 'P-1004'"));
    const out = run(w, 'eo-unbound-exposure');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-unbound-premium');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['P-1004']);
    assert.equal(out.rows[0].client_funds_held_cents, 500000);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled insurance ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed insurance ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'eo-unbound-exposure');
    assert.equal(out.entry.ruleset.version, 'insurance-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
