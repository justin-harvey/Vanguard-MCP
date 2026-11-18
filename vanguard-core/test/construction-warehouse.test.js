/**
 * The construction demo warehouse (the Construction Contracts pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the six permitted tables, and refuse the deliberately
 * omitted payroll table through the same guard every warehouse uses. The
 * ruleset's six controls (clean and tripped) are exercised in
 * construction-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshConstructionDb, CONSTRUCTION_ALLOWLIST } from './construction-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function constructionWarehouse() {
    const dbPath = freshConstructionDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: CONSTRUCTION_ALLOWLIST } });
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

test('the construction warehouse loads and serves exactly its six tables', () => {
    const w = constructionWarehouse();
    assert.equal(w.name, 'construction');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        [
            'balance_sheet_balances',
            'gl_revenue',
            'jobs',
            'retainage',
            'sub_payments',
            'wip_snapshots',
        ],
    );
    assert.ok(!w.allowedTables.includes('payroll_pii'), 'the payroll table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(constructionWarehouse);
});

test('the guard refuses any query that reaches employee payroll', () => {
    const w = constructionWarehouse();
    assert.equal(rejection('SELECT employee_id, ssn FROM payroll_pii', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT j.job_id FROM jobs j JOIN payroll_pii p ON p.employee_id = j.job_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM jobs', w).reason, 'wildcard_not_allowed');
});
