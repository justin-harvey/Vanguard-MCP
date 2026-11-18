/**
 * The HOA demo warehouse (the Property Management & HOA pack's hoa ruleset).
 *
 * These prove the shipped seed and allow-list load as one more custom
 * warehouse, serve the four permitted tables, and refuse the deliberately
 * omitted resident-PII table through the same guard every warehouse uses. The
 * ruleset's three controls (clean and tripped) are exercised in
 * hoa-ruleset.test.js. Offline: no network, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshHoaDb, HOA_ALLOWLIST } from './hoa-fixture.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guard, SqlRejected } from '../src/guard.js';

function hoaWarehouse() {
    const dbPath = freshHoaDb();
    return loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: HOA_ALLOWLIST } });
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

test('the hoa warehouse loads and serves exactly its four tables', () => {
    const w = hoaWarehouse();
    assert.equal(w.name, 'hoa');
    assert.deepEqual(
        [...w.allowedTables].sort(),
        ['assessments', 'budget_lines', 'operating_expenses', 'reserve_transfers'],
    );
    assert.ok(!w.allowedTables.includes('resident_pii'), 'the resident-PII table is not served');
});

test('the allow-list validates against the live database at load (its columns all exist)', () => {
    assert.doesNotThrow(hoaWarehouse);
});

test('the guard refuses any query that reaches resident PII', () => {
    const w = hoaWarehouse();
    assert.equal(rejection('SELECT unit_id, full_name FROM resident_pii', w).reason, 'table_not_allowed');
    assert.equal(
        rejection('SELECT a.assessment_id FROM assessments a JOIN resident_pii p ON p.unit_id = a.unit_id', w).reason,
        'table_not_allowed',
    );
    assert.equal(rejection('SELECT * FROM assessments', w).reason, 'wildcard_not_allowed');
});
