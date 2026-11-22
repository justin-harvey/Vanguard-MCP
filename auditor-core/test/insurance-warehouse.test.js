/**
 * The insurance demo warehouse (II1 of the Insurance & Fiduciary pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the five permitted tables, and refuse the deliberately
 * omitted PII table through the same guard every warehouse uses. The ruleset's
 * three controls (clean and tripped) are exercised in insurance-ruleset.test.js.
 * Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshInsuranceDb, INSURANCE_ALLOWLIST } from './insurance-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function insuranceWarehouse() {
    const dbPath = freshInsuranceDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: INSURANCE_ALLOWLIST } });
}

function rejection(sql, w) {
    try {
        guard(sql, { allowedTables: w.allowedTables, allowedColumns: w.allowedColumns });
    } catch (error) {
        if (error instanceof SqlRejected) return error;
        throw error;
    }
    throw new assert.AssertionError({ message: `expected rejection, but this was allowed: ${sql}` });
}

test('the insurance warehouse loads and serves exactly its five tables', () => {
    const w = insuranceWarehouse();
    assert.equal(w.name, 'insurance');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['binders', 'commission_receipts', 'policies', 'trust_bank_snapshots', 'trust_ledger'],
    );
    assert.ok(!w.allowedTables.includes('insured_pii'), 'the PII table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(insuranceWarehouse);
});

test('the guard refuses any query that reaches policyholder PII', () => {
    const w = insuranceWarehouse();
    assert.equal(rejection('SELECT insured_id, ssn FROM insured_pii', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT t.entry_id FROM trust_ledger t JOIN insured_pii p ON t.policy_id = p.policy_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT policy_id, ssn FROM policies', w).reason, 'column_not_allowed');
    assert.equal(rejection('SELECT * FROM trust_ledger', w).reason, 'wildcard_not_allowed');
});
