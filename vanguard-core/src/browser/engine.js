/**
 * The demo engine, assembled from the same source the Node package runs.
 *
 * This is runtime-agnostic: no DOM, no sql.js import, no storage of its own. It
 * takes a SQLite adapter, the seed SQL, the allow-list and an audit store, and
 * exposes the four operations the demo page needs. The guard, the named-query
 * orchestration, the lineage and the audit chain are all the real engine
 * modules (guard.js, named-core.js, lineage.js, audit-core.js), so a visitor's
 * browser runs byte-for-byte what a buyer runs; test/browser-parity.test.js
 * pins that the result hashes match.
 *
 * Everything runs locally. Nothing is sent anywhere.
 */

import { guard } from '../guard.js';
import { parseAllowlist } from '../allowlist.js';
import { describeQuery } from '../named-queries.js';
import { executeNamedQuery } from '../named-core.js';
import { appendEntry, verifyEntries, provenanceOf } from '../audit-core.js';

/**
 * @param {object} deps
 * @param {{ exec(sql: string): void, query(sql: string, options?: object): object[] }} deps.sqlite
 * @param {string} deps.seedSql  the demo database as SQL text
 * @param {object} deps.allowlist  the allow-list document (unparsed JSON object)
 * @param {{ load(): object[], save(entries: object[]): void }} deps.store  the audit chain's storage
 * @returns {{
 *   name: string,
 *   listQueries(): object[],
 *   runNamed(name: string, args?: object): object,
 *   verifyChain(): { ok: boolean, entries: number, brokenAt: number|null, reason: string|null },
 *   resetChain(): void,
 *   tamperFirstEntry(): boolean,
 * }}
 */
export function createDemoEngine({ sqlite, seedSql, allowlist, store }) {
    sqlite.exec(seedSql);
    // The guard is the real read-only control; this is the browser equivalent
    // of the Node read-only file handle, a second line in case of a guard bug.
    sqlite.exec('PRAGMA query_only = ON');

    const parsed = parseAllowlist(allowlist);
    const descriptor = {
        name: parsed.name,
        allowedTables: Object.keys(parsed.tables),
        allowedColumns: parsed.tables,
        queries: parsed.queries,
    };

    const warehouse = { query: (sql, options) => sqlite.query(sql, options) };

    const appendAudit = (record, { complianceTags }) => {
        const entries = store.load();
        const entry = appendEntry(entries, record, { complianceTags });
        entries.push(entry);
        store.save(entries);
        return entry;
    };

    return {
        name: parsed.name,

        /** Names, descriptions and parameters of the available named queries. */
        listQueries() {
            return Object.values(parsed.queries).map(describeQuery);
        },

        /**
         * Run a named query. Output matches run_canonical over MCP: rows, the
         * automatic checks, integrity, findings and the provenance record.
         */
        runNamed(name, args) {
            const out = executeNamedQuery(descriptor, name, args ?? {}, { guard, warehouse, appendAudit });
            return {
                query: out.query,
                params: out.params,
                sql: out.lineage.sql,
                rows: out.rows,
                integrity: out.integrity,
                findings: out.findings,
                checks: out.checks,
                provenance: provenanceOf(out.entry),
            };
        },

        /**
         * Run arbitrary SQL through the guard and the read-only connection, so
         * a visitor can watch the guard refuse what reaches outside the
         * allow-list (a write, SELECT *, the payroll table, a vendor tax id).
         * Not audited: this is the "try your own SQL" box, not a canonical
         * answer. Returns the guarded SQL and rows on success, or the refusal
         * reason on rejection.
         */
        tryRawSql(sql) {
            try {
                const guarded = guard(sql, {
                    allowedTables: descriptor.allowedTables,
                    allowedColumns: descriptor.allowedColumns,
                });
                const rows = warehouse.query(guarded.sql, { params: guarded.params });
                return { ok: true, sql: guarded.sql, rows, limitInjected: guarded.limitInjected };
            } catch (error) {
                return { ok: false, reason: error.reason ?? 'error', message: error.message };
            }
        },

        /** Walk this browser's audit chain and report whether it is intact. */
        verifyChain() {
            return verifyEntries(store.load());
        },

        /** Clear this browser's audit chain. */
        resetChain() {
            store.save([]);
        },

        /**
         * Tamper with the first stored entry so the visitor can watch
         * verifyChain() catch it, the clearest demonstration of tamper
         * evidence, and only possible because the chain is local. Returns false
         * if there is nothing to tamper with yet.
         */
        tamperFirstEntry() {
            const entries = store.load();
            if (entries.length === 0) return false;
            // Alter a field the entry hash covers without recomputing the hash:
            // verifyEntries recomputes it and finds the mismatch at index 0.
            entries[0] = { ...entries[0], rowCount: (entries[0].rowCount ?? 0) + 1 };
            store.save(entries);
            return true;
        },
    };
}
