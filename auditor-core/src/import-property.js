/**
 * Import a real estate broker's or property manager's own trust-account exports
 * into the canonical property schema the four property-trust-v1 controls run
 * against.
 *
 * This is the property counterpart to the municipal importer (import-csv.js): it
 * holds the same promise — the numbers that come out are exactly the numbers
 * that went in, and the record says which file was read and how its columns were
 * understood — but it targets the broker-trust warehouse. The genuinely shared
 * parts (the RFC-4180 CSV reader, exact-cents money and ISO-date coercion, the
 * propose/validate mapping engine, ImportError) are reused from import-csv.js;
 * only the property-specific schema, field specs, coercers and loaders live here.
 *
 * A brokerage's trust books are one ledger plus two dimensions, so an import is
 * up to three files:
 *   1. The trust ledger — every movement of beneficiary money in and out of the
 *      pooled trust account (the primary file; it builds the ledger). Each entry
 *      is tagged to a beneficiary ledger (OWNER funds or a tenant DEPOSIT) and
 *      carries its sign in entry_type (IN adds, OUT subtracts). The trust
 *      liability is the sum of every ledger balance.
 *   2. The bank snapshots — the point-in-time reconciliations trust-vs-liability
 *      reads the most recent of, to check the reconciled bank balance covers the
 *      liability.
 *   3. The leases — the managed leases whose security deposits must be held in
 *      trust (deposits-held-vs-owed) and returned on time (deposit-return-overdue).
 *
 * Resident-level data never enters: the demo warehouse keeps a resident_pii
 * table only so the guard has something to refuse, but there is no mapping
 * target for a tenant or owner name, SSN or bank account here, so an imported
 * ledger simply has no column that could hold one. The controls identify parties
 * by ledger, property and lease ID only, and the copied allow-list lists only the
 * three non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for municipal.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { PROPERTY_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical property schema ─────────────────────────────────────────────────
//
// The three tables the property-trust-v1 ruleset reads, reproduced from the demo
// seed (sample_property_trust.sql) minus the seed rows and minus resident_pii
// (tenant and owner names, SSNs and bank account numbers), which the import never
// carries. Kept here, beside the importer, so the shape the loader writes and the
// shape the controls query are defined together.
export const PROPERTY_SCHEMA_VERSION = 'property-canonical-v1';

export const PROPERTY_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE trust_ledger (
  entry_id     TEXT PRIMARY KEY,
  ledger_id    TEXT NOT NULL,
  ledger_type  TEXT NOT NULL CHECK (ledger_type IN ('OWNER', 'DEPOSIT')),
  property_id  TEXT NOT NULL,
  lease_id     TEXT,
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('IN', 'OUT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  entry_date   TEXT NOT NULL
);

CREATE TABLE trust_bank_snapshots (
  snapshot_id                  TEXT PRIMARY KEY,
  snapshot_date                TEXT NOT NULL,
  bank_statement_balance_cents INTEGER NOT NULL,
  deposits_in_transit_cents    INTEGER NOT NULL,
  outstanding_checks_cents     INTEGER NOT NULL
);

CREATE TABLE leases (
  lease_id               TEXT PRIMARY KEY,
  property_id            TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  security_deposit_cents INTEGER NOT NULL CHECK (security_deposit_cents >= 0),
  start_date             TEXT NOT NULL,
  move_out_date          TEXT,
  deposit_returned_date  TEXT
);
`;

// ── mapping targets ─────────────────────────────────────────────────────────────
//
// The trust ledger is the primary file: one row is one movement of beneficiary
// money. Only the beneficiary ledger, its type, the property, the sign, the
// amount and the date are required to produce a usable ledger. lease_id is blank
// for OWNER funds (and set for a DEPOSIT); entry_id is generated in file order
// when unmapped.
export const CANONICAL_PROPERTY_LEDGER_FIELDS = Object.freeze([
    { field: 'ledger_id', type: 'text', required: true,
      synonyms: ['ledger id', 'ledger', 'beneficiary', 'beneficiary ledger', 'owner id', 'ledger account'],
      description: 'The beneficiary ledger the money belongs to (an OWNER ledger or a tenant DEPOSIT ledger).' },
    { field: 'ledger_type', type: 'text', required: true,
      synonyms: ['ledger type', 'fund type', 'beneficiary type', 'ledger kind'],
      description: 'OWNER (rent held for a property owner) or DEPOSIT (a tenant security deposit).' },
    { field: 'property_id', type: 'text', required: true,
      synonyms: ['property id', 'property', 'building', 'property code', 'unit'],
      description: 'The property the money relates to.' },
    { field: 'entry_type', type: 'text', required: true,
      synonyms: ['entry type', 'direction', 'in or out', 'posting type', 'movement'],
      description: 'IN (money into the trust for this ledger) or OUT (money out); gives the amount its sign.' },
    { field: 'amount_cents', type: 'money', required: true,
      synonyms: ['amount', 'amount cents', 'entry amount', 'value'],
      description: 'The movement amount (always positive), coerced to integer cents; entry_type gives the sign.' },
    { field: 'entry_date', type: 'date', required: true,
      synonyms: ['entry date', 'date', 'posted date', 'transaction date'],
      description: 'When the movement was posted.' },
    { field: 'lease_id', type: 'text', required: false,
      synonyms: ['lease id', 'lease', 'lease ref', 'rental'],
      description: 'The lease for a DEPOSIT ledger; blank or unmapped means none (an OWNER entry).' },
    { field: 'entry_id', type: 'text', required: false,
      synonyms: ['entry id', 'id', 'reference', 'ref', 'transaction id'],
      description: "The broker's own id for the entry; generated (ENT-0001…) in file order when unmapped." },
]);

// The bank snapshots: one row per point-in-time reconciliation of the trust
// account. The deposits-in-transit and outstanding-checks amounts default to 0
// when unmapped; snapshot_id is generated in file order when unmapped.
export const CANONICAL_PROPERTY_SNAPSHOT_FIELDS = Object.freeze([
    { field: 'snapshot_date', type: 'date', required: true,
      synonyms: ['snapshot date', 'date', 'statement date', 'reconciliation date', 'as of date', 'as of'],
      description: 'The reconciliation date; trust-vs-liability reads the latest on or before its as-of date.' },
    { field: 'bank_statement_balance_cents', type: 'money', required: true,
      synonyms: ['bank statement balance', 'statement balance', 'bank balance', 'ending balance', 'balance'],
      description: 'The bank statement balance, coerced to integer cents.' },
    { field: 'deposits_in_transit_cents', type: 'money', required: false,
      synonyms: ['deposits in transit', 'in transit', 'deposits in transit cents'],
      description: 'Deposits in transit added to the statement (defaults to 0 when unmapped).' },
    { field: 'outstanding_checks_cents', type: 'money', required: false,
      synonyms: ['outstanding checks', 'outstanding cheques', 'uncleared checks', 'outstanding checks cents'],
      description: 'Outstanding checks subtracted from the statement (defaults to 0 when unmapped).' },
    { field: 'snapshot_id', type: 'text', required: false,
      synonyms: ['snapshot id', 'id', 'reference', 'statement id'],
      description: "The broker's own id for the snapshot; generated (SNAP-0001…) in file order when unmapped." },
]);

// The leases: one row per managed lease. status is ACTIVE or ENDED;
// security_deposit_cents is the deposit that must be held in trust. move_out_date
// and deposit_returned_date are set only on an ENDED lease. lease_id is the key
// the deposit controls reconcile against, so it is taken from the file (never generated).
export const CANONICAL_PROPERTY_LEASE_FIELDS = Object.freeze([
    { field: 'lease_id', type: 'text', required: true,
      synonyms: ['lease id', 'lease', 'lease ref', 'rental'],
      description: 'The lease id (the key the deposit controls reconcile against).' },
    { field: 'property_id', type: 'text', required: true,
      synonyms: ['property id', 'property', 'building', 'property code', 'unit'],
      description: 'The property the lease is on.' },
    { field: 'status', type: 'text', required: true,
      synonyms: ['status', 'lease status', 'state'],
      description: 'ACTIVE or ENDED.' },
    { field: 'security_deposit_cents', type: 'money', required: true,
      synonyms: ['security deposit', 'deposit', 'deposit amount', 'security deposit cents'],
      description: 'The security deposit that must be held in trust, coerced to integer cents.' },
    { field: 'start_date', type: 'date', required: true,
      synonyms: ['start date', 'lease start', 'commencement date', 'begin date'],
      description: 'When the lease began.' },
    { field: 'move_out_date', type: 'date', required: false,
      synonyms: ['move out date', 'move-out date', 'moveout date', 'vacated date', 'end date'],
      description: 'When the tenant moved out (set only on an ENDED lease).' },
    { field: 'deposit_returned_date', type: 'date', required: false,
      synonyms: ['deposit returned date', 'returned date', 'return date', 'deposit return date'],
      description: 'When the deposit was returned; blank on an ended lease past the deadline is a late return.' },
]);

// ── property-specific coercion ────────────────────────────────────────────────

/** Coerce a beneficiary ledger type to OWNER/DEPOSIT, or throw. */
export function coerceLedgerType(raw) {
    const s = String(raw).trim().toUpperCase();
    if (s === 'OWNER' || s === 'DEPOSIT') return s;
    throw new ImportError(`unrecognised ledger type: "${raw}" (expected OWNER or DEPOSIT)`);
}

/** Coerce a ledger entry direction to IN/OUT, or throw. */
export function coerceEntryType(raw) {
    const s = String(raw).trim().toUpperCase();
    if (s === 'IN' || s === 'OUT') return s;
    throw new ImportError(`unrecognised entry type: "${raw}" (expected IN or OUT)`);
}

/** Coerce a lease status to ACTIVE/ENDED, or throw. */
export function coerceLeaseStatus(raw) {
    const s = String(raw).trim().toUpperCase();
    if (s === 'ACTIVE' || s === 'ENDED') return s;
    throw new ImportError(`unrecognised lease status: "${raw}" (expected ACTIVE or ENDED)`);
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

// ── trust ledger: build the ledger ──────────────────────────────────────────────

function coerceLedgerRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            entryId: optionalId(cell, row, 'entry_id', mapping, lineNo),
            ledgerId: at('ledger_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty ledger id'); return s; }),
            ledgerType: at('ledger_type', coerceLedgerType),
            propertyId: at('property_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty property id'); return s; }),
            leaseId: present(cell, row, 'lease_id', mapping) ? String(cell(row, 'lease_id')).trim() : null,
            entryType: at('entry_type', coerceEntryType),
            amountCents: at('amount_cents', coerceMoneyToCents),
            entryDate: at('entry_date', normalizeDate),
        };
    });
}

function loadLedger(db, records) {
    const ins = db.prepare(
        'INSERT INTO trust_ledger (entry_id, ledger_id, ledger_type, property_id, lease_id, entry_type, amount_cents, entry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    records.forEach((r, i) => {
        const id = r.entryId || `ENT-${String(i + 1).padStart(4, '0')}`;
        if (seen.has(id)) throw new ImportError(`The trust ledger lists entry id "${id}" more than once.`);
        seen.add(id);
        ins.run(id, r.ledgerId, r.ledgerType, r.propertyId, r.leaseId, r.entryType, r.amountCents, r.entryDate);
    });
    const ledgers = new Set(records.map((r) => r.ledgerId));
    const liabilityCents = records.reduce((sum, r) => sum + (r.entryType === 'IN' ? r.amountCents : -r.amountCents), 0);
    return { rowCount: records.length, ledgers: ledgers.size, liabilityCents };
}

/**
 * Build a canonical property-trust ledger database from a trust-ledger CSV and a
 * confirmed mapping. Atomic: writes a temp database and renames on success, so an
 * aborted build (including a malformed value) never leaves a half-written ledger
 * behind. Copies the bundled property allow-list beside it so the four named
 * queries are serveable immediately (the two companion dimensions are applied after).
 */
export function buildPropertyLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = PROPERTY_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_PROPERTY_LEDGER_FIELDS);
    if (rows.length === 0) throw new ImportError('The trust-ledger file has a header but no data rows.');
    const records = coerceLedgerRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(PROPERTY_SCHEMA_DDL);
            counts = loadLedger(db, records);
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

// ── bank snapshots: apply onto the ledger ─────────────────────────────────────

function coerceSnapshotRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            snapshotId: optionalId(cell, row, 'snapshot_id', mapping, lineNo),
            snapshotDate: at('snapshot_date', normalizeDate),
            statementCents: at('bank_statement_balance_cents', coerceMoneyToCents),
            depositsInTransitCents: present(cell, row, 'deposits_in_transit_cents', mapping) ? at('deposits_in_transit_cents', coerceMoneyToCents) : 0,
            outstandingChecksCents: present(cell, row, 'outstanding_checks_cents', mapping) ? at('outstanding_checks_cents', coerceMoneyToCents) : 0,
        };
    });
}

/**
 * Apply the bank snapshots onto an existing imported property ledger, filling
 * trust_bank_snapshots so trust-vs-liability has a reconciled bank balance to
 * compare against the trust liability. One transaction; a malformed or duplicate
 * row aborts it and leaves the ledger untouched.
 */
export function applyPropertyBankSnapshotsToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_PROPERTY_SNAPSHOT_FIELDS,
        coerce: coerceSnapshotRows,
        noun: 'bank snapshots',
        idField: 'snapshotId', idPrefix: 'SNAP',
        dupLabel: (id) => `The bank snapshots file lists snapshot id "${id}" more than once.`,
        insertSql: 'INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, bank_statement_balance_cents, deposits_in_transit_cents, outstanding_checks_cents) VALUES (?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.snapshotDate, r.statementCents, r.depositsInTransitCents, r.outstandingChecksCents],
        countKey: 'snapshots',
    });
}

// ── leases: apply onto the ledger ─────────────────────────────────────────────

function coerceLeaseRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = rowCoercer(cell, row, lineNo, mapping);
        return {
            lineNo,
            leaseId: at('lease_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty lease id'); return s; }),
            propertyId: at('property_id', (v) => { const s = v.trim(); if (s === '') throw new ImportError('empty property id'); return s; }),
            status: at('status', coerceLeaseStatus),
            securityDepositCents: at('security_deposit_cents', coerceMoneyToCents),
            startDate: at('start_date', normalizeDate),
            moveOutDate: present(cell, row, 'move_out_date', mapping) ? at('move_out_date', normalizeDate) : null,
            depositReturnedDate: present(cell, row, 'deposit_returned_date', mapping) ? at('deposit_returned_date', normalizeDate) : null,
        };
    });
}

/**
 * Apply the leases onto an existing imported property ledger, filling leases so
 * deposits-held-vs-owed and deposit-return-overdue have the managed leases to
 * reconcile tenant deposits against. One transaction; a malformed or duplicate
 * row aborts it.
 */
export function applyLeasesToLedger({ csvPath, mapping, dbPath }) {
    return applyRegister({
        csvPath, mapping, dbPath,
        fields: CANONICAL_PROPERTY_LEASE_FIELDS,
        coerce: coerceLeaseRows,
        noun: 'leases',
        idField: 'leaseId', idPrefix: 'L',
        dupLabel: (id) => `The leases file lists lease id "${id}" more than once.`,
        insertSql: 'INSERT INTO leases (lease_id, property_id, status, security_deposit_cents, start_date, move_out_date, deposit_returned_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bind: (r, id) => [id, r.propertyId, r.status, r.securityDepositCents, r.startDate, r.moveOutDate, r.depositReturnedDate],
        countKey: 'leases',
    });
}

// ── shared companion loader ───────────────────────────────────────────────────
//
// The two companion dimensions (bank snapshots, leases) share the same shape:
// parse, validate against the companion's field spec, coerce every row (naming
// the offending row/column on failure), reject a duplicate mapped id, then insert
// all rows in a single transaction that rolls back on any error. Only the schema,
// coercer, id prefix and insert differ, so the body lives here (the same move the
// schools and excise importers make for their registers).
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

// Re-export the shared mapping engine so callers can propose/validate property
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
