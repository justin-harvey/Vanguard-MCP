/**
 * The excise demo warehouse (the Excise Tax pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the four permitted tables, and refuse the deliberately
 * omitted customer-data table through the same guard every warehouse uses. The
 * ruleset's five controls (clean and tripped) are exercised in
 * excise-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshExciseDb, EXCISE_ALLOWLIST } from './excise-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function exciseWarehouse() {
    const dbPath = freshExciseDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: EXCISE_ALLOWLIST } });
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

test('the excise warehouse loads and serves exactly its four tables', () => {
    const w = exciseWarehouse();
    assert.equal(w.name, 'excise');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['operations_reports', 'removals', 'tax_rates', 'tax_returns'],
    );
    assert.ok(!w.allowedTables.includes('customer_accounts'), 'the customer-data table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(exciseWarehouse);
});

test('the guard refuses any query that reaches customer data', () => {
    const w = exciseWarehouse();
    assert.equal(rejection('SELECT account_id, customer_name FROM customer_accounts', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT r.removal_id FROM removals r JOIN customer_accounts c ON c.account_id = r.removal_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM tax_returns', w).reason, 'wildcard_not_allowed');
});
