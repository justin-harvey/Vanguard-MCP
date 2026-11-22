/**
 * The named-query orchestration, pure.
 *
 * This runs a custom warehouse's named query through the same controls as every
 * other query, the guard, lineage, the checks, and the hash-chained audit, but
 * takes its I/O as injected collaborators rather than importing them, so it has
 * no `node:` imports and runs unchanged in the browser:
 *
 *   guard       the SQL guard (table and column allow-lists)
 *   warehouse   anything with query(sql, { params }) -> rows (node:sqlite in
 *               Node, WASM SQLite in the browser)
 *   appendAudit (record, { complianceTags }) -> entry; the Node path writes a
 *               signed JSONL line, the browser path appends to a localStorage
 *               chain. Both build the entry with audit-core's appendEntry, so
 *               an entry is identical whichever path wrote it.
 *
 * `named-run.js` is the thin Node wrapper that supplies the file-backed audit
 * and the SQLite warehouse; the browser engine supplies its own. They share
 * this function, so the browser demo cannot drift from the engine buyers run,
 * which is what the parity test (test/browser-parity.test.js) pins.
 */

import { buildLineage } from './lineage.js';
import { validateArgs, bindParams, evaluateChecks, NamedQueryError } from './named-queries.js';

/** The guard's row cap: a result this long may have been cut off. */
const MAX_ROWS = 1000;

/** Compliance tags carried by every named-query audit entry, in both runtimes. */
export const NAMED_QUERY_TAGS = Object.freeze(['named-query', 'checked', 'reproducible']);

export function guardOptionsFor(descriptor) {
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
 * Run one named query end to end: validate arguments, guard and run the SQL,
 * run its checks, build the lineage, and append it to the audit chain via the
 * injected `appendAudit`.
 *
 * @param {object} descriptor a custom warehouse descriptor
 * @param {string} name the query name, without the warehouse prefix
 * @param {object} [args] argument values by parameter name
 * @param {object} deps
 * @param {Function} deps.guard the SQL guard
 * @param {{ query: Function }} deps.warehouse a read-only warehouse adapter
 * @param {(record: object, opts: { complianceTags: readonly string[] }) => object} deps.appendAudit
 * @returns {{ query: string, params: object, rows: object[], checks: object[], integrity: 'pass'|'flag',
 *   findings: number, lineage: object, entry: object }}
 */
export function executeNamedQuery(descriptor, name, args, { guard, warehouse, appendAudit }) {
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
    const entry = appendAudit(
        {
            ...lineage,
            namedQuery: query,
            params: values,
            checks: evaluation.checks,
            integrity: evaluation.integrity,
            findings: evaluation.findings,
            // S9: tie the result to the ruleset that produced it and the data it
            // ran against. rulesetHash is deterministic from the ruleset bytes,
            // so the same ruleset version on another machine records the same
            // hash; dataHash (e.g. the imported CSV's SHA-256) ties to the data.
            ruleset: descriptor.ruleset ?? null,
            rulesetHash: descriptor.ruleset?.contentHash ?? null,
            dataHash: descriptor.dataHash ?? null,
        },
        { complianceTags: NAMED_QUERY_TAGS },
    );

    return { query, params: values, rows, ...evaluation, lineage, entry };
}
