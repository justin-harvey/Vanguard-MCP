/**
 * Import a buyer's expenditure CSV into the canonical municipal schema.
 *
 * The promise of the whole engine is that every figure is reproducible and
 * every answer carries provenance. An import has to earn that same standard:
 * the numbers that come out of the buyer's spreadsheet must be exactly the
 * numbers that went in, and the record must say exactly which file was read and
 * how its columns were understood. So the importer does three things and
 * nothing clever:
 *
 *   1. Parses the CSV itself (a small RFC-4180 reader, no new dependency), so
 *      quoting, embedded commas and newlines are handled the same way a
 *      spreadsheet exports them, and a ragged row is an error, not a guess.
 *   2. Coerces money to *integer cents* (never a float) and dates to ISO, and
 *      refuses a malformed value rather than silently turning it into 0 or
 *      null. An auditor cannot trust a total that quietly dropped a row.
 *   3. Builds a Canonical Municipal Schema v1 database (the same shape the three
 *      named queries target) with the derived dimension rows the expenditures
 *      reference, so grant-status, spending-by-vendor and budget-variance run
 *      against it unchanged.
 *
 * The agent proposes a column mapping (proposeMapping); the human confirms it;
 * only the confirmed mapping is written. The source file's SHA-256, its byte
 * length, the row count and the confirmed mapping are what the caller records as
 * an audit entry (see import.js), so a reader can tie any later figure back to
 * the exact bytes it came from.
 *
 * This module is Node-bound (node:fs + node:sqlite) but holds no policy about
 * *where* files may be read from: path confinement to the import folder lives in
 * paths.js (resolveImportPath) and is applied by the callers (import.js, mcp.js).
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { MUNICIPAL_ALLOWLIST_PATH, ensureParent } from './paths.js';

export class ImportError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ImportError';
    }
}

/** The schema this importer targets. S9 will formalise and sign this version. */
export const CANONICAL_SCHEMA_VERSION = 'municipal-v1';

// ── canonical schema v1 ─────────────────────────────────────────────────────
//
// The same tables as the bundled municipal demo, minus its sample data. Kept
// here as the one explicit definition of the import target so the importer does
// not depend on parsing the demo's seed file. The gate test proves it stays
// compatible with the allow-list by running all three named queries against it.
const SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE funds (
  fund_id   TEXT PRIMARY KEY,
  fund_name TEXT NOT NULL,
  fund_type TEXT NOT NULL
);

CREATE TABLE departments (
  dept_id   TEXT PRIMARY KEY,
  dept_name TEXT NOT NULL
);

CREATE TABLE vendors (
  vendor_id            TEXT PRIMARY KEY,
  vendor_name          TEXT NOT NULL,
  category             TEXT NOT NULL,
  tax_id               TEXT NOT NULL,
  remit_account_last4  TEXT NOT NULL
);

CREATE TABLE grants (
  grant_id              TEXT PRIMARY KEY,
  grant_name            TEXT NOT NULL,
  grantor               TEXT NOT NULL,
  grantor_type          TEXT NOT NULL CHECK (grantor_type IN ('federal', 'state', 'county', 'private')),
  fund_id               TEXT NOT NULL REFERENCES funds(fund_id),
  dept_id               TEXT NOT NULL REFERENCES departments(dept_id),
  award_cents           INTEGER NOT NULL,
  match_required_cents  INTEGER NOT NULL,
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'closed'))
);

CREATE TABLE budget_lines (
  line_id           TEXT PRIMARY KEY,
  fiscal_year       INTEGER NOT NULL,
  dept_id           TEXT NOT NULL REFERENCES departments(dept_id),
  fund_id           TEXT NOT NULL REFERENCES funds(fund_id),
  account_code      TEXT NOT NULL,
  line_description  TEXT NOT NULL,
  adopted_cents     INTEGER NOT NULL,
  amended_cents     INTEGER NOT NULL
);

CREATE TABLE expenditures (
  expenditure_id  TEXT PRIMARY KEY,
  fiscal_year     INTEGER NOT NULL,
  line_id         TEXT NOT NULL REFERENCES budget_lines(line_id),
  grant_id        TEXT REFERENCES grants(grant_id),
  vendor_id       TEXT NOT NULL REFERENCES vendors(vendor_id),
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  paid_date       TEXT,
  amount_cents    INTEGER NOT NULL,
  memo            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'void'))
);

CREATE TABLE grant_drawdowns (
  drawdown_id   TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES grants(grant_id),
  request_date  TEXT NOT NULL,
  received_date TEXT,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('received', 'pending'))
);
`;

// ── mapping target ──────────────────────────────────────────────────────────
//
// The canonical fields a CSV column can map onto. One row of the buyer's CSV is
// one expenditure; the dimension tables (vendors, departments, funds,
// budget_lines) are derived from these fields. `type` drives coercion and type
// inference; `synonyms` drive the proposed mapping. Only amount, vendor and
// invoice_date are required to produce a usable ledger.
export const CANONICAL_IMPORT_FIELDS = Object.freeze([
    { field: 'invoice_date', type: 'date', required: true,
      synonyms: ['date', 'invoice date', 'payment date', 'check date', 'transaction date', 'posted date', 'paid date'],
      description: 'The expenditure date (invoice or payment).' },
    { field: 'vendor_name', type: 'text', required: true,
      synonyms: ['vendor', 'vendor name', 'payee', 'payee name', 'supplier', 'merchant', 'name'],
      description: 'Who was paid.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'amount paid', 'payment amount', 'expenditure', 'expense', 'total', 'cost', 'value'],
      description: 'The amount; coerced to integer cents.' },
    { field: 'paid_date', type: 'date', required: false,
      synonyms: ['paid date', 'payment date', 'check date', 'cleared date'],
      description: 'When it was paid (defaults to the invoice date for paid rows).' },
    { field: 'status', type: 'status', required: false,
      synonyms: ['status', 'payment status', 'state'],
      description: "paid / pending / void (defaults to paid). 'void' rows are excluded from spend." },
    { field: 'dept_name', type: 'text', required: false,
      synonyms: ['department', 'dept', 'dept name', 'division', 'agency'],
      description: 'Department; derives the departments dimension.' },
    { field: 'fund_name', type: 'text', required: false,
      synonyms: ['fund', 'fund name', 'funding source'],
      description: 'Fund; derives the funds dimension.' },
    { field: 'account_code', type: 'text', required: false,
      synonyms: ['account', 'account code', 'account number', 'gl code', 'object code', 'line', 'line item'],
      description: 'Account/line code; groups expenditures into budget lines.' },
    { field: 'line_description', type: 'text', required: false,
      synonyms: ['account description', 'line description', 'category', 'expense category', 'description'],
      description: 'Human label for the budget line.' },
    { field: 'budget_amount', type: 'money', required: false,
      synonyms: ['budget', 'line budget', 'amended budget', 'adopted budget', 'appropriation'],
      description: 'Budgeted amount for the line, if the export carries it; coerced to cents.' },
    { field: 'invoice_number', type: 'text', required: false,
      synonyms: ['invoice', 'invoice number', 'invoice no', 'reference', 'check number', 'check no', 'voucher', 'document number'],
      description: 'Invoice / check / voucher reference.' },
    { field: 'memo', type: 'text', required: false,
      synonyms: ['memo', 'note', 'notes', 'comment', 'purpose', 'description'],
      description: 'Free-text memo.' },
    { field: 'fiscal_year', type: 'integer', required: false,
      synonyms: ['fiscal year', 'fy', 'budget year', 'year'],
      description: 'Fiscal year; derived from the date (July–June) when absent.' },
    { field: 'grant_id', type: 'text', required: false,
      synonyms: ['grant', 'grant id', 'grant number', 'award', 'award id'],
      description: 'Grant identifier when the row is grant-funded; derives the grants dimension.' },
]);

const FIELD_BY_NAME = new Map(CANONICAL_IMPORT_FIELDS.map((f) => [f.field, f]));

// ── CSV parsing (RFC 4180) ──────────────────────────────────────────────────

/**
 * Parse CSV text into a header row and data rows. Handles quoted fields with
 * embedded commas, newlines and doubled "" quotes, a leading BOM, and CRLF or
 * LF line endings. A row whose column count differs from the header is a hard
 * error: silently padding or dropping cells would corrupt a total.
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 * @throws {ImportError}
 */
export function parseCsv(text) {
    if (typeof text !== 'string') throw new ImportError('CSV content must be text.');
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    let sawAny = false;
    let i = 0;
    const pushField = () => { record.push(field); field = ''; };
    const pushRecord = () => { pushField(); records.push(record); record = []; sawAny = false; };

    while (i < src.length) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i += 1; continue;
            }
            field += ch; i += 1; continue;
        }
        if (ch === '"') { inQuotes = true; sawAny = true; i += 1; continue; }
        if (ch === ',') { pushField(); sawAny = true; i += 1; continue; }
        if (ch === '\r') { i += 1; continue; }
        if (ch === '\n') { pushRecord(); i += 1; continue; }
        field += ch; sawAny = true; i += 1;
    }
    if (inQuotes) throw new ImportError('CSV has an unterminated quoted field.');
    // A trailing newline leaves an empty pending record; only flush a real one.
    if (sawAny || field !== '' || record.length > 0) pushRecord();

    // Drop blank trailing records (a file that ends with a newline).
    while (records.length > 0 && records[records.length - 1].length === 1 && records[records.length - 1][0].trim() === '') {
        records.pop();
    }
    if (records.length === 0) throw new ImportError('The CSV is empty.');

    const headers = records[0].map((h) => h.trim());
    if (headers.some((h) => h === '')) throw new ImportError('The CSV header row has a blank column name.');
    const rows = [];
    for (let r = 1; r < records.length; r++) {
        const row = records[r];
        // A wholly blank line between records is ignored; a short/long one is not.
        if (row.length === 1 && row[0].trim() === '') continue;
        if (row.length !== headers.length) {
            throw new ImportError(`Row ${r + 1} has ${row.length} value(s) but the header has ${headers.length}.`);
        }
        rows.push(row);
    }
    return { headers, rows };
}

// ── coercion ────────────────────────────────────────────────────────────────

/**
 * Coerce a money string to an integer number of cents, exactly, never via
 * float. Accepts a currency symbol, thousands separators, a leading minus or
 * accounting parentheses for negatives, and at most two decimal places.
 *
 * @param {string} raw
 * @returns {number}
 * @throws {ImportError}
 */
export function coerceMoneyToCents(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty money value');
    let body = s;
    let negative = false;
    if (/^\(.*\)$/.test(body)) { negative = true; body = body.slice(1, -1).trim(); }
    if (body.startsWith('-')) { negative = true; body = body.slice(1).trim(); }
    if (body.startsWith('+')) body = body.slice(1).trim();
    // Strip a currency symbol and thousands separators; keep digits and one dot.
    body = body.replace(/[$£€\s]/g, '').replace(/,/g, '');
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(body);
    if (!m) throw new ImportError(`not a money amount: "${raw}"`);
    const whole = Number(m[1]);
    const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
    const cents = whole * 100 + frac;
    return negative ? -cents : cents;
}

/**
 * Normalise a date to ISO 'YYYY-MM-DD'. Accepts ISO, US M/D/Y and Y/M/D forms,
 * and validates that the calendar date is real (so 2026-13-40 is refused).
 *
 * @param {string} raw
 * @returns {string}
 * @throws {ImportError}
 */
export function normalizeDate(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty date value');
    let y;
    let mo;
    let d;
    let m;
    if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) {
        y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) {
        mo = +m[1]; d = +m[2]; y = +m[3];
    } else {
        throw new ImportError(`not a recognised date: "${raw}" (use YYYY-MM-DD or MM/DD/YYYY)`);
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new ImportError(`date out of range: "${raw}"`);
    const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const check = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d || check.getUTCMonth() + 1 !== mo) {
        throw new ImportError(`not a real calendar date: "${raw}"`);
    }
    return iso;
}

/** Fiscal year for an ISO date: July–June, so FY2026 = 2025-07-01 .. 2026-06-30. */
export function fiscalYearOf(iso) {
    const y = Number(iso.slice(0, 4));
    const mo = Number(iso.slice(5, 7));
    return mo >= 7 ? y + 1 : y;
}

const STATUS_MAP = new Map([
    ['paid', 'paid'], ['cleared', 'paid'], ['issued', 'paid'], ['complete', 'paid'], ['completed', 'paid'],
    ['pending', 'pending'], ['open', 'pending'], ['outstanding', 'pending'], ['unpaid', 'pending'], ['approved', 'pending'],
    ['void', 'void'], ['voided', 'void'], ['cancelled', 'void'], ['canceled', 'void'], ['reversed', 'void'],
]);

/** Map a raw status to the canonical set, or throw rather than misclassify. */
export function coerceStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return 'paid';
    const mapped = STATUS_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised status: "${raw}" (expected paid, pending or void)`);
    return mapped;
}

// ── mapping proposal ────────────────────────────────────────────────────────

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Does a sample of values look like money / dates? Used to break header ties. */
function looksLike(type, samples) {
    const nonEmpty = samples.filter((v) => String(v).trim() !== '');
    if (nonEmpty.length === 0) return false;
    const test = type === 'money' ? coerceMoneyToCents : type === 'date' ? normalizeDate : null;
    if (!test) return false;
    let ok = 0;
    for (const v of nonEmpty) {
        try { test(v); ok += 1; } catch { /* not this type */ }
    }
    return ok / nonEmpty.length >= 0.8;
}

/**
 * Propose a column mapping from CSV headers (and a sample of rows to confirm
 * types). The agent proposes; the human confirms before any write. This reads
 * headers and samples only; it never writes.
 *
 * @param {string[]} headers
 * @param {string[][]} [sampleRows] data rows (arrays aligned to headers)
 * @returns {{ mapping: Record<string,string>, fields: object[], unmappedHeaders: string[], missingRequired: string[] }}
 */
export function proposeMapping(headers, sampleRows = []) {
    const column = (name) => {
        const idx = headers.indexOf(name);
        return sampleRows.map((r) => r[idx]).filter((v) => v !== undefined);
    };
    const normHeaders = headers.map(norm);
    const used = new Set();
    const mapping = {};
    const fields = [];

    for (const spec of CANONICAL_IMPORT_FIELDS) {
        const wants = new Set([norm(spec.field), ...spec.synonyms.map(norm)]);
        let chosen = null;
        // Exact synonym match first, then substring, skipping already-used headers.
        for (let i = 0; i < headers.length; i++) {
            if (used.has(headers[i]) || !wants.has(normHeaders[i])) continue;
            chosen = headers[i];
            break;
        }
        if (!chosen) {
            for (let i = 0; i < headers.length; i++) {
                if (used.has(headers[i])) continue;
                if ([...wants].some((w) => normHeaders[i].includes(w) || w.includes(normHeaders[i]))) {
                    chosen = headers[i];
                    break;
                }
            }
        }
        // For a typed field, only accept a header whose sample values fit the type.
        if (chosen && (spec.type === 'money' || spec.type === 'date') && sampleRows.length > 0 && !looksLike(spec.type, column(chosen))) {
            chosen = null;
        }
        if (chosen) {
            used.add(chosen);
            mapping[spec.field] = chosen;
        }
        fields.push({ field: spec.field, type: spec.type, required: spec.required, description: spec.description, header: chosen ?? null });
    }

    const unmappedHeaders = headers.filter((h) => !used.has(h));
    const missingRequired = CANONICAL_IMPORT_FIELDS.filter((f) => f.required && !mapping[f.field]).map((f) => f.field);
    return { mapping, fields, unmappedHeaders, missingRequired };
}

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Validate a confirmed mapping against the canonical fields and the CSV headers.
 * Throws on an unknown field, a header that is not in the file, or a missing
 * required field.
 *
 * @param {Record<string,string>} mapping canonical field -> CSV header
 * @param {string[]} headers
 * @throws {ImportError}
 */
export function validateMapping(mapping, headers) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new ImportError('The mapping must be an object of canonical-field -> CSV-column.');
    }
    const headerSet = new Set(headers);
    for (const [field, header] of Object.entries(mapping)) {
        if (!FIELD_BY_NAME.has(field)) {
            throw new ImportError(`Unknown canonical field "${field}". Known: ${[...FIELD_BY_NAME.keys()].join(', ')}.`);
        }
        if (!headerSet.has(header)) throw new ImportError(`Mapping sends "${field}" to column "${header}", which is not in the CSV.`);
    }
    const missing = CANONICAL_IMPORT_FIELDS.filter((f) => f.required && !mapping[f.field]).map((f) => f.field);
    if (missing.length) throw new ImportError(`The mapping is missing required field(s): ${missing.join(', ')}.`);
}

// ── build ───────────────────────────────────────────────────────────────────

/** Deterministic id generator: PREFIX-0001, ... stable across a sorted key list. */
function ids(prefix, keys) {
    const map = new Map();
    let n = 0;
    for (const key of keys) {
        if (!map.has(key)) map.set(key, `${prefix}-${String(++n).padStart(4, '0')}`);
    }
    return map;
}

/**
 * Transform raw CSV rows into canonical expenditure records using the confirmed
 * mapping. Coercion happens here; a malformed value in any mapped field throws,
 * naming the row and column, so the import aborts rather than corrupting a total.
 *
 * @returns {object[]} one record per row, with coerced fields
 */
function coerceRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const invoiceDate = at('invoice_date', normalizeDate);
        const status = 'status' in mapping ? at('status', coerceStatus) : 'paid';
        const paidDate = 'paid_date' in mapping
            ? (String(cell(row, 'paid_date')).trim() === '' ? null : at('paid_date', normalizeDate))
            : (status === 'paid' ? invoiceDate : null);
        const fiscalYear = 'fiscal_year' in mapping
            ? at('fiscal_year', (v) => {
                  const n = Number(v.trim());
                  if (!Number.isInteger(n) || n < 1900 || n > 2200) throw new ImportError(`not a fiscal year: "${v}"`);
                  return n;
              })
            : fiscalYearOf(invoiceDate);

        const vendorName = String(cell(row, 'vendor_name')).trim();
        if (vendorName === '') throw new ImportError(`Row ${lineNo}, column "${mapping.vendor_name}": empty vendor name`);

        const deptName = 'dept_name' in mapping ? String(cell(row, 'dept_name')).trim() || 'Unspecified' : 'Unspecified';
        const fundName = 'fund_name' in mapping ? String(cell(row, 'fund_name')).trim() || 'Unspecified' : 'Unspecified';
        const accountCode = 'account_code' in mapping ? String(cell(row, 'account_code')).trim() || 'UNCLASSIFIED' : 'UNCLASSIFIED';
        const lineDescription = 'line_description' in mapping ? String(cell(row, 'line_description')).trim() : '';
        const grantId = 'grant_id' in mapping ? String(cell(row, 'grant_id')).trim() || null : null;

        return {
            lineNo,
            invoiceDate,
            paidDate,
            status,
            fiscalYear,
            vendorName,
            deptName,
            fundName,
            accountCode,
            lineDescription,
            grantId,
            amountCents: at('amount', coerceMoneyToCents),
            budgetCents: 'budget_amount' in mapping && String(cell(row, 'budget_amount')).trim() !== ''
                ? at('budget_amount', coerceMoneyToCents)
                : null,
            invoiceNumber: 'invoice_number' in mapping ? String(cell(row, 'invoice_number')).trim() : '',
            memo: 'memo' in mapping ? String(cell(row, 'memo')).trim() : '',
        };
    });
}

/** Write the derived dimension + fact rows into the open database. */
function loadCanonical(db, records) {
    // Dimensions, derived from distinct values in a stable (sorted) order so the
    // generated ids are deterministic for the same input.
    const fundIds = ids('F', [...new Set(records.map((r) => r.fundName))].sort());
    const deptIds = ids('D', [...new Set(records.map((r) => r.deptName))].sort());
    const vendorIds = ids('V', [...new Set(records.map((r) => r.vendorName))].sort());
    // A budget line is one (fiscal_year, dept, fund, account_code) combination.
    const lineKey = (r) => `${r.fiscalYear} ${r.deptName} ${r.fundName} ${r.accountCode}`;
    const lineIds = ids('BL', [...new Set(records.map(lineKey))].sort());

    const insFund = db.prepare('INSERT INTO funds (fund_id, fund_name, fund_type) VALUES (?, ?, ?)');
    for (const [name, id] of fundIds) insFund.run(id, name, 'imported');
    const insDept = db.prepare('INSERT INTO departments (dept_id, dept_name) VALUES (?, ?)');
    for (const [name, id] of deptIds) insDept.run(id, name);
    const insVendor = db.prepare('INSERT INTO vendors (vendor_id, vendor_name, category, tax_id, remit_account_last4) VALUES (?, ?, ?, ?, ?)');
    for (const [name, id] of vendorIds) insVendor.run(id, name, 'imported', '', '');

    // Budget lines: the budget figure, if the CSV supplied one for the line, else
    // 0. We take the maximum budget value seen for a line (a budget-vs-actual
    // export repeats the same line budget on every row of that line).
    const lineMeta = new Map();
    for (const r of records) {
        const key = lineKey(r);
        const prev = lineMeta.get(key);
        const budget = r.budgetCents ?? 0;
        if (!prev) {
            lineMeta.set(key, { r, budget });
        } else if (budget > prev.budget) {
            prev.budget = budget;
        }
    }
    const insLine = db.prepare(
        'INSERT INTO budget_lines (line_id, fiscal_year, dept_id, fund_id, account_code, line_description, adopted_cents, amended_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [key, { r, budget }] of lineMeta) {
        insLine.run(
            lineIds.get(key), r.fiscalYear, deptIds.get(r.deptName), fundIds.get(r.fundName),
            r.accountCode, r.lineDescription || r.accountCode, budget, budget,
        );
    }

    // Grants referenced by expenditures: derived as placeholders so the foreign
    // key holds and grant-status runs. The award is unknown from an expenditure
    // export (0), so grant-status reports spend with a NULL percent-of-award; a
    // later import of the grant register would fill these in.
    const grantKeys = [...new Set(records.map((r) => r.grantId).filter(Boolean))].sort();
    if (grantKeys.length) {
        const anyFund = [...fundIds.values()][0];
        const anyDept = [...deptIds.values()][0];
        const insGrant = db.prepare(
            'INSERT INTO grants (grant_id, grant_name, grantor, grantor_type, fund_id, dept_id, award_cents, match_required_cents, period_start, period_end, status) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)',
        );
        for (const g of grantKeys) {
            const dates = records.filter((r) => r.grantId === g).map((r) => r.invoiceDate).sort();
            insGrant.run(g, g, 'imported', 'private', anyFund, anyDept, dates[0], dates[dates.length - 1], 'active');
        }
    }

    // Expenditures, in file order, with a generated stable id.
    const insExp = db.prepare(
        'INSERT INTO expenditures (expenditure_id, fiscal_year, line_id, grant_id, vendor_id, invoice_number, invoice_date, paid_date, amount_cents, memo, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    records.forEach((r, i) => {
        insExp.run(
            `E-${String(i + 1).padStart(5, '0')}`,
            r.fiscalYear, lineIds.get(lineKey(r)), r.grantId, vendorIds.get(r.vendorName),
            r.invoiceNumber, r.invoiceDate, r.paidDate, r.amountCents, r.memo, r.status,
        );
    });

    return {
        rowCount: records.length,
        vendors: vendorIds.size,
        departments: deptIds.size,
        funds: fundIds.size,
        budgetLines: lineIds.size,
        grants: grantKeys.length,
    };
}

/**
 * Build a canonical ledger database from a CSV file and a confirmed mapping.
 * Atomic: writes a temp database and renames on success, so an aborted build
 * (including a malformed value) never leaves a half-written ledger behind. Also
 * copies the canonical municipal allow-list beside it so the three named queries
 * are serveable immediately.
 *
 * @param {object} params
 * @param {string} params.csvPath      absolute path to the source CSV (already confined by the caller)
 * @param {Record<string,string>} params.mapping confirmed field -> column
 * @param {string} params.dbPath       where to build the ledger
 * @param {string} [params.allowlistPath] where to copy the allow-list (defaults beside dbPath is caller's job)
 * @param {string} [params.allowlistSource] source allow-list (defaults to the bundled municipal one)
 * @returns {{ dbPath: string, allowlistPath: string|null, sourceFileSha256: string, byteLength: number, counts: object, mapping: Record<string,string> }}
 * @throws {ImportError}
 */
export function buildLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = MUNICIPAL_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers);
    if (rows.length === 0) throw new ImportError('The CSV has a header but no data rows.');
    const records = coerceRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(SCHEMA_DDL);
            counts = loadCanonical(db, records);
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
