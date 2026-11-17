/**
 * S8 import gate: a buyer's expenditure CSV imports into the canonical schema
 * and runs the three named queries with clean integrity.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from a temp/committed import folder (CIVIC_IMPORT_DIR). The committed
 * fixture (test/fixtures/riverton_expenditures.csv) is an anonymized, fictional
 * town expenditure export in a realistic open-checkbook shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    parseCsv,
    proposeMapping,
    coerceMoneyToCents,
    normalizeDate,
    fiscalYearOf,
    coerceStatus,
    buildLedgerFromCsv,
    ImportError,
} from '../src/import-csv.js';
import { resolveImportPath, importDir, ImportPathError } from '../src/paths.js';
import { runImport } from '../src/import.js';
import { verify } from '../src/audit.js';
import { listTools, callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const FIXTURE = join(FIXTURE_DIR, 'riverton_expenditures.csv');

/** A fresh env that reads the committed fixtures folder and writes to a temp data dir. */
function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-import-data-')), CIVIC_IMPORT_DIR: importDir };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('money coerces to exact integer cents, never a float', () => {
    assert.equal(coerceMoneyToCents('$21,780.00'), 2_178_000);
    assert.equal(coerceMoneyToCents('6,325.00'), 632_500);
    assert.equal(coerceMoneyToCents('$6,840.00'), 684_000);
    assert.equal(coerceMoneyToCents('500'), 50_000);
    assert.equal(coerceMoneyToCents('12.5'), 1_250);
    assert.equal(coerceMoneyToCents('0.07'), 7);
    assert.equal(coerceMoneyToCents('(250.00)'), -25_000);
    assert.equal(coerceMoneyToCents('-10.01'), -1_001);
    // The classic float trap: 0.1 + 0.2 handled exactly as cents.
    assert.equal(coerceMoneyToCents('0.10') + coerceMoneyToCents('0.20'), 30);
    assert.throws(() => coerceMoneyToCents('twelve'), ImportError);
    assert.throws(() => coerceMoneyToCents('1.234'), ImportError); // too many decimals
    assert.throws(() => coerceMoneyToCents(''), ImportError);
});

test('dates normalise to ISO and reject nonsense', () => {
    assert.equal(normalizeDate('04/15/2026'), '2026-04-15');
    assert.equal(normalizeDate('2026-6-3'), '2026-06-03');
    assert.equal(normalizeDate('2026/12/31'), '2026-12-31');
    assert.throws(() => normalizeDate('2026-13-01'), ImportError);
    assert.throws(() => normalizeDate('02/30/2026'), ImportError);
    assert.throws(() => normalizeDate('not a date'), ImportError);
});

test('fiscal year runs July–June', () => {
    assert.equal(fiscalYearOf('2025-07-01'), 2026);
    assert.equal(fiscalYearOf('2026-06-30'), 2026);
    assert.equal(fiscalYearOf('2026-07-01'), 2027);
});

test('status maps to the canonical set or is refused', () => {
    assert.equal(coerceStatus('Paid'), 'paid');
    assert.equal(coerceStatus('VOID'), 'void');
    assert.equal(coerceStatus('outstanding'), 'pending');
    assert.equal(coerceStatus(''), 'paid');
    assert.throws(() => coerceStatus('refunded?'), ImportError);
});

// ── CSV parsing ─────────────────────────────────────────────────────────────

test('CSV parser handles quotes, embedded commas and CRLF', () => {
    const text = 'a,b,c\r\n1,"two, and a half","he said ""hi"""\r\n';
    const { headers, rows } = parseCsv(text);
    assert.deepEqual(headers, ['a', 'b', 'c']);
    assert.deepEqual(rows, [['1', 'two, and a half', 'he said "hi"']]);
});

test('a ragged row is an error, not a silent drop', () => {
    assert.throws(() => parseCsv('a,b,c\n1,2\n'), ImportError);
});

// ── mapping proposal ────────────────────────────────────────────────────────

test('the proposed mapping covers the fixture with no required field unmapped', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const { headers, rows } = parseCsv(text);
    const proposal = proposeMapping(headers, rows.slice(0, 5));
    assert.deepEqual(proposal.missingRequired, []);
    assert.equal(proposal.mapping.invoice_date, 'Payment Date');
    assert.equal(proposal.mapping.vendor_name, 'Vendor Name');
    assert.equal(proposal.mapping.amount, 'Amount');
    assert.equal(proposal.mapping.status, 'Payment Status');
    assert.equal(proposal.mapping.budget_amount, 'Line Budget');
    assert.equal(proposal.mapping.account_code, 'Account Code');
    assert.equal(proposal.mapping.line_description, 'Account Description');
});

// ── path confinement ────────────────────────────────────────────────────────

test('a path outside the import folder is refused', () => {
    const e = env();
    assert.throws(() => resolveImportPath('../secrets.csv', { env: e }), ImportPathError);
    assert.throws(() => resolveImportPath('/etc/passwd', { env: e }), ImportPathError);
    assert.throws(() => resolveImportPath('a/../../b.csv', { env: e }), ImportPathError);
    // A plain name inside the folder resolves.
    assert.equal(resolveImportPath('riverton_expenditures.csv', { env: e }), FIXTURE);
});

test('with no import folder configured, resolution is refused', () => {
    assert.throws(() => resolveImportPath('x.csv', { env: { CIVIC_DATA_DIR: '/tmp' } }), ImportPathError);
    assert.equal(importDir({ env: {} }), null);
});

test('runImport refuses a file outside the import folder before opening anything', async () => {
    await assert.rejects(() => runImport({ file: '../x.csv', mapping: { amount: 'a' }, env: env() }), ImportPathError);
});

// ── malformed data aborts the build atomically ───────────────────────────────

test('a malformed money value aborts the import and writes no ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-import-bad-'));
    const csv = join(dir, 'bad.csv');
    writeFileSync(csv, 'Date,Vendor,Amount\n04/15/2026,Acme,$100.00\n05/01/2026,Beta,not-a-number\n');
    const dbPath = join(dir, 'ledger.db');
    assert.throws(
        () => buildLedgerFromCsv({ csvPath: csv, mapping: { invoice_date: 'Date', vendor_name: 'Vendor', amount: 'Amount' }, dbPath }),
        /Row 3.*not a money amount/,
    );
    assert.ok(!existsSync(dbPath), 'no ledger file left behind');
    assert.ok(!existsSync(`${dbPath}.building-${process.pid}`), 'no temp file left behind');
});

// ── the gate: real import runs the three queries with clean integrity ─────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runImport({ file: 'riverton_expenditures.csv', mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.deepEqual(r.missingRequired, []);
    // Nothing was written into the data dir.
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

test('a real expenditure CSV imports and all three named queries pass integrity', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(FIXTURE, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const result = await runImport({ file: 'riverton_expenditures.csv', mapping, env: e });

    assert.equal(result.stage, 'imported');
    assert.deepEqual(result.counts, {
        rowCount: 12, vendors: 6, departments: 3, funds: 3, budgetLines: 4, grants: 0,
    });

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all three.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    assert.equal(byName['grant-status'].integrity, 'pass');
    assert.equal(byName['grant-status'].rowCount, 0); // a flat export carries no grant ledger
    assert.equal(byName['spending-by-vendor'].integrity, 'pass');
    assert.equal(byName['budget-variance'].integrity, 'pass');
    // Winter salt overspends its amended budget: an audit finding, not an integrity fault.
    assert.equal(byName['budget-variance'].findings, 1);

    // The audit chain is intact: one import entry then three attested queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 4);
    assert.equal(result.audit.seq, 0);

    // S9: the import runs under the signed Civic-Chain ruleset, and the import
    // entry ties the data (dataHash) to the ruleset version (rulesetHash).
    assert.equal(result.ruleset.version, 'municipal-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);
    // The three gate queries each recorded the same ruleset + data hashes.
    const queryEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[1]);
    assert.equal(queryEntry.rulesetHash, result.ruleset.contentHash);
    assert.equal(queryEntry.dataHash, expectHash);
    assert.equal(queryEntry.ruleset.status, 'signed');

    // The confirmed mapping was persisted.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'municipal-v1');
});

test('money and void handling are exact in the imported ledger', async () => {
    const e = env();
    const { headers, rows } = parseCsv(readFileSync(FIXTURE, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const result = await runImport({ file: 'riverton_expenditures.csv', mapping, env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Granite Ridge Salt: three paid invoices, exact to the cent.
        const salt = db
            .prepare(
                "SELECT v.vendor_name, COUNT(*) AS n, SUM(e.amount_cents) AS cents FROM expenditures e " +
                    "JOIN vendors v ON v.vendor_id = e.vendor_id WHERE e.status = 'paid' AND v.vendor_name = ? GROUP BY v.vendor_id",
            )
            .get('Granite Ridge Salt Supply');
        assert.equal(salt.n, 3);
        assert.equal(salt.cents, 1_964_000);

        // The voided parks invoice is present but excluded from paid spend.
        const voided = db.prepare("SELECT COUNT(*) AS n FROM expenditures WHERE status = 'void'").get();
        assert.equal(voided.n, 1);
        const paidTotal = db.prepare("SELECT SUM(amount_cents) AS c FROM expenditures WHERE status = 'paid'").get();
        assert.equal(paidTotal.c, 6_872_000);

        // Dates normalised to ISO.
        const anyDate = db.prepare('SELECT invoice_date FROM expenditures LIMIT 1').get();
        assert.match(anyDate.invoice_date, /^\d{4}-\d{2}-\d{2}$/);
    } finally {
        db.close();
    }
});

// ── MCP surface ───────────────────────────────────────────────────────────

/** Run fn with CIVIC_IMPORT_DIR / CIVIC_DATA_DIR set in process.env (importTools reads it), restoring after. */
async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-import-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('the import tools appear only when an import folder is configured', () => {
    assert.ok(!listTools().some((t) => t.name === 'import_csv'), 'absent without CIVIC_IMPORT_DIR');
});

test('over MCP: propose_csv_mapping reads and suggests; import_csv imports with clean gate', async () => {
    await withImportEnv(async () => {
        const names = listTools().map((t) => t.name);
        assert.ok(names.includes('propose_csv_mapping'));
        assert.ok(names.includes('import_csv'));

        const proposal = await callTool('propose_csv_mapping', { file: 'riverton_expenditures.csv' });
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.amount, 'Amount');

        const out = await callTool('import_csv', { file: 'riverton_expenditures.csv', mapping: proposal.mapping });
        assert.equal(out.counts.rowCount, 12);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});

test('over MCP: import_csv refuses a file outside the import folder', async () => {
    await withImportEnv(async () => {
        await assert.rejects(
            () => callTool('import_csv', { file: '../../etc/passwd', mapping: { amount: 'x' } }),
            ImportPathError,
        );
    });
});

test('re-importing the same file is reproducible: identical source hash and counts', async () => {
    const { headers, rows } = parseCsv(readFileSync(FIXTURE, 'utf8'));
    const { mapping } = proposeMapping(headers, rows);
    const a = await runImport({ file: 'riverton_expenditures.csv', mapping, env: env() });
    const b = await runImport({ file: 'riverton_expenditures.csv', mapping, env: env() });
    assert.equal(a.sourceFileSha256, b.sourceFileSha256);
    assert.deepEqual(a.counts, b.counts);
});
