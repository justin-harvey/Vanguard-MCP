/**
 * Import an insurance agency's own premium-trust and policy export into the
 * canonical insurance schema the three insurance-v1 controls run against.
 *
 * This is the insurance counterpart to the municipal (import-csv.js), IOLTA
 * (import-iolta.js), construction (import-construction.js) and nonprofit
 * (import-nonprofit.js) importers: it holds the same promise — the numbers that
 * come out are exactly the numbers that went in, and the record says which file
 * was read and how its columns were understood — but it targets the insurance
 * warehouse. The genuinely shared parts (the RFC-4180 CSV reader, exact-cents
 * money and ISO-date coercion, the propose/validate mapping engine, ImportError)
 * are reused from import-csv.js; only the insurance-specific schema, field specs,
 * coercers and loaders live here.
 *
 * An agency's fiduciary duty turns on the premium-trust ledger — client premium
 * in, carrier remittances out, the agency's own commission draws — so the trust
 * ledger is the primary file and four companion files reconcile against it:
 *   1. The premium-trust ledger — one row per trust movement (the primary file;
 *      it builds the ledger). entry_type and reconciled_status are what
 *      trust-account-solvency and eo-unbound-exposure read.
 *   2. The policies — one row per policy written, with the carrier's contracted
 *      commission rate (basis points). commission-variance-audit reads it. Loaded
 *      before receipts and binders, which reference it. Optional.
 *   3. The commission receipts — commission actually paid by carriers per policy,
 *      so commission-variance-audit has a paid figure to measure against the
 *      contracted rate. Optional.
 *   4. The binders — carrier-confirmation status per policy, so eo-unbound-exposure
 *      can flag client premium held for coverage that is not yet bound. Optional.
 *   5. The trust bank snapshots — point-in-time statements of the actual trust
 *      bank balance, so trust-account-solvency has a balance to compare the net
 *      trust liability against. Optional.
 *
 * Insured PII never enters: the demo warehouse keeps an insured_pii table (SSNs,
 * health notes) only so the guard has something to refuse, but there is no mapping
 * target for a name, SSN or health condition here, so an imported ledger simply
 * has no column that could hold one. The controls identify policies and carriers
 * by code only, and the copied allow-list lists only the five non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for the other packs.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { INSURANCE_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical insurance schema ──────────────────────────────────────────────────
//
// The five tables the insurance-v1 ruleset reads, reproduced from the demo seed
// (sample_insurance_trust.sql) minus the seed rows and minus insured_pii (PII,
// which the import never carries). Kept here, beside the importer, so the shape
// the loaders write and the shape the controls query are defined together.
// commission_receipts and binders reference policies, so policies is loaded first
// and foreign-key enforcement stays on through the companion loaders.
export const INSURANCE_SCHEMA_VERSION = 'insurance-canonical-v1';

export const INSURANCE_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE trust_ledger (
  entry_id          TEXT PRIMARY KEY,
  policy_id         TEXT,
  carrier_code      TEXT,
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('CLIENT_PREMIUM_IN', 'CARRIER_REMIT_OUT', 'AGENCY_COMMISSION_DRAW')),
  amount_cents      INTEGER NOT NULL,
  reconciled_status TEXT NOT NULL CHECK (reconciled_status IN ('POSTED', 'PENDING')),
  entry_date        TEXT NOT NULL
);

CREATE TABLE policies (
  policy_id             TEXT PRIMARY KEY,
  carrier_code          TEXT NOT NULL,
  line_of_business      TEXT NOT NULL,
  written_premium_cents INTEGER NOT NULL,
  contracted_comm_bps   INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE', 'BOUND', 'CANCELLED'))
);

CREATE TABLE commission_receipts (
  receipt_id      TEXT PRIMARY KEY,
  policy_id       TEXT NOT NULL REFERENCES policies(policy_id),
  paid_comm_cents INTEGER NOT NULL
);

CREATE TABLE binders (
  binder_id         TEXT PRIMARY KEY,
  policy_id         TEXT NOT NULL REFERENCES policies(policy_id),
  carrier_confirmed INTEGER NOT NULL CHECK (carrier_confirmed IN (0, 1)),
  effective_date    TEXT
);

CREATE TABLE trust_bank_snapshots (
  snapshot_id               TEXT PRIMARY KEY,
  snapshot_date             TEXT NOT NULL,
  actual_bank_balance_cents INTEGER NOT NULL
);
`;

// ── mapping targets ──────────────────────────────────────────────────────────
//
// The premium-trust ledger is the primary file: one row is one trust movement.
// entry_type, amount, reconciled_status and date are required; policy_id and
// carrier_code are optional (an agency commission draw carries neither).
export const CANONICAL_INSURANCE_LEDGER_FIELDS = Object.freeze([
    { field: 'entry_id', type: 'text', required: true,
      synonyms: ['entry id', 'entry', 'id', 'transaction id', 'txn id', 'ledger id', 'reference', 'ref'],
      description: 'The trust-ledger entry id (primary key).' },
    { field: 'entry_type', type: 'insurance_entry_type', required: true,
      synonyms: ['entry type', 'type', 'transaction type', 'txn type', 'kind', 'movement'],
      description: 'client premium in / carrier remit out / agency commission draw.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'amount cents', 'value', 'debit', 'credit', 'transaction amount'],
      description: 'The trust movement amount; coerced to integer cents.' },
    { field: 'reconciled_status', type: 'insurance_reconciled_status', required: true,
      synonyms: ['reconciled status', 'status', 'reconciliation', 'reconciled', 'posted status', 'cleared'],
      description: "posted / pending — the solvency control counts POSTED movements only." },
    { field: 'entry_date', type: 'date', required: true,
      synonyms: ['entry date', 'date', 'transaction date', 'posted date', 'txn date'],
      description: 'When the movement posted (YYYY-MM-DD or MM/DD/YYYY).' },
    { field: 'policy_id', type: 'text', required: false,
      synonyms: ['policy', 'policy id', 'policy number', 'policy no', 'policy #'],
      description: 'The policy the movement relates to; blank for an agency-level commission draw.' },
    { field: 'carrier_code', type: 'text', required: false,
      synonyms: ['carrier', 'carrier code', 'carrier id', 'insurer', 'underwriter', 'market'],
      description: 'The carrier the movement relates to; blank for an agency-level commission draw.' },
]);

// The policies file: one row per policy. commission-variance-audit reads the
// written premium and the contracted commission rate to derive the expected
// commission. The carrier contract's rate is stored in basis points
// (1500 = 15%). Loaded before receipts and binders (which reference policy_id).
export const CANONICAL_INSURANCE_POLICY_FIELDS = Object.freeze([
    { field: 'policy_id', type: 'text', required: true,
      synonyms: ['policy', 'policy id', 'policy number', 'policy no', 'policy #'],
      description: 'The policy id; the key the receipts and binders join on.' },
    { field: 'carrier_code', type: 'text', required: true,
      synonyms: ['carrier', 'carrier code', 'carrier id', 'insurer', 'underwriter', 'market'],
      description: 'The carrier that wrote the policy.' },
    { field: 'line_of_business', type: 'text', required: true,
      synonyms: ['line of business', 'line', 'lob', 'coverage', 'product', 'policy type', 'class'],
      description: 'The line of business, e.g. COMMERCIAL_AUTO, GENERAL_LIABILITY, PROPERTY.' },
    { field: 'written_premium', type: 'money', required: true,
      synonyms: ['written premium', 'premium', 'premium written', 'written', 'gross premium', 'annual premium'],
      description: 'The written premium; coerced to integer cents.' },
    { field: 'contracted_comm_bps', type: 'insurance_commission_bps', required: true,
      synonyms: ['contracted commission', 'commission rate', 'commission bps', 'commission', 'comm rate', 'comm bps', 'rate'],
      description: 'The carrier-contracted commission rate: basis points (1500) or a percentage (15%).' },
    { field: 'status', type: 'insurance_policy_status', required: true,
      synonyms: ['status', 'policy status', 'state', 'policy state'],
      description: 'active / bound / cancelled — the variance audit examines active and bound policies only.' },
]);

// The commission receipts file: one row per receipt. A policy may have several;
// commission-variance-audit sums them to the actual commission paid.
export const CANONICAL_INSURANCE_RECEIPT_FIELDS = Object.freeze([
    { field: 'receipt_id', type: 'text', required: true,
      synonyms: ['receipt id', 'receipt', 'id', 'statement id', 'reference', 'ref'],
      description: 'The commission-receipt id (primary key).' },
    { field: 'policy_id', type: 'text', required: true,
      synonyms: ['policy', 'policy id', 'policy number', 'policy no', 'policy #'],
      description: 'The policy the commission was paid on.' },
    { field: 'paid_comm', type: 'money', required: true,
      synonyms: ['paid commission', 'commission paid', 'paid comm', 'amount', 'commission', 'paid', 'commission amount'],
      description: 'The commission the carrier actually paid; coerced to integer cents.' },
]);

// The binders file: one row per binder. eo-unbound-exposure reads carrier_confirmed
// to decide whether client premium is held for coverage that is bound.
export const CANONICAL_INSURANCE_BINDER_FIELDS = Object.freeze([
    { field: 'binder_id', type: 'text', required: true,
      synonyms: ['binder id', 'binder', 'id', 'reference', 'ref'],
      description: 'The binder id (primary key).' },
    { field: 'policy_id', type: 'text', required: true,
      synonyms: ['policy', 'policy id', 'policy number', 'policy no', 'policy #'],
      description: 'The policy the binder covers.' },
    { field: 'carrier_confirmed', type: 'insurance_bound_status', required: true,
      synonyms: ['carrier confirmed', 'confirmed', 'bound', 'binding status', 'bind status', 'coverage confirmed', 'status'],
      description: 'yes/confirmed/bound → 1, no/pending/unconfirmed → 0; blank reads as not confirmed (0).' },
    { field: 'effective_date', type: 'date', required: false,
      synonyms: ['effective date', 'bind date', 'date', 'effective', 'coverage date'],
      description: 'The date coverage is effective (optional).' },
]);

// The trust bank snapshots file: one row per statement. trust-account-solvency
// reads the most recent snapshot by date as the actual trust bank balance.
export const CANONICAL_INSURANCE_SNAPSHOT_FIELDS = Object.freeze([
    { field: 'snapshot_id', type: 'text', required: true,
      synonyms: ['snapshot id', 'snapshot', 'id', 'statement id', 'reference', 'ref'],
      description: 'The bank-snapshot id (primary key).' },
    { field: 'snapshot_date', type: 'date', required: true,
      synonyms: ['snapshot date', 'date', 'statement date', 'as of', 'as of date', 'balance date'],
      description: 'The statement date (YYYY-MM-DD); the latest is the one the solvency check reads.' },
    { field: 'actual_bank_balance', type: 'money', required: true,
      synonyms: ['actual bank balance', 'bank balance', 'balance', 'actual balance', 'statement balance', 'ending balance'],
      description: 'The actual trust bank balance on the statement; coerced to integer cents.' },
]);

// ── insurance-specific coercion ────────────────────────────────────────────────

const ENTRY_TYPE_MAP = new Map([
    ['client_premium_in', 'CLIENT_PREMIUM_IN'], ['client premium in', 'CLIENT_PREMIUM_IN'],
    ['client premium', 'CLIENT_PREMIUM_IN'], ['premium in', 'CLIENT_PREMIUM_IN'], ['premium', 'CLIENT_PREMIUM_IN'],
    ['premium received', 'CLIENT_PREMIUM_IN'], ['premium collected', 'CLIENT_PREMIUM_IN'],
    ['carrier_remit_out', 'CARRIER_REMIT_OUT'], ['carrier remit out', 'CARRIER_REMIT_OUT'],
    ['carrier remittance', 'CARRIER_REMIT_OUT'], ['remittance', 'CARRIER_REMIT_OUT'], ['remit', 'CARRIER_REMIT_OUT'],
    ['carrier payment', 'CARRIER_REMIT_OUT'], ['remit to carrier', 'CARRIER_REMIT_OUT'],
    ['agency_commission_draw', 'AGENCY_COMMISSION_DRAW'], ['agency commission draw', 'AGENCY_COMMISSION_DRAW'],
    ['commission draw', 'AGENCY_COMMISSION_DRAW'], ['agency draw', 'AGENCY_COMMISSION_DRAW'],
    ['commission', 'AGENCY_COMMISSION_DRAW'], ['draw', 'AGENCY_COMMISSION_DRAW'], ['commission sweep', 'AGENCY_COMMISSION_DRAW'],
]);

/** Map a raw trust-ledger entry type to one of the three canonical types, or throw. */
export function coerceEntryType(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = ENTRY_TYPE_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised entry type: "${raw}" (expected client premium in, carrier remit out or agency commission draw)`);
    }
    return mapped;
}

const RECONCILED_STATUS_MAP = new Map([
    ['posted', 'POSTED'], ['reconciled', 'POSTED'], ['cleared', 'POSTED'], ['settled', 'POSTED'], ['complete', 'POSTED'],
    ['pending', 'PENDING'], ['unposted', 'PENDING'], ['uncleared', 'PENDING'], ['open', 'PENDING'], ['in transit', 'PENDING'],
]);

/** Map a raw reconciliation status to POSTED / PENDING, or throw. */
export function coerceReconciledStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = RECONCILED_STATUS_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised reconciled status: "${raw}" (expected posted or pending)`);
    }
    return mapped;
}

const POLICY_STATUS_MAP = new Map([
    ['active', 'ACTIVE'], ['in force', 'ACTIVE'], ['inforce', 'ACTIVE'], ['in-force', 'ACTIVE'], ['live', 'ACTIVE'],
    ['bound', 'BOUND'], ['binding', 'BOUND'],
    ['cancelled', 'CANCELLED'], ['canceled', 'CANCELLED'], ['void', 'CANCELLED'], ['lapsed', 'CANCELLED'],
    ['terminated', 'CANCELLED'], ['expired', 'CANCELLED'],
]);

/** Map a raw policy status to ACTIVE / BOUND / CANCELLED, or throw. */
export function coercePolicyStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = POLICY_STATUS_MAP.get(s);
    if (!mapped) {
        throw new ImportError(`unrecognised policy status: "${raw}" (expected active, bound or cancelled)`);
    }
    return mapped;
}

/**
 * Coerce a carrier-contracted commission rate to integer basis points. Two forms
 * are accepted: a bare integer is basis points as-is (1500 → 1500), and a value
 * with a trailing percent sign is a percentage (15% → 1500, 12.5% → 1250).
 * Anything else throws, so a bare decimal is never silently mis-scaled.
 */
export function coerceCommissionBps(raw) {
    const s = String(raw).trim();
    if (s === '') throw new ImportError('empty commission rate');
    if (s.endsWith('%')) {
        const pct = s.slice(0, -1).trim();
        if (!/^\d+(\.\d+)?$/.test(pct)) throw new ImportError(`not a percentage: "${raw}"`);
        return Math.round(Number(pct) * 100);
    }
    if (/^\d+$/.test(s)) return Number(s);
    throw new ImportError(`not a commission rate: "${raw}" (give basis points like 1500, or a percentage like 15%)`);
}

const CONFIRMED_YES = new Set(['yes', 'y', 'true', '1', 'confirmed', 'bound', 'carrier confirmed', 'on file', 'confirmed by carrier', 'is bound']);
const CONFIRMED_NO = new Set(['no', 'n', 'false', '0', 'pending', 'unconfirmed', 'not confirmed', 'not bound', 'unbound', '']);

/** Coerce a carrier-confirmed status to 1/0 (blank reads as not confirmed), or throw. */
export function coerceCarrierConfirmed(raw) {
    const s = String(raw).trim().toLowerCase();
    if (CONFIRMED_YES.has(s)) return 1;
    if (CONFIRMED_NO.has(s)) return 0;
    throw new ImportError(`unrecognised carrier-confirmed status: "${raw}" (expected yes/confirmed or no/pending)`);
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

/** An optional text cell: the mapped value, or null when unmapped or blank. */
function nullableText(cell, row, mapping, field) {
    if (!(field in mapping)) return null;
    const v = String(cell(row, field)).trim();
    return v === '' ? null : v;
}

// ── trust ledger: build the ledger ────────────────────────────────────────────

function coerceLedgerRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            entryId: requiredText(cell, row, lineNo, mapping, 'entry_id'),
            policyId: nullableText(cell, row, mapping, 'policy_id'),
            carrierCode: nullableText(cell, row, mapping, 'carrier_code'),
            entryType: at('entry_type', coerceEntryType),
            amountCents: at('amount', coerceMoneyToCents),
            reconciledStatus: at('reconciled_status', coerceReconciledStatus),
            entryDate: at('entry_date', normalizeDate),
        };
    });
}

function loadTrustLedger(db, records) {
    const ins = db.prepare(
        'INSERT INTO trust_ledger (entry_id, policy_id, carrier_code, entry_type, amount_cents, reconciled_status, entry_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.entryId)) throw new ImportError(`The trust ledger lists entry id "${r.entryId}" more than once.`);
        seen.add(r.entryId);
        ins.run(r.entryId, r.policyId, r.carrierCode, r.entryType, r.amountCents, r.reconciledStatus, r.entryDate);
    }
    return { rowCount: records.length };
}

/**
 * Build a canonical insurance ledger database from a premium-trust ledger CSV and
 * a confirmed mapping. Atomic: writes a temp database and renames on success, so
 * an aborted build (including a malformed value) never leaves a half-written
 * ledger behind. Copies the bundled insurance allow-list beside it so the three
 * named queries are serveable immediately (the four optional companions are
 * applied afterward).
 */
export function buildInsuranceLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = INSURANCE_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_INSURANCE_LEDGER_FIELDS);
    if (rows.length === 0) throw new ImportError('The premium-trust ledger has a header but no data rows.');
    const records = coerceLedgerRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(INSURANCE_SCHEMA_DDL);
            counts = loadTrustLedger(db, records);
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
// transaction, with foreign-key enforcement on: a malformed, duplicate or
// dangling-reference row aborts it and leaves the ledger untouched. They share
// one shape, so the per-file differences (the coercer per field, the table) are
// all that vary. policies must be applied before commission_receipts and binders,
// which reference it.

/** Open the imported ledger, run `fn` inside one FK-enforced transaction, and close. */
function withLedgerTxn(dbPath, applyLabel, fn) {
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the ${applyLabel} to: ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
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

function coercePolicyRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            policyId: requiredText(cell, row, lineNo, mapping, 'policy_id'),
            carrierCode: requiredText(cell, row, lineNo, mapping, 'carrier_code'),
            lineOfBusiness: requiredText(cell, row, lineNo, mapping, 'line_of_business'),
            writtenPremiumCents: at('written_premium', coerceMoneyToCents),
            contractedCommBps: at('contracted_comm_bps', coerceCommissionBps),
            status: at('status', coercePolicyStatus),
        };
    });
}

/**
 * Apply the policies file onto the ledger, filling policies so
 * commission-variance-audit can derive each policy's expected commission.
 */
export function applyPoliciesToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'policies', mapping, CANONICAL_INSURANCE_POLICY_FIELDS);
    const records = coercePolicyRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.policyId)) throw new ImportError(`The policies file lists policy id "${r.policyId}" more than once.`);
        seen.add(r.policyId);
    }
    const inserted = withLedgerTxn(dbPath, 'policies', (db) => {
        const ins = db.prepare('INSERT INTO policies (policy_id, carrier_code, line_of_business, written_premium_cents, contracted_comm_bps, status) VALUES (?, ?, ?, ?, ?, ?)');
        records.forEach((r) => ins.run(r.policyId, r.carrierCode, r.lineOfBusiness, r.writtenPremiumCents, r.contractedCommBps, r.status));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { policies: records.length, inserted } };
}

function coerceReceiptRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            receiptId: requiredText(cell, row, lineNo, mapping, 'receipt_id'),
            policyId: requiredText(cell, row, lineNo, mapping, 'policy_id'),
            paidCommCents: at('paid_comm', coerceMoneyToCents),
        };
    });
}

/**
 * Apply the commission receipts onto the ledger, filling commission_receipts so
 * commission-variance-audit has the paid commission to measure against the
 * contracted rate. A receipt for a policy not in the ledger aborts (foreign key).
 */
export function applyCommissionReceiptsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'commission receipts', mapping, CANONICAL_INSURANCE_RECEIPT_FIELDS);
    const records = coerceReceiptRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.receiptId)) throw new ImportError(`The commission receipts file lists receipt id "${r.receiptId}" more than once.`);
        seen.add(r.receiptId);
    }
    const inserted = withLedgerTxn(dbPath, 'commission receipts', (db) => {
        const ins = db.prepare('INSERT INTO commission_receipts (receipt_id, policy_id, paid_comm_cents) VALUES (?, ?, ?)');
        try {
            records.forEach((r) => ins.run(r.receiptId, r.policyId, r.paidCommCents));
        } catch (error) {
            if (/FOREIGN KEY/i.test(error.message)) {
                throw new ImportError('A commission receipt references a policy that is not in the ledger; import the policies file first (or correct the policy id).');
            }
            throw error;
        }
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { receipts: records.length, inserted } };
}

function coerceBinderRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const effectiveDate = 'effective_date' in mapping && String(cell(row, 'effective_date')).trim() !== ''
            ? at('effective_date', normalizeDate) : null;
        return {
            lineNo,
            binderId: requiredText(cell, row, lineNo, mapping, 'binder_id'),
            policyId: requiredText(cell, row, lineNo, mapping, 'policy_id'),
            carrierConfirmed: at('carrier_confirmed', coerceCarrierConfirmed),
            effectiveDate,
        };
    });
}

/**
 * Apply the binders onto the ledger, filling binders so eo-unbound-exposure can
 * tell whether client premium is held for coverage that is carrier-confirmed. A
 * binder for a policy not in the ledger aborts (foreign key).
 */
export function applyBindersToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'binders', mapping, CANONICAL_INSURANCE_BINDER_FIELDS);
    const records = coerceBinderRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.binderId)) throw new ImportError(`The binders file lists binder id "${r.binderId}" more than once.`);
        seen.add(r.binderId);
    }
    const inserted = withLedgerTxn(dbPath, 'binders', (db) => {
        const ins = db.prepare('INSERT INTO binders (binder_id, policy_id, carrier_confirmed, effective_date) VALUES (?, ?, ?, ?)');
        try {
            records.forEach((r) => ins.run(r.binderId, r.policyId, r.carrierConfirmed, r.effectiveDate));
        } catch (error) {
            if (/FOREIGN KEY/i.test(error.message)) {
                throw new ImportError('A binder references a policy that is not in the ledger; import the policies file first (or correct the policy id).');
            }
            throw error;
        }
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { binders: records.length, inserted } };
}

function coerceSnapshotRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            snapshotId: requiredText(cell, row, lineNo, mapping, 'snapshot_id'),
            snapshotDate: at('snapshot_date', normalizeDate),
            actualBalanceCents: at('actual_bank_balance', coerceMoneyToCents),
        };
    });
}

/**
 * Apply the trust bank snapshots onto the ledger, filling trust_bank_snapshots so
 * trust-account-solvency has the latest actual balance to compare the net trust
 * liability against.
 */
export function applyBankSnapshotsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'trust bank snapshots', mapping, CANONICAL_INSURANCE_SNAPSHOT_FIELDS);
    const records = coerceSnapshotRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.snapshotId)) throw new ImportError(`The bank snapshots file lists snapshot id "${r.snapshotId}" more than once.`);
        seen.add(r.snapshotId);
    }
    const inserted = withLedgerTxn(dbPath, 'trust bank snapshots', (db) => {
        const ins = db.prepare('INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, actual_bank_balance_cents) VALUES (?, ?, ?)');
        records.forEach((r) => ins.run(r.snapshotId, r.snapshotDate, r.actualBalanceCents));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { snapshots: records.length, inserted } };
}

// Re-export the shared mapping engine so callers can propose/validate insurance
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
