/**
 * Import a contractor's own job-cost export into the canonical construction
 * schema the six construction-v1 controls run against.
 *
 * This is the construction counterpart to the municipal (import-csv.js) and IOLTA
 * (import-iolta.js) importers: it holds the same promise — the numbers that come
 * out are exactly the numbers that went in, and the record says which file was
 * read and how its columns were understood — but it targets the construction
 * warehouse. The genuinely shared parts (the RFC-4180 CSV reader, exact-cents
 * money and ISO-date coercion, the propose/validate mapping engine, ImportError)
 * are reused from import-csv.js; only the construction-specific schema, field
 * specs, coercers and loaders live here.
 *
 * A contractor's financials turn on the work-in-progress (WIP) schedule, so an
 * import is the job list plus up to five companion files that reconcile it:
 *   1. The jobs / WIP schedule — one row per job under contract (the primary
 *      file; it builds the ledger). Contract value, estimated cost at completion,
 *      cost to date and billings to date, in cents; earned revenue is derived
 *      cost-to-cost (ASC 606).
 *   2. The general-ledger revenue — recognized revenue per job, so wip-schedule's
 *      earned total can tie to the income statement. Optional.
 *   3. The balance-sheet contract balances — the contract liability and contract
 *      asset carried, so billings-tie-out has balances to tie to. Optional.
 *   4. The prior WIP snapshots — so margin-fade has a last-quarter margin to
 *      measure the current one against. Optional.
 *   5. The retainage ledger — withheld, released and carried per job, so
 *      retainage-reconciles can confirm the receivable ties. Optional.
 *   6. The subcontractor payments — with their lien-waiver status, so
 *      payments-without-lien-waiver can flag an unwaived release. Optional.
 *
 * Employee pay and certified-payroll detail never enter: the demo warehouse keeps
 * a payroll_pii table only so the guard has something to refuse, but there is no
 * mapping target for a name, Social Security number or pay rate here, so an
 * imported ledger simply has no column that could hold one. The controls identify
 * jobs, subcontractors and balances by code only, and the copied allow-list lists
 * only the six non-PII tables.
 *
 * Node-bound (node:fs + node:sqlite); path confinement to the import folder lives
 * in paths.js and is applied by the callers, exactly as for municipal and iolta.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { CONSTRUCTION_ALLOWLIST_PATH, ensureParent } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    validateMapping,
    coerceMoneyToCents,
    normalizeDate,
    ImportError,
} from './import-csv.js';

// ── canonical construction schema ──────────────────────────────────────────────
//
// The six tables the construction-v1 ruleset reads, reproduced from the demo seed
// (sample_construction_ledger.sql) minus the seed rows and minus payroll_pii (PII,
// which the import never carries). Kept here, beside the importer, so the shape
// the loaders write and the shape the controls query are defined together.
export const CONSTRUCTION_SCHEMA_VERSION = 'construction-canonical-v1';

export const CONSTRUCTION_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  job_id               TEXT PRIMARY KEY,
  job_name             TEXT NOT NULL,
  status               TEXT NOT NULL,
  contract_value_cents INTEGER NOT NULL CHECK (contract_value_cents > 0),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0),
  cost_to_date_cents   INTEGER NOT NULL CHECK (cost_to_date_cents >= 0),
  billed_to_date_cents INTEGER NOT NULL CHECK (billed_to_date_cents >= 0)
);

CREATE TABLE gl_revenue (
  entry_id     TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  posted_date  TEXT NOT NULL
);

CREATE TABLE balance_sheet_balances (
  account       TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL,
  as_of         TEXT NOT NULL
);

CREATE TABLE wip_snapshots (
  snapshot_id          TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  snapshot_date        TEXT NOT NULL,
  contract_value_cents INTEGER NOT NULL CHECK (contract_value_cents > 0),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0)
);

CREATE TABLE retainage (
  job_id           TEXT PRIMARY KEY,
  withheld_cents   INTEGER NOT NULL CHECK (withheld_cents >= 0),
  released_cents   INTEGER NOT NULL CHECK (released_cents >= 0),
  receivable_cents INTEGER NOT NULL
);

CREATE TABLE sub_payments (
  payment_id           TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  subcontractor_id     TEXT NOT NULL,
  amount_cents         INTEGER NOT NULL CHECK (amount_cents >= 0),
  payment_date         TEXT NOT NULL,
  lien_waiver_received INTEGER NOT NULL
);
`;

// ── mapping targets ──────────────────────────────────────────────────────────
//
// The jobs / WIP schedule is the primary file: one row is one job under contract.
// Everything but a job id, a name and the four money figures is derived by the
// controls, so those are the required fields; status defaults to OPEN.
export const CANONICAL_CONSTRUCTION_JOB_FIELDS = Object.freeze([
    { field: 'job_id', type: 'text', required: true,
      synonyms: ['job', 'job id', 'job number', 'job no', 'project', 'project id', 'project number', 'contract', 'contract id'],
      description: 'The job / contract id; the key every companion file joins on.' },
    { field: 'job_name', type: 'text', required: true,
      synonyms: ['name', 'job name', 'project name', 'description', 'job description', 'contract name'],
      description: 'The job name.' },
    { field: 'contract_value', type: 'money', required: true,
      synonyms: ['contract value', 'contract amount', 'contract', 'revised contract', 'total contract', 'contract price', 'contract sum'],
      description: 'The current contract value including approved change orders; coerced to integer cents. Must be positive.' },
    { field: 'estimated_cost', type: 'money', required: true,
      synonyms: ['estimated cost', 'estimated cost at completion', 'eac', 'total estimated cost', 'cost at completion', 'budget', 'estimated total cost'],
      description: 'The current total estimated cost at completion; coerced to integer cents. Must be positive.' },
    { field: 'cost_to_date', type: 'money', required: true,
      synonyms: ['cost to date', 'costs to date', 'actual cost', 'cost incurred', 'costs incurred', 'ctd', 'job cost to date'],
      description: 'The cost incurred so far; coerced to integer cents. Drives percent complete (cost-to-cost).' },
    { field: 'billed_to_date', type: 'money', required: true,
      synonyms: ['billed to date', 'billings to date', 'billed', 'billings', 'invoiced', 'invoiced to date', 'progress billed', 'btd'],
      description: 'Progress billed so far; coerced to integer cents. Compared to earned revenue for over/underbilling.' },
    { field: 'status', type: 'construction_job_status', required: false,
      synonyms: ['status', 'job status', 'state', 'phase'],
      description: 'open / closed (defaults to open).' },
]);

// The general-ledger revenue file: one row per revenue posting. wip-schedule ties
// the earned-revenue total it computes to the sum of this table.
export const CANONICAL_CONSTRUCTION_GL_FIELDS = Object.freeze([
    { field: 'job_id', type: 'text', required: true,
      synonyms: ['job', 'job id', 'job number', 'project', 'project id', 'contract'],
      description: 'The job the revenue was recognized on.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'revenue', 'recognized revenue', 'earned revenue', 'amount cents', 'value', 'credit'],
      description: 'The revenue recognized in the general ledger; coerced to integer cents.' },
    { field: 'posted_date', type: 'date', required: true,
      synonyms: ['date', 'posted date', 'posting date', 'gl date', 'recognized date', 'period'],
      description: 'When the revenue was posted.' },
    { field: 'entry_id', type: 'text', required: false,
      synonyms: ['entry id', 'entry', 'id', 'gl id', 'journal id', 'reference', 'ref'],
      description: "The firm's own id for the posting; generated (GLR-0001…) in file order when unmapped." },
]);

// The balance-sheet contract balances file: one row per account. billings-tie-out
// ties the summed over/underbillings to these. account carries the sign by its
// name (a contract liability vs a contract asset), so balance is read as-is.
export const CANONICAL_CONSTRUCTION_BALANCE_FIELDS = Object.freeze([
    { field: 'account', type: 'construction_balance_account', required: true,
      synonyms: ['account', 'account name', 'balance', 'balance sheet account', 'type', 'line'],
      description: 'contract liability (billings in excess) or contract asset (costs in excess).' },
    { field: 'balance', type: 'money', required: true,
      synonyms: ['balance', 'balance cents', 'amount', 'carried', 'carried balance', 'value', 'ending balance'],
      description: 'The balance carried on the balance sheet; coerced to integer cents.' },
    { field: 'as_of', type: 'date', required: false,
      synonyms: ['as of', 'as of date', 'date', 'balance date', 'statement date', 'period'],
      description: 'The balance-sheet date (defaults to the import date when omitted).' },
]);

// The prior WIP snapshots file: one row per point-in-time snapshot. margin-fade
// reads the latest per job (MAX(snapshot_date)) and compares its margin to the
// current one on the jobs table.
export const CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS = Object.freeze([
    { field: 'job_id', type: 'text', required: true,
      synonyms: ['job', 'job id', 'job number', 'project', 'project id', 'contract'],
      description: 'The job the snapshot is for.' },
    { field: 'snapshot_date', type: 'date', required: true,
      synonyms: ['date', 'snapshot date', 'as of', 'as of date', 'period', 'period end', 'quarter'],
      description: 'The snapshot date; the latest per job is the one margin-fade compares against.' },
    { field: 'contract_value', type: 'money', required: true,
      synonyms: ['contract value', 'contract amount', 'contract', 'contract price', 'contract sum'],
      description: 'The contract value as of the snapshot; coerced to integer cents. Must be positive.' },
    { field: 'estimated_cost', type: 'money', required: true,
      synonyms: ['estimated cost', 'estimated cost at completion', 'eac', 'cost at completion', 'budget'],
      description: 'The estimated cost at completion as of the snapshot; coerced to integer cents. Must be positive.' },
    { field: 'snapshot_id', type: 'text', required: false,
      synonyms: ['snapshot id', 'snapshot', 'id', 'reference', 'ref'],
      description: "The firm's own id for the snapshot; generated (WS-0001…) in file order when unmapped." },
]);

// The retainage file: one row per job. retainage-reconciles checks that the
// carried receivable equals withheld less released.
export const CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS = Object.freeze([
    { field: 'job_id', type: 'text', required: true,
      synonyms: ['job', 'job id', 'job number', 'project', 'project id', 'contract'],
      description: 'The job the retainage is for (one row per job).' },
    { field: 'withheld', type: 'money', required: true,
      synonyms: ['withheld', 'retainage withheld', 'retention withheld', 'withheld to date', 'held', 'retained'],
      description: 'Retainage withheld to date; coerced to integer cents.' },
    { field: 'released', type: 'money', required: true,
      synonyms: ['released', 'retainage released', 'retention released', 'released to date', 'paid out'],
      description: 'Retainage released to date; coerced to integer cents.' },
    { field: 'receivable', type: 'money', required: true,
      synonyms: ['receivable', 'retainage receivable', 'carried', 'carried receivable', 'balance', 'retainage balance'],
      description: 'The retainage receivable actually carried; coerced to integer cents. Should equal withheld less released.' },
]);

// The subcontractor payments file: one row per payment. payments-without-lien-waiver
// flags any payment released with no waiver on file.
export const CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS = Object.freeze([
    { field: 'job_id', type: 'text', required: true,
      synonyms: ['job', 'job id', 'job number', 'project', 'project id', 'contract'],
      description: 'The job the payment was made on.' },
    { field: 'subcontractor_id', type: 'text', required: true,
      synonyms: ['subcontractor', 'subcontractor id', 'sub', 'sub id', 'vendor', 'vendor id', 'payee', 'payee id'],
      description: 'The subcontractor paid, identified by code only.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'payment amount', 'paid', 'amount cents', 'value', 'check amount'],
      description: 'The payment amount; coerced to integer cents.' },
    { field: 'payment_date', type: 'date', required: true,
      synonyms: ['date', 'payment date', 'paid date', 'check date', 'release date'],
      description: 'When the payment was released.' },
    { field: 'lien_waiver_received', type: 'construction_lien_waiver', required: true,
      synonyms: ['lien waiver', 'lien waiver received', 'waiver', 'waiver received', 'waiver on file', 'lien release'],
      description: 'Whether the lien waiver is on file: yes/no (blank is read as no / missing).' },
    { field: 'payment_id', type: 'text', required: false,
      synonyms: ['payment id', 'payment', 'id', 'check number', 'check no', 'reference', 'ref'],
      description: "The firm's own id for the payment; generated (SP-0001…) in file order when unmapped." },
]);

// ── construction-specific coercion ─────────────────────────────────────────────

const JOB_STATUS_MAP = new Map([
    ['open', 'OPEN'], ['active', 'OPEN'], ['in progress', 'OPEN'], ['in-progress', 'OPEN'], ['wip', 'OPEN'], ['ongoing', 'OPEN'],
    ['closed', 'CLOSED'], ['complete', 'CLOSED'], ['completed', 'CLOSED'], ['done', 'CLOSED'], ['finished', 'CLOSED'], ['final', 'CLOSED'],
]);

/** Map a raw job status to OPEN / CLOSED. Empty defaults to OPEN. */
export function coerceJobStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return 'OPEN';
    const mapped = JOB_STATUS_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised job status: "${raw}" (expected open or closed)`);
    return mapped;
}

const BALANCE_ACCOUNT_MAP = new Map([
    ['contract_liability', 'CONTRACT_LIABILITY'], ['contract liability', 'CONTRACT_LIABILITY'],
    ['liability', 'CONTRACT_LIABILITY'], ['billings in excess', 'CONTRACT_LIABILITY'],
    ['billings in excess of costs', 'CONTRACT_LIABILITY'], ['overbillings', 'CONTRACT_LIABILITY'],
    ['overbilling', 'CONTRACT_LIABILITY'], ['deferred revenue', 'CONTRACT_LIABILITY'],
    ['contract_asset', 'CONTRACT_ASSET'], ['contract asset', 'CONTRACT_ASSET'],
    ['asset', 'CONTRACT_ASSET'], ['costs in excess', 'CONTRACT_ASSET'],
    ['costs in excess of billings', 'CONTRACT_ASSET'], ['underbillings', 'CONTRACT_ASSET'],
    ['underbilling', 'CONTRACT_ASSET'], ['unbilled receivable', 'CONTRACT_ASSET'],
]);

/** Map a raw balance-sheet account to CONTRACT_LIABILITY / CONTRACT_ASSET, or throw. */
export function coerceBalanceAccount(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = BALANCE_ACCOUNT_MAP.get(s);
    if (!mapped) {
        throw new ImportError(
            `unrecognised balance-sheet account: "${raw}" (expected a contract liability / billings in excess, or a contract asset / costs in excess)`,
        );
    }
    return mapped;
}

const LIEN_WAIVER_TRUE = new Set(['yes', 'y', 'true', '1', 'on file', 'received', 'waiver', 'waiver on file', 'signed', 'complete']);
const LIEN_WAIVER_FALSE = new Set(['no', 'n', 'false', '0', 'missing', 'none', 'not received', 'outstanding', 'pending', 'na', 'n/a']);

/** Map a raw lien-waiver status to 1 (on file) / 0 (missing). Empty is read as 0. */
export function coerceLienWaiver(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return 0;
    if (LIEN_WAIVER_TRUE.has(s)) return 1;
    if (LIEN_WAIVER_FALSE.has(s)) return 0;
    throw new ImportError(`unrecognised lien-waiver status: "${raw}" (expected yes/no)`);
}

/** Coerce a money amount that must be strictly positive (a contract value or cost estimate). */
function coercePositiveMoney(raw) {
    const cents = coerceMoneyToCents(raw);
    if (cents <= 0) throw new ImportError(`amount must be positive: "${raw}"`);
    return cents;
}

/** Coerce a money amount that must be non-negative (a cost, billing or retainage figure). */
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

// ── jobs: build the ledger ──────────────────────────────────────────────────

function coerceJobRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2; // header is line 1
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            jobId: requiredText(cell, row, lineNo, mapping, 'job_id'),
            jobName: requiredText(cell, row, lineNo, mapping, 'job_name'),
            contractValueCents: at('contract_value', coercePositiveMoney),
            estimatedCostCents: at('estimated_cost', coercePositiveMoney),
            costToDateCents: at('cost_to_date', coerceNonNegativeMoney),
            billedToDateCents: at('billed_to_date', coerceNonNegativeMoney),
            status: 'status' in mapping ? at('status', coerceJobStatus) : 'OPEN',
        };
    });
}

function loadJobs(db, records) {
    const ins = db.prepare(
        'INSERT INTO jobs (job_id, job_name, status, contract_value_cents, estimated_cost_cents, cost_to_date_cents, billed_to_date_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.jobId)) throw new ImportError(`The jobs file lists job id "${r.jobId}" more than once.`);
        seen.add(r.jobId);
        ins.run(r.jobId, r.jobName, r.status, r.contractValueCents, r.estimatedCostCents, r.costToDateCents, r.billedToDateCents);
    }
    return { rowCount: records.length };
}

/**
 * Build a canonical construction ledger database from a jobs / WIP-schedule CSV
 * and a confirmed mapping. Atomic: writes a temp database and renames on success,
 * so an aborted build (including a malformed value) never leaves a half-written
 * ledger behind. Copies the bundled construction allow-list beside it so the six
 * named queries are serveable immediately (the five optional companions are
 * applied afterward).
 */
export function buildConstructionLedgerFromCsv({ csvPath, mapping, dbPath, allowlistPath = null, allowlistSource = CONSTRUCTION_ALLOWLIST_PATH }) {
    if (!existsSync(csvPath)) throw new ImportError(`CSV not found: ${csvPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_CONSTRUCTION_JOB_FIELDS);
    if (rows.length === 0) throw new ImportError('The jobs file has a header but no data rows.');
    const records = coerceJobRows(rows, headers, mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(CONSTRUCTION_SCHEMA_DDL);
            counts = loadJobs(db, records);
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

function coerceGlRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let entryId = null;
        if ('entry_id' in mapping) entryId = requiredText(cell, row, lineNo, mapping, 'entry_id');
        return {
            lineNo,
            entryId,
            jobId: requiredText(cell, row, lineNo, mapping, 'job_id'),
            amountCents: at('amount', coerceMoneyToCents),
            postedDate: at('posted_date', normalizeDate),
        };
    });
}

/**
 * Apply the general-ledger revenue file onto the ledger, filling gl_revenue so
 * wip-schedule's earned-revenue total can tie to the income statement.
 */
export function applyGlRevenueToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'general-ledger revenue', mapping, CANONICAL_CONSTRUCTION_GL_FIELDS);
    const records = coerceGlRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.entryId) continue;
        if (seen.has(r.entryId)) throw new ImportError(`The general-ledger revenue file lists entry id "${r.entryId}" more than once.`);
        seen.add(r.entryId);
    }
    const inserted = withLedgerTxn(dbPath, 'general-ledger revenue', (db) => {
        const ins = db.prepare('INSERT INTO gl_revenue (entry_id, job_id, amount_cents, posted_date) VALUES (?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.entryId || `GLR-${String(i + 1).padStart(4, '0')}`, r.jobId, r.amountCents, r.postedDate));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { entries: records.length, inserted } };
}

function coerceBalanceRows(rows, headers, mapping, importDate) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            account: at('account', coerceBalanceAccount),
            balanceCents: at('balance', coerceMoneyToCents),
            asOf: 'as_of' in mapping && String(cell(row, 'as_of')).trim() !== '' ? at('as_of', normalizeDate) : importDate,
        };
    });
}

/**
 * Apply the balance-sheet contract balances onto the ledger, filling
 * balance_sheet_balances so billings-tie-out has the carried contract liability
 * and contract asset to tie the summed over/underbillings to.
 */
export function applyBalancesToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'balance-sheet balances', mapping, CANONICAL_CONSTRUCTION_BALANCE_FIELDS);
    const importDate = new Date().toISOString().slice(0, 10);
    const records = coerceBalanceRows(rows, headers, mapping, importDate);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.account)) throw new ImportError(`The balance-sheet balances file lists account "${r.account}" more than once.`);
        seen.add(r.account);
    }
    const inserted = withLedgerTxn(dbPath, 'balance-sheet balances', (db) => {
        const ins = db.prepare('INSERT INTO balance_sheet_balances (account, balance_cents, as_of) VALUES (?, ?, ?)');
        for (const r of records) ins.run(r.account, r.balanceCents, r.asOf);
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { balances: records.length, inserted } };
}

function coerceSnapshotRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let snapshotId = null;
        if ('snapshot_id' in mapping) snapshotId = requiredText(cell, row, lineNo, mapping, 'snapshot_id');
        return {
            lineNo,
            snapshotId,
            jobId: requiredText(cell, row, lineNo, mapping, 'job_id'),
            snapshotDate: at('snapshot_date', normalizeDate),
            contractValueCents: at('contract_value', coercePositiveMoney),
            estimatedCostCents: at('estimated_cost', coercePositiveMoney),
        };
    });
}

/**
 * Apply the prior WIP snapshots onto the ledger, filling wip_snapshots so
 * margin-fade has a last-snapshot margin to measure the current margin against.
 */
export function applyWipSnapshotsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'WIP snapshots', mapping, CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS);
    const records = coerceSnapshotRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.snapshotId) continue;
        if (seen.has(r.snapshotId)) throw new ImportError(`The WIP snapshots file lists snapshot "${r.snapshotId}" more than once.`);
        seen.add(r.snapshotId);
    }
    const inserted = withLedgerTxn(dbPath, 'WIP snapshots', (db) => {
        const ins = db.prepare('INSERT INTO wip_snapshots (snapshot_id, job_id, snapshot_date, contract_value_cents, estimated_cost_cents) VALUES (?, ?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.snapshotId || `WS-${String(i + 1).padStart(4, '0')}`, r.jobId, r.snapshotDate, r.contractValueCents, r.estimatedCostCents));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { snapshots: records.length, inserted } };
}

function coerceRetainageRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        return {
            lineNo,
            jobId: requiredText(cell, row, lineNo, mapping, 'job_id'),
            withheldCents: at('withheld', coerceNonNegativeMoney),
            releasedCents: at('released', coerceNonNegativeMoney),
            receivableCents: at('receivable', coerceMoneyToCents),
        };
    });
}

/**
 * Apply the retainage ledger onto the ledger, filling retainage so
 * retainage-reconciles can confirm each job's carried receivable equals withheld
 * less released.
 */
export function applyRetainageToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'retainage', mapping, CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS);
    const records = coerceRetainageRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (seen.has(r.jobId)) throw new ImportError(`The retainage file lists job "${r.jobId}" more than once (one row per job).`);
        seen.add(r.jobId);
    }
    const inserted = withLedgerTxn(dbPath, 'retainage', (db) => {
        const ins = db.prepare('INSERT INTO retainage (job_id, withheld_cents, released_cents, receivable_cents) VALUES (?, ?, ?, ?)');
        for (const r of records) ins.run(r.jobId, r.withheldCents, r.releasedCents, r.receivableCents);
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { jobs: records.length, inserted } };
}

function coerceSubPaymentRows(rows, headers, mapping) {
    const cell = cellReader(headers, mapping);
    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        let paymentId = null;
        if ('payment_id' in mapping) paymentId = requiredText(cell, row, lineNo, mapping, 'payment_id');
        return {
            lineNo,
            paymentId,
            jobId: requiredText(cell, row, lineNo, mapping, 'job_id'),
            subcontractorId: requiredText(cell, row, lineNo, mapping, 'subcontractor_id'),
            amountCents: at('amount', coerceNonNegativeMoney),
            paymentDate: at('payment_date', normalizeDate),
            lienWaiverReceived: at('lien_waiver_received', coerceLienWaiver),
        };
    });
}

/**
 * Apply the subcontractor payments onto the ledger, filling sub_payments so
 * payments-without-lien-waiver can flag any payment released with no waiver on
 * file.
 */
export function applySubPaymentsToLedger({ csvPath, mapping, dbPath }) {
    const { bytes, sourceFileSha256, headers, rows } = openCompanion(csvPath, 'subcontractor payments', mapping, CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS);
    const records = coerceSubPaymentRows(rows, headers, mapping);
    const seen = new Set();
    for (const r of records) {
        if (!r.paymentId) continue;
        if (seen.has(r.paymentId)) throw new ImportError(`The subcontractor payments file lists payment "${r.paymentId}" more than once.`);
        seen.add(r.paymentId);
    }
    const inserted = withLedgerTxn(dbPath, 'subcontractor payments', (db) => {
        const ins = db.prepare('INSERT INTO sub_payments (payment_id, job_id, subcontractor_id, amount_cents, payment_date, lien_waiver_received) VALUES (?, ?, ?, ?, ?, ?)');
        records.forEach((r, i) => ins.run(r.paymentId || `SP-${String(i + 1).padStart(4, '0')}`, r.jobId, r.subcontractorId, r.amountCents, r.paymentDate, r.lienWaiverReceived));
        return records.length;
    });
    return { sourceFileSha256, byteLength: bytes.length, counts: { payments: records.length, inserted } };
}

// Re-export the shared mapping engine so callers can propose/validate construction
// mappings without importing both modules.
export { parseCsv, proposeMapping, validateMapping, ImportError };
