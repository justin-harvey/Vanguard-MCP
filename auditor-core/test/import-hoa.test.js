/**
 * M4 (hoa): a community association's own board-review exports import into the
 * canonical HOA schema and run the three hoa-v1 controls with clean integrity, the
 * same way the municipal importer does for an expenditure export.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/palmgrove_*.csv) are a fictional association's reserve
 * transfers, budget lines, operating expenses and assessments in a realistic
 * export shape (messy headers, $/comma money, MM/DD/YYYY dates, blank approval /
 * paid cells, and no expense-id column so the id-generation path is exercised).
 * They mirror the clean demo seed, so all three controls read pass: every reserve
 * transfer out is approved, every operating line is within its adopted budget, and
 * no unpaid assessment is aged past the 60-day default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    proposeMapping,
    coerceFiscalYear,
    coerceAccount,
    CANONICAL_HOA_TRANSFER_FIELDS,
    CANONICAL_HOA_BUDGET_FIELDS,
    CANONICAL_HOA_EXPENSE_FIELDS,
    CANONICAL_HOA_ASSESSMENT_FIELDS,
    ImportError,
} from '../src/import-hoa.js';
import { runHoaImport } from '../src/import-hoa-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const TRANSFERS = 'palmgrove_reserve_transfers.csv';
const BUDGET = 'palmgrove_budget_lines.csv';
const EXPENSES = 'palmgrove_operating_expenses.csv';
const ASSESSMENTS = 'palmgrove_assessments.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-hoa-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** All three companion mappings, proposed from their fixtures. */
function companionMappings() {
    return {
        budgetLines: { file: BUDGET, mapping: mappingFor(BUDGET, CANONICAL_HOA_BUDGET_FIELDS).mapping },
        operatingExpenses: { file: EXPENSES, mapping: mappingFor(EXPENSES, CANONICAL_HOA_EXPENSE_FIELDS).mapping },
        assessments: { file: ASSESSMENTS, mapping: mappingFor(ASSESSMENTS, CANONICAL_HOA_ASSESSMENT_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('fiscal years and accounts coerce and reject nonsense', () => {
    assert.equal(coerceFiscalYear('2026'), 2026);
    assert.throws(() => coerceFiscalYear('26'), ImportError);
    assert.equal(coerceAccount('reserve'), 'RESERVE');
    assert.equal(coerceAccount(' Operating '), 'OPERATING');
    assert.throws(() => coerceAccount('checking'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all four HOA files', () => {
    assert.deepEqual(mappingFor(TRANSFERS, CANONICAL_HOA_TRANSFER_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BUDGET, CANONICAL_HOA_BUDGET_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(EXPENSES, CANONICAL_HOA_EXPENSE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(ASSESSMENTS, CANONICAL_HOA_ASSESSMENT_FIELDS).missingRequired, []);

    const tr = mappingFor(TRANSFERS, CANONICAL_HOA_TRANSFER_FIELDS).mapping;
    assert.equal(tr.from_account, 'From Account');
    assert.equal(tr.to_account, 'To Account');
    assert.equal(tr.board_approval_id, 'Board Approval');

    // The operating-expenses export carries no expense-id column; it is generated.
    assert.ok(!('expense_id' in mappingFor(EXPENSES, CANONICAL_HOA_EXPENSE_FIELDS).mapping));
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runHoaImport({ file: TRANSFERS, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'hoa');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the three controls with clean integrity ───────

test('a real HOA export imports and all three controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(TRANSFERS, CANONICAL_HOA_TRANSFER_FIELDS).mapping;
    const result = await runHoaImport({ file: TRANSFERS, mapping, ...companionMappings(), env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'hoa');
    assert.deepEqual(result.counts, { rowCount: 2, outOfReserve: 1 });
    assert.equal(result.budgetLines.counts.lines, 3);
    assert.equal(result.operatingExpenses.counts.expenses, 5);
    assert.equal(result.assessments.counts.assessments, 4);

    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, TRANSFERS))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all three, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of ['reserve-transfers-unapproved', 'budget-variance', 'delinquent-assessments']) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + three companions + three queries = 7 entries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 7);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed HOA ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'hoa-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'hoa-canonical-v1');
});

// ── the numbers are exact, budgets hold, and no resident PII enters ────────────

test('money is exact, budgets hold, approvals are on record, and no resident records exist', async () => {
    const e = env();
    const mapping = mappingFor(TRANSFERS, CANONICAL_HOA_TRANSFER_FIELDS).mapping;
    const result = await runHoaImport({ file: TRANSFERS, mapping, ...companionMappings(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // The one transfer out of reserve cites an approval; the contribution in does not.
        const unapproved = db.prepare(
            "SELECT COUNT(*) AS n FROM reserve_transfers WHERE from_account = 'RESERVE' AND board_approval_id IS NULL",
        ).get();
        assert.equal(unapproved.n, 0);
        const intoReserve = db.prepare(
            "SELECT board_approval_id FROM reserve_transfers WHERE from_account = 'OPERATING' AND to_account = 'RESERVE'",
        ).get();
        assert.equal(intoReserve.board_approval_id, null); // blank cell → NULL, correctly not a finding

        // Paid spending per line stays within the adopted budget.
        const lines = db.prepare(`
            SELECT b.line_id, b.adopted_cents,
                   COALESCE((SELECT SUM(e.amount_cents) FROM operating_expenses e WHERE e.line_id = b.line_id), 0) AS spent
            FROM budget_lines b ORDER BY b.line_id`).all()
            .map((r) => ({ line_id: r.line_id, adopted: r.adopted_cents, spent: r.spent }));
        assert.deepEqual(lines, [
            { line_id: 'BL-1', adopted: 500000, spent: 450000 },
            { line_id: 'BL-2', adopted: 800000, spent: 800000 },
            { line_id: 'BL-3', adopted: 300000, spent: 250000 },
        ]);

        // Expense ids were generated in file order (no id column in the export).
        const genIds = db.prepare('SELECT expense_id FROM operating_expenses ORDER BY expense_id').all().map((r) => r.expense_id);
        assert.deepEqual(genIds, ['E-0001', 'E-0002', 'E-0003', 'E-0004', 'E-0005']);

        // Two unpaid assessments, neither aged past the 60-day default.
        const unpaid = db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE paid_date IS NULL').get();
        assert.equal(unpaid.n, 2);

        // No resident-PII table exists in an imported warehouse.
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['assessments', 'budget_lines', 'operating_expenses', 'reserve_transfers']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the four non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(Object.keys(allow.tables).sort(), ['assessments', 'budget_lines', 'operating_expenses', 'reserve_transfers']);
});

// ── malformed input aborts rather than corrupting the warehouse ────────────────

test('a malformed account aborts the import, naming the row', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-hoa-bad-')) });
    const bad = 'Transfer Date,From Account,To Account,Amount\n02/15/2026,savings,OPERATING,"$1,000.00"\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = { transfer_date: 'Transfer Date', from_account: 'From Account', to_account: 'To Account', amount_cents: 'Amount' };
    await assert.rejects(
        () => runHoaImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*From Account.*account/.test(err.message),
    );
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-hoa-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=hoa proposes then imports transfers + companions with a clean gate', async () => {
    await withImportEnv(async () => {
        const proposal = await callTool('propose_csv_mapping', {
            file: TRANSFERS,
            pack: 'hoa',
            companions: {
                budgetLines: { file: BUDGET }, operatingExpenses: { file: EXPENSES }, assessments: { file: ASSESSMENTS },
            },
        });
        assert.equal(proposal.pack, 'hoa');
        assert.deepEqual(proposal.missingRequired, []);
        assert.deepEqual(proposal.budgetLines.missingRequired, []);
        assert.deepEqual(proposal.assessments.missingRequired, []);

        const out = await callTool('import_csv', {
            file: TRANSFERS,
            pack: 'hoa',
            mapping: proposal.mapping,
            companions: {
                budgetLines: { file: BUDGET, mapping: proposal.budgetLines.mapping },
                operatingExpenses: { file: EXPENSES, mapping: proposal.operatingExpenses.mapping },
                assessments: { file: ASSESSMENTS, mapping: proposal.assessments.mapping },
            },
        });
        assert.equal(out.pack, 'hoa');
        assert.equal(out.counts.rowCount, 2);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
