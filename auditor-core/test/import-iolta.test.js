/**
 * M4 (iolta): a law firm's own client-trust (IOLTA) CSV export imports into the
 * canonical IOLTA schema and runs the five iolta-v1 controls with clean
 * integrity, the same way the municipal importer does for an expenditure export.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/northfield_*.csv) are an anonymized, fictional law
 * firm's trust journal, bank snapshots and fee invoices in a realistic
 * trust-accounting export shape. They mirror the clean demo seed, so all five
 * controls read pass and the three-way reconciliation ties to $5,700.00.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    proposeMapping,
    coerceEntryType,
    coerceClearedStatus,
    CANONICAL_IOLTA_JOURNAL_FIELDS,
    CANONICAL_IOLTA_BANK_FIELDS,
    CANONICAL_IOLTA_INVOICE_FIELDS,
    ImportError,
} from '../src/import-iolta.js';
import { runIoltaImport } from '../src/import-iolta-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { listTools, callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const JOURNAL = join(FIXTURE_DIR, 'northfield_trust_journal.csv');
const BANK = 'northfield_bank_snapshots.csv';
const INVOICES = 'northfield_fee_invoices.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-iolta-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

// ── coercion units ──────────────────────────────────────────────────────────

test('entry types coerce to the four canonical kinds and reject nonsense', () => {
    assert.equal(coerceEntryType('Client Deposit'), 'CLIENT_DEPOSIT');
    assert.equal(coerceEntryType('deposit'), 'CLIENT_DEPOSIT');
    assert.equal(coerceEntryType('Disbursement'), 'CLIENT_DISBURSEMENT');
    assert.equal(coerceEntryType('Earned Fee Transfer'), 'EARNED_FEE_TRANSFER');
    assert.equal(coerceEntryType('Firm Buffer'), 'FIRM_BUFFER_IN');
    assert.equal(coerceEntryType('FIRM_BUFFER_IN'), 'FIRM_BUFFER_IN');
    assert.throws(() => coerceEntryType('journal entry'), ImportError);
    assert.throws(() => coerceEntryType(''), ImportError);
});

test('cleared status coerces and defaults to CLEARED when blank', () => {
    assert.equal(coerceClearedStatus('Cleared'), 'CLEARED');
    assert.equal(coerceClearedStatus('outstanding'), 'OUTSTANDING');
    assert.equal(coerceClearedStatus('uncleared'), 'OUTSTANDING');
    assert.equal(coerceClearedStatus(''), 'CLEARED');
    assert.throws(() => coerceClearedStatus('bounced'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all three IOLTA files', () => {
    assert.deepEqual(mappingFor('northfield_trust_journal.csv', CANONICAL_IOLTA_JOURNAL_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BANK, CANONICAL_IOLTA_BANK_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(INVOICES, CANONICAL_IOLTA_INVOICE_FIELDS).missingRequired, []);
    const j = mappingFor('northfield_trust_journal.csv', CANONICAL_IOLTA_JOURNAL_FIELDS).mapping;
    assert.equal(j.entry_type, 'Transaction Type');
    assert.equal(j.amount, 'Amount');
    assert.equal(j.cleared_status, 'Bank Status');
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runIoltaImport({ file: 'northfield_trust_journal.csv', mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'iolta');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the five controls with clean integrity ────────

test('a real IOLTA export imports and all five controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor('northfield_trust_journal.csv', CANONICAL_IOLTA_JOURNAL_FIELDS).mapping;
    const bankMapping = mappingFor(BANK, CANONICAL_IOLTA_BANK_FIELDS).mapping;
    const invoicesMapping = mappingFor(INVOICES, CANONICAL_IOLTA_INVOICE_FIELDS).mapping;

    const result = await runIoltaImport({
        file: 'northfield_trust_journal.csv',
        mapping,
        bankSnapshots: { file: BANK, mapping: bankMapping },
        feeInvoices: { file: INVOICES, mapping: invoicesMapping },
        env: e,
    });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'iolta');
    assert.deepEqual(result.counts, { rowCount: 8, clients: 4 });
    assert.equal(result.bankSnapshots.counts.snapshots, 2);
    assert.equal(result.feeInvoices.counts.invoices, 2);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(JOURNAL)).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all five, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of [
        'three-way-reconciliation', 'negative-client-balances',
        'unsupported-fee-transfers', 'firm-funds-in-trust', 'dormant-balances',
    ]) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
    }
    assert.equal(byName['negative-client-balances'].findings, 0);
    assert.equal(byName['unsupported-fee-transfers'].findings, 0);
    assert.equal(byName['firm-funds-in-trust'].findings, 0);
    assert.equal(byName['dormant-balances'].findings, 0);

    // The audit chain is intact: import + bank + invoices + five attested queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 8);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed IOLTA ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'iolta-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the IOLTA schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'iolta-canonical-v1');
});

// ── the numbers are exact, and no client PII enters the ledger ─────────────────

test('money is exact and the three-way reconciliation ties to the cent', async () => {
    const e = env();
    const mapping = mappingFor('northfield_trust_journal.csv', CANONICAL_IOLTA_JOURNAL_FIELDS).mapping;
    const bankMapping = mappingFor(BANK, CANONICAL_IOLTA_BANK_FIELDS).mapping;
    const invoicesMapping = mappingFor(INVOICES, CANONICAL_IOLTA_INVOICE_FIELDS).mapping;
    const result = await runIoltaImport({
        file: 'northfield_trust_journal.csv', mapping,
        bankSnapshots: { file: BANK, mapping: bankMapping },
        feeInvoices: { file: INVOICES, mapping: invoicesMapping }, env: e,
    });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Signed journal balance (deposits/firm buffer add; disbursements/fee transfers subtract).
        const journal = db.prepare(
            "SELECT SUM(CASE WHEN entry_type IN ('CLIENT_DEPOSIT','FIRM_BUFFER_IN') THEN amount_cents ELSE -amount_cents END) AS bal FROM trust_journal",
        ).get();
        assert.equal(journal.bal, 570_000); // $5,700.00

        // Adjusted bank from the latest snapshot: $6,200 − $500 outstanding = $5,700.
        const bank = db.prepare(
            'SELECT bank_statement_balance_cents + deposits_in_transit_cents - outstanding_checks_cents AS adj FROM trust_bank_snapshots ORDER BY snapshot_date DESC LIMIT 1',
        ).get();
        assert.equal(bank.adj, 570_000);

        // The outstanding disbursement is preserved as OUTSTANDING.
        const outstanding = db.prepare("SELECT COUNT(*) AS n FROM trust_journal WHERE cleared_status = 'OUTSTANDING'").get();
        assert.equal(outstanding.n, 1);

        // No client-PII table exists in an imported ledger: the import has no
        // column that could hold a name, email or address.
        const hasContacts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_contacts'").get();
        assert.equal(hasContacts, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['fee_invoices', 'trust_bank_snapshots', 'trust_journal']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the three non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(Object.keys(allow.tables).sort(), ['fee_invoices', 'trust_bank_snapshots', 'trust_journal']);
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a malformed entry type aborts the import, naming the row', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-iolta-bad-')) });
    const bad = 'Entry ID,Date,Client ID,Transaction Type,Amount\nX-1,02/10/2026,C-1,Mystery Move,"$5,000.00"\n';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = { entry_id: 'Entry ID', entry_date: 'Date', client_id: 'Client ID', entry_type: 'Transaction Type', amount: 'Amount' };
    await assert.rejects(
        () => runIoltaImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Transaction Type.*unrecognised entry type/.test(err.message),
    );
    // Nothing partial was left behind.
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-iolta-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=iolta proposes then imports a trust journal with a clean gate', async () => {
    await withImportEnv(async () => {
        const proposal = await callTool('propose_csv_mapping', {
            file: 'northfield_trust_journal.csv', pack: 'iolta', bankFile: BANK, invoicesFile: INVOICES,
        });
        assert.equal(proposal.pack, 'iolta');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.entry_type, 'Transaction Type');
        assert.deepEqual(proposal.bankSnapshots.missingRequired, []);
        assert.deepEqual(proposal.feeInvoices.missingRequired, []);

        const out = await callTool('import_csv', {
            file: 'northfield_trust_journal.csv', pack: 'iolta', mapping: proposal.mapping,
            bankFile: BANK, bankMapping: proposal.bankSnapshots.mapping,
            invoicesFile: INVOICES, invoicesMapping: proposal.feeInvoices.mapping,
        });
        assert.equal(out.pack, 'iolta');
        assert.equal(out.counts.rowCount, 8);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
