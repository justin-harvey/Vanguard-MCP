/**
 * Run a custom warehouse's named query, with its checks, through the same
 * controls as every other query: the guard (table and column allow-lists), the
 * read-only connection, lineage, and the warehouse's hash-chained audit log.
 *
 * The guard is passed in rather than imported, so this module (and its tests)
 * load without the SQL parser; mcp.js passes the real one.
 *
 * Check results are written into the audit entry, so they are covered by the
 * entry hash: a later reader can see that a result was checked, and what the
 * checks found, without re-running anything.
 */

import { SqliteWarehouse } from './warehouse.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { validateArgs, bindParams, evaluateChecks, NamedQueryError } from './named-queries.js';

/** The guard's row cap: a result this long may have been cut off. */
const MAX_ROWS = 1000;

function guardOptionsFor(descriptor) {
    return { allowedTables: descriptor.allowedTables, allowedColumns: descriptor.allowedColumns };
}

function lookup(descriptor, name) {
    const def = descriptor.queries?.[name];
    if (!def) {
        const known = Object.keys(descriptor.queries ?? {});
        throw new NamedQueryError(
            `Unknown query "${descriptor.name}/${name}". ` +
                (known.length ? `Known: ${known.map((q) => `${descriptor.name}/${q}`).join(', ')}.` : 'This warehouse defines none.'),
        );
    }
    return def;
}

/**
 * @param {object} descriptor a custom warehouse descriptor (custom.js)
 * @param {string} name the query name, without the warehouse prefix
 * @param {object} [args] argument values by parameter name
 * @param {object} options
 * @param {Function} options.guard the SQL guard
 * @param {object|null} [options.signer]
 * @param {{ query: Function }} [options.warehouse]
 * @returns {{ query: string, params: object, rows: object[], checks: object[], integrity: 'pass'|'flag',
 *   findings: number, lineage: object, entry: object }}
 */
export function runNamedQuery(descriptor, name, args, { guard, signer = null, warehouse = new SqliteWarehouse(descriptor.dbPath) }) {
    const def = lookup(descriptor, name);
    const values = validateArgs(def, args ?? {});
    const options = guardOptionsFor(descriptor);

    const guarded = guard(def.sql, options);
    const rows = warehouse.query(guarded.sql, { params: [...guarded.params, ...bindParams(def.order, values)] });

    // Independent totals for total_matches checks, each its own guarded query.
    const totals = {};
    for (const check of def.checks) {
        if (check.type !== 'total_matches') continue;
        const g = guard(check.sql, options);
        const result = warehouse.query(g.sql, { params: [...g.params, ...bindParams(check.order, values)] });
        const first = result[0] ? Object.values(result[0])[0] : null;
        totals[check.id] = typeof first === 'number' ? first : null;
    }
    const evaluation = evaluateChecks(def.checks, rows, {
        totals,
        truncated: guarded.limitInjected && rows.length >= MAX_ROWS,
    });

    const query = `${descriptor.name}/${name}`;
    const lineage = buildLineage({
        question: `${query} ${JSON.stringify(values)}`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append(
        {
            ...lineage,
            namedQuery: query,
            params: values,
            checks: evaluation.checks,
            integrity: evaluation.integrity,
            findings: evaluation.findings,
        },
        { path: descriptor.logPath, complianceTags: ['named-query', 'checked', 'reproducible'], signer },
    );

    return { query, params: values, rows, ...evaluation, lineage, entry };
}

/**
 * Guard every named query and check SQL without running it, so a definition
 * that reaches outside the allow-list fails at server start rather than on a
 * user's first call. Returns the number of statements checked.
 *
 * @param {object} descriptor
 * @param {Function} guard
 * @returns {number}
 * @throws {Error} listing every refused statement
 */
export function validateNamedQueries(descriptor, guard) {
    const options = guardOptionsFor(descriptor);
    const refused = [];
    let count = 0;
    for (const def of Object.values(descriptor.queries ?? {})) {
        const statements = [['sql', def.sql], ...def.checks.filter((c) => c.sql).map((c) => [`check "${c.id}"`, c.sql])];
        for (const [label, sql] of statements) {
            count += 1;
            try {
                guard(sql, options);
            } catch (error) {
                refused.push(`${descriptor.name}/${def.name} ${label}: ${error.reason ?? 'refused'}: ${error.message}`);
            }
        }
    }
    if (refused.length > 0) {
        throw new Error(`Named queries refused by the guard: ${refused.join('; ')}`);
    }
    return count;
}
