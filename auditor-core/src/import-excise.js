/**
 * Import a brewer's (or other excise filer's) own filings export into the
 * canonical excise schema the five excise-v1 controls run against.
 *
 * This is the excise counterpart to the municipal importer (import-csv.js): it
 * holds the same promise — the numbers that come out are exactly the numbers
 * that went in, and the record says which file was read and how its columns were
 * understood — but it targets a different warehouse. The genuinely shared parts
 * (the RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, ImportError) are reused from import-csv.js;
 * only the excise-specific schema, field specs, coercers and loaders live here.
 *
 * An excise filing is four things, so an import is up to four files:
 *   1. The removals — one row per taxable removal from bond (the primary file;
 *      it builds the ledger). barrels is the beer excise unit (a US barrel is
 *      31 gallons); the taxable event that creates the liability.
 *   2. The rate schedule — rate_cents_per_barrel with an effective_date, so a
 *      control can read the rate in force for each period. Optional.
 *   3. The operations reports — the period production rollforward (opening +
 *      produced − removed − losses = closing). Optional.
 *   4. The excise returns — barrels reported and tax paid per period. Optional.
 *
 * Wholesale-customer data never enters: the demo warehouse keeps a
 * customer_accounts table only so the guard has something to refuse, but there
 * is no mapping target for a name, address or license number here, so an
 * imported ledger simply has no column that could hold one. The filings identify
 * product by class and period only, and the copied allow-list lists only the
 * four non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder
 * lives in paths.js and is applied by the callers, exactly as for municipal.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { EXCISE_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical excise schema ───────────────────────────────────────────────────
//
// The four tables the excise-v1 ruleset reads, reproduced from the demo seed
// (sample_excise_filings.sql) minus the seed rows and minus customer_accounts
// (PII, which the import never carries). Kept here, beside the importer, so the
// shape the loader writes and the shape the controls query are defined together.
export const EXCISE_SCHEMA_VERSION = 'excise-canonical-v1';

export const EXCISE_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE tax_rates (
  rate_id               TEXT PRIMARY KEY,
  product_class         TEXT NOT NULL,
  jurisdiction          TEXT NOT NULL,
  rate_cents_per_barrel INTEGER NOT NULL CHECK (rate_cents_per_barrel >= 0),
  effective_date        TEXT NOT NULL
);

CREATE TABLE removals (
  removal_id    TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  product_class TEXT NOT NULL,
  barrels       INTEGER NOT NULL CHECK (barrels >= 0),
  removal_date  TEXT NOT NULL
);

CREATE TABLE operations_reports (
  report_id        TEXT PRIMARY KEY,
  period           TEXT NOT NULL,
  product_class    TEXT NOT NULL,
  opening_barrels  INTEGER NOT NULL CHECK (opening_barrels >= 0),
  produced_barrels INTEGER NOT NULL CHECK (produced_barrels >= 0),
  removed_barrels  INTEGER NOT NULL CHECK (removed_barrels >= 0),
  loss_barrels     INTEGER NOT NULL CHECK (loss_barrels >= 0),
  closing_barrels  INTEGER NOT NULL CHECK (closing_barrels >= 0),
  filed_date       TEXT NOT NULL,
  due_date         TEXT NOT NULL
);

CREATE TABLE tax_returns (
  return_id        TEXT PRIMARY KEY,
  period           TEXT NOT NULL,
  product_class    TEXT NOT NULL,
  barrels_reported INTEGER NOT NULL CHECK (barrels_reported >= 0),
  tax_paid_cents   INTEGER NOT NULL CHECK (tax_paid_cents >= 0),
  filed_date       TEXT NOT NULL,
  due_date         TEXT NOT NULL
);
`;

// ── mapping targets ────────────────────────────────────────────────────────────
//
// The removals file is the primary file: one row is one taxable removal from
// bond. Only the removal date and the barrels are required to produce a usable
// ledger. The filing period is derived from the removal date (its YYYY-MM) when
// unmapped or blank, so a plain removals export with just a date and a quantity
// imports cleanly. product_class defaults to BEER; removal_id is generated in
// file order when unmapped.
export const CANONICAL_EXCISE_REMOVAL_FIELDS = Object.freeze([
    { field: 'removal_date', type: 'date', required: true,
      synonyms: ['date', 'removal date', 'ship date', 'date removed', 'shipped date', 'removed on'],
      description: 'When the beer was removed from bond (the taxable event).' },
    { field: 'barrels', type: 'barrels', required: true,
      synonyms: ['barrels', 'bbl', 'bbls', 'quantity', 'qty', 'volume', 'barrels removed', 'amount'],
      description: 'Taxable barrels removed; a whole number of US beer barrels (31 gallons each).' },
    { field: 'period', type: 'period', required: false,
      synonyms: ['period', 'filing period', 'tax period', 'month', 'reporting period'],
      description: 'The YYYY-MM filing period; derived from the removal date when blank or unmapped.' },
    { field: 'product_class', type: 'text', required: false,
      synonyms: ['product', 'product class', 'class', 'beverage', 'commodity', 'type'],
      description: 'The product class the rate schedule keys on (defaults to BEER).' },
    { field: 'removal_id', type: 'text', required: false,
      synonyms: ['removal id', 'id', 'removal', 'reference', 'document number', 'doc number', 'shipment id'],
      description: "The filer's own id for the removal; generated (RM-0001…) in file order when unmapped." },
]);

// The rate schedule: one row per (product class, jurisdiction) that took effect
// on a date. A control reads the row whose effective_date is the latest on or
// before the period it reconciles, so a rate change is a row, never a new ruleset.
export const CANONICAL_EXCISE_RATE_FIELDS = Object.freeze([
    { field: 'rate_cents_per_barrel', type: 'money', required: true,
      synonyms: ['rate', 'rate per barrel', 'excise rate', 'tax rate', 'rate per bbl', 'per barrel', 'rate cents per barrel'],
      description: 'The per-barrel excise rate, coerced to integer cents (so $3.50/bbl becomes 350).' },
    { field: 'effective_date', type: 'date', required: true,
      synonyms: ['effective date', 'effective', 'start date', 'as of', 'as of date', 'from date'],
      description: 'The date the rate applies from (forward).' },
    { field: 'product_class', type: 'text', required: false,
      synonyms: ['product', 'product class', 'class', 'beverage', 'commodity', 'type'],
      description: 'The product class the rate applies to (defaults to BEER).' },
    { field: 'jurisdiction', type: 'text', required: false,
      synonyms: ['jurisdiction', 'authority', 'agency', 'taxing authority'],
      description: 'The taxing authority (defaults to US-TTB).' },
    { field: 'rate_id', type: 'text', required: false,
      synonyms: ['rate id', 'id', 'rate', 'schedule id'],
      description: "The filer's own id for the rate row; generated (RATE-0001…) in file order when unmapped." },
]);

// The operations reports: one row per period. The rollforward must tie
// (opening + produced − removed − losses = closing) and removed must agree with
// the return. due_date defaults to the 15th of the month after the period.
export const CANONICAL_EXCISE_OPERATIONS_FIELDS = Object.freeze([
    { field: 'period', type: 'period', required: true,
      synonyms: ['period', 'filing period', 'tax period', 'month', 'reporting period'],
      description: 'The YYYY-MM period the report covers.' },
    { field: 'opening_barrels', type: 'barrels', required: true,
      synonyms: ['opening', 'opening barrels', 'beginning', 'beginning barrels', 'opening inventory', 'bbl opening'],
      description: 'On-hand barrels at the start of the period.' },
    { field: 'produced_barrels', type: 'barrels', required: true,
      synonyms: ['produced', 'produced barrels', 'production', 'brewed', 'made', 'bbl produced'],
      description: 'Barrels produced during the period.' },
    { field: 'removed_barrels', type: 'barrels', required: true,
      synonyms: ['removed', 'removed barrels', 'removals', 'shipped', 'bbl removed'],
      description: 'Barrels removed from bond during the period (must tie to the return).' },
    { field: 'closing_barrels', type: 'barrels', required: true,
      synonyms: ['closing', 'closing barrels', 'ending', 'ending barrels', 'closing inventory', 'bbl closing'],
      description: 'On-hand barrels at the end of the period.' },
    { field: 'loss_barrels', type: 'barrels', required: false,
      synonyms: ['loss', 'losses', 'loss barrels', 'destruction', 'spillage', 'shrinkage', 'bbl loss'],
      description: 'Barrels lost to destruction, spillage and shrinkage (defaults to 0).' },
    { field: 'filed_date', type: 'date', required: true,
      synonyms: ['filed date', 'filed', 'date filed', 'report date', 'submitted', 'submitted date'],
      description: 'When the operations report was filed.' },
    { field: 'due_date', type: 'date', required: false,
      synonyms: ['due date', 'due', 'deadline'],
      description: 'The filing due date; defaults to the 15th of the month after the period.' },
    { field: 'product_class', type: 'text', required: false,
      synonyms: ['product', 'product class', 'class', 'beverage', 'commodity', 'type'],
      description: 'The product class (defaults to BEER).' },
    { field: 'report_id', type: 'text', required: false,
      synonyms: ['report id', 'id', 'report', 'reference', 'document number', 'doc number'],
      description: "The filer's own id for the report; generated (OR-0001…) in file order when unmapped." },
]);

// The excise returns: one row per period. barrels_reported must agree with the
// operations report's removed_barrels; tax_paid_cents is what the filer paid.
export const CANONICAL_EXCISE_RETURN_FIELDS = Object.freeze([
    { field: 'period', type: 'period', required: true,
      synonyms: ['period', 'filing period', 'tax period', 'month', 'reporting period'],
      description: 'The YYYY-MM period the return covers.' },
    { field: 'barrels_reported', type: 'barrels', required: true,
      synonyms: ['barrels', 'barrels reported', 'bbl reported', 'reported barrels', 'quantity', 'qty'],
      description: 'Barrels the filer reported removing (must tie to the operations report).' },
    { field: 'tax_paid_cents', type: 'money', required: true,
      synonyms: ['tax paid', 'excise paid', 'amount paid', 'tax', 'payment', 'tax paid cents', 'paid'],
      description: 'Excise tax paid for the period, coerced to integer cents.' },
    { field: 'filed_date', type: 'date', required: true,
      synonyms: ['filed date', 'filed', 'date filed', 'return date', 'submitted', 'submitted date'],
      description: 'When the return was filed (late when after the due date).' },
    { field: 'due_date', type: 'date', required: false,
      synonyms: ['due date', 'due', 'deadline'],
      description: 'The return due date; defaults to the 15th of the month after the period.' },
    { field: 'product_class', type: 'text', required: false,
      synonyms: ['product', 'product class', 'class', 'beverage', 'commodity', 'type'],
      description: 'The product class (defaults to BEER).' },
    { field: 'return_id', type: 'text', required: false,
      synonyms: ['return id', 'id', 'return', 'reference', 'document number', 'doc number'],
      description: "The filer's own id for the return; generated (TR-0001…) in file order when unmapped." },
]);

// ── excise-specific coercion ────────────────────────────────────────────────────

/** Coerce a required, non-negative whole number of barrels (strips "bbl"/commas), or throw. */
export function coerceBarrels(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty barrels value');
    const body = s.replace(/,/g, '').replace(/\b(?:bbls?|barrels?)\b/gi, '').trim();
    if (!/^\d+$/.test(body)) {
        throw new ImportError(`not a whole number of barrels: "${raw}" (barrels are integers)`);
    }
    return Number(body);
}

/** Coerce an optional barrels value; blank defaults to 0. */
function coerceOptionalBarrels(raw) {
    return String(raw).trim() === '' ? 0 : coerceBarrels(raw);
}

/**
 * Normalise a filing period to 'YYYY-MM'. Accepts YYYY-MM, YYYY/MM, MM/YYYY and a
 * full ISO date (whose month is taken), and validates the month is 01–12.
 */
export function normalizePeriod(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty period value');
    let y;
    let mo;
    let m;
    if ((m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s))) {
        y = +m[1]; mo = +m[2];
    } else if ((m = /^(\d{1,2})[-/](\d{4})$/.exec(s))) {
        mo = +m[1]; y = +m[2];
    } else {
        throw new ImportError(`not a recognised filing period: "${raw}" (use YYYY-MM)`);
    }
    if (mo < 1 || mo > 12) throw new ImportError(`period month out of range: "${raw}"`);
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;
}

/** The YYYY-MM period an ISO date falls in. */
function periodOfDate(iso) {
    return iso.slice(0, 7);
}

/** The filing due date for a period: the 15th of the month after it (27 CFR 25.297). */
export function dueDateForPeriod(period) {
    const y = Number(period.slice(0, 4));
    const mo = Number(period.slice(5, 7));
    const nextY = mo === 12 ? y + 1 : y;
    const nextMo = mo === 12 ? 1 : mo + 1;
    return `${String(nextY).padStart(4, '0')}-${String(nextMo).padStart(2, '0')}-15`;
}

/** Trim a product class and upper-case it; blank defaults to BEER. */
function coerceProductClass(raw) {
    const s = String(raw).trim();
    return s === '' ? 'BEER' : s.toUpperCase();
}

/** Trim a jurisdiction; blank defaults to US-TTB. */
function coerceJurisdiction(raw) {
    const s = String(raw).trim();
    return s === '' ? 'US-TTB' : s;
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

// ── removals: build the ledger ──────────────────────────────────────────────────

function coerceRemovalRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = rowCoercer(cell, row, lineNo, mapping);
        const removalDate = at('removal_date', normalizeDate);
        const period = 'period' in mapping && String(cell(row, 'period')).trim() !== ''
            ? at('period', normalizePeriod)
            : periodOfDate(removalDate);
        return {
            lineNo,
            removalId: optionalId(cell, row, 'removal_id', mapping, lineNo),
            period,
            productClass: 'product_class' in mapping ? at('product_class', coerceProductClass) : 'BEER',
            barrels: at('barrels', coerceBarrels),
            removalDate,
        };
    });
}

function loadRemovals(db, records) {
    const ins = db.prepare(
        'INSERT INTO removals (removal_id, period, product_class, barrels, removal_date) VALUES (?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    records.forEach((r, i) => {
        const id = r.removalId || `RM-${String(i + 1).padStart(4, '0')}`;
        if (seen.has(id)) throw new ImportError(`The removals file lists removal id "${id}" more than once.`);
        seen.add(id);
        ins.run(id, r.period, r.productClass, r.barrels, r.removalDate);
    });
    const periods = new Set(records.map((r) => r.period));
    const barrels = records.reduce((sum, r) => sum + r.barrels, 0);
    return { rowCount: records.length, periods: periods.size, barrels };
}

/**
 * Build a canonical excise ledger database from a removals CSV and a confirmed
 * mapping. Atomic: writes a temp database and renames on success, so an aborted
 * build (including a malformed value) never leaves a half-written ledger behind.
 * Copies the bundled excise allow-list beside it so the five named queries are
 * serveable immediately (the three optional registers are applied afterward).
 */
export function buildExciseLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = EXCISE_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_EXCISE_REMOVAL_FIELDS);
    if (rows.length === 0) throw new ImportError('The removals file has a header but no data rows.');
    const records = coerceRemovalRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(EXCISE_SCHEMA_DDL);
            counts = loadRemovals(db, records);
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

// ── rate schedule: apply onto the ledger ──────────────────────────────────────

function coerceRateRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            rateId: optionalId(cell, row, 'rate_id', mapping, lineNo),
            productClass: 'product_class' in mapping ? at('product_class', coerceProductClass) : 'BEER',
            jurisdiction: 'jurisdiction' in mapping ? at('jurisdiction', coerceJurisdiction) : 'US-TTB',
            rateCentsPerBarrel: at('rate_cents_per_barrel', coerceMoneyToCents),
            effectiveDate: at('effective_date', normalizeDate),
        };
    });
}

/**
 * Apply a rate schedule onto an existing imported excise ledger, filling
 * tax_rates so liability-vs-remitted can read the rate in force for each period.
 * One transaction: a malformed or duplicate row aborts it and leaves the ledger
 * untouched. rate_id is taken from the file when mapped (and must be unique),
 * else generated RATE-0001… in file order.
 */
export function applyRatesToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_EXCISE_RATE_FIELDS,
        coerce: coerceRateRows,
        noun: 'rate schedule',
        idField: 'rateId', idPrefix: 'RATE',
        dupLabel: (id) => `The rate schedule lists rate id "${id}" more than once.`,
        insertSql: 'INSERT INTO tax_rates (rate_id, product_class, jurisdiction, rate_cents_per_barrel, effective_date) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.productClass, r.jurisdiction, r.rateCentsPerBarrel, r.effectiveDate],
        countKey: 'rates',
    });
}

// ── operations reports: apply onto the ledger ─────────────────────────────────

function coerceOperationsRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        const period = at('period', normalizePeriod);
        const dueDate = 'due_date' in mapping && String(cell(row, 'due_date')).trim() !== ''
            ? at('due_date', normalizeDate)
            : dueDateForPeriod(period);
        return {
            lineNo,
            reportId: optionalId(cell, row, 'report_id', mapping, lineNo),
            period,
            productClass: 'product_class' in mapping ? at('product_class', coerceProductClass) : 'BEER',
            openingBarrels: at('opening_barrels', coerceBarrels),
            producedBarrels: at('produced_barrels', coerceBarrels),
            removedBarrels: at('removed_barrels', coerceBarrels),
            lossBarrels: 'loss_barrels' in mapping ? at('loss_barrels', coerceOptionalBarrels) : 0,
            closingBarrels: at('closing_barrels', coerceBarrels),
            filedDate: at('filed_date', normalizeDate),
            dueDate,
        };
    });
}

/**
 * Apply operations reports onto an existing imported excise ledger, filling
 * operations_reports so inventory-rollforward, report-vs-return and loss-variance
 * have each period's production rollforward. One transaction; malformed or
 * duplicate rows abort it. report_id is taken from the file or generated OR-0001….
 */
export function applyOperationsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_EXCISE_OPERATIONS_FIELDS,
        coerce: coerceOperationsRows,
        noun: 'operations reports',
        idField: 'reportId', idPrefix: 'OR',
        dupLabel: (id) => `The operations reports file lists report id "${id}" more than once.`,
        insertSql: 'INSERT INTO operations_reports (report_id, period, product_class, opening_barrels, produced_barrels, removed_barrels, loss_barrels, closing_barrels, filed_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.period, r.productClass, r.openingBarrels, r.producedBarrels, r.removedBarrels, r.lossBarrels, r.closingBarrels, r.filedDate, r.dueDate],
        countKey: 'reports',
    });
}

// ── excise returns: apply onto the ledger ─────────────────────────────────────

function coerceReturnRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        const period = at('period', normalizePeriod);
        const dueDate = 'due_date' in mapping && String(cell(row, 'due_date')).trim() !== ''
            ? at('due_date', normalizeDate)
            : dueDateForPeriod(period);
        return {
            lineNo,
            returnId: optionalId(cell, row, 'return_id', mapping, lineNo),
            period,
            productClass: 'product_class' in mapping ? at('product_class', coerceProductClass) : 'BEER',
            barrelsReported: at('barrels_reported', coerceBarrels),
            taxPaidCents: at('tax_paid_cents', coerceMoneyToCents),
            filedDate: at('filed_date', normalizeDate),
            dueDate,
        };
    });
}

/**
 * Apply excise returns onto an existing imported excise ledger, filling
 * tax_returns so liability-vs-remitted, report-vs-return and missing-or-late-filings
 * have the barrels reported and tax paid per period. One transaction; malformed or
 * duplicate rows abort it. return_id is taken from the file or generated TR-0001….
 */
export function applyReturnsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_EXCISE_RETURN_FIELDS,
        coerce: coerceReturnRows,
        noun: 'excise returns',
        idField: 'returnId', idPrefix: 'TR',
        dupLabel: (id) => `The excise returns file lists return id "${id}" more than once.`,
        insertSql: 'INSERT INTO tax_returns (return_id, period, product_class, barrels_reported, tax_paid_cents, filed_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.period, r.productClass, r.barrelsReported, r.taxPaidCents, r.filedDate, r.dueDate],
        countKey: 'returns',
    });
}

// ── shared companion loader ───────────────────────────────────────────────────
//
// The three companion registers (rates, operations reports, returns) share the
// same shape: parse, validate against the companion's field spec, coerce every
// row (naming the offending row/column on failure), reject a duplicate mapped id,
// then insert all rows in a single transaction that rolls back on any error.
// Only the schema, coercer, id prefix and insert differ, so the body lives here.
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

// Re-export the shared mapping engine so callers can propose/validate excise
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
