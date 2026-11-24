/**
 * Import a school district's own activity-fund, federal-program and budget
 * exports into the canonical schools schema the five schools-v1 controls run
 * against.
 *
 * This is the schools counterpart to the municipal importer (import-csv.js): it
 * holds the same promise — the numbers that come out are exactly the numbers
 * that went in, and the record says which file was read and how its columns were
 * understood — but it targets a different warehouse. The genuinely shared parts
 * (the RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, the fiscal-year helper and the paid/pending
 * status coercer, ImportError) are reused from import-csv.js; only the
 * schools-specific schema, field specs, coercers and loaders live here.
 *
 * A district's books are three reconciliations, so an import is up to seven files:
 *   1. The activity collections — cash taken into a student activity account (the
 *      primary file; it builds the ledger). The collected/deposited gap is the
 *      classic activity-fund loss point the deposits-late control measures.
 *   2. The activity accounts — the custodial accounts the district holds for the
 *      student groups (GASB 84). A dimension the negative-balance control iterates.
 *   3. The activity disbursements — money paid out, each carrying (or missing) the
 *      advisor and principal approval the unapproved-disbursements control reads.
 *   4. The federal programs — each award's period of performance (2 CFR 200).
 *   5. The federal costs — costs charged to a program, tested against its period.
 *   6. The budget lines — the adopted/amended budget (Maine DOE Fund/Function/Object).
 *   7. The expenditures — paid/pending spending the budget-variance control tots up.
 *
 * Student-level data never enters: the demo warehouse keeps a student_records
 * table only so the guard has something to refuse, but there is no mapping target
 * for a student name, grade level or meal-eligibility status here, so an imported
 * ledger simply has no column that could hold one. The controls identify
 * accounts, programs and budget lines by code only, and the copied allow-list
 * lists only the seven non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for municipal.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { SCHOOLS_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    fiscalYearOf,
    coerceStatus,
    ImportError,
} from './import-csv.js';

// ── canonical schools schema ──────────────────────────────────────────────────
//
// The seven tables the schools-v1 ruleset reads, reproduced from the demo seed
// (sample_schools_ledger.sql) minus the seed rows and minus student_records
// (student names, grade levels and meal-eligibility status, all protected under
// FERPA, which the import never carries). Kept here, beside the importer, so the
// shape the loader writes and the shape the controls query are defined together.
export const SCHOOLS_SCHEMA_VERSION = 'schools-canonical-v1';

export const SCHOOLS_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE activity_accounts (
  account_id    TEXT PRIMARY KEY,
  account_name  TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  fund_class    TEXT NOT NULL
);

CREATE TABLE activity_collections (
  collection_id  TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  collected_date TEXT NOT NULL,
  deposited_date TEXT
);

CREATE TABLE activity_disbursements (
  disbursement_id    TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  fiscal_year        INTEGER NOT NULL,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  disbursement_date  TEXT NOT NULL,
  advisor_approved   INTEGER NOT NULL,
  principal_approved INTEGER NOT NULL
);

CREATE TABLE federal_programs (
  program_id   TEXT PRIMARY KEY,
  program_name TEXT NOT NULL,
  cfda_number  TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL
);

CREATE TABLE federal_costs (
  cost_id      TEXT PRIMARY KEY,
  program_id   TEXT NOT NULL,
  fiscal_year  INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  charge_date  TEXT NOT NULL
);

CREATE TABLE budget_lines (
  line_id          TEXT PRIMARY KEY,
  fiscal_year      INTEGER NOT NULL,
  fund_code        TEXT NOT NULL,
  function_code    TEXT NOT NULL,
  object_code      TEXT NOT NULL,
  line_description TEXT NOT NULL,
  adopted_cents    INTEGER NOT NULL,
  amended_cents    INTEGER NOT NULL
);

CREATE TABLE expenditures (
  expenditure_id TEXT PRIMARY KEY,
  line_id        TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL
);
`;

// ── mapping targets ─────────────────────────────────────────────────────────────
//
// The activity collections file is the primary file: one row is one deposit of
// cash into a student activity account — the inflow that creates the custodial
// obligation, and whose deposit gap the deposits-late control measures. Only the
// account, the amount and the collected date are required to produce a usable
// ledger. The fiscal year is derived from the collected date (July–June) when
// unmapped or blank, so a plain collections export imports cleanly; the deposited
// date is optional (blank or unmapped means not yet deposited, i.e. NULL); the
// collection_id is generated in file order when unmapped.
export const CANONICAL_SCHOOLS_COLLECTION_FIELDS = Object.freeze([
    { field: 'account_id', type: 'text', required: true,
      synonyms: ['account id', 'activity account', 'account', 'fund', 'club account', 'account code'],
      description: 'The student activity account the cash was collected into.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'amount collected', 'collected', 'cash', 'receipt amount', 'total', 'deposit amount'],
      description: 'The amount collected, coerced to integer cents (so $1,500.00 becomes 150000).' },
    { field: 'collected_date', type: 'date', required: true,
      synonyms: ['collected date', 'date collected', 'collection date', 'date', 'received date', 'date received'],
      description: 'When the cash was taken in (the start of the deposit-exposure window).' },
    { field: 'deposited_date', type: 'date', required: false,
      synonyms: ['deposited date', 'date deposited', 'deposit date', 'bank date', 'date to bank'],
      description: 'When the cash reached the bank; blank or unmapped means not yet deposited (NULL).' },
    { field: 'fiscal_year', type: 'integer', required: false,
      synonyms: ['fiscal year', 'fy', 'year', 'school year'],
      description: 'The fiscal year (July–June); derived from the collected date when blank or unmapped.' },
    { field: 'collection_id', type: 'text', required: false,
      synonyms: ['collection id', 'id', 'receipt id', 'reference', 'deposit slip', 'receipt number'],
      description: "The district's own id for the collection; generated (COL-0001…) in file order when unmapped." },
]);

// The activity accounts: one row per custodial account the district holds for a
// student group (GASB 84 fiduciary funds). activity_type defaults to CLUB and
// fund_class to CUSTODIAL when unmapped. account_id is the key the collections
// and disbursements reconcile against, so it is taken from the file (never generated).
export const CANONICAL_SCHOOLS_ACCOUNT_FIELDS = Object.freeze([
    { field: 'account_id', type: 'text', required: true,
      synonyms: ['account id', 'activity account', 'account', 'fund', 'club account', 'account code'],
      description: 'The activity account id (the key collections and disbursements reconcile against).' },
    { field: 'account_name', type: 'text', required: true,
      synonyms: ['account name', 'name', 'club', 'group', 'activity name', 'description'],
      description: 'The name of the student group or class (e.g. Drama Club, Senior Class).' },
    { field: 'activity_type', type: 'text', required: false,
      synonyms: ['activity type', 'type', 'group type', 'category'],
      description: 'The kind of group — CLUB, CLASS or ATHLETIC (defaults to CLUB).' },
    { field: 'fund_class', type: 'text', required: false,
      synonyms: ['fund class', 'fund type', 'class', 'classification'],
      description: 'The GASB 84 fund classification (defaults to CUSTODIAL).' },
]);

// The activity disbursements: one row per payment out of an activity account.
// advisor_approved and principal_approved are the two required sign-offs; both
// default to 0 (not on record) when unmapped or blank, so an export that omits an
// approval column surfaces as unapproved rather than being silently waved through.
export const CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS = Object.freeze([
    { field: 'account_id', type: 'text', required: true,
      synonyms: ['account id', 'activity account', 'account', 'fund', 'club account', 'account code'],
      description: 'The activity account the money was paid out of.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'disbursed', 'payment', 'check amount', 'total', 'amount paid'],
      description: 'The amount disbursed, coerced to integer cents.' },
    { field: 'disbursement_date', type: 'date', required: true,
      synonyms: ['disbursement date', 'date paid', 'paid date', 'check date', 'payment date', 'date'],
      description: 'When the disbursement was made.' },
    { field: 'advisor_approved', type: 'flag', required: false,
      synonyms: ['advisor approved', 'advisor', 'advisor signoff', 'advisor sign off', 'advisor approval'],
      description: 'Whether the advisor approval is on record (yes/no, 1/0); defaults to no when unmapped.' },
    { field: 'principal_approved', type: 'flag', required: false,
      synonyms: ['principal approved', 'principal', 'principal signoff', 'principal sign off', 'principal approval'],
      description: 'Whether the principal approval is on record (yes/no, 1/0); defaults to no when unmapped.' },
    { field: 'fiscal_year', type: 'integer', required: false,
      synonyms: ['fiscal year', 'fy', 'year', 'school year'],
      description: 'The fiscal year (July–June); derived from the disbursement date when blank or unmapped.' },
    { field: 'disbursement_id', type: 'text', required: false,
      synonyms: ['disbursement id', 'id', 'check number', 'check no', 'voucher', 'reference'],
      description: "The district's own id for the disbursement; generated (DIS-0001…) in file order when unmapped." },
]);

// The federal programs: one row per award, with its period of performance. The
// period-of-performance control reads period_start/period_end. program_id is the
// key the costs reconcile against, so it is taken from the file (never generated);
// cfda_number defaults to 'N/A' when unmapped.
export const CANONICAL_SCHOOLS_PROGRAM_FIELDS = Object.freeze([
    { field: 'program_id', type: 'text', required: true,
      synonyms: ['program id', 'id', 'award id', 'grant id', 'program code'],
      description: 'The federal program id (the key the costs reconcile against).' },
    { field: 'program_name', type: 'text', required: true,
      synonyms: ['program name', 'name', 'program', 'award', 'grant name', 'title'],
      description: 'The program name (e.g. Title I-A Improving Basic Programs).' },
    { field: 'period_start', type: 'date', required: true,
      synonyms: ['period start', 'start date', 'start', 'period of performance start', 'award start', 'begin date'],
      description: "The award's period-of-performance start date (2 CFR 200)." },
    { field: 'period_end', type: 'date', required: true,
      synonyms: ['period end', 'end date', 'end', 'period of performance end', 'award end', 'expiration'],
      description: "The award's period-of-performance end date (2 CFR 200)." },
    { field: 'cfda_number', type: 'text', required: false,
      synonyms: ['cfda', 'cfda number', 'assistance listing', 'al number', 'cfda no'],
      description: 'The Assistance Listing (CFDA) number (defaults to N/A when unmapped).' },
]);

// The federal costs: one row per cost charged to a program. charge_date is tested
// against the program's period. The fiscal year is derived from the charge date
// (July–June) when unmapped; cost_id is generated in file order when unmapped.
export const CANONICAL_SCHOOLS_COST_FIELDS = Object.freeze([
    { field: 'program_id', type: 'text', required: true,
      synonyms: ['program id', 'id', 'award id', 'grant id', 'program code'],
      description: 'The federal program the cost was charged to.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'cost', 'charge', 'amount charged', 'expenditure', 'total'],
      description: 'The amount charged to the program, coerced to integer cents.' },
    { field: 'charge_date', type: 'date', required: true,
      synonyms: ['charge date', 'date charged', 'posted date', 'transaction date', 'date'],
      description: 'When the cost was charged (tested against the award period of performance).' },
    { field: 'fiscal_year', type: 'integer', required: false,
      synonyms: ['fiscal year', 'fy', 'year', 'school year'],
      description: 'The fiscal year (July–June); derived from the charge date when blank or unmapped.' },
    { field: 'cost_id', type: 'text', required: false,
      synonyms: ['cost id', 'id', 'transaction id', 'reference', 'voucher'],
      description: "The district's own id for the cost; generated (FCOST-0001…) in file order when unmapped." },
]);

// The budget lines: one row per adopted/amended budget line on the Maine DOE
// Fund/Function/Object chart of accounts. amended_cents defaults to adopted_cents
// when unmapped (no amendment); line_description defaults to empty. There is no
// date to derive from, so fiscal_year is required. line_id is the key expenditures
// reconcile against, so it is taken from the file (never generated).
export const CANONICAL_SCHOOLS_BUDGET_FIELDS = Object.freeze([
    { field: 'line_id', type: 'text', required: true,
      synonyms: ['line id', 'id', 'budget line', 'line', 'account', 'account code'],
      description: 'The budget line id (the key expenditures reconcile against).' },
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'school year'],
      description: 'The fiscal year (July–June) the budget line belongs to.' },
    { field: 'fund_code', type: 'text', required: true,
      synonyms: ['fund code', 'fund', 'fund no'],
      description: 'The fund code (e.g. 1000 General Fund).' },
    { field: 'function_code', type: 'text', required: true,
      synonyms: ['function code', 'function', 'function no'],
      description: 'The function code (e.g. 1000 Instruction, 2700 Student Transportation).' },
    { field: 'object_code', type: 'text', required: true,
      synonyms: ['object code', 'object', 'object no'],
      description: 'The object code (e.g. 0610 General Supplies).' },
    { field: 'adopted_cents', type: 'money', required: true,
      synonyms: ['adopted', 'adopted budget', 'original budget', 'adopted amount', 'budget'],
      description: 'The adopted budget for the line, coerced to integer cents.' },
    { field: 'amended_cents', type: 'money', required: false,
      synonyms: ['amended', 'amended budget', 'revised budget', 'current budget', 'amended amount'],
      description: 'The amended budget; defaults to the adopted amount when unmapped or blank.' },
    { field: 'line_description', type: 'text', required: false,
      synonyms: ['description', 'line description', 'account description', 'name'],
      description: 'A human description of the line (defaults to empty).' },
]);

// The expenditures: one row per expenditure against a budget line. status defaults
// to paid when unmapped; the variance control compares paid spending to the amended
// budget. There is no date to derive from, so fiscal_year is required. expenditure_id
// is generated in file order when unmapped.
export const CANONICAL_SCHOOLS_EXPENDITURE_FIELDS = Object.freeze([
    { field: 'line_id', type: 'text', required: true,
      synonyms: ['line id', 'id', 'budget line', 'line', 'account', 'account code'],
      description: 'The budget line the expenditure is charged against.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'spent', 'expenditure', 'paid', 'cost', 'total'],
      description: 'The amount spent, coerced to integer cents.' },
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'school year'],
      description: 'The fiscal year (July–June) the expenditure belongs to.' },
    { field: 'status', type: 'text', required: false,
      synonyms: ['status', 'state', 'paid status'],
      description: 'paid or pending (defaults to paid); only paid spending counts against the budget.' },
    { field: 'expenditure_id', type: 'text', required: false,
      synonyms: ['expenditure id', 'id', 'voucher', 'reference', 'transaction id', 'check number'],
      description: "The district's own id for the expenditure; generated (EXP-0001…) in file order when unmapped." },
]);

// ── schools-specific coercion ─────────────────────────────────────────────────

/** Coerce a fiscal year to a plausible integer, or throw. */
export function coerceFiscalYear(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty fiscal year');
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1900 || n > 2200) throw new ImportError(`not a fiscal year: "${raw}"`);
    return n;
}

const APPROVAL_TRUE = new Set(['1', 'y', 'yes', 'true', 't', 'approved', 'signed', 'on record', 'on file', 'x']);
const APPROVAL_FALSE = new Set(['', '0', 'n', 'no', 'false', 'f', 'missing', 'none', 'not approved', 'unapproved']);

/** Coerce an approval flag to 1/0 (blank → 0, not on record), or throw on anything ambiguous. */
export function coerceApproval(raw) {
    const s = String(raw).trim().toLowerCase();
    if (APPROVAL_TRUE.has(s)) return 1;
    if (APPROVAL_FALSE.has(s)) return 0;
    throw new ImportError(`unrecognised approval flag: "${raw}" (expected yes/no or 1/0)`);
}

/** Trim an activity type and upper-case it; blank defaults to CLUB. */
function coerceActivityType(raw) {
    const s = String(raw).trim();
    return s === '' ? 'CLUB' : s.toUpperCase();
}

/** Trim a fund class and upper-case it; blank defaults to CUSTODIAL. */
function coerceFundClass(raw) {
    const s = String(raw).trim();
    return s === '' ? 'CUSTODIAL' : s.toUpperCase();
}

/** Trim a CFDA / Assistance Listing number; blank defaults to N/A. */
function coerceCfda(raw) {
    const s = String(raw).trim();
    return s === '' ? 'N/A' : s;
}

/** Build a field→column-index lookup and a safe cell reader for a confirmed mapping. */
function cellReader(headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    return (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));
}

/** A per-row coercer that names the row and column in any ImportError it raises. */
function rowCoercer(cell, row, lineNo, mapping) {
    return (field, fn) => {
        try { return fn(String(cell(row, field))); }
        catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
    };
}

/** Read an optional text cell: null when unmapped, else the trimmed value (required non-empty when mapped). */
function optionalId(cell, row, field, mapping, lineNo) {
    if (!(field in mapping)) return null;
    const v = String(cell(row, field)).trim();
    if (v === '') throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": empty ${field.replace(/_/g, ' ')}`);
    return v;
}

/** True when a field is mapped and its cell is non-empty on this row. */
function present(cell, row, field, mapping) {
    return field in mapping && String(cell(row, field)).trim() !== '';
}

// ── activity collections: build the ledger ──────────────────────────────────────

function coerceCollectionRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = rowCoercer(cell, row, lineNo, mapping);
        const collectedDate = at('collected_date', normalizeDate);
        return {
            lineNo,
            collectionId: optionalId(cell, row, 'collection_id', mapping, lineNo),
            accountId: at('account_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty account id'); return s; }),
            amountCents: at('amount_cents', coerceMoneyToCents),
            collectedDate,
            depositedDate: present(cell, row, 'deposited_date', mapping) ? at('deposited_date', normalizeDate) : null,
            fiscalYear: present(cell, row, 'fiscal_year', mapping) ? at('fiscal_year', coerceFiscalYear) : fiscalYearOf(collectedDate),
        };
    });
}

function loadCollections(db, records) {
    const ins = db.prepare(
        'INSERT INTO activity_collections (collection_id, account_id, fiscal_year, amount_cents, collected_date, deposited_date) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    records.forEach((r, i) => {
        const id = r.collectionId || `COL-${String(i + 1).padStart(4, '0')}`;
        if (seen.has(id)) throw new ImportError(`The collections file lists collection id "${id}" more than once.`);
        seen.add(id);
        ins.run(id, r.accountId, r.fiscalYear, r.amountCents, r.collectedDate, r.depositedDate);
    });
    const accounts = new Set(records.map((r) => r.accountId));
    const collectedCents = records.reduce((sum, r) => sum + r.amountCents, 0);
    return { rowCount: records.length, accounts: accounts.size, collectedCents };
}

/**
 * Build a canonical schools ledger database from an activity-collections CSV and a
 * confirmed mapping. Atomic: writes a temp database and renames on success, so an
 * aborted build (including a malformed value) never leaves a half-written ledger
 * behind. Copies the bundled schools allow-list beside it so the five named
 * queries are serveable immediately (the six companion registers are applied after).
 */
export function buildSchoolsLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = SCHOOLS_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_SCHOOLS_COLLECTION_FIELDS);
    if (rows.length === 0) throw new ImportError('The activity-collections file has a header but no data rows.');
    const records = coerceCollectionRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(SCHOOLS_SCHEMA_DDL);
            counts = loadCollections(db, records);
        } finally {
            db.close();
        }
        renameSync(tmp, dbPath);
    } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }

    if (allowlistPath) {
        ensureParent(allowlistPath);
        writeFileSync(allowlistPath, readFileSync(allowlistSource));
    }

    return { dbPath, allowlistPath, sourceFileSha256, byteLength: bytes.length, counts, mapping: { ...mapping } };
}

// ── activity accounts: apply onto the ledger ──────────────────────────────────

function coerceAccountRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            accountId: at('account_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty account id'); return s; }),
            accountName: at('account_name', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty account name'); return s; }),
            activityType: 'activity_type' in mapping ? at('activity_type', coerceActivityType) : 'CLUB',
            fundClass: 'fund_class' in mapping ? at('fund_class', coerceFundClass) : 'CUSTODIAL',
        };
    });
}

/**
 * Apply the activity accounts onto an existing imported schools ledger, filling
 * activity_accounts so activity-negative-balances has an account to iterate. One
 * transaction; a malformed or duplicate row aborts it and leaves the ledger untouched.
 */
export function applyActivityAccountsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_ACCOUNT_FIELDS,
        coerce: coerceAccountRows,
        noun: 'activity accounts',
        idField: 'accountId', idPrefix: 'ACT',
        dupLabel: (id) => `The activity accounts file lists account id "${id}" more than once.`,
        insertSql: 'INSERT INTO activity_accounts (account_id, account_name, activity_type, fund_class) VALUES (?, ?, ?, ?)',
        bind: (r, id) => [id, r.accountName, r.activityType, r.fundClass],
        countKey: 'accounts',
    });
}

// ── activity disbursements: apply onto the ledger ─────────────────────────────

function coerceDisbursementRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        const disbursementDate = at('disbursement_date', normalizeDate);
        return {
            lineNo,
            disbursementId: optionalId(cell, row, 'disbursement_id', mapping, lineNo),
            accountId: at('account_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty account id'); return s; }),
            amountCents: at('amount_cents', coerceMoneyToCents),
            disbursementDate,
            advisorApproved: 'advisor_approved' in mapping ? at('advisor_approved', coerceApproval) : 0,
            principalApproved: 'principal_approved' in mapping ? at('principal_approved', coerceApproval) : 0,
            fiscalYear: present(cell, row, 'fiscal_year', mapping) ? at('fiscal_year', coerceFiscalYear) : fiscalYearOf(disbursementDate),
        };
    });
}

/**
 * Apply the activity disbursements onto an existing imported schools ledger,
 * filling activity_disbursements so activity-negative-balances and
 * activity-unapproved-disbursements can read payments and their approvals. One
 * transaction; a malformed or duplicate row aborts it.
 */
export function applyActivityDisbursementsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_DISBURSEMENT_FIELDS,
        coerce: coerceDisbursementRows,
        noun: 'activity disbursements',
        idField: 'disbursementId', idPrefix: 'DIS',
        dupLabel: (id) => `The activity disbursements file lists disbursement id "${id}" more than once.`,
        insertSql: 'INSERT INTO activity_disbursements (disbursement_id, account_id, fiscal_year, amount_cents, disbursement_date, advisor_approved, principal_approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.accountId, r.fiscalYear, r.amountCents, r.disbursementDate, r.advisorApproved, r.principalApproved],
        countKey: 'disbursements',
    });
}

// ── federal programs: apply onto the ledger ───────────────────────────────────

function coerceProgramRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            programId: at('program_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty program id'); return s; }),
            programName: at('program_name', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty program name'); return s; }),
            cfdaNumber: 'cfda_number' in mapping ? at('cfda_number', coerceCfda) : 'N/A',
            periodStart: at('period_start', normalizeDate),
            periodEnd: at('period_end', normalizeDate),
        };
    });
}

/**
 * Apply the federal programs onto an existing imported schools ledger, filling
 * federal_programs so federal-outside-period has each award's period of
 * performance to test costs against. One transaction; malformed or duplicate rows
 * abort it.
 */
export function applyFederalProgramsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_PROGRAM_FIELDS,
        coerce: coerceProgramRows,
        noun: 'federal programs',
        idField: 'programId', idPrefix: 'FP',
        dupLabel: (id) => `The federal programs file lists program id "${id}" more than once.`,
        insertSql: 'INSERT INTO federal_programs (program_id, program_name, cfda_number, period_start, period_end) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.programName, r.cfdaNumber, r.periodStart, r.periodEnd],
        countKey: 'programs',
    });
}

// ── federal costs: apply onto the ledger ──────────────────────────────────────

function coerceCostRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        const chargeDate = at('charge_date', normalizeDate);
        return {
            lineNo,
            costId: optionalId(cell, row, 'cost_id', mapping, lineNo),
            programId: at('program_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty program id'); return s; }),
            amountCents: at('amount_cents', coerceMoneyToCents),
            chargeDate,
            fiscalYear: present(cell, row, 'fiscal_year', mapping) ? at('fiscal_year', coerceFiscalYear) : fiscalYearOf(chargeDate),
        };
    });
}

/**
 * Apply the federal costs onto an existing imported schools ledger, filling
 * federal_costs so federal-outside-period can test each charge against its
 * program's period. One transaction; malformed or duplicate rows abort it.
 */
export function applyFederalCostsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_COST_FIELDS,
        coerce: coerceCostRows,
        noun: 'federal costs',
        idField: 'costId', idPrefix: 'FCOST',
        dupLabel: (id) => `The federal costs file lists cost id "${id}" more than once.`,
        insertSql: 'INSERT INTO federal_costs (cost_id, program_id, fiscal_year, amount_cents, charge_date) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.programId, r.fiscalYear, r.amountCents, r.chargeDate],
        countKey: 'costs',
    });
}

// ── budget lines: apply onto the ledger ───────────────────────────────────────

function coerceBudgetRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        const adoptedCents = at('adopted_cents', coerceMoneyToCents);
        return {
            lineNo,
            lineId: at('line_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty line id'); return s; }),
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            fundCode: at('fund_code', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty fund code'); return s; }),
            functionCode: at('function_code', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty function code'); return s; }),
            objectCode: at('object_code', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty object code'); return s; }),
            lineDescription: 'line_description' in mapping ? String(cell(row, 'line_description')).trim() : '',
            adoptedCents,
            amendedCents: present(cell, row, 'amended_cents', mapping) ? at('amended_cents', coerceMoneyToCents) : adoptedCents,
        };
    });
}

/**
 * Apply the budget lines onto an existing imported schools ledger, filling
 * budget_lines so budget-variance has the adopted/amended budget per line. One
 * transaction; malformed or duplicate rows abort it.
 */
export function applyBudgetLinesToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_BUDGET_FIELDS,
        coerce: coerceBudgetRows,
        noun: 'budget lines',
        idField: 'lineId', idPrefix: 'BL',
        dupLabel: (id) => `The budget lines file lists line id "${id}" more than once.`,
        insertSql: 'INSERT INTO budget_lines (line_id, fiscal_year, fund_code, function_code, object_code, line_description, adopted_cents, amended_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.fiscalYear, r.fundCode, r.functionCode, r.objectCode, r.lineDescription, r.adoptedCents, r.amendedCents],
        countKey: 'lines',
    });
}

// ── expenditures: apply onto the ledger ───────────────────────────────────────

function coerceExpenditureRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            expenditureId: optionalId(cell, row, 'expenditure_id', mapping, lineNo),
            lineId: at('line_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty line id'); return s; }),
            amountCents: at('amount_cents', coerceMoneyToCents),
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            status: 'status' in mapping ? at('status', coerceStatus) : 'paid',
        };
    });
}

/**
 * Apply the expenditures onto an existing imported schools ledger, filling
 * expenditures so budget-variance can tot up paid spending per line. One
 * transaction; malformed or duplicate rows abort it.
 */
export function applyExpendituresToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_SCHOOLS_EXPENDITURE_FIELDS,
        coerce: coerceExpenditureRows,
        noun: 'expenditures',
        idField: 'expenditureId', idPrefix: 'EXP',
        dupLabel: (id) => `The expenditures file lists expenditure id "${id}" more than once.`,
        insertSql: 'INSERT INTO expenditures (expenditure_id, line_id, fiscal_year, amount_cents, status) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.lineId, r.fiscalYear, r.amountCents, r.status],
        countKey: 'expenditures',
    });
}

// ── shared companion loader ───────────────────────────────────────────────────
//
// The six companion registers (activity accounts, disbursements, federal programs,
// federal costs, budget lines, expenditures) share the same shape: parse, validate
// against the companion's field spec, coerce every row (naming the offending
// row/column on failure), reject a duplicate mapped id, then insert all rows in a
// single transaction that rolls back on any error. Only the schema, coercer, id
// prefix and insert differ, so the body lives here (the same move the excise
// importer makes for its three period-keyed registers).
function applyRegister({ csvPath, mapping, dbPath, fields, coerce, noun, idField, idPrefix, dupLabel, insertSql, bind, countKey }) {
    if (!existsSync(csvPath)) throw new ImportError(`${noun} not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the ${noun} to: ${dbPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, fields);
    if (rows.length === 0) throw new ImportError(`The ${noun} file has a header but no data rows.`);
    const records = coerce(rows, headers, mapping);

    const seen = new Set();
    for (const rec of records) {
        const id = rec[idField];
        if (!id) continue;
        if (seen.has(id)) throw new ImportError(dupLabel(id));
        seen.add(id);
    }

    const db = new DatabaseSync(dbPath);
    try {
        const insert = db.prepare(insertSql);
        let inserted = 0;
        db.exec('BEGIN');
        try {
            records.forEach((rec, i) => {
                const id = rec[idField] || `${idPrefix}-${String(i + 1).padStart(4, '0')}`;
                insert.run(...bind(rec, id));
                inserted += 1;
            });
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { sourceFileSha256, byteLength: bytes.length, counts: { [countKey]: records.length, inserted } };
    } finally {
        db.close();
    }
}

// Re-export the shared mapping engine so callers can propose/validate schools
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
