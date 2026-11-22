/**
 * The Node wrapper around the ad-hoc query orchestration.
 *
 * The orchestration lives in query-core.js, which is pure so the browser engine
 * can share it. This module supplies the two Node-bound collaborators: the
 * SQLite warehouse (node:sqlite, via warehouse.js) and the file-backed,
 * optionally-signed audit append (audit.js), the same pair named-run.js supplies
 * for named queries. The guard is passed in rather than imported, so this module
 * (and its tests) load without the SQL parser; mcp.js passes the real one.
 */

import { SqliteWarehouse } from './warehouse.js';
import { append } from './audit.js';
import { executeAgentQuery, verifyAgentAnswer } from './query-core.js';

/**
 * Run the host AI's SQL through the guard and record it. The descriptor carries
 * the warehouse's paths, allow-lists, ruleset and data hash.
 *
 * @param {object} descriptor a warehouse descriptor
 * @param {string} sql the host AI's SELECT
 * @param {object} options
 * @param {Function} options.guard the SQL guard
 * @param {object|null} [options.signer]
 * @param {string|null} [options.question]
 * @param {{ query: Function }} [options.warehouse]
 */
export function runAgentQuery(descriptor, sql, { guard, signer = null, question = null, warehouse = new SqliteWarehouse(descriptor.dbPath) }) {
    const appendAudit = (record, { complianceTags }) =>
        append(record, { path: descriptor.logPath, complianceTags, signer });
    return executeAgentQuery(descriptor, sql, { guard, warehouse, appendAudit, question });
}

/**
 * Re-run the SQL behind a claimed answer and check it reproduces. Read-only: it
 * opens the warehouse but never appends to the audit log.
 *
 * @param {object} descriptor a warehouse descriptor
 * @param {{ sql: string, claimedResultHash?: string|null, claimedFigure?: string|number|null }} claim
 * @param {object} options
 * @param {Function} options.guard the SQL guard
 * @param {{ query: Function }} [options.warehouse]
 */
export function verifyAgentQuery(descriptor, claim, { guard, warehouse = new SqliteWarehouse(descriptor.dbPath) }) {
    return verifyAgentAnswer(descriptor, claim, { guard, warehouse });
}
