/**
 * The schools demo warehouse (the School Districts pack).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the seven permitted tables, and refuse the deliberately
 * omitted student-records table through the same guard every warehouse uses.
 * The ruleset's five controls (clean and tripped) are exercised in
 * schools-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSchoolsDb, SCHOOLS_ALLOWLIST } from './schools-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function schoolsWarehouse() {
    const dbPath = freshSchoolsDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: SCHOOLS_ALLOWLIST } });
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

test('the schools warehouse loads and serves exactly its seven tables', () => {
    const w = schoolsWarehouse();
    assert.equal(w.name, 'schools');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        [
            'activity_accounts',
            'activity_collections',
            'activity_disbursements',
            'budget_lines',
            'expenditures',
            'federal_costs',
            'federal_programs',
        ],
    );
    assert.ok(!w.allowedTables.includes('student_records'), 'the student-records table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    // loadCustomWarehouse calls describeAgainstDatabase, which fails loudly if a
    // permitted column is absent; a clean load is the assertion.
    assert.doesNotThrow(schoolsWarehouse);
});

test('the guard refuses any query that reaches student records', () => {
    const w = schoolsWarehouse();
    assert.equal(rejection('SELECT student_id, student_name FROM student_records', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT a.account_id FROM activity_accounts a JOIN student_records s ON s.student_id = a.account_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM activity_accounts', w).reason, 'wildcard_not_allowed');
});
