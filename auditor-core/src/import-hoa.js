/**
 * Import a community association's own board-review exports into the canonical
 * HOA schema the three hoa-v1 controls run against.
 *
 * This is the HOA counterpart to the municipal importer (import-csv.js): it holds
 * the same promise — the numbers that come out are exactly the numbers that went
 * in, and the record says which file was read and how its columns were understood
 * — but it targets the HOA board-review warehouse. The genuinely shared parts
 * (the RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, ImportError) are reused from import-csv.js;
 * only the HOA-specific schema, field specs, coercers and loaders live here.
 *
 * A board's monthly review is three independent books, so an import is up to four
 * files:
 *   1. The reserve transfers — money moved between the operating and reserve
 *      accounts (the primary file; it builds the warehouse). A transfer OUT of
 *      reserve needs prior board approval on record (Civil Code s 5502).
 *   2. The budget lines — the adopted operating budget, one row per line per year.
 *   3. The operating expenses — spending charged to a budget line; budget-variance
 *      tots these up per line against the adopted budget.
 *   4. The assessments — owner dues; delinquent-assessments ages the unpaid ones.
 *
 * Unit-owner data never enters: the demo warehouse keeps a resident_pii table only
 * so the guard has something to refuse, but there is no mapping target for an
 * owner name, email or phone here, so an imported warehouse simply has no column
 * that could hold one. The controls identify owners by unit, line and transfer ID
 * only, and the copied allow-list lists only the four non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for municipal.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { HOA_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical HOA schema ──────────────────────────────────────────────────────
//
// The four tables the hoa-v1 ruleset reads, reproduced from the demo seed
// (sample_hoa_ledger.sql) minus the seed rows and minus resident_pii (unit-owner
// names, emails and phones), which the import never carries. Kept here, beside
// the importer, so the shape the loader writes and the shape the controls query
// are defined together.
export const HOA_SCHEMA_VERSION = 'hoa-canonical-v1';

export const HOA_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE reserve_transfers (
  transfer_id       TEXT PRIMARY KEY,
  transfer_date     TEXT NOT NULL,
  from_account      TEXT NOT NULL CHECK (from_account IN ('OPERATING', 'RESERVE')),
  to_account        TEXT NOT NULL CHECK (to_account IN ('OPERATING', 'RESERVE')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  board_approval_id TEXT,
  approval_date     TEXT
);

CREATE TABLE budget_lines (
  line_id       TEXT PRIMARY KEY,
  fiscal_year   INTEGER NOT NULL,
  category      TEXT NOT NULL,
  adopted_cents INTEGER NOT NULL CHECK (adopted_cents >= 0)
);

CREATE TABLE operating_expenses (
  expense_id   TEXT PRIMARY KEY,
  line_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  expense_date TEXT NOT NULL
);

CREATE TABLE assessments (
  assessment_id TEXT PRIMARY KEY,
  unit_id       TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_date     TEXT
);
`;

// ── mapping targets ─────────────────────────────────────────────────────────────
//
// The reserve transfers are the primary file: one row is one movement between the
// operating and reserve accounts. The accounts, the amount and the date are
// required; board_approval_id and approval_date are blank for a contribution INTO
// reserve (which needs no approval) and set for a transfer OUT; transfer_id is
// generated in file order when unmapped.
export const CANONICAL_HOA_TRANSFER_FIELDS = Object.freeze([
    { field: 'transfer_date', type: 'date', required: true,
      synonyms: ['transfer date', 'date', 'posted date', 'transaction date'],
      description: 'When the transfer was made.' },
    { field: 'from_account', type: 'text', required: true,
      synonyms: ['from account', 'from', 'source account', 'source'],
      description: 'The account the money came from: OPERATING or RESERVE.' },
    { field: 'to_account', type: 'text', required: true,
      synonyms: ['to account', 'to', 'destination account', 'destination'],
      description: 'The account the money went to: OPERATING or RESERVE.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'amount cents', 'transfer amount', 'value'],
      description: 'The transfer amount, coerced to integer cents.' },
    { field: 'board_approval_id', type: 'text', required: false,
      synonyms: ['board approval id', 'board approval', 'approval id', 'minutes reference', 'minutes ref', 'approval'],
      description: 'The approving board-minutes reference; required for a transfer OUT of reserve, blank for a contribution in.' },
    { field: 'approval_date', type: 'date', required: false,
      synonyms: ['approval date', 'approved date', 'date approved'],
      description: 'When the board approved the transfer (blank when there is no approval).' },
    { field: 'transfer_id', type: 'text', required: false,
      synonyms: ['transfer id', 'id', 'reference', 'ref'],
      description: "The association's own id for the transfer; generated (RT-0001…) in file order when unmapped." },
]);

// The budget lines: one row per adopted operating-budget line per fiscal year.
// line_id is the key operating expenses reconcile against, so it is taken from the
// file (never generated). There is no date to derive from, so fiscal_year is required.
export const CANONICAL_HOA_BUDGET_FIELDS = Object.freeze([
    { field: 'line_id', type: 'text', required: true,
      synonyms: ['line id', 'line', 'budget line', 'account code', 'account'],
      description: 'The budget line id (the key operating expenses reconcile against).' },
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'budget year'],
      description: 'The fiscal year the budget line belongs to.' },
    { field: 'category', type: 'text', required: true,
      synonyms: ['category', 'line category', 'budget category', 'name'],
      description: 'The budget category (e.g. Landscaping, Insurance, Utilities).' },
    { field: 'adopted_cents', type: 'money', required: true,
      synonyms: ['adopted', 'adopted budget', 'budget', 'adopted amount', 'appropriation'],
      description: 'The adopted budget for the line, coerced to integer cents.' },
]);

// The operating expenses: one row per expense charged to a budget line.
// expense_id is generated in file order when unmapped.
export const CANONICAL_HOA_EXPENSE_FIELDS = Object.freeze([
    { field: 'line_id', type: 'text', required: true,
      synonyms: ['line id', 'line', 'budget line', 'account code', 'account'],
      description: 'The budget line the expense is charged against.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'spent', 'expense', 'amount spent', 'cost'],
      description: 'The amount spent, coerced to integer cents.' },
    { field: 'expense_date', type: 'date', required: true,
      synonyms: ['expense date', 'date', 'paid date', 'transaction date'],
      description: 'When the expense was incurred.' },
    { field: 'expense_id', type: 'text', required: false,
      synonyms: ['expense id', 'id', 'voucher', 'reference', 'check number'],
      description: "The association's own id for the expense; generated (E-0001…) in file order when unmapped." },
]);

// The assessments: one row per owner assessment (HOA dues). paid_date is blank
// until the owner pays; a null aged past the threshold is a delinquency.
// assessment_id is generated in file order when unmapped.
export const CANONICAL_HOA_ASSESSMENT_FIELDS = Object.freeze([
    { field: 'unit_id', type: 'text', required: true,
      synonyms: ['unit id', 'unit', 'owner', 'unit number', 'account'],
      description: 'The unit the assessment is billed to.' },
    { field: 'due_date', type: 'date', required: true,
      synonyms: ['due date', 'date due', 'billing date', 'date'],
      description: 'When the assessment was due (the clock for aging).' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'assessment', 'dues', 'amount due', 'assessment amount'],
      description: 'The assessment amount, coerced to integer cents.' },
    { field: 'paid_date', type: 'date', required: false,
      synonyms: ['paid date', 'date paid', 'payment date'],
      description: 'When the owner paid; blank or unmapped means unpaid (NULL).' },
    { field: 'assessment_id', type: 'text', required: false,
      synonyms: ['assessment id', 'id', 'reference', 'invoice number'],
      description: "The association's own id for the assessment; generated (A-0001…) in file order when unmapped." },
]);

// ── HOA-specific coercion ─────────────────────────────────────────────────────

/** Coerce a fiscal year to a plausible integer, or throw. */
export function coerceFiscalYear(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty fiscal year');
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1900 || n > 2200) throw new ImportError(`not a fiscal year: "${raw}"`);
    return n;
}

/** Coerce an operating/reserve account name to OPERATING/RESERVE, or throw. */
export function coerceAccount(raw) {
    const s = String(raw).trim().toUpperCase();
    if (s === 'OPERATING' || s === 'RESERVE') return s;
    throw new ImportError(`unrecognised account: "${raw}" (expected OPERATING or RESERVE)`);
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

// ── reserve transfers: build the warehouse ───────────────────────────────────────

function coerceTransferRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            transferId: optionalId(cell, row, 'transfer_id', mapping, lineNo),
            transferDate: at('transfer_date', normalizeDate),
            fromAccount: at('from_account', coerceAccount),
            toAccount: at('to_account', coerceAccount),
            amountCents: at('amount_cents', coerceMoneyToCents),
            boardApprovalId: present(cell, row, 'board_approval_id', mapping) ? String(cell(row, 'board_approval_id')).trim() : null,
            approvalDate: present(cell, row, 'approval_date', mapping) ? at('approval_date', normalizeDate) : null,
        };
    });
}

function loadTransfers(db, records) {
    const ins = db.prepare(
        'INSERT INTO reserve_transfers (transfer_id, transfer_date, from_account, to_account, amount_cents, board_approval_id, approval_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    records.forEach((r, i) => {
        const id = r.transferId || `RT-${String(i + 1).padStart(4, '0')}`;
        if (seen.has(id)) throw new ImportError(`The reserve-transfers file lists transfer id "${id}" more than once.`);
        seen.add(id);
        ins.run(id, r.transferDate, r.fromAccount, r.toAccount, r.amountCents, r.boardApprovalId, r.approvalDate);
    });
    const outOfReserve = records.filter((r) => r.fromAccount === 'RESERVE').length;
    return { rowCount: records.length, outOfReserve };
}

/**
 * Build a canonical HOA warehouse database from a reserve-transfers CSV and a
 * confirmed mapping. Atomic: writes a temp database and renames on success, so an
 * aborted build (including a malformed value) never leaves a half-written
 * warehouse behind. Copies the bundled HOA allow-list beside it so the three
 * named queries are serveable immediately (the three companion books are applied after).
 */
export function buildHoaLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = HOA_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_HOA_TRANSFER_FIELDS);
    if (rows.length === 0) throw new ImportError('The reserve-transfers file has a header but no data rows.');
    const records = coerceTransferRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(HOA_SCHEMA_DDL);
            counts = loadTransfers(db, records);
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

// ── budget lines: apply onto the warehouse ────────────────────────────────────

function coerceBudgetRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            lineId: at('line_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty line id'); return s; }),
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            category: at('category', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty category'); return s; }),
            adoptedCents: at('adopted_cents', coerceMoneyToCents),
        };
    });
}

/**
 * Apply the budget lines onto an existing imported HOA warehouse, filling
 * budget_lines so budget-variance has the adopted budget per line. One
 * transaction; a malformed or duplicate row aborts it and leaves it untouched.
 */
export function applyBudgetLinesToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_HOA_BUDGET_FIELDS,
        coerce: coerceBudgetRows,
        noun: 'budget lines',
        idField: 'lineId', idPrefix: 'BL',
        dupLabel: (id) => `The budget lines file lists line id "${id}" more than once.`,
        insertSql: 'INSERT INTO budget_lines (line_id, fiscal_year, category, adopted_cents) VALUES (?, ?, ?, ?)',
        bind: (r, id) => [id, r.fiscalYear, r.category, r.adoptedCents],
        countKey: 'lines',
    });
}

// ── operating expenses: apply onto the warehouse ──────────────────────────────

function coerceExpenseRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            expenseId: optionalId(cell, row, 'expense_id', mapping, lineNo),
            lineId: at('line_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty line id'); return s; }),
            amountCents: at('amount_cents', coerceMoneyToCents),
            expenseDate: at('expense_date', normalizeDate),
        };
    });
}

/**
 * Apply the operating expenses onto an existing imported HOA warehouse, filling
 * operating_expenses so budget-variance can tot up spending per line. One
 * transaction; a malformed or duplicate row aborts it.
 */
export function applyOperatingExpensesToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_HOA_EXPENSE_FIELDS,
        coerce: coerceExpenseRows,
        noun: 'operating expenses',
        idField: 'expenseId', idPrefix: 'E',
        dupLabel: (id) => `The operating expenses file lists expense id "${id}" more than once.`,
        insertSql: 'INSERT INTO operating_expenses (expense_id, line_id, amount_cents, expense_date) VALUES (?, ?, ?, ?)',
        bind: (r, id) => [id, r.lineId, r.amountCents, r.expenseDate],
        countKey: 'expenses',
    });
}

// ── assessments: apply onto the warehouse ─────────────────────────────────────

function coerceAssessmentRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            assessmentId: optionalId(cell, row, 'assessment_id', mapping, lineNo),
            unitId: at('unit_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty unit id'); return s; }),
            dueDate: at('due_date', normalizeDate),
            amountCents: at('amount_cents', coerceMoneyToCents),
            paidDate: present(cell, row, 'paid_date', mapping) ? at('paid_date', normalizeDate) : null,
        };
    });
}

/**
 * Apply the assessments onto an existing imported HOA warehouse, filling
 * assessments so delinquent-assessments can age the unpaid ones. One transaction;
 * a malformed or duplicate row aborts it.
 */
export function applyAssessmentsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_HOA_ASSESSMENT_FIELDS,
        coerce: coerceAssessmentRows,
        noun: 'assessments',
        idField: 'assessmentId', idPrefix: 'A',
        dupLabel: (id) => `The assessments file lists assessment id "${id}" more than once.`,
        insertSql: 'INSERT INTO assessments (assessment_id, unit_id, due_date, amount_cents, paid_date) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.unitId, r.dueDate, r.amountCents, r.paidDate],
        countKey: 'assessments',
    });
}

// ── shared companion loader ───────────────────────────────────────────────────
//
// The three companion books (budget lines, operating expenses, assessments) share
// the same shape: parse, validate against the companion's field spec, coerce every
// row (naming the offending row/column on failure), reject a duplicate mapped id,
// then insert all rows in a single transaction that rolls back on any error. Only
// the schema, coercer, id prefix and insert differ, so the body lives here (the
// same move the schools and excise importers make for their registers).
function applyRegister({ csvPath, mapping, dbPath, fields, coerce, noun, idField, idPrefix, dupLabel, insertSql, bind, countKey }) {
    if (!existsSync(csvPath)) throw new ImportError(`${noun} not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported warehouse to apply the ${noun} to: ${dbPath}`);
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

// Re-export the shared mapping engine so callers can propose/validate HOA
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
