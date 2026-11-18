/**
 * Named queries and automatic checks for custom warehouses.
 *
 * A named query is SQL the warehouse operator writes once, in the allow-list
 * file, with named parameters. An agent calls it by name with argument values;
 * it never sees or writes SQL. That is cheaper (no schema reading, no SQL
 * generation) and more consistent (a definition such as "spent means paid, never
 * void" is fixed in one place instead of re-derived on every question). It needs
 * no model and no credential.
 *
 * Each named query can carry checks that run against its result:
 *
 *   integrity checks: does the result look *correct*? A flag here means the
 *     result should not be presented as fact.
 *       unique          key columns must not repeat (catches JOIN fan-out)
 *       total_matches   the column total must equal an independent SQL total
 *                       (catches double counting and dropped rows)
 *   finding checks: is there a data condition worth reporting? A flag here is
 *     an audit finding about the ledger, not a fault in the query.
 *       compare         per row, left <op> right, e.g. paid_cents <= award_cents
 *       empty           the result must have no rows, for SQL that already
 *                       filters to only the offending rows (a HAVING clause)
 *
 * Nothing here trusts the definitions: every query and check SQL still goes
 * through the guard (with the warehouse's table and column allow-lists) and the
 * read-only connection when it runs. Parameter values are bound as SQL
 * parameters, never spliced into the text.
 *
 * Definition format, inside the allow-list's "queries" object:
 *
 *   "grant-status": {
 *     "description": "Award, paid spend and remaining balance per grant.",
 *     "params": {
 *       "grant_id": { "type": "string", "description": "e.g. G-402; omit for all" },
 *       "fiscal_year": { "type": "integer", "required": true },
 *       "status": { "type": "string", "enum": ["active", "closed"] }
 *     },
 *     "sql": "SELECT … WHERE (:grant_id IS NULL OR g.grant_id = :grant_id)",
 *     "checks": [
 *       { "id": "one-row-per-grant", "type": "unique", "columns": ["grant_id"] },
 *       { "id": "paid-total", "type": "total_matches", "column": "paid_cents",
 *         "sql": "SELECT COALESCE(SUM(amount_cents), 0) FROM …" },
 *       { "id": "within-award", "type": "compare", "left": "paid_cents", "op": "<=",
 *         "right": "award_cents", "key": "grant_id", "message": "Paid spending exceeds the award." }
 *     ]
 *   }
 *
 * Optional parameters left out are bound as NULL, so write filters as
 * "(:p IS NULL OR col = :p)".
 *
 * This module is pure: no database, no parser, no I/O.
 */

const QUERY_NAME = /^[a-z][a-z0-9-]*$/;
const PARAM_NAME = /^[a-z_][a-z0-9_]*$/;
const CHECK_ID = /^[a-z][a-z0-9-]*$/;
const PARAM_TYPES = ['string', 'integer', 'number'];
const COMPARE_OPS = ['<', '<=', '=', '!=', '>=', '>'];
const MAX_STRING_PARAM = 200;
const MAX_FLAGGED_KEYS = 10;

export class NamedQueryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NamedQueryError';
    }
}

// ── SQL placeholders ──────────────────────────────────────────────────────

/**
 * Replace :name placeholders with positional ? markers, outside string
 * literals, quoted identifiers and comments. Returns the rewritten SQL and the
 * parameter name for each ? in order (a name used twice appears twice).
 *
 * @param {string} sql
 * @returns {{ sql: string, order: string[] }}
 */
export function compilePlaceholders(sql) {
    let out = '';
    const order = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        // String literal or quoted identifier: copy verbatim, honouring doubled quotes.
        if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) j += 2;
                    else break;
                } else j += 1;
            }
            if (j >= sql.length) throw new NamedQueryError('SQL has an unterminated quote.');
            out += sql.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const j = end === -1 ? sql.length : end;
            out += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            if (end === -1) throw new NamedQueryError('SQL has an unterminated comment.');
            out += sql.slice(i, end + 2);
            i = end + 2;
            continue;
        }
        if (ch === '?') throw new NamedQueryError('Use named :parameters, not positional ? markers.');
        if (ch === ':' && /[a-z_]/.test(sql[i + 1] ?? '')) {
            let j = i + 1;
            while (j < sql.length && /[a-z0-9_]/.test(sql[j])) j += 1;
            order.push(sql.slice(i + 1, j));
            out += '?';
            i = j;
            continue;
        }
        out += ch;
        i += 1;
    }
    return { sql: out, order };
}

// ── definitions ───────────────────────────────────────────────────────────

function parseParams(name, params) {
    if (params === undefined) return {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new NamedQueryError(`Query "${name}": "params" must be an object.`);
    }
    const out = {};
    for (const [p, spec] of Object.entries(params)) {
        if (!PARAM_NAME.test(p)) throw new NamedQueryError(`Query "${name}": bad parameter name "${p}".`);
        if (!spec || typeof spec !== 'object') throw new NamedQueryError(`Query "${name}": parameter "${p}" needs a spec.`);
        const type = spec.type ?? 'string';
        if (!PARAM_TYPES.includes(type)) {
            throw new NamedQueryError(`Query "${name}": parameter "${p}" type must be one of ${PARAM_TYPES.join(', ')}.`);
        }
        if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
            throw new NamedQueryError(`Query "${name}": parameter "${p}" enum must be a non-empty array.`);
        }
        out[p] = {
            type,
            required: spec.required === true,
            description: typeof spec.description === 'string' ? spec.description : '',
            ...(spec.enum ? { enum: [...spec.enum] } : {}),
        };
    }
    return out;
}

function compileWith(name, label, sql, params) {
    if (typeof sql !== 'string' || sql.trim() === '') throw new NamedQueryError(`Query "${name}": ${label} must be SQL text.`);
    const compiled = compilePlaceholders(sql);
    for (const p of compiled.order) {
        if (!(p in params)) throw new NamedQueryError(`Query "${name}": ${label} uses :${p}, which is not a declared parameter.`);
    }
    return compiled;
}

function parseCheck(name, check, params, seen) {
    if (!check || typeof check !== 'object') throw new NamedQueryError(`Query "${name}": each check must be an object.`);
    const { id, type } = check;
    if (typeof id !== 'string' || !CHECK_ID.test(id)) throw new NamedQueryError(`Query "${name}": check id "${id}" is invalid.`);
    if (seen.has(id)) throw new NamedQueryError(`Query "${name}": duplicate check id "${id}".`);
    seen.add(id);
    const message = typeof check.message === 'string' ? check.message : null;

    switch (type) {
        case 'unique': {
            const cols = check.columns;
            if (!Array.isArray(cols) || cols.length === 0 || cols.some((c) => typeof c !== 'string')) {
                throw new NamedQueryError(`Query "${name}": unique check "${id}" needs "columns".`);
            }
            return { id, type, severity: 'integrity', columns: [...cols], message };
        }
        case 'total_matches': {
            if (typeof check.column !== 'string') throw new NamedQueryError(`Query "${name}": check "${id}" needs "column".`);
            const compiled = compileWith(name, `check "${id}" sql`, check.sql, params);
            return { id, type, severity: 'integrity', column: check.column, sql: compiled.sql, order: compiled.order, message };
        }
        case 'compare': {
            if (typeof check.left !== 'string') throw new NamedQueryError(`Query "${name}": check "${id}" needs "left".`);
            if (!COMPARE_OPS.includes(check.op)) {
                throw new NamedQueryError(`Query "${name}": check "${id}" op must be one of ${COMPARE_OPS.join(' ')}.`);
            }
            if (typeof check.right !== 'string' && typeof check.right !== 'number') {
                throw new NamedQueryError(`Query "${name}": check "${id}" "right" must be a column name or a number.`);
            }
            return {
                id,
                type,
                severity: 'finding',
                left: check.left,
                op: check.op,
                right: check.right,
                key: typeof check.key === 'string' ? check.key : null,
                message,
            };
        }
        case 'empty': {
            // A finding check for queries whose SQL already filters to exactly
            // the offending rows (a HAVING that keeps only variances, only
            // unbound policies). The finding is simply "no such row should
            // exist": clean when the result is empty, a flag otherwise. An
            // optional "key" column names what to sample in the detail.
            if (check.key !== undefined && typeof check.key !== 'string') {
                throw new NamedQueryError(`Query "${name}": check "${id}" "key" must be a column name.`);
            }
            return { id, type, severity: 'finding', key: typeof check.key === 'string' ? check.key : null, message };
        }
        default:
            throw new NamedQueryError(`Query "${name}": check "${id}" has unknown type "${type}" (unique, total_matches, compare, empty).`);
    }
}

/**
 * Validate the "queries" object of an allow-list document.
 *
 * @param {unknown} queries
 * @returns {Record<string, { name: string, description: string, params: object, sql: string, order: string[], checks: object[] }>}
 * @throws {NamedQueryError}
 */
export function parseQueries(queries) {
    if (queries === undefined) return {};
    if (!queries || typeof queries !== 'object' || Array.isArray(queries)) {
        throw new NamedQueryError('"queries" must be an object mapping each query name to its definition.');
    }
    const out = {};
    for (const [name, def] of Object.entries(queries)) {
        if (!QUERY_NAME.test(name)) {
            throw new NamedQueryError(`Query name "${name}" must be lowercase letters, digits or hyphens.`);
        }
        if (!def || typeof def !== 'object') throw new NamedQueryError(`Query "${name}" needs a definition object.`);
        if (typeof def.description !== 'string' || def.description.trim() === '') {
            throw new NamedQueryError(`Query "${name}" needs a "description"; it is what an agent chooses by.`);
        }
        const params = parseParams(name, def.params);
        const compiled = compileWith(name, 'sql', def.sql, params);
        if (def.checks !== undefined && !Array.isArray(def.checks)) {
            throw new NamedQueryError(`Query "${name}": "checks" must be an array.`);
        }
        const seen = new Set();
        const checks = (def.checks ?? []).map((c) => parseCheck(name, c, params, seen));
        out[name] = { name, description: def.description, params, sql: compiled.sql, order: compiled.order, checks };
    }
    return out;
}

/** The public view of a query definition: what an agent needs to call it. */
export function describeQuery(def) {
    return {
        name: def.name,
        description: def.description,
        params: def.params,
        checks: def.checks.map((c) => ({ id: c.id, type: c.type, severity: c.severity })),
    };
}

// ── arguments ─────────────────────────────────────────────────────────────

/**
 * Validate caller arguments against a query's declared parameters and return
 * the values by name (missing optional parameters become null).
 *
 * @param {{ name: string, params: object }} def
 * @param {unknown} args
 * @returns {Record<string, string|number|null>}
 * @throws {NamedQueryError}
 */
export function validateArgs(def, args = {}) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new NamedQueryError(`Arguments for "${def.name}" must be an object.`);
    }
    for (const key of Object.keys(args)) {
        if (!(key in def.params)) {
            const known = Object.keys(def.params);
            throw new NamedQueryError(
                `"${def.name}" has no parameter "${key}". ` + (known.length ? `Parameters: ${known.join(', ')}.` : 'It takes none.'),
            );
        }
    }
    const values = {};
    for (const [p, spec] of Object.entries(def.params)) {
        const v = args[p];
        if (v === undefined || v === null) {
            if (spec.required) throw new NamedQueryError(`"${def.name}" requires parameter "${p}".`);
            values[p] = null;
            continue;
        }
        if (spec.type === 'string') {
            if (typeof v !== 'string' || v.length > MAX_STRING_PARAM || /[\u0000-\u001f]/.test(v)) {
                throw new NamedQueryError(`"${p}" must be a string of at most ${MAX_STRING_PARAM} printable characters.`);
            }
        } else if (spec.type === 'integer') {
            if (!Number.isSafeInteger(v)) throw new NamedQueryError(`"${p}" must be an integer.`);
        } else if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new NamedQueryError(`"${p}" must be a number.`);
        }
        if (spec.enum && !spec.enum.includes(v)) {
            throw new NamedQueryError(`"${p}" must be one of: ${spec.enum.join(', ')}.`);
        }
        values[p] = v;
    }
    return values;
}

/** Positional parameter array for compiled SQL, from validated values. */
export function bindParams(order, values) {
    return order.map((p) => values[p]);
}

// ── checks ────────────────────────────────────────────────────────────────

function compare(a, op, b) {
    switch (op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '=': return a === b;
        case '!=': return a !== b;
        case '>=': return a >= b;
        case '>': return a > b;
        default: return false;
    }
}

/**
 * Evaluate a query's checks against its result.
 *
 * @param {object[]} checks parsed check definitions
 * @param {object[]} rows the query result
 * @param {object} [context]
 * @param {Record<string, number|null>} [context.totals] check id -> independent total (total_matches)
 * @param {boolean} [context.truncated] the result hit the row limit
 * @returns {{ checks: object[], integrity: 'pass'|'flag', findings: number }}
 */
export function evaluateChecks(checks, rows, { totals = {}, truncated = false } = {}) {
    const results = checks.map((check) => {
        const base = { id: check.id, type: check.type, severity: check.severity };
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const missing = (col) => rows.length > 0 && !columns.includes(col);

        if (check.type === 'unique') {
            const absent = check.columns.filter(missing);
            if (absent.length) return { ...base, status: 'error', detail: `result has no column ${absent.join(', ')}` };
            const seen = new Map();
            for (const row of rows) {
                const key = JSON.stringify(check.columns.map((c) => row[c]));
                seen.set(key, (seen.get(key) ?? 0) + 1);
            }
            const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => JSON.parse(k).join(' / '));
            return dupes.length === 0
                ? { ...base, status: 'pass' }
                : {
                      ...base,
                      status: 'flag',
                      message: check.message ?? 'Key columns repeat; a JOIN may have multiplied rows.',
                      detail: { repeated: dupes.slice(0, MAX_FLAGGED_KEYS), count: dupes.length },
                  };
        }

        if (check.type === 'total_matches') {
            if (missing(check.column)) return { ...base, status: 'error', detail: `result has no column ${check.column}` };
            if (truncated) return { ...base, status: 'skipped', detail: 'result was truncated by the row limit' };
            const expected = totals[check.id];
            if (typeof expected !== 'number') return { ...base, status: 'error', detail: 'independent total unavailable' };
            const actual = rows.reduce((sum, r) => sum + (typeof r[check.column] === 'number' ? r[check.column] : 0), 0);
            // Totals here are integers (cents) in practice; allow float noise for REAL columns.
            const equal = Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
            return equal
                ? { ...base, status: 'pass', detail: { total: actual } }
                : {
                      ...base,
                      status: 'flag',
                      message: check.message ?? 'Column total does not match an independent total; rows may be double counted or missing.',
                      detail: { resultTotal: actual, independentTotal: expected },
                  };
        }

        if (check.type === 'empty') {
            if (rows.length === 0) return { ...base, status: 'pass' };
            if (check.key && missing(check.key)) return { ...base, status: 'error', detail: `result has no column ${check.key}` };
            const sample = check.key ? rows.map((r) => r[check.key]) : [];
            return {
                ...base,
                status: 'flag',
                message: check.message ?? 'The query returned rows; none were expected.',
                detail: { count: rows.length, ...(check.key ? { rows: sample.slice(0, MAX_FLAGGED_KEYS) } : {}) },
            };
        }

        // compare
        const rightIsColumn = typeof check.right === 'string';
        const absent = [check.left, ...(rightIsColumn ? [check.right] : []), ...(check.key ? [check.key] : [])].filter(missing);
        if (absent.length) return { ...base, status: 'error', detail: `result has no column ${absent.join(', ')}` };
        const offending = [];
        for (const row of rows) {
            const a = row[check.left];
            const b = rightIsColumn ? row[check.right] : check.right;
            if (a === null || a === undefined || b === null || b === undefined) continue;
            if (!compare(a, check.op, b)) offending.push(check.key ? row[check.key] : offending.length);
        }
        const rule = `${check.left} ${check.op} ${check.right}`;
        return offending.length === 0
            ? { ...base, status: 'pass', rule }
            : {
                  ...base,
                  status: 'flag',
                  rule,
                  message: check.message ?? `Rule ${rule} does not hold for every row.`,
                  detail: { rows: offending.slice(0, MAX_FLAGGED_KEYS), count: offending.length },
              };
    });

    const integrityBad = results.some((r) => r.severity === 'integrity' && (r.status === 'flag' || r.status === 'error'));
    return {
        checks: results,
        integrity: integrityBad ? 'flag' : 'pass',
        findings: results.filter((r) => r.severity === 'finding' && r.status === 'flag').length,
    };
}
