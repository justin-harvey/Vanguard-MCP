/**
 * The ad-hoc query orchestration, pure.
 *
 * S4 removes the Anthropic key from the open-ended path. For a named query the
 * ruleset writes the SQL; for a free-text question the planner did, which needed
 * a key. But the host AI calling this engine can write SQL itself, so there is a
 * third shape: the agent brings its own SELECT and we run it through the *same*
 * controls as everything else. No planner, no narration, no model call, no key.
 *
 * The guard (guard.js) stays the one trust boundary: the SQL is parsed,
 * SELECT-only, held to the warehouse's table and column allow-list, and run over
 * the read-only connection. This module adds no new path to the data; it reuses
 * the guard, the lineage and the hash-chained audit the credentialed path uses.
 *
 * Like named-core.js it takes its I/O as injected collaborators (guard,
 * warehouse, appendAudit) rather than importing them, so it has no `node:`
 * imports and the browser engine can share it unchanged. query-run.js is the
 * thin Node wrapper that supplies the SQLite warehouse and the file-backed audit.
 *
 * Two operations:
 *   executeAgentQuery  run the agent's SQL, record lineage + audit entry.
 *   verifyAgentAnswer  re-run a claimed figure's SQL and check it reproduces,
 *                      so any number in a narration is checkable without
 *                      trusting the narration. Read-only: it never appends.
 */

import { buildLineage, fingerprint } from './lineage.js';
import { checkGrounding } from './grounding.js';

/** Compliance tags carried by every agent-SQL audit entry, in both runtimes. */
export const AGENT_QUERY_TAGS = Object.freeze(['agent-sql', 'guarded', 'reproducible']);

/** The guard options a warehouse descriptor implies: its table and column allow-lists. */
function guardOptionsFor(descriptor) {
    return { allowedTables: descriptor.allowedTables, allowedColumns: descriptor.allowedColumns ?? null };
}

/**
 * Guard and run one statement, returning either the guarded SQL and rows or a
 * refusal object (never throwing for an expected refusal). A guard rejection
 * carries `.reason`/`.name === 'SqlRejected'`; a warehouse failure (a write the
 * read-only connection refused, an unknown column, a timeout) is reported as a
 * database rejection. Classifying by shape rather than `instanceof` keeps this
 * module free of the guard and db imports, so it loads without the SQL parser.
 *
 * @returns {{ ok: true, guarded: object, rows: object[] } | { ok: false, stage, reason, message, proposedSql }}
 */
function guardAndRun(descriptor, sql, { guard, warehouse }) {
    let guarded;
    try {
        guarded = guard(sql, guardOptionsFor(descriptor));
    } catch (error) {
        if (error && error.name === 'SqlRejected') {
            return { ok: false, stage: 'guard', reason: error.reason, message: error.message, proposedSql: sql };
        }
        throw error;
    }
    let rows;
    try {
        rows = warehouse.query(guarded.sql, { params: guarded.params });
    } catch (error) {
        return {
            ok: false,
            stage: 'execute',
            reason: error.reason ?? 'database_rejected',
            message: error.message,
            proposedSql: guarded.sql,
        };
    }
    return { ok: true, guarded, rows };
}

/**
 * Run the agent's own SQL end to end: guard it, run it read-only, build the
 * lineage, and append it to the hash-chained audit via the injected appendAudit.
 * The result carries the ruleset that governs this warehouse and the hash of the
 * data it ran against, the same provenance a named query records (named-core.js).
 *
 * @param {object} descriptor a warehouse descriptor (its allow-lists, ruleset, dataHash)
 * @param {string} sql the host AI's SELECT
 * @param {object} deps
 * @param {Function} deps.guard the SQL guard
 * @param {{ query: Function }} deps.warehouse a read-only warehouse adapter
 * @param {(record: object, opts: { complianceTags: readonly string[] }) => object} deps.appendAudit
 * @param {string|null} [deps.question] what the SQL is meant to answer, recorded in lineage
 * @param {string} [deps.actor]
 * @returns {{ ok: true, sql: string, rows: object[], limitInjected: boolean, lineage: object, entry: object }
 *   | { ok: false, stage: string, reason: string, message: string, proposedSql: string }}
 */
export function executeAgentQuery(descriptor, sql, { guard, warehouse, appendAudit, question = null, actor = 'agent' }) {
    const run = guardAndRun(descriptor, sql, { guard, warehouse });
    if (!run.ok) return run;
    const { guarded, rows } = run;

    const lineage = buildLineage({
        question: question ?? guarded.sql,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        actor,
    });
    const entry = appendAudit(
        {
            ...lineage,
            // The SQL came from the host AI, not the planner: no model call, no
            // key. Recorded as a field so the audit export carries the claim.
            agentSql: true,
            // Tie the result to the ruleset governing this warehouse and the data
            // it ran against, exactly as the named-query path does.
            ruleset: descriptor.ruleset ?? null,
            rulesetHash: descriptor.ruleset?.contentHash ?? null,
            dataHash: descriptor.dataHash ?? null,
        },
        { complianceTags: AGENT_QUERY_TAGS },
    );

    return { ok: true, sql: guarded.sql, rows, limitInjected: guarded.limitInjected, lineage, entry };
}

/**
 * Is a claimed figure grounded in a result set? Reuses the narration grounding
 * check (grounding.js), treating the single figure as the prose to verify; a
 * value that matches nothing the query returned is ungrounded. A non-numeric
 * claim extracts no figure, which is treated as not grounded rather than as
 * vacuously true.
 *
 * @param {string|number} figure
 * @param {object[]} rows
 * @returns {{ grounded: boolean, source: number|null, via: string|null }}
 */
function groundFigure(figure, rows) {
    const result = checkGrounding({ narration: String(figure), rows });
    const first = result.grounded[0] ?? null;
    return {
        grounded: result.checked > 0 && result.ok,
        source: first?.source ?? null,
        via: first?.via ?? null,
    };
}

/**
 * Re-run the SQL behind a claimed answer and check it reproduces. This is the
 * "every figure is checkable without trusting the narration" operation: give it
 * the SQL and either a prior `resultHash` or a claimed figure, and it recomputes
 * from the live data and compares. Read-only; it appends nothing.
 *
 * @param {object} descriptor a warehouse descriptor
 * @param {object} claim
 * @param {string} claim.sql the SQL to re-run
 * @param {string|null} [claim.claimedResultHash] a prior lineage resultHash to match
 * @param {string|number|null} [claim.claimedFigure] a figure that should appear in the result
 * @param {object} deps
 * @param {Function} deps.guard the SQL guard
 * @param {{ query: Function }} deps.warehouse a read-only warehouse adapter
 * @returns {{ ok: true, sql, rowCount, resultHash, claimedResultHash, hashMatch, claimedFigure,
 *   figureGrounded, figureSource, figureVia, match, rulesetHash, dataHash }
 *   | { ok: false, stage, reason, message, proposedSql? }}
 */
export function verifyAgentAnswer(descriptor, { sql, claimedResultHash = null, claimedFigure = null }, { guard, warehouse }) {
    if (claimedResultHash == null && claimedFigure == null) {
        return {
            ok: false,
            stage: 'verify',
            reason: 'no_claim',
            message: 'Provide claimedResultHash or claimedFigure to verify against the SQL.',
        };
    }

    const run = guardAndRun(descriptor, sql, { guard, warehouse });
    if (!run.ok) return run;
    const { guarded, rows } = run;

    const resultHash = fingerprint(rows);

    let hashMatch = null;
    if (claimedResultHash != null) hashMatch = resultHash === claimedResultHash;

    let figureGrounded = null;
    let figureSource = null;
    let figureVia = null;
    if (claimedFigure != null) {
        const g = groundFigure(claimedFigure, rows);
        figureGrounded = g.grounded;
        figureSource = g.source;
        figureVia = g.via;
    }

    // "match" is true only when every claim supplied actually checked out.
    const match = (hashMatch ?? true) && (figureGrounded ?? true);

    return {
        ok: true,
        sql: guarded.sql,
        rowCount: rows.length,
        resultHash,
        claimedResultHash,
        hashMatch,
        claimedFigure,
        figureGrounded,
        figureSource,
        figureVia,
        match,
        // The ruleset and data this verification ran against, so a mismatch can
        // be told apart from a check run against a different ruleset or dataset.
        rulesetHash: descriptor.ruleset?.contentHash ?? null,
        dataHash: descriptor.dataHash ?? null,
    };
}
