/**
 * Grant-drawdowns import tests.
 *
 * A grant register fills in each award, but says nothing about the cash actually
 * drawn from the grantor. With no drawdowns file, municipal/grant-status reports
 * drawn = 0, so its cash-ahead-of-spending check is blind. A third import of the
 * buyer's drawdown register fills grant_drawdowns. These tests pin the coercion,
 * the insert onto an existing ledger (ids carried or generated, unknown grants
 * refused, a malformed row rolled back), and the end-to-end three-file import
 * that turns drawn cash real — each file recording its own source-SHA-256 entry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    applyGrantDrawdownsToLedger,
    coerceDrawdownStatus,
    CANONICAL_GRANT_FIELDS,
    CANONICAL_DRAWDOWN_FIELDS,
    ImportError,
} from '../src/import-csv.js';
import { runImport } from '../src/import.js';
import { verify } from '../src/audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const EXP = join(FIXTURE_DIR, 'riverton_grant_expenditures.csv');
const REG = join(FIXTURE_DIR, 'riverton_grant_register.csv');
const DRAW = join(FIXTURE_DIR, 'riverton_grant_drawdowns.csv');

function env() {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-draw-data-')), CIVIC_IMPORT_DIR: FIXTURE_DIR };
}

/** Build an expenditure ledger (with grant_id placeholders) into a temp db. */
function expenditureLedger() {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'cc-draw-ledger-')), 'ledger.db');
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    buildLedgerFromCsv({ csvPath: EXP, mapping, dbPath });
    return dbPath;
}

function drawdownMapping() {
    const { headers, rows } = parseCsv(readFileSync(DRAW, 'utf8'));
    return proposeMapping(headers, rows, CANONICAL_DRAWDOWN_FIELDS).mapping;
}

function grantMapping() {
    const { headers, rows } = parseCsv(readFileSync(REG, 'utf8'));
    return proposeMapping(headers, rows, CANONICAL_GRANT_FIELDS).mapping;
}

test('drawdown status coerces to the schema CHECK set or is refused', () => {
    assert.equal(coerceDrawdownStatus('Received'), 'received');
    assert.equal(coerceDrawdownStatus('funded'), 'received');
    assert.equal(coerceDrawdownStatus('PENDING'), 'pending');
    assert.equal(coerceDrawdownStatus('requested'), 'pending');
    assert.throws(() => coerceDrawdownStatus('cancelled'), ImportError);
    assert.throws(() => coerceDrawdownStatus(''), ImportError); // empty is resolved by the caller, never here
});

test('the proposed drawdown mapping covers the file with no required field unmapped', () => {
    const { headers, rows } = parseCsv(readFileSync(DRAW, 'utf8'));
    const proposal = proposeMapping(headers, rows, CANONICAL_DRAWDOWN_FIELDS);
    assert.deepEqual(proposal.missingRequired, []);
    assert.equal(proposal.mapping.grant_id, 'Grant');
    assert.equal(proposal.mapping.amount, 'Amount');
    assert.equal(proposal.mapping.request_date, 'Request Date');
    assert.equal(proposal.mapping.received_date, 'Received Date');
    assert.equal(proposal.mapping.drawdown_id, 'Drawdown ID');
});

test('applyGrantDrawdownsToLedger inserts drawdowns and resolves received cash per grant', () => {
    const dbPath = expenditureLedger();
    const applied = applyGrantDrawdownsToLedger({ csvPath: DRAW, mapping: drawdownMapping(), dbPath });
    assert.equal(applied.counts.drawdowns, 6);
    assert.equal(applied.counts.inserted, 6);
    assert.equal(applied.counts.grants, 2); // G-402, G-317

    const db = new DatabaseSync(dbPath);
    // Carried ids were kept; status drives what counts as drawn (received) cash.
    const rows = db.prepare('SELECT drawdown_id, grant_id, amount_cents, status, received_date FROM grant_drawdowns ORDER BY drawdown_id').all();
    assert.equal(rows.length, 6);
    assert.equal(rows[0].drawdown_id, 'DD-01');
    // A blank received date became a pending drawdown with a NULL received_date.
    const pending = rows.find((r) => r.drawdown_id === 'DD-03');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.received_date, null);
    // Received cash per grant (the figure grant-status compares against spending).
    const drawn = (g) => db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM grant_drawdowns WHERE grant_id = ? AND status = 'received'").get(g).c;
    assert.equal(drawn('G-402'), 4500000); // 25,000 + 20,000
    assert.equal(drawn('G-317'), 2500000); // 15,000 + 10,000
    db.close();
});

test('a drawdown generates DD-0001… ids in file order when drawdown_id is unmapped', () => {
    const dbPath = expenditureLedger();
    const mapping = { ...drawdownMapping() };
    delete mapping.drawdown_id;
    applyGrantDrawdownsToLedger({ csvPath: DRAW, mapping, dbPath });
    const db = new DatabaseSync(dbPath);
    const ids = db.prepare('SELECT drawdown_id FROM grant_drawdowns ORDER BY drawdown_id').all().map((r) => r.drawdown_id);
    db.close();
    assert.deepEqual(ids, ['DD-0001', 'DD-0002', 'DD-0003', 'DD-0004', 'DD-0005', 'DD-0006']);
});

test('a drawdown for a grant not in the ledger is refused, naming the grant', () => {
    const dbPath = expenditureLedger();
    const tmp = join(mkdtempSync(join(tmpdir(), 'cc-draw-bad-')), 'draws.csv');
    writeFileSync(tmp, 'Grant,Request Date,Amount,Status\nG-999,2026-05-01,"$1,000.00",received\n');
    const { headers, rows } = parseCsv(readFileSync(tmp, 'utf8'));
    const mapping = proposeMapping(headers, rows, CANONICAL_DRAWDOWN_FIELDS).mapping;
    assert.throws(() => applyGrantDrawdownsToLedger({ csvPath: tmp, mapping, dbPath }), /G-999.*not in the ledger/);

    const db = new DatabaseSync(dbPath);
    const count = db.prepare('SELECT COUNT(*) AS c FROM grant_drawdowns').get().c;
    db.close();
    assert.equal(count, 0); // nothing committed
});

test('a malformed drawdown row aborts the whole apply and leaves grant_drawdowns empty', () => {
    const dbPath = expenditureLedger();
    // Point amount at a date column: a coercion failure mid-file exercises rollback.
    const bad = { ...drawdownMapping(), amount: 'Request Date' };
    assert.throws(() => applyGrantDrawdownsToLedger({ csvPath: DRAW, mapping: bad, dbPath }), ImportError);
    const db = new DatabaseSync(dbPath);
    const count = db.prepare('SELECT COUNT(*) AS c FROM grant_drawdowns').get().c;
    db.close();
    assert.equal(count, 0);
});

test('three-file import makes drawn cash real, with a third source-hash audit entry', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);

    const result = await runImport({
        file: 'riverton_grant_expenditures.csv',
        mapping,
        grantRegister: { file: 'riverton_grant_register.csv', mapping: grantMapping() },
        grantDrawdowns: { file: 'riverton_grant_drawdowns.csv', mapping: drawdownMapping() },
        env: e,
    });

    assert.equal(result.stage, 'imported');

    // The drawdowns were applied and recorded as their own source-hash entry,
    // distinct from the expenditure and register hashes.
    assert.ok(result.grantDrawdowns);
    assert.equal(result.grantDrawdowns.counts.drawdowns, 6);
    assert.equal(result.grantDrawdowns.counts.grants, 2);
    const drawHash = createHash('sha256').update(readFileSync(DRAW)).digest('hex');
    assert.equal(result.grantDrawdowns.sourceFileSha256, drawHash);
    assert.notEqual(result.grantDrawdowns.sourceFileSha256, result.sourceFileSha256);
    assert.notEqual(result.grantDrawdowns.sourceFileSha256, result.grantRegister.sourceFileSha256);

    // grant-status stays clean: awards are real, and received cash is within paid
    // spending on every grant (no cash drawn ahead of spending).
    const grantStatus = result.gate.queries.find((q) => q.name === 'grant-status');
    assert.equal(grantStatus.rowCount, 3);
    assert.equal(grantStatus.integrity, 'pass');
    assert.equal(grantStatus.findings, 0);

    // Drawn cash is now real in the ledger, not the award-0/zero-drawn blind spot.
    const db = new DatabaseSync(result.paths.dbPath);
    const drawn = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM grant_drawdowns WHERE status = 'received'").get().c;
    db.close();
    assert.equal(drawn, 7000000); // 4,500,000 (G-402) + 2,500,000 (G-317)

    // The chain holds: import, import-grants, import-drawdowns, then three gate queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 6);
    const entries = readFileSync(result.paths.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries[0].kind, 'import');
    assert.equal(entries[1].kind, 'import-grants');
    assert.equal(entries[2].kind, 'import-drawdowns');
    assert.equal(entries[2].dataHash, drawHash);
    assert.deepEqual(entries[2].tables, ['grant_drawdowns']);
});

test('drawdowns can be imported without a grant register, onto expenditure placeholders', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(EXP, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const result = await runImport({
        file: 'riverton_grant_expenditures.csv',
        mapping,
        grantDrawdowns: { file: 'riverton_grant_drawdowns.csv', mapping: drawdownMapping() },
        env: e,
    });
    assert.equal(result.grantRegister, null);
    assert.ok(result.grantDrawdowns);
    assert.equal(result.grantDrawdowns.counts.drawdowns, 6);
    // import, import-drawdowns, then three gate queries (no import-grants).
    const entries = readFileSync(result.paths.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(entries.slice(0, 2).map((x) => x.kind), ['import', 'import-drawdowns']);
});

test('propose stage proposes all three mappings and writes nothing', async () => {
    const e = env();
    const result = await runImport({
        file: 'riverton_grant_expenditures.csv',
        mapping: null,
        grantRegister: { file: 'riverton_grant_register.csv', mapping: null },
        grantDrawdowns: { file: 'riverton_grant_drawdowns.csv', mapping: null },
        env: e,
    });
    assert.equal(result.stage, 'propose');
    assert.ok(result.grantRegister);
    assert.ok(result.grantDrawdowns);
    assert.equal(result.grantDrawdowns.file, 'riverton_grant_drawdowns.csv');
    assert.deepEqual(result.grantDrawdowns.missingRequired, []);
});
