/**
 * Import a law firm's own client-trust (IOLTA) export into the canonical IOLTA
 * schema the five iolta-v1 controls run against.
 *
 * This is the IOLTA counterpart to the municipal importer (import-csv.js): it
 * holds the same promise — the numbers that come out are exactly the numbers
 * that went in, and the record says which file was read and how its columns were
 * understood — but it targets a different warehouse. The genuinely shared parts
 * (the RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, ImportError) are reused from import-csv.js;
 * only the IOLTA-specific schema, field specs, coercers and loaders live here.
 *
 * A firm's trust accounting is three things, so an import is up to three files:
 *   1. The trust journal — one row per movement of client money (the primary
 *      file; it builds the ledger). entry_type carries the sign and the amount
 *      is always positive, matching the warehouse's CHECK constraint.
 *   2. The bank reconciliation snapshots — needed so three-way-reconciliation
 *      has an adjusted bank balance to tie to. Optional.
 *   3. The fee invoices — needed so unsupported-fee-transfers can confirm each
 *      earned-fee transfer cites, and does not exceed, a real invoice. Optional.
 *
 * Client PII never enters: the demo warehouse keeps a client_contacts table only
 * so the guard has something to refuse, but there is no mapping target for a
 * name, email, phone or address here, so an imported ledger simply has no column
 * that could hold one. The ledger identifies clients and matters by ID only, and
 * the copied allow-list lists only the three non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder
 * lives in paths.js and is applied by the callers, exactly as for municipal.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { IOLTA_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical IOLTA schema ────────────────────────────────────────────────────
//
// The three tables the iolta-v1 ruleset reads, reproduced from the demo seed
// (sample_iolta_trust.sql) minus the seed rows and minus client_contacts (PII,
// which the import never carries). Kept here, beside the importer, so the shape
// the loader writes and the shape the controls query are defined together.
export const IOLTA_SCHEMA_VERSION = 'iolta-canonical-v1';

export const IOLTA_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE trust_journal (
  entry_id       TEXT PRIMARY KEY,
  client_id      TEXT,
  matter_id      TEXT,
  entry_type     TEXT NOT NULL CHECK (entry_type IN ('CLIENT_DEPOSIT', 'CLIENT_DISBURSEMENT', 'EARNED_FEE_TRANSFER', 'FIRM_BUFFER_IN')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  invoice_id     TEXT,
  cleared_status TEXT NOT NULL CHECK (cleared_status IN ('CLEARED', 'OUTSTANDING')),
  entry_date     TEXT NOT NULL
);

CREATE TABLE trust_bank_snapshots (
  snapshot_id                  TEXT PRIMARY KEY,
  snapshot_date                TEXT NOT NULL,
  bank_statement_balance_cents INTEGER NOT NULL,
  deposits_in_transit_cents    INTEGER NOT NULL,
  outstanding_checks_cents     INTEGER NOT NULL
);

CREATE TABLE fee_invoices (
  invoice_id           TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  matter_id            TEXT NOT NULL,
  invoice_amount_cents INTEGER NOT NULL,
  invoice_date         TEXT NOT NULL
);
`;

// ── mapping targets ────────────────────────────────────────────────────────────
//
// The trust journal is the primary file: one row is one movement of client
// money. Only entry_type, amount and entry_date are required to produce a usable
// ledger. A blank client_id is kept as NULL (an unidentified deposit, which the
// reconciliation and negative-balance controls are meant to surface), so it is
// deliberately optional. entry_id is generated in file order when unmapped.
export const CANONICAL_IOLTA_JOURNAL_FIELDS = Object.freeze([
    { field: 'entry_date', type: 'date', required: true,
      synonyms: ['date', 'entry date', 'transaction date', 'posted date', 'txn date'],
      description: 'When the money moved.' },
    { field: 'entry_type', type: 'iolta_entry_type', required: true,
      synonyms: ['type', 'entry type', 'transaction type', 'txn type', 'activity', 'category'],
      description: 'deposit / disbursement / earned-fee transfer / firm buffer; carries the sign.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'amount cents', 'value', 'debit', 'credit', 'total'],
      description: 'The movement amount, always positive; the entry type carries the sign. Coerced to integer cents.' },
    { field: 'client_id', type: 'text', required: false,
      synonyms: ['client', 'client id', 'client number', 'account', 'ledger', 'ledger id'],
      description: "The client ledger the money belongs to; blank is kept NULL (an unidentified deposit). Use 'FIRM-BUFFER' for the firm's service-charge buffer card." },
    { field: 'matter_id', type: 'text', required: false,
      synonyms: ['matter', 'matter id', 'matter number', 'case', 'case id', 'file', 'file number'],
      description: 'The matter the money belongs to.' },
    { field: 'invoice_id', type: 'text', required: false,
      synonyms: ['invoice', 'invoice id', 'invoice number', 'invoice no', 'bill', 'bill number', 'reference'],
      description: 'For an earned-fee transfer, the fee invoice it draws against.' },
    { field: 'cleared_status', type: 'iolta_cleared_status', required: false,
      synonyms: ['cleared', 'cleared status', 'status', 'bank status', 'reconciled'],
      description: 'cleared / outstanding (defaults to cleared). Outstanding items are what the bank reconciliation subtracts.' },
    { field: 'entry_id', type: 'text', required: false,
      synonyms: ['entry id', 'entry', 'id', 'journal id', 'transaction id', 'txn id', 'check number', 'check no'],
      description: "The firm's own id for the entry; generated (T-0001…) in file order when unmapped." },
]);

// The bank snapshots file: one row per point-in-time reconciliation. The
// three-way control reads the most recent by date. deposits-in-transit and
// outstanding-checks default to 0 when the export omits them.
export const CANONICAL_IOLTA_BANK_FIELDS = Object.freeze([
    { field: 'snapshot_date', type: 'date', required: true,
      synonyms: ['date', 'snapshot date', 'statement date', 'as of', 'as of date', 'reconciliation date'],
      description: 'The reconciliation / statement date.' },
    { field: 'bank_statement_balance', type: 'money', required: true,
      synonyms: ['bank balance', 'statement balance', 'bank statement balance', 'ending balance', 'balance'],
      description: 'The bank statement balance; coerced to cents.' },
    { field: 'deposits_in_transit', type: 'money', required: false,
      synonyms: ['deposits in transit', 'in transit', 'deposits', 'dit'],
      description: 'Deposits recorded but not yet on the statement (defaults to 0); coerced to cents.' },
    { field: 'outstanding_checks', type: 'money', required: false,
      synonyms: ['outstanding checks', 'outstanding', 'uncleared checks', 'checks outstanding'],
      description: 'Checks written but not yet cleared (defaults to 0); coerced to cents.' },
    { field: 'snapshot_id', type: 'text', required: false,
      synonyms: ['snapshot id', 'snapshot', 'id', 'reconciliation id', 'statement id'],
      description: 'The firm\'s own id for the snapshot; generated (S-0001…) in file order when unmapped.' },
]);

// The fee invoices file: one row per billed invoice. An earned-fee transfer out
// of trust is supported only when it cites one of these and does not exceed it.
export const CANONICAL_IOLTA_INVOICE_FIELDS = Object.freeze([
    { field: 'invoice_id', type: 'text', required: true,
      synonyms: ['invoice', 'invoice id', 'invoice number', 'invoice no', 'bill', 'bill number'],
      description: 'The invoice id; must match the invoice_id an earned-fee transfer cites.' },
    { field: 'client_id', type: 'text', required: true,
      synonyms: ['client', 'client id', 'client number', 'account'],
      description: 'The client billed.' },
    { field: 'matter_id', type: 'text', required: true,
      synonyms: ['matter', 'matter id', 'matter number', 'case', 'case id', 'file'],
      description: 'The matter billed.' },
    { field: 'invoice_amount', type: 'money', required: true,
      synonyms: ['amount', 'invoice amount', 'fee', 'fees', 'total', 'billed', 'billed amount'],
      description: 'The invoice total; coerced to integer cents.' },
    { field: 'invoice_date', type: 'date', required: true,
      synonyms: ['date', 'invoice date', 'bill date', 'billed date'],
      description: 'The invoice date.' },
]);

// ── IOLTA-specific coercion ────────────────────────────────────────────────────

const ENTRY_TYPE_MAP = new Map([
    ['client_deposit', 'CLIENT_DEPOSIT'], ['deposit', 'CLIENT_DEPOSIT'], ['client deposit', 'CLIENT_DEPOSIT'],
    ['receipt', 'CLIENT_DEPOSIT'], ['trust deposit', 'CLIENT_DEPOSIT'], ['retainer', 'CLIENT_DEPOSIT'],
    ['client_disbursement', 'CLIENT_DISBURSEMENT'], ['disbursement', 'CLIENT_DISBURSEMENT'],
    ['client disbursement', 'CLIENT_DISBURSEMENT'], ['payment', 'CLIENT_DISBURSEMENT'],
    ['withdrawal', 'CLIENT_DISBURSEMENT'], ['check', 'CLIENT_DISBURSEMENT'], ['disbursed', 'CLIENT_DISBURSEMENT'],
    ['earned_fee_transfer', 'EARNED_FEE_TRANSFER'], ['earned fee transfer', 'EARNED_FEE_TRANSFER'],
    ['earned fee', 'EARNED_FEE_TRANSFER'], ['fee transfer', 'EARNED_FEE_TRANSFER'],
    ['fee', 'EARNED_FEE_TRANSFER'], ['fee withdrawal', 'EARNED_FEE_TRANSFER'], ['transfer to firm', 'EARNED_FEE_TRANSFER'],
    ['firm_buffer_in', 'FIRM_BUFFER_IN'], ['firm buffer in', 'FIRM_BUFFER_IN'], ['firm buffer', 'FIRM_BUFFER_IN'],
    ['buffer', 'FIRM_BUFFER_IN'], ['firm deposit', 'FIRM_BUFFER_IN'], ['firm funds', 'FIRM_BUFFER_IN'],
]);

/** Map a raw transaction type to the warehouse's four entry types, or throw. */
export function coerceEntryType(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = ENTRY_TYPE_MAP.get(s);
    if (!mapped) {
        throw new ImportError(
            `unrecognised entry type: "${raw}" (expected a deposit, disbursement, earned-fee transfer or firm buffer)`,
        );
    }
    return mapped;
}

const CLEARED_STATUS_MAP = new Map([
    ['cleared', 'CLEARED'], ['clear', 'CLEARED'], ['reconciled', 'CLEARED'], ['paid', 'CLEARED'], ['posted', 'CLEARED'],
    ['outstanding', 'OUTSTANDING'], ['uncleared', 'OUTSTANDING'], ['pending', 'OUTSTANDING'],
    ['in transit', 'OUTSTANDING'], ['open', 'OUTSTANDING'], ['not cleared', 'OUTSTANDING'],
]);

/** Map a raw cleared/outstanding status to the schema's set. Empty defaults to CLEARED. */
export function coerceClearedStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return 'CLEARED';
    const mapped = CLEARED_STATUS_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised cleared status: "${raw}" (expected cleared or outstanding)`);
    return mapped;
}

/** Coerce a required, non-negative money amount; the entry type carries the sign. */
function coercePositiveMoney(raw) {
    const cents = coerceMoneyToCents(raw);
    if (cents < 0) {
        throw new ImportError(
            `amount must be non-negative (the entry type carries the sign): "${raw}"`,
        );
    }
    return cents;
}

// ── trust journal: build the ledger ────────────────────────────────────────────

/**
 * Coerce the raw trust-journal rows under a confirmed mapping. One row is one
 * movement of client money. Coercion throws, naming the row and column, rather
 * than writing a malformed entry.
 */
function coerceJournalRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const clientId = 'client_id' in mapping ? (String(cell(row, 'client_id')).trim() || null) : null;
        const matterId = 'matter_id' in mapping ? (String(cell(row, 'matter_id')).trim() || null) : null;
        const invoiceId = 'invoice_id' in mapping ? (String(cell(row, 'invoice_id')).trim() || null) : null;
        let entryId = null;
        if ('entry_id' in mapping) {
            entryId = String(cell(row, 'entry_id')).trim();
            if (entryId === '') throw new ImportError(`Row ${lineNo}, column "${mapping.entry_id}": empty entry id`);
        }
        return {
            lineNo,
            entryId,
            clientId,
            matterId,
            invoiceId,
            entryType: at('entry_type', coerceEntryType),
            amountCents: at('amount', coercePositiveMoney),
            clearedStatus: 'cleared_status' in mapping ? at('cleared_status', coerceClearedStatus) : 'CLEARED',
            entryDate: at('entry_date', normalizeDate),
        };
    });
}

/** Write the coerced journal rows into the open database, generating ids where needed. */
function loadJournal(db, records) {
    const ins = db.prepare(
        'INSERT INTO trust_journal (entry_id, client_id, matter_id, entry_type, amount_cents, invoice_id, cleared_status, entry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    records.forEach((r, i) => {
        const id = r.entryId || `T-${String(i + 1).padStart(4, '0')}`;
        if (seen.has(id)) throw new ImportError(`The trust journal lists entry id "${id}" more than once.`);
        seen.add(id);
        ins.run(id, r.clientId, r.matterId, r.entryType, r.amountCents, r.invoiceId, r.clearedStatus, r.entryDate);
    });
    const clients = new Set(records.map((r) => r.clientId).filter(Boolean));
    return { rowCount: records.length, clients: clients.size };
}

/**
 * Build a canonical IOLTA ledger database from a trust-journal CSV and a
 * confirmed mapping. Atomic: writes a temp database and renames on success, so an
 * aborted build (including a malformed value) never leaves a half-written ledger
 * behind. Copies the bundled IOLTA allow-list beside it so the five named queries
 * are serveable immediately (the two optional registers are applied afterward).
 */
export function buildIoltaLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = IOLTA_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_IOLTA_JOURNAL_FIELDS);
    if (rows.length === 0) throw new ImportError('The trust journal has a header but no data rows.');
    const records = coerceJournalRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(IOLTA_SCHEMA_DDL);
            counts = loadJournal(db, records);
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

// ── bank snapshots: apply onto the ledger ──────────────────────────────────────

function coerceBankRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let snapshotId = null;
        if ('snapshot_id' in mapping) {
            snapshotId = String(cell(row, 'snapshot_id')).trim();
            if (snapshotId === '') throw new ImportError(`Row ${lineNo}, column "${mapping.snapshot_id}": empty snapshot id`);
        }
        const optionalCents = (field) =>
            field in mapping && String(cell(row, field)).trim() !== '' ? at(field, coerceMoneyToCents) : 0;
        return {
            lineNo,
            snapshotId,
            snapshotDate: at('snapshot_date', normalizeDate),
            bankStatementCents: at('bank_statement_balance', coerceMoneyToCents),
            depositsInTransitCents: optionalCents('deposits_in_transit'),
            outstandingChecksCents: optionalCents('outstanding_checks'),
        };
    });
}

/**
 * Apply a bank-snapshots register onto an existing imported IOLTA ledger, filling
 * trust_bank_snapshots so three-way-reconciliation has an adjusted bank balance
 * to tie to. One transaction: a malformed row aborts it and leaves the ledger
 * untouched. snapshot_id is taken from the file when mapped (and must be unique),
 * else generated S-0001… in file order.
 */
export function applyBankSnapshotsToLedger({ csvPath, mapping, dbPath }) {
    if (!existsSync(csvPath)) throw new ImportError(`bank snapshots not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the bank snapshots to: ${dbPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_IOLTA_BANK_FIELDS);
    if (rows.length === 0) throw new ImportError('The bank snapshots file has a header but no data rows.');
    const snaps = coerceBankRows(rows, headers, mapping);

    const seen = new Set();
    for (const s of snaps) {
        if (!s.snapshotId) continue;
        if (seen.has(s.snapshotId)) throw new ImportError(`The bank snapshots file lists snapshot "${s.snapshotId}" more than once.`);
        seen.add(s.snapshotId);
    }

    const db = new DatabaseSync(dbPath);
    try {
        const insert = db.prepare(
            'INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, bank_statement_balance_cents, deposits_in_transit_cents, outstanding_checks_cents) VALUES (?, ?, ?, ?, ?)',
        );
        let inserted = 0;
        db.exec('BEGIN');
        try {
            snaps.forEach((s, i) => {
                const id = s.snapshotId || `S-${String(i + 1).padStart(4, '0')}`;
                insert.run(id, s.snapshotDate, s.bankStatementCents, s.depositsInTransitCents, s.outstandingChecksCents);
                inserted += 1;
            });
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { sourceFileSha256, byteLength: bytes.length, counts: { snapshots: snaps.length, inserted } };
    } finally {
        db.close();
    }
}

// ── fee invoices: apply onto the ledger ─────────────────────────────────────────

function coerceInvoiceRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const required = (field) => {
            const v = String(cell(row, field)).trim();
            if (v === '') throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": empty ${field.replace(/_/g, ' ')}`);
            return v;
        };
        return {
            lineNo,
            invoiceId: required('invoice_id'),
            clientId: required('client_id'),
            matterId: required('matter_id'),
            invoiceAmountCents: at('invoice_amount', coerceMoneyToCents),
            invoiceDate: at('invoice_date', normalizeDate),
        };
    });
}

/**
 * Apply a fee-invoices register onto an existing imported IOLTA ledger, filling
 * fee_invoices so unsupported-fee-transfers can confirm each earned-fee transfer
 * cites, and does not exceed, a real invoice. One transaction: a malformed or
 * duplicate row aborts it and leaves the ledger untouched.
 */
export function applyFeeInvoicesToLedger({ csvPath, mapping, dbPath }) {
    if (!existsSync(csvPath)) throw new ImportError(`fee invoices not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the fee invoices to: ${dbPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_IOLTA_INVOICE_FIELDS);
    if (rows.length === 0) throw new ImportError('The fee invoices file has a header but no data rows.');
    const invoices = coerceInvoiceRows(rows, headers, mapping);

    const seen = new Set();
    for (const inv of invoices) {
        if (seen.has(inv.invoiceId)) throw new ImportError(`The fee invoices file lists invoice "${inv.invoiceId}" more than once.`);
        seen.add(inv.invoiceId);
    }

    const db = new DatabaseSync(dbPath);
    try {
        const insert = db.prepare(
            'INSERT INTO fee_invoices (invoice_id, client_id, matter_id, invoice_amount_cents, invoice_date) VALUES (?, ?, ?, ?, ?)',
        );
        let inserted = 0;
        db.exec('BEGIN');
        try {
            for (const inv of invoices) {
                insert.run(inv.invoiceId, inv.clientId, inv.matterId, inv.invoiceAmountCents, inv.invoiceDate);
                inserted += 1;
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { sourceFileSha256, byteLength: bytes.length, counts: { invoices: invoices.length, inserted } };
    } finally {
        db.close();
    }
}

// Re-export the shared mapping engine so callers can propose/validate IOLTA
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
