/**
 * Custom-warehouse loader tests: the allow-list format, validation against the
 * live database, and the descriptor handed to the guard and planner. Uses the
 * municipal demo shipped with the civic-chain-auditor skill, so a change that
 * breaks the skill's bundled assets fails here.
 *
 * Needs only node:sqlite (no SQL parser, no model SDK).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseAllowlist, loadCustomWarehouse, CustomWarehouseInvalid, CUSTOM_ENV } from '../src/custom.js';
import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

function envFor(dbPath, allowlistPath = MUNICIPAL_ALLOWLIST, extra = {}) {
    return { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: allowlistPath, ...extra };
}

function writeAllowlist(doc) {
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-allow-')), 'allowlist.json');
    writeFileSync(path, JSON.stringify(doc));
    return path;
}

test('no environment means no custom warehouse', () => {
    assert.equal(loadCustomWarehouse({ env: {} }), null);
});

test('setting only one of the two variables is an error, not a silent no-op', () => {
    assert.throws(() => loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: '/tmp/x.sqlite' } }), CustomWarehouseInvalid);
    assert.throws(() => loadCustomWarehouse({ env: { [CUSTOM_ENV.allowlist]: '/tmp/x.json' } }), CustomWarehouseInvalid);
});

test('the bundled municipal demo loads as a free-text warehouse with a column allow-list', () => {
    const dbPath = freshMunicipalDb();
    const w = loadCustomWarehouse({ env: envFor(dbPath) });
    assert.equal(w.name, 'municipal');
    assert.equal(w.freeText, true);
    assert.equal(w.custom, true);
    assert.equal(w.dbPath, dbPath);
    assert.equal(w.logPath, join(dirname(dbPath), 'municipal-audit.jsonl'));
    assert.ok(w.allowedTables.includes('grants'));
    assert.ok(w.allowedTables.includes('expenditures'));
    // payroll exists in the database but is deliberately not allow-listed.
    assert.ok(!w.allowedTables.includes('payroll'));
    // Sensitive vendor columns are excluded from the column allow-list.
    assert.deepEqual([...w.allowedColumns.vendors], ['vendor_id', 'vendor_name', 'category']);
});

test('the planner sees only allow-listed tables and columns, plus the notes', () => {
    const w = loadCustomWarehouse({ env: envFor(freshMunicipalDb()) });
    const text = w.planSchema.schemaDescription;
    assert.match(text, /grants\(grant_id TEXT, /);
    assert.match(text, /award_cents INTEGER/);
    assert.match(text, /INTEGER CENTS/);
    assert.doesNotMatch(text, /payroll/);
    assert.doesNotMatch(text, /tax_id/);
    assert.doesNotMatch(text, /remit_account_last4/);
    assert.equal(w.planSchema.columnRestricted, true);
    assert.equal(w.planSchema.domain, 'municipal budget, grant and spending data');
});

test('CIVIC_AUDIT_LOG overrides the default log location', () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'civic-log-')), 'custom.jsonl');
    const w = loadCustomWarehouse({ env: envFor(freshMunicipalDb(), MUNICIPAL_ALLOWLIST, { [CUSTOM_ENV.log]: logPath }) });
    assert.equal(w.logPath, logPath);
});

test('an allow-list naming a column the database lacks fails at load time', () => {
    const doc = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));
    doc.tables.grants.push('grant_officer');
    assert.throws(
        () => loadCustomWarehouse({ env: envFor(freshMunicipalDb(), writeAllowlist(doc)) }),
        /column grants\.grant_officer/,
    );
});

test('an allow-list naming a missing table fails at load time', () => {
    const doc = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));
    doc.tables.contracts = ['contract_id'];
    assert.throws(() => loadCustomWarehouse({ env: envFor(freshMunicipalDb(), writeAllowlist(doc)) }), /table contracts/);
});

test('a missing database file is reported by path', () => {
    assert.throws(
        () => loadCustomWarehouse({ env: envFor('/nonexistent/municipal.sqlite') }),
        /does not exist/,
    );
});

test('parseAllowlist rejects malformed documents', () => {
    const base = { name: 'town', tables: { grants: ['grant_id'] } };
    assert.doesNotThrow(() => parseAllowlist(base));
    const bad = [
        null,
        [],
        { ...base, name: 'Town' },
        { ...base, name: '1town' },
        { ...base, name: 'saas' },
        { ...base, name: 'audit' },
        { ...base, tables: {} },
        { ...base, tables: [] },
        { ...base, tables: { grants: [] } },
        { ...base, tables: { grants: 'grant_id' } },
        { ...base, tables: { 'grants; DROP TABLE x': ['grant_id'] } },
        { ...base, tables: { grants: ['grant_id) --'] } },
        { ...base, tables: { sqlite_master: ['name'] } },
        { ...base, notes: 'one note' },
        { ...base, description: 42 },
    ];
    for (const doc of bad) {
        assert.throws(() => parseAllowlist(doc), CustomWarehouseInvalid, JSON.stringify(doc));
    }
});

test('parseAllowlist defaults the domain from the name and de-duplicates columns', () => {
    const parsed = parseAllowlist({ name: 'town', tables: { grants: ['grant_id', 'grant_id', 'status'] } });
    assert.equal(parsed.domain, 'town data');
    assert.deepEqual(parsed.tables.grants, ['grant_id', 'status']);
    assert.deepEqual(parsed.notes, []);
});
