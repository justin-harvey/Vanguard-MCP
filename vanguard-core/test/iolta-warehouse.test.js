/**
 * The IOLTA demo warehouse (the Law Firm Trust pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the three permitted tables, and refuse the deliberately
 * omitted client-PII table through the same guard every warehouse uses. The
 * ruleset's five controls (clean and tripped) are exercised in
 * iolta-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshIoltaDb, IOLTA_ALLOWLIST } from './iolta-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function ioltaWarehouse() {
    const dbPath = freshIoltaDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: IOLTA_ALLOWLIST } });
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

test('the IOLTA warehouse loads and serves exactly its three tables', () => {
    const w = ioltaWarehouse();
    assert.equal(w.name, 'iolta');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['fee_invoices', 'trust_bank_snapshots', 'trust_journal'],
    );
    assert.ok(!w.allowedTables.includes('client_contacts'), 'the client-PII table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(ioltaWarehouse);
});

test('the guard refuses any query that reaches client PII', () => {
    const w = ioltaWarehouse();
    assert.equal(rejection('SELECT client_id, full_name FROM client_contacts', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT j.entry_id FROM trust_journal j JOIN client_contacts c ON j.client_id = c.client_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM trust_journal', w).reason, 'wildcard_not_allowed');
});
