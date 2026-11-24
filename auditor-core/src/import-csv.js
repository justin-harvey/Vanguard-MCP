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
 * The parsing, coercion, mapping and canonical-row logic are pure and live in
 * import-canonical.js, so the browser build can run the same import without a
 * `node:` dependency (see src/browser/import-engine.js). This module is the Node
 * half: it reads the file, hashes its bytes, and writes the rows that
 * canonicalTables() produces into a `node:sqlite` database. It holds no policy
 * about *where* files may be read from: path confinement to the import folder
 * lives in paths.js (resolveImportPath) and is applied by the callers
 * (import.js, mcp.js).
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { MUNICIPAL_ALLOWLIST_PATH, ensureParent } from './paths.js';
import { CANONICAL_SCHEMA_VERSION, CANONICAL_SCHEMA_DDL } from './schema.js';
import {
    ImportError,
    coerceMoneyToCents,
    normalizeDate,
    parseCsv,
    validateMapping,
    canonicalTables,
    buildCanonicalRecordsFromCsv,
} from './import-canonical.js';

// The pure import core (CSV parsing, coercion, mapping proposal/validation, row
// coercion and the canonical-field list) lives in import-canonical.js so the
// browser build can share it. Re-export the pieces this module's callers import
// from here, so the public surface of import-csv.js is unchanged.
export {
    ImportError,
    CANONICAL_IMPORT_FIELDS,
    parseCsv,
    coerceMoneyToCents,
    normalizeDate,
    fiscalYearOf,
    coerceStatus,
    proposeMapping,
    validateMapping,
} from './import-canonical.js';

// The schema this importer targets lives in schema.js (one definition, shared
// with the drift test); re-exported here so existing importers of this module
// keep resolving CANONICAL_SCHEMA_VERSION from the same place.
export { CANONICAL_SCHEMA_VERSION };

// ── grant-register mapping target ─────────────────────────────────────────────
//
// An expenditure-only import derives the `grants` it sees referenced as award-0
// placeholders (see canonicalTables), so `municipal/grant-status` has no award
// to measure spending against. A second import of the buyer's grant register
// fills those tables in: one row per grant award. It writes onto the *same*
// ledger the expenditure import built (see applyGrantRegisterToLedger), so a
// grant an expenditure already referenced is updated in place and the foreign
// key holds. fund_id/dept_id are deliberately not mappable here: the dimension
// ids are derived from the expenditure names, not the register's codes, so a
// placeholder grant keeps its existing dimensions and a brand-new grant takes an
// existing fund/dept — the same fallback the placeholder path uses.
export const CANONICAL_GRANT_FIELDS = Object.freeze([
    { field: 'grant_id', type: 'text', required: true,
      synonyms: ['grant', 'grant id', 'grant number', 'grant no', 'award', 'award id', 'award number', 'cfda'],
      description: 'The grant identifier, e.g. G-402; must match the grant_id expenditures are charged to.' },
    { field: 'grant_name', type: 'text', required: true,
      synonyms: ['grant name', 'name', 'program', 'program name', 'title', 'description'],
      description: 'The grant or program name.' },
    { field: 'grantor', type: 'text', required: true,
      synonyms: ['grantor', 'funder', 'agency', 'awarding agency', 'source', 'funding source', 'sponsor'],
      description: 'Who awarded the grant.' },
    { field: 'grantor_type', type: 'grantor_type', required: true,
      synonyms: ['grantor type', 'type', 'source type', 'level', 'government level', 'funder type'],
      description: 'federal / state / county / private.' },
    { field: 'award_amount', type: 'money', required: true,
      synonyms: ['award', 'award amount', 'total award', 'grant amount', 'awarded', 'obligated', 'obligated amount'],
      description: 'The total award; coerced to integer cents.' },
    { field: 'match_required_amount', type: 'money', required: false,
      synonyms: ['match', 'match required', 'required match', 'local match', 'cost share', 'match amount'],
      description: 'Required local match, if any; coerced to cents (defaults to 0).' },
    { field: 'period_start', type: 'date', required: true,
      synonyms: ['period start', 'start', 'start date', 'award date', 'begin', 'begin date', 'from'],
      description: 'Period of performance start.' },
    { field: 'period_end', type: 'date', required: true,
      synonyms: ['period end', 'end', 'end date', 'expiration', 'expires', 'expiry', 'to', 'through'],
      description: 'Period of performance end.' },
    { field: 'status', type: 'grant_status', required: false,
      synonyms: ['status', 'grant status', 'state', 'award status'],
      description: 'active / closed (defaults to active).' },
]);

// ── grant-drawdowns mapping target ────────────────────────────────────────────
//
// A grant register gives each award; it says nothing about the cash actually
// requested from the grantor. `municipal/grant-status` measures drawn cash
// (grant_drawdowns, status 'received') against paid spending to catch cash drawn
// ahead of spending. With no drawdowns file, drawn = 0, which is honest but
// blind. A third import of the buyer's drawdown register fills grant_drawdowns:
// one row per cash request, applied onto the same ledger the expenditures and
// register already built (see applyGrantDrawdownsToLedger), so each drawdown's
// grant_id resolves to a real grant. drawdown_id is optional — supply it to
// carry the municipality's own ids, or leave it unmapped to have DD-0001…
// generated in file order.
export const CANONICAL_DRAWDOWN_FIELDS = Object.freeze([
    { field: 'grant_id', type: 'text', required: true,
      synonyms: ['grant', 'grant id', 'grant number', 'grant no', 'award', 'award id', 'award number', 'cfda'],
      description: 'The grant the cash was drawn against; must match a grant_id already in the ledger.' },
    { field: 'amount', type: 'money', required: true,
      synonyms: ['amount', 'drawdown amount', 'draw amount', 'amount drawn', 'cash drawn', 'disbursed', 'disbursement', 'requested amount', 'reimbursement'],
      description: 'The cash requested in this drawdown; coerced to integer cents.' },
    { field: 'request_date', type: 'date', required: true,
      synonyms: ['request date', 'requested', 'requested date', 'date requested', 'draw date', 'drawdown date', 'submitted'],
      description: 'When the drawdown was requested from the grantor.' },
    { field: 'received_date', type: 'date', required: false,
      synonyms: ['received date', 'received', 'date received', 'receipt date', 'funded date', 'deposited', 'deposit date', 'payment date'],
      description: 'When the cash was received; leave blank for a pending drawdown.' },
    { field: 'status', type: 'drawdown_status', required: false,
      synonyms: ['status', 'drawdown status', 'draw status', 'state'],
      description: "received / pending (defaults to received when a received date is present, else pending)." },
    { field: 'drawdown_id', type: 'text', required: false,
      synonyms: ['drawdown id', 'drawdown', 'draw id', 'drawdown number', 'draw number', 'reference', 'reference number'],
      description: 'The municipality\'s own id for the drawdown; generated (DD-0001…) when unmapped.' },
]);

// ── register / drawdown coercion (Node register importers only) ───────────────

const GRANTOR_TYPE_MAP = new Map([
    ['federal', 'federal'], ['fed', 'federal'], ['us', 'federal'], ['national', 'federal'],
    ['state', 'state'],
    ['county', 'county'], ['regional', 'county'], ['local', 'county'],
    ['private', 'private'], ['foundation', 'private'], ['nonprofit', 'private'], ['corporate', 'private'],
]);

/** Map a raw grantor type to the schema's CHECK set, or throw rather than guess. */
export function coerceGrantorType(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = GRANTOR_TYPE_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised grantor type: "${raw}" (expected federal, state, county or private)`);
    return mapped;
}

const GRANT_STATUS_MAP = new Map([
    ['active', 'active'], ['open', 'active'], ['ongoing', 'active'], ['current', 'active'],
    ['closed', 'closed'], ['complete', 'closed'], ['completed', 'closed'], ['ended', 'closed'], ['expired', 'closed'],
]);

/** Map a raw grant status to active/closed, or throw. Empty defaults to active. */
export function coerceGrantStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return 'active';
    const mapped = GRANT_STATUS_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised grant status: "${raw}" (expected active or closed)`);
    return mapped;
}

const DRAWDOWN_STATUS_MAP = new Map([
    ['received', 'received'], ['paid', 'received'], ['funded', 'received'], ['deposited', 'received'],
    ['complete', 'received'], ['completed', 'received'], ['reimbursed', 'received'], ['settled', 'received'],
    ['pending', 'pending'], ['requested', 'pending'], ['open', 'pending'], ['outstanding', 'pending'],
    ['submitted', 'pending'], ['in process', 'pending'], ['in progress', 'pending'],
]);

/**
 * Map a raw drawdown status to the schema's CHECK set (received/pending), or
 * throw rather than guess. An empty value is resolved by the caller from whether
 * a received date is present, so this never defaults on its own.
 */
export function coerceDrawdownStatus(raw) {
    const s = String(raw).trim().toLowerCase();
    const mapped = DRAWDOWN_STATUS_MAP.get(s);
    if (!mapped) throw new ImportError(`unrecognised drawdown status: "${raw}" (expected received or pending)`);
    return mapped;
}

// ── build ───────────────────────────────────────────────────────────────────

/**
 * Write the canonical dimension + fact rows into the open database. The rows are
 * computed once by canonicalTables (shared with the browser build) so this is a
 * thin inserter: it only moves those arrays into `node:sqlite`, in dependency
 * order, so the figures are identical across runtimes.
 */
function loadCanonical(db, records) {
    const t = canonicalTables(records);

    const insFund = db.prepare('INSERT INTO funds (fund_id, fund_name, fund_type) VALUES (?, ?, ?)');
    for (const f of t.funds) insFund.run(f.fund_id, f.fund_name, f.fund_type);

    const insDept = db.prepare('INSERT INTO departments (dept_id, dept_name) VALUES (?, ?)');
    for (const d of t.departments) insDept.run(d.dept_id, d.dept_name);

    const insVendor = db.prepare('INSERT INTO vendors (vendor_id, vendor_name, category, tax_id, remit_account_last4) VALUES (?, ?, ?, ?, ?)');
    for (const v of t.vendors) insVendor.run(v.vendor_id, v.vendor_name, v.category, v.tax_id, v.remit_account_last4);

    const insLine = db.prepare(
        'INSERT INTO budget_lines (line_id, fiscal_year, dept_id, fund_id, account_code, line_description, adopted_cents, amended_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of t.budget_lines) {
        insLine.run(l.line_id, l.fiscal_year, l.dept_id, l.fund_id, l.account_code, l.line_description, l.adopted_cents, l.amended_cents);
    }

    if (t.grants.length) {
        const insGrant = db.prepare(
            'INSERT INTO grants (grant_id, grant_name, grantor, grantor_type, fund_id, dept_id, award_cents, match_required_cents, period_start, period_end, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const g of t.grants) {
            insGrant.run(g.grant_id, g.grant_name, g.grantor, g.grantor_type, g.fund_id, g.dept_id, g.award_cents, g.match_required_cents, g.period_start, g.period_end, g.status);
        }
    }

    const insExp = db.prepare(
        'INSERT INTO expenditures (expenditure_id, fiscal_year, line_id, grant_id, vendor_id, invoice_number, invoice_date, paid_date, amount_cents, memo, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const e of t.expenditures) {
        insExp.run(e.expenditure_id, e.fiscal_year, e.line_id, e.grant_id, e.vendor_id, e.invoice_number, e.invoice_date, e.paid_date, e.amount_cents, e.memo, e.status);
    }

    return t.counts;
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
    const { records } = buildCanonicalRecordsFromCsv(bytes.toString('utf8'), mapping);

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    let counts;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        try {
            db.exec(CANONICAL_SCHEMA_DDL);
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

/**
 * Coerce the grant-register rows under a confirmed mapping. One row is one grant
 * award. Coercion throws, naming the row and column, rather than writing a
 * malformed grant.
 *
 * @returns {object[]}
 */
function coerceGrantRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const grantId = String(cell(row, 'grant_id')).trim();
        if (grantId === '') throw new ImportError(`Row ${lineNo}, column "${mapping.grant_id}": empty grant id`);
        const grantName = String(cell(row, 'grant_name')).trim();
        if (grantName === '') throw new ImportError(`Row ${lineNo}, column "${mapping.grant_name}": empty grant name`);
        const grantor = String(cell(row, 'grantor')).trim();
        if (grantor === '') throw new ImportError(`Row ${lineNo}, column "${mapping.grantor}": empty grantor`);

        return {
            lineNo,
            grantId,
            grantName,
            grantor,
            grantorType: at('grantor_type', coerceGrantorType),
            awardCents: at('award_amount', coerceMoneyToCents),
            matchCents: 'match_required_amount' in mapping && String(cell(row, 'match_required_amount')).trim() !== ''
                ? at('match_required_amount', coerceMoneyToCents)
                : 0,
            periodStart: at('period_start', normalizeDate),
            periodEnd: at('period_end', normalizeDate),
            status: 'status' in mapping ? at('status', coerceGrantStatus) : 'active',
        };
    });
}

/**
 * Apply a grant register onto an existing imported ledger, filling the `grants`
 * table with real award amounts so municipal/grant-status is meaningful.
 *
 * It writes onto the ledger the expenditure import already built: a grant an
 * expenditure referenced exists as an award-0 placeholder and is updated in
 * place (its derived fund_id/dept_id kept so the foreign keys hold); a grant the
 * register names that no expenditure referenced is inserted, taking an existing
 * fund/dept. The whole register is applied in one transaction, so a malformed
 * row aborts it and leaves the ledger untouched. grant_drawdowns are out of
 * scope here (a separate register); with none, grant-status reports 0 drawn,
 * which is honest.
 *
 * @param {object} params
 * @param {string} params.csvPath absolute path to the grant-register CSV (confined by the caller)
 * @param {Record<string,string>} params.mapping confirmed grant-field -> column
 * @param {string} params.dbPath  the existing imported ledger to write onto
 * @returns {{ sourceFileSha256: string, byteLength: number, counts: { grants: number, updated: number, inserted: number } }}
 * @throws {ImportError}
 */
export function applyGrantRegisterToLedger({ csvPath, mapping, dbPath }) {
    if (!existsSync(csvPath)) throw new ImportError(`grant register not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the grant register to: ${dbPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_GRANT_FIELDS);
    if (rows.length === 0) throw new ImportError('The grant register has a header but no data rows.');
    const grants = coerceGrantRows(rows, headers, mapping);

    const seen = new Set();
    for (const g of grants) {
        if (seen.has(g.grantId)) throw new ImportError(`The grant register lists grant "${g.grantId}" more than once.`);
        seen.add(g.grantId);
    }

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        const fallbackFund = db.prepare('SELECT fund_id FROM funds ORDER BY fund_id LIMIT 1').get();
        const fallbackDept = db.prepare('SELECT dept_id FROM departments ORDER BY dept_id LIMIT 1').get();
        const exists = db.prepare('SELECT grant_id FROM grants WHERE grant_id = ?');
        const update = db.prepare(
            'UPDATE grants SET grant_name = ?, grantor = ?, grantor_type = ?, award_cents = ?, match_required_cents = ?, period_start = ?, period_end = ?, status = ? WHERE grant_id = ?',
        );
        const insert = db.prepare(
            'INSERT INTO grants (grant_id, grant_name, grantor, grantor_type, fund_id, dept_id, award_cents, match_required_cents, period_start, period_end, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );

        let updated = 0;
        let inserted = 0;
        db.exec('BEGIN');
        try {
            for (const g of grants) {
                if (exists.get(g.grantId)) {
                    update.run(g.grantName, g.grantor, g.grantorType, g.awardCents, g.matchCents, g.periodStart, g.periodEnd, g.status, g.grantId);
                    updated += 1;
                } else {
                    if (!fallbackFund || !fallbackDept) {
                        throw new ImportError(`grant "${g.grantId}" is new to the ledger, which has no fund/department to attach it to; import expenditures first.`);
                    }
                    insert.run(g.grantId, g.grantName, g.grantor, g.grantorType, fallbackFund.fund_id, fallbackDept.dept_id, g.awardCents, g.matchCents, g.periodStart, g.periodEnd, g.status);
                    inserted += 1;
                }
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }

        return { sourceFileSha256, byteLength: bytes.length, counts: { grants: grants.length, updated, inserted } };
    } finally {
        db.close();
    }
}

/**
 * Coerce the grant-drawdown rows under a confirmed mapping. One row is one cash
 * request. Coercion throws, naming the row and column, rather than writing a
 * malformed drawdown. The status defaults from the presence of a received date
 * (received if the cash landed, else pending) only when the file left it blank.
 *
 * @returns {object[]}
 */
function coerceDrawdownRows(rows, headers, mapping) {
    const idx = {};
    for (const [field, header] of Object.entries(mapping)) idx[field] = headers.indexOf(header);
    const cell = (row, field) => (idx[field] === undefined ? '' : (row[idx[field]] ?? ''));

    return rows.map((row, r) => {
        const lineNo = r + 2;
        const at = (field, fn) => {
            try { return fn(String(cell(row, field))); }
            catch (error) { throw new ImportError(`Row ${lineNo}, column "${mapping[field]}": ${error.message}`); }
        };
        const grantId = String(cell(row, 'grant_id')).trim();
        if (grantId === '') throw new ImportError(`Row ${lineNo}, column "${mapping.grant_id}": empty grant id`);

        const requestDate = at('request_date', normalizeDate);
        const receivedRaw = 'received_date' in mapping ? String(cell(row, 'received_date')).trim() : '';
        const receivedDate = receivedRaw === '' ? null : at('received_date', normalizeDate);

        const statusRaw = 'status' in mapping ? String(cell(row, 'status')).trim() : '';
        const status = statusRaw === '' ? (receivedDate ? 'received' : 'pending') : at('status', coerceDrawdownStatus);

        // drawdown_id, when the file carries its own, must be present on every row
        // (it is a primary key); unmapped, the id is generated by the caller.
        let drawdownId = null;
        if ('drawdown_id' in mapping) {
            drawdownId = String(cell(row, 'drawdown_id')).trim();
            if (drawdownId === '') throw new ImportError(`Row ${lineNo}, column "${mapping.drawdown_id}": empty drawdown id`);
        }

        return { lineNo, drawdownId, grantId, requestDate, receivedDate, amountCents: at('amount', coerceMoneyToCents), status };
    });
}

/**
 * Apply a grant-drawdown register onto an existing imported ledger, filling the
 * grant_drawdowns table so municipal/grant-status measures cash drawn against
 * cash spent (the cash-ahead-of-spending check).
 *
 * It writes onto the ledger the expenditure (and optionally grant-register)
 * import already built: every drawdown's grant_id must resolve to a grant on the
 * ledger, so a drawdown for a grant no expenditure referenced needs the grant
 * register imported first. The whole file is applied in one transaction, so a
 * malformed row aborts it and leaves the ledger untouched. drawdown_id is taken
 * from the file when mapped (and must be unique), else generated DD-0001… in
 * file order.
 *
 * @param {object} params
 * @param {string} params.csvPath absolute path to the drawdowns CSV (confined by the caller)
 * @param {Record<string,string>} params.mapping confirmed drawdown-field -> column
 * @param {string} params.dbPath  the existing imported ledger to write onto
 * @returns {{ sourceFileSha256: string, byteLength: number, counts: { drawdowns: number, inserted: number, grants: number } }}
 * @throws {ImportError}
 */
export function applyGrantDrawdownsToLedger({ csvPath, mapping, dbPath }) {
    if (!existsSync(csvPath)) throw new ImportError(`grant drawdowns not found: ${csvPath}`);
    if (!existsSync(dbPath)) throw new ImportError(`no imported ledger to apply the grant drawdowns to: ${dbPath}`);
    const bytes = readFileSync(csvPath);
    const sourceFileSha256 = createHash('sha256').update(bytes).digest('hex');
    const { headers, rows } = parseCsv(bytes.toString('utf8'));
    validateMapping(mapping, headers, CANONICAL_DRAWDOWN_FIELDS);
    if (rows.length === 0) throw new ImportError('The grant drawdowns file has a header but no data rows.');
    const draws = coerceDrawdownRows(rows, headers, mapping);

    // Carried ids must be unique: grant_drawdowns.drawdown_id is a primary key.
    const seen = new Set();
    for (const d of draws) {
        if (!d.drawdownId) continue;
        if (seen.has(d.drawdownId)) throw new ImportError(`The drawdowns file lists drawdown "${d.drawdownId}" more than once.`);
        seen.add(d.drawdownId);
    }

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        const grantExists = db.prepare('SELECT grant_id FROM grants WHERE grant_id = ?');
        const insert = db.prepare(
            'INSERT INTO grant_drawdowns (drawdown_id, grant_id, request_date, received_date, amount_cents, status) VALUES (?, ?, ?, ?, ?, ?)',
        );

        let inserted = 0;
        const grants = new Set();
        db.exec('BEGIN');
        try {
            draws.forEach((d, i) => {
                if (!grantExists.get(d.grantId)) {
                    throw new ImportError(`drawdown row ${d.lineNo}: grant "${d.grantId}" is not in the ledger; import that grant (via expenditures or the grant register) first.`);
                }
                const id = d.drawdownId || `DD-${String(i + 1).padStart(4, '0')}`;
                insert.run(id, d.grantId, d.requestDate, d.receivedDate, d.amountCents, d.status);
                inserted += 1;
                grants.add(d.grantId);
            });
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }

        return { sourceFileSha256, byteLength: bytes.length, counts: { drawdowns: draws.length, inserted, grants: grants.size } };
    } finally {
        db.close();
    }
}
