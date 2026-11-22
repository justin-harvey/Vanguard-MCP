/**
 * The broker-trust demo warehouse (the Property Management & HOA pack's
 * property-trust ruleset).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the three permitted tables, and refuse the deliberately
 * omitted resident-PII table through the same guard every warehouse uses. The
 * ruleset's four controls (clean and tripped) are exercised in
 * property-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPropertyDb, PROPERTY_ALLOWLIST } from './property-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function propertyWarehouse() {
    const dbPath = freshPropertyDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: PROPERTY_ALLOWLIST } });
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

test('the property warehouse loads and serves exactly its three tables', () => {
    const w = propertyWarehouse();
    assert.equal(w.name, 'property');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['leases', 'trust_bank_snapshots', 'trust_ledger'],
    );
    assert.ok(!w.allowedTables.includes('resident_pii'), 'the resident-PII table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    assert.doesNotThrow(propertyWarehouse);
});

test('the guard refuses any query that reaches resident PII', () => {
    const w = propertyWarehouse();
    assert.equal(rejection('SELECT party_id, full_name FROM resident_pii', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT t.entry_id FROM trust_ledger t JOIN resident_pii p ON p.party_id = t.ledger_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM leases', w).reason, 'wildcard_not_allowed');
});
