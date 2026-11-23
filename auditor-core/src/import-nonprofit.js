/**
 * Import a nonprofit's own fund-accounting export into the canonical nonprofit
 * schema the five nonprofit-v1 controls run against.
 *
 * This is the nonprofit counterpart to the municipal (import-csv.js), IOLTA
 * (import-iolta.js) and construction (import-construction.js) importers: it holds
 * the same promise — the numbers that come out are exactly the numbers that went
 * in, and the record says which file was read and how its columns were understood
 * — but it targets the nonprofit warehouse. The genuinely shared parts (the
 * RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, ImportError) are reused from import-csv.js;
 * only the nonprofit-specific schema, field specs, coercers and loaders live here.
 *
 * A nonprofit's restricted-fund accounting turns on the fund register — which
 * fund carries which donor restriction — so the register is the primary file and
 * five companion files reconcile against it:
 *   1. The fund register — one row per fund the organization accounts for (the
 *      primary file; it builds the ledger). restriction_class, purpose_code and
 *      the time window are what the restricted-spending and releases controls read.
 *   2. The expenses / general ledger — one row per expense, tagged by fund,
 *      program and natural + functional classification. Restricted-spending and
 *      the ASC 958 functional-expense grid read it. Optional.
 *   3. The restriction releases — amounts released from donor restriction by fund,
 *      so releases-vs-spending has a released figure to measure against qualifying
 *      spending. Optional.
 *   4. The balance-sheet account balances — cash, investment and other balances by
 *      snapshot date, so restricted-cash-coverage has liquid assets to compare.
 *      Optional.
 *   5. The net assets — balances by donor-restriction class and snapshot date, so
 *      restricted-cash-coverage has the restricted net-asset balance to cover.
 *      Optional.
 *   6. The federal awards — federal money expended by fiscal year, so
 *      single-audit-threshold can test the 2 CFR 200.501 trigger. Optional.
 *
 * Donor PII never enters: the demo warehouse keeps a donor_pii table only so the
 * guard has something to refuse, but there is no mapping target for a donor name,
 * address or gift history here, so an imported ledger simply has no column that
 * could hold one. The controls identify funds and programs by code only, and the
 * copied allow-list lists only the six non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for the other packs.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { NONPROFIT_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical nonprofit schema ──────────────────────────────────────────────────
//
// The six tables the nonprofit-v1 ruleset reads, reproduced from the demo seed
// (sample_nonprofit_funds.sql) minus the seed rows and minus donor_pii (PII,
// which the import never carries). Kept here, beside the importer, so the shape
// the loaders write and the shape the controls query are defined together.
export const NONPROFIT_SCHEMA_VERSION = 'nonprofit-canonical-v1';

// The open-window sentinel an unrestricted fund carries when the register leaves
// its restriction window blank: the same bounds the demo seed uses, so the
// restricted-spending control ignores the fund exactly as it does in the demo.
const OPEN_WINDOW_START = '0001-01-01';
const OPEN_WINDOW_END = '9999-12-31';

export const NONPROFIT_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE funds (
  fund_id           TEXT PRIMARY KEY,
  fund_name         TEXT NOT NULL,
  restriction_class TEXT NOT NULL,
  purpose_code      TEXT NOT NULL,
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL
);

CREATE TABLE expenses (
  expense_id    TEXT PRIMARY KEY,
  fiscal_year   INTEGER NOT NULL,
  fund_id       TEXT NOT NULL,
  program_code  TEXT NOT NULL,
  nature_code   TEXT NOT NULL,
  function_class TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  expense_date  TEXT NOT NULL
);

CREATE TABLE restriction_releases (
  release_id    TEXT PRIMARY KEY,
  fund_id       TEXT NOT NULL,
  fiscal_year   INTEGER NOT NULL,
  released_cents INTEGER NOT NULL CHECK (released_cents >= 0),
  release_date  TEXT NOT NULL
);

CREATE TABLE account_balances (
  balance_id    TEXT PRIMARY KEY,
  account_type  TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  as_of         TEXT NOT NULL
);

CREATE TABLE net_assets (
  na_id            TEXT PRIMARY KEY,
  restriction_class TEXT NOT NULL,
  balance_cents    INTEGER NOT NULL,
  as_of            TEXT NOT NULL
);

CREATE TABLE federal_awards (
  award_id      TEXT PRIMARY KEY,
  fiscal_year   INTEGER NOT NULL,
  program_name  TEXT NOT NULL,
  cfda_number   TEXT NOT NULL,
  expended_cents INTEGER NOT NULL CHECK (expended_cents >= 0)
);
`;

// ── mapping targets ──────────────────────────────────────────────────────────
//
// The fund register is the primary file: one row is one fund the organization
// accounts for. restriction_class, purpose_code and the window are what the
// restricted-spending and releases-vs-spending controls read; the window
// defaults to an open window (so an unrestricted fund needs no dates).
export const CANONICAL_NONPROFIT_FUND_FIELDS = Object.freeze([
    { field: 'fund_id', type: 'text', required: true,
      synonyms: ['fund', 'fund id', 'fund code', 'fund number', 'fund no', 'account', 'account id'],
      description: 'The fund id; the key every companion file joins on.' },
    { field: 'fund_name', type: 'text', required: true,
      synonyms: ['name', 'fund name', 'description', 'fund description', 'title'],
      description: 'The fund name.' },
    { field: 'restriction_class', type: 'nonprofit_fund_restriction', required: true,
      synonyms: ['restriction', 'restriction class', 'donor restriction', 'class', 'restriction type', 'net asset class'],
      description: 'restricted / unrestricted — whether a donor restriction governs the fund.' },
    { field: 'purpose_code', type: 'text', required: true,
      synonyms: ['purpose', 'purpose code', 'program', 'program code', 'restricted purpose', 'use', 'activity'],
      description: "The program a restricted fund may pay for (an unrestricted fund carries the sentinel 'GENERAL'); matched against an expense's program_code." },
    { field: 'window_start', type: 'date', required: false,
      synonyms: ['window start', 'restricted from', 'start', 'start date', 'from', 'effective date', 'period start'],
      description: 'The date restricted spending is allowed from; defaults to an open window (0001-01-01) when blank.' },
    { field: 'window_end', type: 'date', required: false,
      synonyms: ['window end', 'restricted through', 'end', 'end date', 'through', 'expiration', 'expires', 'period end'],
      description: 'The date restricted spending is allowed through; defaults to an open window (9999-12-31) when blank.' },
]);

// The expenses / general-ledger file: one row per expense. restricted-spending
// and functional-expense-tie read it. amount is read as-is (a reversal or credit
// can be negative, which functional-expense-tie reports as a negative cell).
export const CANONICAL_NONPROFIT_EXPENSE_FIELDS = Object.freeze([
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'period', 'fiscal yr'],
      description: 'The fiscal year the expense falls in, e.g. 2026.' },
    { field: 'fund_id', type: 'text', required: true,
      synonyms: ['fund', 'fund id', 'fund code', 'fund number', 'account'],
      description: 'The fund the expense was charged to.' },
    { field: 'program_code', type: 'text', required: true,
      synonyms: ['program', 'program code', 'program id', 'activity', 'purpose', 'use'],
      description: "What the spend was for; matched against a restricted fund's purpose_code." },
    { field: 'nature_code', type: 'text', required: true,
      synonyms: ['nature', 'nature code', 'natural classification', 'natural', 'category', 'line', 'account type', 'object'],
      description: 'Natural classification: SALARIES, GRANTS, OCCUPANCY, SUPPLIES.' },
    { field: 'function_class', type: 'text', required: true,
      synonyms: ['function', 'function class', 'functional classification', 'functional', 'functional class'],
      description: 'Functional classification: PROGRAM, MGMT_GENERAL, FUNDRAISING.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'amount cents', 'expense amount', 'value', 'cost', 'debit'],
      description: 'The expense amount; coerced to integer cents. A credit/reversal may be negative.' },
    { field: 'expense_date', type: 'date', required: true,
      synonyms: ['date', 'expense date', 'posted date', 'transaction date', 'gl date'],
      description: 'When the expense was incurred (YYYY-MM-DD or MM/DD/YYYY).' },
    { field: 'expense_id', type: 'text', required: false,
      synonyms: ['expense id', 'expense', 'id', 'voucher', 'voucher id', 'reference', 'ref', 'entry id'],
      description: "The organization's own id for the expense; generated (EXP-0001…) in file order when unmapped." },
]);

// The restriction releases file: one row per release. releases-vs-spending ties
// each fund's released amount to the qualifying spending that justified it.
export const CANONICAL_NONPROFIT_RELEASE_FIELDS = Object.freeze([
    { field: 'fund_id', type: 'text', required: true,
      synonyms: ['fund', 'fund id', 'fund code', 'fund number', 'account'],
      description: 'The fund the restriction was released on.' },
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'period', 'fiscal yr'],
      description: 'The fiscal year the release was recorded in, e.g. 2026.' },
    { field: 'released', type: 'money', required: true,
      synonyms: ['released', 'released amount', 'amount released', 'release', 'released cents', 'amount'],
      description: 'The amount released from donor restriction; coerced to integer cents. Must be non-negative.' },
    { field: 'release_date', type: 'date', required: true,
      synonyms: ['release date', 'date', 'date released', 'released date'],
      description: 'When the restriction was released.' },
    { field: 'release_id', type: 'text', required: false,
      synonyms: ['release id', 'release', 'id', 'reference', 'ref'],
      description: "The organization's own id for the release; generated (REL-0001…) in file order when unmapped." },
]);

// The balance-sheet account balances file: one row per account snapshot.
// restricted-cash-coverage sums CASH + INVESTMENT at the latest date as the
// liquid assets that must cover restricted net assets.
export const CANONICAL_NONPROFIT_BALANCE_FIELDS = Object.freeze([
    { field: 'account_type', type: 'nonprofit_account_type', required: true,
      synonyms: ['account type', 'account', 'type', 'balance type', 'asset type'],
      description: 'cash / investment / other — only cash and investment count as liquid.' },
    { field: 'balance', type: 'money', required: true,
      synonyms: ['balance', 'balance cents', 'amount', 'ending balance', 'value', 'carried'],
      description: 'The balance carried for the account; coerced to integer cents.' },
    { field: 'as_of', type: 'date', required: true,
      synonyms: ['as of', 'as of date', 'date', 'snapshot date', 'balance date', 'statement date'],
      description: 'The snapshot date (YYYY-MM-DD); the latest is the one the coverage check reads.' },
    { field: 'balance_id', type: 'text', required: false,
      synonyms: ['balance id', 'id', 'reference', 'ref'],
      description: "The organization's own id for the balance; generated (AB-0001…) in file order when unmapped." },
]);

// The net assets file: one row per restriction class per snapshot.
// restricted-cash-coverage reads the WITH_DONOR_RESTRICTIONS balance at the
// latest date as the restricted net assets liquid assets must cover.
export const CANONICAL_NONPROFIT_NET_ASSET_FIELDS = Object.freeze([
    { field: 'restriction_class', type: 'nonprofit_net_asset_class', required: true,
      synonyms: ['restriction class', 'restriction', 'donor restriction', 'class', 'net asset class', 'net assets'],
      description: 'with donor restrictions / without donor restrictions (ASC 958 two classes).' },
    { field: 'balance', type: 'money', required: true,
      synonyms: ['balance', 'balance cents', 'amount', 'ending balance', 'value', 'net assets'],
      description: 'The net-asset balance for the class; coerced to integer cents.' },
    { field: 'as_of', type: 'date', required: true,
      synonyms: ['as of', 'as of date', 'date', 'snapshot date', 'balance date', 'statement date'],
      description: 'The snapshot date (YYYY-MM-DD); the latest is the one the coverage check reads.' },
    { field: 'na_id', type: 'text', required: false,
      synonyms: ['net asset id', 'na id', 'id', 'reference', 'ref'],
      description: "The organization's own id for the net-asset row; generated (NA-0001…) in file order when unmapped." },
]);

// The federal awards file: one row per award. single-audit-threshold sums
// expended per fiscal year against the 2 CFR 200.501 trigger.
export const CANONICAL_NONPROFIT_FEDERAL_FIELDS = Object.freeze([
    { field: 'fiscal_year', type: 'integer', required: true,
      synonyms: ['fiscal year', 'fy', 'year', 'period', 'fiscal yr'],
      description: 'The fiscal year the federal money was expended in, e.g. 2026.' },
    { field: 'program_name', type: 'text', required: true,
      synonyms: ['program name', 'program', 'award name', 'federal program', 'name'],
      description: 'The federal program name.' },
    { field: 'cfda_number', type: 'text', required: true,
      synonyms: ['cfda', 'cfda number', 'assistance listing', 'assistance listing number', 'aln', 'cfda no'],
      description: 'The Assistance Listing (CFDA) number, e.g. 93.569.' },
    { field: 'expended', type: 'money', required: true,
      synonyms: ['expended', 'expended amount', 'amount expended', 'federal expended', 'spent', 'expenditures', 'amount'],
      description: 'Federal award money expended; coerced to integer cents. Must be non-negative.' },
    { field: 'award_id', type: 'text', required: false,
      synonyms: ['award id', 'award', 'id', 'grant id', 'reference', 'ref'],
      description: "The organization's own id for the award; generated (FA-0001…) in file order when unmapped." },
]);

// ── nonprofit-specific coercion ────────────────────────────────────────────────

const FUND_RESTRICTION_MAP = new Map([
    ['restricted', 'RESTRICTED'], ['donor restricted', 'RESTRICTED'], ['donor-restricted', 'RESTRICTED'],
    ['temporarily restricted', 'RESTRICTED'], ['permanently restricted', 'RESTRICTED'],
    ['with donor restrictions', 'RESTRICTED'], ['with donor restriction', 'RESTRICTED'],
    ['unrestricted', 'UNRESTRICTED'], ['without donor restrictions', 'UNRESTRICTED'],
    ['without donor restriction', 'UNRESTRICTED'], ['general', 'UNRESTRICTED'], ['none', 'UNRESTRICTED'],
]);

/** Map a raw fund restriction to RESTRICTED / UNRESTRICTED, or throw. */
export function coerceFundRestriction(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = FUND_RESTRICTION_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised fund restriction: "${raw}" (expected restricted or unrestricted)`);
    }
    return mapped;
}

const NET_ASSET_CLASS_MAP = new Map([
    ['with donor restrictions', 'WITH_DONOR_RESTRICTIONS'], ['with donor restriction', 'WITH_DONOR_RESTRICTIONS'],
    ['with', 'WITH_DONOR_RESTRICTIONS'], ['restricted', 'WITH_DONOR_RESTRICTIONS'], ['donor restricted', 'WITH_DONOR_RESTRICTIONS'],
    ['temporarily restricted', 'WITH_DONOR_RESTRICTIONS'], ['permanently restricted', 'WITH_DONOR_RESTRICTIONS'],
    ['without donor restrictions', 'WITHOUT_DONOR_RESTRICTIONS'], ['without donor restriction', 'WITHOUT_DONOR_RESTRICTIONS'],
    ['without', 'WITHOUT_DONOR_RESTRICTIONS'], ['unrestricted', 'WITHOUT_DONOR_RESTRICTIONS'], ['general', 'WITHOUT_DONOR_RESTRICTIONS'],
]);

/** Map a raw net-asset class to the ASC 958 two classes, or throw. */
export function coerceNetAssetClass(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = NET_ASSET_CLASS_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised net-asset class: "${raw}" (expected with or without donor restrictions)`);
    }
    return mapped;
}

const ACCOUNT_TYPE_MAP = new Map([
    ['cash', 'CASH'], ['cash and equivalents', 'CASH'], ['cash equivalents', 'CASH'], ['operating cash', 'CASH'],
    ['investment', 'INVESTMENT'], ['investments', 'INVESTMENT'], ['securities', 'INVESTMENT'], ['endowment', 'INVESTMENT'],
    ['other', 'OTHER'], ['receivable', 'OTHER'], ['receivables', 'OTHER'], ['fixed asset', 'OTHER'],
    ['fixed assets', 'OTHER'], ['ppe', 'OTHER'], ['property', 'OTHER'], ['prepaid', 'OTHER'],
]);

/** Map a raw balance-sheet account type to CASH / INVESTMENT / OTHER, or throw. */
export function coerceAccountType(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = ACCOUNT_TYPE_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised account type: "${raw}" (expected cash, investment or other)`);
    }
    return mapped;
}

/** Coerce a fiscal year to a 4-digit integer, accepting an optional "FY" prefix. */
export function coerceFiscalYear(raw) {
    const s = String(raw).trim().replace(/^fy[\s-]?/i, '');
    if (s === '') throw new ImportError('empty fiscal year');
    if (!/^\d{4}$/.test(s)) throw new ImportError(`not a 4-digit fiscal year: "${raw}"`);
    return Number(s);
}

/** Coerce a money amount that must be non-negative (a release or federal spend). */
function coerceNonNegativeMoney(raw) {
    const cents = coerceMoneyToCents(raw);
    if (cents < 0) throw new ImportError(`amount must be non-negative: "${raw}"`);
    return cents;
}

/** Build the per-field cell reader shared by every coerce-rows helper below. */
function cellReader(headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    return (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));
}

/** A required, non-empty text cell, or throw naming the row and column. */
function requiredText(cell, row, lineNo, mapping, field) {
    const v = String(cell(row, field)).trim();
    if (v === '') throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": empty ${field.replace(/_/g, ' ')}`);
    return v;
}

// ── funds: build the ledger ──────────────────────────────────────────────────

function coerceFundRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const windowStart = 'window_start' in mapping && String(cell(row, 'window_start')).trim() !== ''
            ? at('window_start', normalizeDate) : OPEN_WINDOW_START;
        const windowEnd = 'window_end' in mapping && String(cell(row, 'window_end')).trim() !== ''
            ? at('window_end', normalizeDate) : OPEN_WINDOW_END;
        return {
            lineNo,
            fundId: requiredText(cell, row, lineNo, mapping, 'fund_id'),
            fundName: requiredText(cell, row, lineNo, mapping, 'fund_name'),
            restrictionClass: at('restriction_class', coerceFundRestriction),
            purposeCode: requiredText(cell, row, lineNo, mapping, 'purpose_code'),
            windowStart,
            windowEnd,
        };
    });
}

function loadFunds(db, records) {
    const ins = db.prepare(
        'INSERT INTO funds (fund_id, fund_name, restriction_class, purpose_code, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.fundId)) throw new ImportError(`The fund register lists fund id "${r.fundId}" more than once.`);
        seen.add(r.fundId);
        ins.run(r.fundId, r.fundName, r.restrictionClass, r.purposeCode, r.windowStart, r.windowEnd);
    }
    return { rowCount: records.length };
}

/**
 * Build a canonical nonprofit ledger database from a fund-register CSV and a
 * confirmed mapping. Atomic: writes a temp database and renames on success, so an
 * aborted build (including a malformed value) never leaves a half-written ledger
 * behind. Copies the bundled nonprofit allow-list beside it so the five named
 * queries are serveable immediately (the five optional companions are applied
 * afterward).
 */
export function buildNonprofitLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = NONPROFIT_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_NONPROFIT_FUND_FIELDS);
    if (rows.length === 0) throw new ImportError('The fund register has a header but no data rows.');
    const records = coerceFundRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(NONPROFIT_SCHEMA_DDL);
            counts = loadFunds(db, records);
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

// ── companion loaders ───────────────────────────────────────────────────────
//
// Each applies one companion file onto the just-built ledger inside a single
// transaction: a malformed or duplicate row aborts it and leaves the ledger
// untouched. They share one shape, so the per-file differences (the coercer per
// field, the generated-id prefix, the table) are all that vary.

/** Open the imported ledger, run `fn` inside one transaction, and close. */
function withLedgerTxn(dbPath, applyLabel, fn) {
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the ${applyLabel} to: ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    try {
        db.exec('BEGIN');
        try {
            const out = fn(db);
            db.exec('COMMIT');
            return out;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    } finally {
        db.close();
    }
}

/** Read + hash a companion CSV, validate its confirmed mapping, and parse its rows. */
function openCompanion(csvPath, label, mapping, fields) {
    if (!existsSync(csvPath)) throw new ImportError(`${label} not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, fields);
    if (rows.length === 0) throw new ImportError(`The ${label} file has a header but no data rows.`);
    return { bytes, sourceFileSha256, headers, rows };
}

function coerceExpenseRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let expenseId = null;
        if ('expense_id' in mapping) expenseId = requiredText(cell, row, lineNo, mapping, 'expense_id');
        return {
            lineNo,
            expenseId,
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            fundId: requiredText(cell, row, lineNo, mapping, 'fund_id'),
            programCode: requiredText(cell, row, lineNo, mapping, 'program_code'),
            natureCode: requiredText(cell, row, lineNo, mapping, 'nature_code'),
            functionClass: requiredText(cell, row, lineNo, mapping, 'function_class'),
            amountCents: at('amount', coerceMoneyToCents),
            expenseDate: at('expense_date', normalizeDate),
        };
    });
}

/**
 * Apply the expenses / general-ledger file onto the ledger, filling expenses so
 * restricted-spending and the functional-expense grid read real figures.
 */
export function applyExpensesToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'expenses', mapping, CANONICAL_NONPROFIT_EXPENSE_FIELDS);
    const records = coerceExpenseRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.expenseId) continue;
        if (seen.has(r.expenseId)) throw new ImportError(`The expenses file lists expense id "${r.expenseId}" more than once.`);
        seen.add(r.expenseId);
    }
    const inserted = withLedgerTxn(dbPath, 'expenses', (db) => {
        const ins = db.prepare('INSERT INTO expenses (expense_id, fiscal_year, fund_id, program_code, nature_code, function_class, amount_cents, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.expenseId || `EXP-${String(i + 1).padStart(4, '0')}`, r.fiscalYear, r.fundId, r.programCode, r.natureCode, r.functionClass, r.amountCents, r.expenseDate));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { expenses: records.length, inserted } };
}

function coerceReleaseRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let releaseId = null;
        if ('release_id' in mapping) releaseId = requiredText(cell, row, lineNo, mapping, 'release_id');
        return {
            lineNo,
            releaseId,
            fundId: requiredText(cell, row, lineNo, mapping, 'fund_id'),
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            releasedCents: at('released', coerceNonNegativeMoney),
            releaseDate: at('release_date', normalizeDate),
        };
    });
}

/**
 * Apply the restriction releases onto the ledger, filling restriction_releases so
 * releases-vs-spending can measure each fund's released amount against the
 * qualifying spending that justified it.
 */
export function applyReleasesToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'restriction releases', mapping, CANONICAL_NONPROFIT_RELEASE_FIELDS);
    const records = coerceReleaseRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.releaseId) continue;
        if (seen.has(r.releaseId)) throw new ImportError(`The restriction releases file lists release id "${r.releaseId}" more than once.`);
        seen.add(r.releaseId);
    }
    const inserted = withLedgerTxn(dbPath, 'restriction releases', (db) => {
        const ins = db.prepare('INSERT INTO restriction_releases (release_id, fund_id, fiscal_year, released_cents, release_date) VALUES (?, ?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.releaseId || `REL-${String(i + 1).padStart(4, '0')}`, r.fundId, r.fiscalYear, r.releasedCents, r.releaseDate));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { releases: records.length, inserted } };
}

function coerceBalanceRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let balanceId = null;
        if ('balance_id' in mapping) balanceId = requiredText(cell, row, lineNo, mapping, 'balance_id');
        return {
            lineNo,
            balanceId,
            accountType: at('account_type', coerceAccountType),
            balanceCents: at('balance', coerceMoneyToCents),
            asOf: at('as_of', normalizeDate),
        };
    });
}

/**
 * Apply the balance-sheet account balances onto the ledger, filling
 * account_balances so restricted-cash-coverage has the liquid assets (cash and
 * investments) to compare against restricted net assets.
 */
export function applyAccountBalancesToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'account balances', mapping, CANONICAL_NONPROFIT_BALANCE_FIELDS);
    const records = coerceBalanceRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.balanceId) continue;
        if (seen.has(r.balanceId)) throw new ImportError(`The account balances file lists balance id "${r.balanceId}" more than once.`);
        seen.add(r.balanceId);
    }
    const inserted = withLedgerTxn(dbPath, 'account balances', (db) => {
        const ins = db.prepare('INSERT INTO account_balances (balance_id, account_type, balance_cents, as_of) VALUES (?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.balanceId || `AB-${String(i + 1).padStart(4, '0')}`, r.accountType, r.balanceCents, r.asOf));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { balances: records.length, inserted } };
}

function coerceNetAssetRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let naId = null;
        if ('na_id' in mapping) naId = requiredText(cell, row, lineNo, mapping, 'na_id');
        return {
            lineNo,
            naId,
            restrictionClass: at('restriction_class', coerceNetAssetClass),
            balanceCents: at('balance', coerceMoneyToCents),
            asOf: at('as_of', normalizeDate),
        };
    });
}

/**
 * Apply the net assets onto the ledger, filling net_assets so
 * restricted-cash-coverage has the WITH_DONOR_RESTRICTIONS balance that liquid
 * assets must cover.
 */
export function applyNetAssetsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'net assets', mapping, CANONICAL_NONPROFIT_NET_ASSET_FIELDS);
    const records = coerceNetAssetRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.naId) continue;
        if (seen.has(r.naId)) throw new ImportError(`The net assets file lists net-asset id "${r.naId}" more than once.`);
        seen.add(r.naId);
    }
    const inserted = withLedgerTxn(dbPath, 'net assets', (db) => {
        const ins = db.prepare('INSERT INTO net_assets (na_id, restriction_class, balance_cents, as_of) VALUES (?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.naId || `NA-${String(i + 1).padStart(4, '0')}`, r.restrictionClass, r.balanceCents, r.asOf));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { netAssets: records.length, inserted } };
}

function coerceFederalRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let awardId = null;
        if ('award_id' in mapping) awardId = requiredText(cell, row, lineNo, mapping, 'award_id');
        return {
            lineNo,
            awardId,
            fiscalYear: at('fiscal_year', coerceFiscalYear),
            programName: requiredText(cell, row, lineNo, mapping, 'program_name'),
            cfdaNumber: requiredText(cell, row, lineNo, mapping, 'cfda_number'),
            expendedCents: at('expended', coerceNonNegativeMoney),
        };
    });
}

/**
 * Apply the federal awards onto the ledger, filling federal_awards so
 * single-audit-threshold can sum federal spending per fiscal year against the
 * 2 CFR 200.501 trigger.
 */
export function applyFederalAwardsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'federal awards', mapping, CANONICAL_NONPROFIT_FEDERAL_FIELDS);
    const records = coerceFederalRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.awardId) continue;
        if (seen.has(r.awardId)) throw new ImportError(`The federal awards file lists award id "${r.awardId}" more than once.`);
        seen.add(r.awardId);
    }
    const inserted = withLedgerTxn(dbPath, 'federal awards', (db) => {
        const ins = db.prepare('INSERT INTO federal_awards (award_id, fiscal_year, program_name, cfda_number, expended_cents) VALUES (?, ?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.awardId || `FA-${String(i + 1).padStart(4, '0')}`, r.fiscalYear, r.programName, r.cfdaNumber, r.expendedCents));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { awards: records.length, inserted } };
}

// Re-export the shared mapping engine so callers can propose/validate nonprofit
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
