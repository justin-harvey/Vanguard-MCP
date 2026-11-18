/**
 * The nonprofit demo warehouse (the Nonprofit Restricted Funds pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the six permitted tables, and refuse the deliberately
 * omitted donor-PII table through the same guard every warehouse uses. The
 * ruleset's five controls (clean and tripped) are exercised in
 * nonprofit-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshNonprofitDb, NONPROFIT_ALLOWLIST } from './nonprofit-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function nonprofitWarehouse() {
    const dbPath = freshNonprofitDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: NONPROFIT_ALLOWLIST } });
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

test('the nonprofit warehouse loads and serves exactly its six tables', () => {
    const w = nonprofitWarehouse();
    assert.equal(w.name, 'nonprofit');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['account_balances', 'expenses', 'federal_awards', 'funds', 'net_assets', 'restriction_releases'],
    );
    assert.ok(!w.allowedTables.includes('donor_pii'), 'the donor-data table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(nonprofitWarehouse);
});

test('the guard refuses any query that reaches donor data', () => {
    const w = nonprofitWarehouse();
    assert.equal(rejection('SELECT donor_id, donor_name FROM donor_pii', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT e.expense_id FROM expenses e JOIN donor_pii d ON d.donor_id = e.fund_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM funds', w).reason, 'wildcard_not_allowed');
});
