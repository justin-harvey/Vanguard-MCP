/**
 * The Node wrapper around the named-query orchestration.
 *
 * The orchestration itself lives in named-core.js, which is pure so the browser
 * engine can share it. This module supplies the two Node-bound collaborators:
 * the SQLite warehouse (node:sqlite, via warehouse.js) and the file-backed,
 * optionally-signed audit append (audit.js). mcp.js and the CLI call
 * runNamedQuery with the same signature as before, so nothing above changed.
 *
 * The guard is passed in rather than imported, so this module (and its tests)
 * load without the SQL parser; mcp.js passes the real one.
 */

import { SqliteWarehouse } from './warehouse.js';
import { append } from './audit.js';
import { executeNamedQuery, guardOptionsFor } from './named-core.js';

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
    const appendAudit = (record, { complianceTags }) =>
        append(record, { path: descriptor.logPath, complianceTags, signer });
    return executeNamedQuery(descriptor, name, args, { guard, warehouse, appendAudit });
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
