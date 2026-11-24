/**
 * The pure core of the municipal CSV importer — no `node:` imports.
 *
 * Everything here is runtime-agnostic string and data work: parsing a CSV,
 * coercing a cell to integer cents or an ISO date, proposing and validating a
 * column mapping, coercing rows into canonical records, and turning those
 * records into the canonical tables (as plain arrays) and into seed SQL.
 *
 * It exists so one body of logic serves two runtimes:
 *   - Node (src/import-csv.js) opens a `node:sqlite` database, inserts the rows
 *     canonicalTables() produces, and writes the ledger file.
 *   - The browser (src/browser/import-engine.js) emits the same rows as seed SQL
 *     (canonicalSeedSql) into a WASM SQLite database.
 *
 * Because both consume the *same* canonicalTables() output, a ledger a visitor
 * builds in their browser holds byte-identical rows to the one a buyer builds
 * with the Node package, so the named queries return identical results and the
 * result hashes match. test/import-browser-parity.test.js pins that.
 *
 * This module holds no policy about *where* a file comes from: path confinement
 * lives in paths.js and is applied by the Node callers.
 */

import { CANONICAL_SCHEMA_DDL } from './schema.js';

export class ImportError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ImportError';
    }
}

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
 * @param {object[]} [specs] the field specs to map onto (defaults to the expenditure fields)
 * @returns {{ mapping: Record<string,string>, fields: object[], unmappedHeaders: string[], missingRequired: string[] }}
 */
export function proposeMapping(headers, sampleRows = [], specs = CANONICAL_IMPORT_FIELDS) {
    const column = (name) => {
        const idx = headers.indexOf(name);
        return sampleRows.map((r) => r[idx]).filter((v) => v !== undefined);
    };
    const normHeaders = headers.map(norm);
    const used = new Set();
    const mapping = {};
    const fields = [];

    for (const spec of specs) {
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
    const missingRequired = specs.filter((f) => f.required && !mapping[f.field]).map((f) => f.field);
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
 * @param {object[]} [specs] the field specs to validate against (defaults to the expenditure fields)
 * @throws {ImportError}
 */
export function validateMapping(mapping, headers, specs = CANONICAL_IMPORT_FIELDS) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new ImportError('The mapping must be an object of canonical-field -> CSV-column.');
    }
    const fieldByName = specs === CANONICAL_IMPORT_FIELDS ? FIELD_BY_NAME : new Map(specs.map((f) => [f.field, f]));
    const headerSet = new Set(headers);
    for (const [field, header] of Object.entries(mapping)) {
        if (!fieldByName.has(field)) {
            throw new ImportError(`Unknown canonical field "${field}". Known: ${[...fieldByName.keys()].join(', ')}.`);
        }
        if (!headerSet.has(header)) throw new ImportError(`Mapping sends "${field}" to column "${header}", which is not in the CSV.`);
    }
    const missing = specs.filter((f) => f.required && !mapping[f.field]).map((f) => f.field);
    if (missing.length) throw new ImportError(`The mapping is missing required field(s): ${missing.join(', ')}.`);
}

// ── row coercion ──────────────────────────────────────────────────────────────

/**
 * Transform raw CSV rows into canonical expenditure records using the confirmed
 * mapping. Coercion happens here; a malformed value in any mapped field throws,
 * naming the row and column, so the import aborts rather than corrupting a total.
 *
 * @returns {object[]} one record per row, with coerced fields
 */
export function coerceRows(rows, headers, mapping) {
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

// ── canonical tables (the single source of truth for derived rows) ────────────

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
 * Turn coerced expenditure records into the canonical tables, as plain arrays of
 * row objects, in the order they are inserted. This is the one place the derived
 * dimensions and facts are computed; both the Node inserter (import-csv.js
 * loadCanonical) and the browser seed-SQL emitter (canonicalSeedSql) consume
 * this output unchanged, so the two runtimes build identical ledgers.
 *
 * @param {object[]} records  output of coerceRows
 * @returns {{ funds: object[], departments: object[], vendors: object[], budget_lines: object[], grants: object[], expenditures: object[], counts: object }}
 */
export function canonicalTables(records) {
    // Dimensions, derived from distinct values in a stable (sorted) order so the
    // generated ids are deterministic for the same input.
    const fundIds = ids('F', [...new Set(records.map((r) => r.fundName))].sort());
    const deptIds = ids('D', [...new Set(records.map((r) => r.deptName))].sort());
    const vendorIds = ids('V', [...new Set(records.map((r) => r.vendorName))].sort());
    // A budget line is one (fiscal_year, dept, fund, account_code) combination.
    const lineKey = (r) => `${r.fiscalYear} ${r.deptName} ${r.fundName} ${r.accountCode}`;
    const lineIds = ids('BL', [...new Set(records.map(lineKey))].sort());

    const funds = [...fundIds].map(([name, id]) => ({ fund_id: id, fund_name: name, fund_type: 'imported' }));
    const departments = [...deptIds].map(([name, id]) => ({ dept_id: id, dept_name: name }));
    const vendors = [...vendorIds].map(([name, id]) => ({ vendor_id: id, vendor_name: name, category: 'imported', tax_id: '', remit_account_last4: '' }));

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
    const budget_lines = [...lineMeta].map(([key, { r, budget }]) => ({
        line_id: lineIds.get(key),
        fiscal_year: r.fiscalYear,
        dept_id: deptIds.get(r.deptName),
        fund_id: fundIds.get(r.fundName),
        account_code: r.accountCode,
        line_description: r.lineDescription || r.accountCode,
        adopted_cents: budget,
        amended_cents: budget,
    }));

    // Grants referenced by expenditures: derived as placeholders so the foreign
    // key holds and grant-status runs. The award is unknown from an expenditure
    // export (0), so grant-status reports spend with a NULL percent-of-award; a
    // later import of the grant register would fill these in.
    const grantKeys = [...new Set(records.map((r) => r.grantId).filter(Boolean))].sort();
    const grants = [];
    if (grantKeys.length) {
        const anyFund = [...fundIds.values()][0];
        const anyDept = [...deptIds.values()][0];
        for (const g of grantKeys) {
            const dates = records.filter((r) => r.grantId === g).map((r) => r.invoiceDate).sort();
            grants.push({
                grant_id: g, grant_name: g, grantor: 'imported', grantor_type: 'private',
                fund_id: anyFund, dept_id: anyDept, award_cents: 0, match_required_cents: 0,
                period_start: dates[0], period_end: dates[dates.length - 1], status: 'active',
            });
        }
    }

    // Expenditures, in file order, with a generated stable id.
    const expenditures = records.map((r, i) => ({
        expenditure_id: `E-${String(i + 1).padStart(5, '0')}`,
        fiscal_year: r.fiscalYear,
        line_id: lineIds.get(lineKey(r)),
        grant_id: r.grantId,
        vendor_id: vendorIds.get(r.vendorName),
        invoice_number: r.invoiceNumber,
        invoice_date: r.invoiceDate,
        paid_date: r.paidDate,
        amount_cents: r.amountCents,
        memo: r.memo,
        status: r.status,
    }));

    return {
        funds,
        departments,
        vendors,
        budget_lines,
        grants,
        expenditures,
        counts: {
            rowCount: records.length,
            vendors: vendorIds.size,
            departments: deptIds.size,
            funds: fundIds.size,
            budgetLines: lineIds.size,
            grants: grantKeys.length,
        },
    };
}

// ── seed SQL (browser build path) ─────────────────────────────────────────────

/** Quote a string as a SQL literal (double any single quotes). */
function sqlStr(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

/** A SQL literal for a canonical cell: NULL, a bare number, or a quoted string. */
function sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return sqlStr(v);
}

/**
 * Build the full seed SQL (schema DDL + INSERTs) for a canonical ledger from
 * coerced records, for the browser path. The rows come from canonicalTables, so
 * this ledger is identical to the one the Node inserter builds; it is emitted as
 * text because the browser seeds a WASM database by executing SQL, not by
 * running prepared INSERTs against a file. Tables are emitted in dependency
 * order (parents before children) so the DDL's foreign keys hold on load.
 *
 * @param {object[]} records  output of coerceRows
 * @returns {string} executable SQL
 */
export function canonicalSeedSql(records) {
    return seedSqlFromTables(canonicalTables(records));
}

/**
 * Emit seed SQL from an already-computed canonicalTables() result, so a caller
 * that also needs the counts does not recompute the tables. See canonicalSeedSql.
 *
 * @param {ReturnType<typeof canonicalTables>} t
 * @returns {string} executable SQL
 */
export function seedSqlFromTables(t) {
    const out = [CANONICAL_SCHEMA_DDL.trim()];
    const emit = (table, cols, rows) => {
        for (const row of rows) {
            out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlVal(row[c])).join(', ')});`);
        }
    };
    emit('funds', ['fund_id', 'fund_name', 'fund_type'], t.funds);
    emit('departments', ['dept_id', 'dept_name'], t.departments);
    emit('vendors', ['vendor_id', 'vendor_name', 'category', 'tax_id', 'remit_account_last4'], t.vendors);
    emit('budget_lines', ['line_id', 'fiscal_year', 'dept_id', 'fund_id', 'account_code', 'line_description', 'adopted_cents', 'amended_cents'], t.budget_lines);
    emit('grants', ['grant_id', 'grant_name', 'grantor', 'grantor_type', 'fund_id', 'dept_id', 'award_cents', 'match_required_cents', 'period_start', 'period_end', 'status'], t.grants);
    emit('expenditures', ['expenditure_id', 'fiscal_year', 'line_id', 'grant_id', 'vendor_id', 'invoice_number', 'invoice_date', 'paid_date', 'amount_cents', 'memo', 'status'], t.expenditures);
    return out.join('\n');
}

/**
 * Parse a CSV and build canonical records under a confirmed mapping — the pure
 * front half of an import, shared by both runtimes. Throws (ImportError) on a
 * parse error, a bad mapping, a header-only file, or any malformed cell.
 *
 * @param {string} csvText
 * @param {Record<string,string>} mapping confirmed field -> column
 * @returns {{ headers: string[], records: object[] }}
 */
export function buildCanonicalRecordsFromCsv(csvText, mapping) {
    const { headers, rows } = parseCsv(csvText);
    validateMapping(mapping, headers);
    if (rows.length === 0) throw new ImportError('The CSV has a header but no data rows.');
    return { headers, records: coerceRows(rows, headers, mapping) };
}
