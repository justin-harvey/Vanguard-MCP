/**
 * Grant-register import tests.
 *
 * An expenditure-only import derives the grants it sees referenced as award-0
 * placeholders, so municipal/grant-status cannot measure spending against an
 * award. A second import of the buyer's grant register fills those awards in.
 * These tests pin the coercion, the upsert onto an existing ledger, and the
 * end-to-end multi-file import that turns grant-status from "0 awards" into a
 * meaningful answer — each file recording its own source-SHA-256 audit entry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    parseCsv,
    proposeMapping,
    buildLedgerFromCsv,
    applyGrantRegisterToLedger,
    coerceGrantorType,
    coerceGrantStatus,
    CANONICAL_GRANT_FIELDS,
    ImportError,
} from '../src/import-csv.js';
import { runImport } from '../src/import.js';
import { verify } from '../src/audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const EXP = join(FIXTURE_DIR, 'riverton_grant_expenditures.csv');
const REG = join(FIXTURE_DIR, 'riverton_grant_register.csv');

function env() {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-grant-data-')), CIVIC_IMPORT_DIR: FIXTURE_DIR };
}

/** Build an expenditure ledger (with grant_id) into a temp db; return its path. */
function expenditureLedger() {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'cc-grant-ledger-')), 'ledger.db');
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    buildLedgerFromCsv({ csvPath: EXP, mapping, dbPath });
    return dbPath;
}

function grantMapping() {
    const { headers, rows } = parseCsv(readFileSync(REG, 'utf8'));
    return proposeMapping(headers, rows, CANONICAL_GRANT_FIELDS).mapping;
}

test('grantor type and grant status coerce to the schema CHECK sets or are refused', () => {
    assert.equal(coerceGrantorType('Federal'), 'federal');
    assert.equal(coerceGrantorType('fed'), 'federal');
    assert.equal(coerceGrantorType('STATE'), 'state');
    assert.throws(() => coerceGrantorType('municipal'), ImportError);

    assert.equal(coerceGrantStatus(''), 'active');
    assert.equal(coerceGrantStatus('Open'), 'active');
    assert.equal(coerceGrantStatus('completed'), 'closed');
    assert.throws(() => coerceGrantStatus('frozen'), ImportError);
});

test('the proposed grant mapping covers the register with no required field unmapped', () => {
    const { headers, rows } = parseCsv(readFileSync(REG, 'utf8'));
    const proposal = proposeMapping(headers, rows, CANONICAL_GRANT_FIELDS);
    assert.deepEqual(proposal.missingRequired, []);
    assert.equal(proposal.mapping.grant_id, 'Grant ID');
    assert.equal(proposal.mapping.award_amount, 'Award');
    assert.equal(proposal.mapping.grantor_type, 'Type');
});

test('applyGrantRegisterToLedger updates placeholders and inserts new grants', () => {
    const dbPath = expenditureLedger();
    const db = new DatabaseSync(dbPath);
    // The expenditure import left G-402 and G-317 as award-0 placeholders.
    const before = db.prepare('SELECT grant_id, award_cents FROM grants ORDER BY grant_id').all().map((r) => ({ ...r }));
    assert.deepEqual(before, [
        { grant_id: 'G-317', award_cents: 0 },
        { grant_id: 'G-402', award_cents: 0 },
    ]);
    db.close();

    const applied = applyGrantRegisterToLedger({ csvPath: REG, mapping: grantMapping(), dbPath });
    assert.equal(applied.counts.grants, 3);
    assert.equal(applied.counts.updated, 2); // G-402, G-317
    assert.equal(applied.counts.inserted, 1); // G-366, which no expenditure referenced

    const db2 = new DatabaseSync(dbPath);
    const g402 = { ...db2.prepare("SELECT award_cents, match_required_cents, grantor_type, status FROM grants WHERE grant_id = 'G-402'").get() };
    assert.deepEqual(g402, { award_cents: 12500000, match_required_cents: 3125000, grantor_type: 'state', status: 'active' });
    const g366 = { ...db2.prepare("SELECT award_cents, status FROM grants WHERE grant_id = 'G-366'").get() };
    assert.deepEqual(g366, { award_cents: 960000, status: 'closed' });
    db2.close();
});

test('a malformed grant-register row aborts the whole apply and leaves the ledger untouched', () => {
    const dbPath = expenditureLedger();
    // A mapping that points grantor_type at a column of amounts guarantees a
    // coercion failure partway through, exercising the transaction rollback.
    const bad = { ...grantMapping(), grantor_type: 'Award' };
    assert.throws(() => applyGrantRegisterToLedger({ csvPath: REG, mapping: bad, dbPath }), ImportError);

    const db = new DatabaseSync(dbPath);
    const awards = db.prepare('SELECT award_cents FROM grants ORDER BY grant_id').all().map((r) => ({ ...r }));
    db.close();
    // Still the award-0 placeholders: nothing was committed.
    assert.deepEqual(awards, [{ award_cents: 0 }, { award_cents: 0 }]);
});

test('multi-file import makes grant-status meaningful, with a second source-hash audit entry', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const grantReg = { file: 'riverton_grant_register.csv', mapping: grantMapping() };

    const result = await runImport({
        file: 'riverton_grant_expenditures.csv',
        mapping,
        grantRegister: grantReg,
        env: e,
    });

    assert.equal(result.stage, 'imported');
    assert.equal(result.counts.grants, 2); // placeholders from the expenditure pass

    // The grant register was applied and recorded as its own entry.
    assert.ok(result.grantRegister);
    assert.equal(result.grantRegister.counts.updated, 2);
    assert.equal(result.grantRegister.counts.inserted, 1);
    const regHash = createHash('sha256').update(readFileSync(REG)).digest('hex');
    assert.equal(result.grantRegister.sourceFileSha256, regHash);
    assert.notEqual(result.grantRegister.sourceFileSha256, result.sourceFileSha256);

    // grant-status is now meaningful: three grants, clean integrity, no findings
    // (paid spending is within every award and no cash is drawn ahead of it).
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    assert.equal(byName['grant-status'].rowCount, 3);
    assert.equal(byName['grant-status'].integrity, 'pass');
    assert.equal(byName['grant-status'].findings, 0);

    // The chain holds: import, import-grants, then three attested gate queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 5);
    const entries = readFileSync(result.paths.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries[0].kind, 'import');
    assert.equal(entries[1].kind, 'import-grants');
    assert.equal(entries[1].dataHash, regHash);
    assert.deepEqual(entries[1].tables, ['grants']);
});

test('without the register, grant-status has awards of zero: the gap the register closes', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const result = await runImport({ file: 'riverton_grant_expenditures.csv', mapping, env: e });

    assert.equal(result.grantRegister, null);
    const grantStatus = result.gate.queries.find((q) => q.name === 'grant-status');
    // Two placeholder grants, but paid spending exceeds their award of 0: the
    // compare checks fire as findings, which is exactly what filling the awards fixes.
    assert.equal(grantStatus.rowCount, 2);
    assert.ok(grantStatus.findings >= 1);
});

test('propose stage proposes both mappings and writes nothing when a register is named', async () => {
    const e = env();
    const result = await runImport({
        file: 'riverton_grant_expenditures.csv',
        mapping: null,
        grantRegister: { file: 'riverton_grant_register.csv', mapping: null },
        env: e,
    });
    assert.equal(result.stage, 'propose');
    assert.equal(result.mapping.grant_id, 'Grant');
    assert.ok(result.grantRegister);
    assert.equal(result.grantRegister.file, 'riverton_grant_register.csv');
    assert.deepEqual(result.grantRegister.missingRequired, []);
});
