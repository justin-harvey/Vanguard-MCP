/**
 * M4 (schools): a school district's own activity-fund, federal-program and budget
 * exports import into the canonical schools schema and run the five schools-v1
 * controls with clean integrity, the same way the municipal importer does for an
 * expenditure export.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/kvrsu_*.csv) are a fictional district's activity
 * collections, accounts, disbursements, federal programs and costs, budget lines
 * and expenditures in a realistic export shape (messy headers, $/comma money,
 * MM/DD/YYYY dates, Yes/Yes approvals, and no fiscal-year columns on the dated
 * files so the derivation path is exercised). They mirror the clean demo seed, so
 * all five controls read pass, every activity account is in the black, and paid
 * spending stays inside each amended budget line.
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
    coerceApproval,
    buildSchoolsLedgerFromCsv,
    applyBudgetLinesToLedger,
    applyActivityDisbursementsToLedger,
    CANONICAL_SCHOOLS_COLLECTION_FIELDS,
    CANONICAL_SCHOOLS_ACCOUNT_FIELDS,
    CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS,
    CANONICAL_SCHOOLS_PROGRAM_FIELDS,
    CANONICAL_SCHOOLS_COST_FIELDS,
    CANONICAL_SCHOOLS_BUDGET_FIELDS,
    CANONICAL_SCHOOLS_EXPENDITURE_FIELDS,
    ImportError,
} from '../src/import-schools.js';
import { runSchoolsImport } from '../src/import-schools-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const COLLECTIONS = 'kvrsu_collections.csv';
const ACCOUNTS = 'kvrsu_activity_accounts.csv';
const DISBURSEMENTS = 'kvrsu_disbursements.csv';
const PROGRAMS = 'kvrsu_federal_programs.csv';
const COSTS = 'kvrsu_federal_costs.csv';
const BUDGET = 'kvrsu_budget_lines.csv';
const EXPENDITURES = 'kvrsu_expenditures.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-schools-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** All six companion mappings, proposed from their fixtures. */
function companionMappings() {
    return {
        accounts: { file: ACCOUNTS, mapping: mappingFor(ACCOUNTS, CANONICAL_SCHOOLS_ACCOUNT_FIELDS).mapping },
        disbursements: { file: DISBURSEMENTS, mapping: mappingFor(DISBURSEMENTS, CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS).mapping },
        programs: { file: PROGRAMS, mapping: mappingFor(PROGRAMS, CANONICAL_SCHOOLS_PROGRAM_FIELDS).mapping },
        costs: { file: COSTS, mapping: mappingFor(COSTS, CANONICAL_SCHOOLS_COST_FIELDS).mapping },
        budgetLines: { file: BUDGET, mapping: mappingFor(BUDGET, CANONICAL_SCHOOLS_BUDGET_FIELDS).mapping },
        expenditures: { file: EXPENDITURES, mapping: mappingFor(EXPENDITURES, CANONICAL_SCHOOLS_EXPENDITURE_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('fiscal years coerce to plausible integers and reject nonsense', () => {
    assert.equal(coerceFiscalYear('2026'), 2026);
    assert.equal(coerceFiscalYear(' 2025 '), 2025);
    assert.throws(() => coerceFiscalYear('26'), ImportError);
    assert.throws(() => coerceFiscalYear('two thousand'), ImportError);
    assert.throws(() => coerceFiscalYear(''), ImportError);
});

test('approval flags coerce to 1/0 and reject ambiguous values', () => {
    assert.equal(coerceApproval('Yes'), 1);
    assert.equal(coerceApproval('1'), 1);
    assert.equal(coerceApproval('TRUE'), 1);
    assert.equal(coerceApproval('No'), 0);
    assert.equal(coerceApproval('0'), 0);
    assert.equal(coerceApproval(''), 0); // blank = not on record
    assert.throws(() => coerceApproval('maybe'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all seven schools files', () => {
    assert.deepEqual(mappingFor(COLLECTIONS, CANONICAL_SCHOOLS_COLLECTION_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(ACCOUNTS, CANONICAL_SCHOOLS_ACCOUNT_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(DISBURSEMENTS, CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(PROGRAMS, CANONICAL_SCHOOLS_PROGRAM_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(COSTS, CANONICAL_SCHOOLS_COST_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BUDGET, CANONICAL_SCHOOLS_BUDGET_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(EXPENDITURES, CANONICAL_SCHOOLS_EXPENDITURE_FIELDS).missingRequired, []);

    const col = mappingFor(COLLECTIONS, CANONICAL_SCHOOLS_COLLECTION_FIELDS).mapping;
    assert.equal(col.account_id, 'Account');
    assert.equal(col.amount_cents, 'Amount Collected');
    assert.equal(col.collected_date, 'Date Collected');
    assert.equal(col.deposited_date, 'Date Deposited');
    // The collections export carries no fiscal-year column; it is derived from the date.
    assert.ok(!('fiscal_year' in col));

    const dis = mappingFor(DISBURSEMENTS, CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS).mapping;
    assert.equal(dis.advisor_approved, 'Advisor Approved');
    assert.equal(dis.principal_approved, 'Principal Approved');

    // The accounts export carries no fund-class column; it defaults to CUSTODIAL.
    assert.ok(!('fund_class' in mappingFor(ACCOUNTS, CANONICAL_SCHOOLS_ACCOUNT_FIELDS).mapping));
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runSchoolsImport({ file: COLLECTIONS, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'schools');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the five controls with clean integrity ────────

test('a real schools export imports and all five controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(COLLECTIONS, CANONICAL_SCHOOLS_COLLECTION_FIELDS).mapping;
    const companions = companionMappings();

    const result = await runSchoolsImport({ file: COLLECTIONS, mapping, ...companions, env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'schools');
    assert.deepEqual(result.counts, { rowCount: 4, accounts: 3, collectedCents: 780000 });
    assert.equal(result.accounts.counts.accounts, 3);
    assert.equal(result.disbursements.counts.disbursements, 3);
    assert.equal(result.programs.counts.programs, 2);
    assert.equal(result.costs.counts.costs, 3);
    assert.equal(result.budgetLines.counts.lines, 3);
    assert.equal(result.expenditures.counts.expenditures, 4);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, COLLECTIONS))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all five, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of [
        'activity-negative-balances', 'activity-deposits-late', 'activity-unapproved-disbursements',
        'federal-outside-period', 'budget-variance',
    ]) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + six companions + five queries = 12 entries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 12);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed schools ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'schools-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the schools schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'schools-canonical-v1');
});

// ── the numbers are exact, derivations hold, and no student PII enters ─────────

test('money is exact, fiscal year derives, balances tie, and no student records exist', async () => {
    const e = env();
    const mapping = mappingFor(COLLECTIONS, CANONICAL_SCHOOLS_COLLECTION_FIELDS).mapping;
    const result = await runSchoolsImport({ file: COLLECTIONS, mapping, ...companionMappings(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Collections per account, summed from the primary file.
        const perAccount = db.prepare(
            'SELECT account_id, SUM(amount_cents) AS c FROM activity_collections GROUP BY account_id ORDER BY account_id',
        ).all().map((r) => ({ account_id: r.account_id, c: r.c }));
        assert.deepEqual(perAccount, [
            { account_id: 'ACT-ATH', c: 250000 },
            { account_id: 'ACT-DRAMA', c: 230000 },
            { account_id: 'ACT-SENIOR', c: 300000 },
        ]);

        // The fiscal year was derived from the collected date (no FY column in the file).
        const fy = db.prepare("SELECT DISTINCT fiscal_year FROM activity_collections").all().map((r) => r.fiscal_year);
        assert.deepEqual(fy, [2026]);

        // Every collection was deposited the day it was collected (no late deposit).
        const anyLate = db.prepare(
            "SELECT COUNT(*) AS n FROM activity_collections WHERE deposited_date IS NULL OR deposited_date <> collected_date",
        ).get();
        assert.equal(anyLate.n, 0);

        // Activity-account balances are all in the black (collections cover disbursements).
        const balances = db.prepare(`
            SELECT a.account_id,
                   (SELECT COALESCE(SUM(amount_cents),0) FROM activity_collections WHERE account_id = a.account_id)
                 - (SELECT COALESCE(SUM(amount_cents),0) FROM activity_disbursements WHERE account_id = a.account_id) AS bal
            FROM activity_accounts a ORDER BY a.account_id`).all().map((r) => ({ account_id: r.account_id, bal: r.bal }));
        assert.deepEqual(balances, [
            { account_id: 'ACT-ATH', bal: 100000 },
            { account_id: 'ACT-DRAMA', bal: 110000 },
            { account_id: 'ACT-SENIOR', bal: 100000 },
        ]);

        // Both approvals present on every disbursement (coerced Yes → 1).
        const unapproved = db.prepare(
            'SELECT COUNT(*) AS n FROM activity_disbursements WHERE advisor_approved = 0 OR principal_approved = 0',
        ).get();
        assert.equal(unapproved.n, 0);

        // Every federal cost is inside its program's period of performance.
        const outside = db.prepare(`
            SELECT COUNT(*) AS n FROM federal_costs fc JOIN federal_programs p ON p.program_id = fc.program_id
            WHERE fc.charge_date < p.period_start OR fc.charge_date > p.period_end`).get();
        assert.equal(outside.n, 0);

        // Paid spending per line stays within the amended budget.
        const lines = db.prepare(`
            SELECT b.line_id, b.amended_cents,
                   COALESCE((SELECT SUM(amount_cents) FROM expenditures e WHERE e.line_id = b.line_id AND e.status = 'paid'), 0) AS paid
            FROM budget_lines b ORDER BY b.line_id`).all()
            .map((r) => ({ line_id: r.line_id, amended: r.amended_cents, paid: r.paid }));
        assert.deepEqual(lines, [
            { line_id: 'BL-INSTR', amended: 5500000, paid: 4800000 },
            { line_id: 'BL-PLANT', amended: 2200000, paid: 2100000 },
            { line_id: 'BL-TRANS', amended: 3000000, paid: 2900000 },
        ]);

        // No student-PII table exists in an imported ledger: the import has no
        // column that could hold a student name, grade level or meal eligibility.
        const hasStudents = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='student_records'").get();
        assert.equal(hasStudents, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, [
            'activity_accounts', 'activity_collections', 'activity_disbursements',
            'budget_lines', 'expenditures', 'federal_costs', 'federal_programs',
        ]);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the seven non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(Object.keys(allow.tables).sort(), [
        'activity_accounts', 'activity_collections', 'activity_disbursements',
        'budget_lines', 'expenditures', 'federal_costs', 'federal_programs',
    ]);
});

// ── defaults: unmapped amended budget and unmapped approvals ────────────────────

test('amended budget defaults to adopted, and an unmapped approval column defaults to not-approved', async () => {
    const e = env();
    const mapping = mappingFor(COLLECTIONS, CANONICAL_SCHOOLS_COLLECTION_FIELDS).mapping;
    const result = await runSchoolsImport({ file: COLLECTIONS, mapping, env: e, runGate: false });

    // The apply fns take an absolute csvPath (path-confinement is the runner's job),
    // so the inline CSVs go in a scratch dir — never the committed fixtures folder.
    const scratch = mkdtempSync(join(tmpdir(), 'cc-schools-scratch-'));

    // A budget line file with no Amended column: amended should fall back to adopted.
    const budgetCsv = 'Line ID,FY,Fund,Function,Object,Description,Adopted\nBL-X,2026,1000,1000,0610,Supplies,"$10,000.00"\n';
    writeFileSync(join(scratch, 'bl.csv'), budgetCsv);
    const budgetMap = mappingFor2(budgetCsv, CANONICAL_SCHOOLS_BUDGET_FIELDS);
    assert.ok(!('amended_cents' in budgetMap));
    applyBudgetLinesToLedger({ csvPath: join(scratch, 'bl.csv'), mapping: budgetMap, dbPath: result.paths.dbPath });

    // A disbursements file with no approval columns: both approvals default to 0.
    const disCsv = 'Account,Amount,Date Paid\nACT-DRAMA,"$100.00",03/20/2026\n';
    writeFileSync(join(scratch, 'dis.csv'), disCsv);
    const disMap = mappingFor2(disCsv, CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS);
    assert.ok(!('advisor_approved' in disMap) && !('principal_approved' in disMap));
    applyActivityDisbursementsToLedger({ csvPath: join(scratch, 'dis.csv'), mapping: disMap, dbPath: result.paths.dbPath });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        const bl = db.prepare("SELECT adopted_cents, amended_cents FROM budget_lines WHERE line_id = 'BL-X'").get();
        assert.equal(bl.adopted_cents, 1000000);
        assert.equal(bl.amended_cents, 1000000); // defaulted to adopted
        const dis = db.prepare("SELECT advisor_approved, principal_approved FROM activity_disbursements WHERE disbursement_id = 'DIS-0001'").get();
        assert.equal(dis.advisor_approved, 0);
        assert.equal(dis.principal_approved, 0);
    } finally {
        db.close();
    }
});

/** Propose a mapping from raw CSV text (for inline fixtures). */
function mappingFor2(text, specs) {
    const { headers, rows } = parseCsv(text);
    return proposeMapping(headers, rows, specs).mapping;
}

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a malformed money value aborts the import, naming the row', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-schools-bad-')) });
    const bad = 'Account,Amount Collected,Date Collected\nACT-DRAMA,lots,03/02/2026\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = { account_id: 'Account', amount_cents: 'Amount Collected', collected_date: 'Date Collected' };
    await assert.rejects(
        () => runSchoolsImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Amount Collected.*money amount/.test(err.message),
    );
    // Nothing partial was left behind.
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-schools-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=schools proposes then imports collections + companions with a clean gate', async () => {
    await withImportEnv(async () => {
        const proposal = await callTool('propose_csv_mapping', {
            file: COLLECTIONS,
            pack: 'schools',
            companions: {
                accounts: { file: ACCOUNTS }, disbursements: { file: DISBURSEMENTS },
                programs: { file: PROGRAMS }, costs: { file: COSTS },
                budgetLines: { file: BUDGET }, expenditures: { file: EXPENDITURES },
            },
        });
        assert.equal(proposal.pack, 'schools');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.amount_cents, 'Amount Collected');
        assert.deepEqual(proposal.accounts.missingRequired, []);
        assert.deepEqual(proposal.budgetLines.missingRequired, []);
        assert.deepEqual(proposal.expenditures.missingRequired, []);

        const out = await callTool('import_csv', {
            file: COLLECTIONS,
            pack: 'schools',
            mapping: proposal.mapping,
            companions: {
                accounts: { file: ACCOUNTS, mapping: proposal.accounts.mapping },
                disbursements: { file: DISBURSEMENTS, mapping: proposal.disbursements.mapping },
                programs: { file: PROGRAMS, mapping: proposal.programs.mapping },
                costs: { file: COSTS, mapping: proposal.costs.mapping },
                budgetLines: { file: BUDGET, mapping: proposal.budgetLines.mapping },
                expenditures: { file: EXPENDITURES, mapping: proposal.expenditures.mapping },
            },
        });
        assert.equal(out.pack, 'schools');
        assert.equal(out.counts.rowCount, 4);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
