/**
 * A custom warehouse, configured from the environment rather than code.
 *
 * The built-in warehouses (saas, markets, enron, lseg) each hardcode their
 * schema, allow-list and audit log in a module. That is right for a demo whose
 * shape is part of the claim, but it means pointing the engine at a new ledger
 * (a town budget, a grant register, a checkbook) needs a code change. This
 * module removes that step: point three environment variables at a SQLite file
 * and an allow-list, and the engine serves it as one more warehouse, with free
 * text, through the same guard, grounding, lineage and audit chain.
 *
 *   CIVIC_DB_PATH          the SQLite file (opened read-only, always)
 *   CIVIC_ALLOWLIST_PATH   JSON naming the warehouse, its tables and columns
 *   CIVIC_AUDIT_LOG        optional; defaults to <name>-audit.jsonl beside the db
 *
 * The former VANGUARD_* names are still honoured as a fallback for one release.
 *
 * Nothing new is trusted. The allow-list is enforced by the existing guard
 * (tables *and* columns, so `SELECT *` is refused); the connection is the
 * existing read-only one. The allow-list is validated against the live database
 * at load time, so a typo fails loudly at startup instead of surfacing later as
 * a confusing refusal.
 *
 * Allow-list format:
 *   {
 *     "name": "municipal",                    // [a-z][a-z0-9_]*, not a built-in name
 *     "description": "…",                     // shown to the host AI
 *     "domain": "municipal budget data",      // optional; fills the planner prompt
 *     "tables": { "grants": ["grant_id", …] },// table -> permitted columns
 *     "notes": ["All money is INTEGER CENTS."],// optional planner hints
 *     "queries": { "grant-status": { … } }    // optional named queries; see named-queries.js
 *   }
 *
 * This module touches only node:sqlite, so it loads (and is tested) without the
 * SQL parser or the model SDK installed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openReadOnly } from './db.js';
import { parseAllowlist, CustomWarehouseInvalid, RESERVED_NAMES } from './allowlist.js';
import { loadRuleset } from './ruleset.js';

// parseAllowlist, CustomWarehouseInvalid and RESERVED_NAMES moved to the pure
// allowlist.js (no node: imports) so the browser build can reuse them; they are
// re-exported here so existing importers of custom.js are unaffected.
export { parseAllowlist, CustomWarehouseInvalid, RESERVED_NAMES };

export const CUSTOM_ENV = Object.freeze({
    db: 'CIVIC_DB_PATH',
    allowlist: 'CIVIC_ALLOWLIST_PATH',
    log: 'CIVIC_AUDIT_LOG',
    // S9: the Civic-Chain ruleset (queries + checks), separate from the buyer's
    // access policy (the allow-list). When set, its queries replace the
    // allow-list's and every result reports the ruleset's signature status.
    ruleset: 'CIVIC_RULESET_PATH',
    // A fingerprint of the data behind this warehouse (e.g. the imported CSV's
    // SHA-256), recorded on every audit entry so a figure ties back to its data.
    dataHash: 'CIVIC_DATA_HASH',
});

/**
 * Deprecated VANGUARD_* names, honoured as a fallback for one release so that
 * existing configs keep working through the rebrand. Read only when the CIVIC_*
 * name is unset.
 */
export const CUSTOM_ENV_ALIASES = Object.freeze({
    db: 'VANGUARD_DB_PATH',
    allowlist: 'VANGUARD_ALLOWLIST_PATH',
    log: 'VANGUARD_AUDIT_LOG',
});

/** Read a custom-warehouse variable by its canonical name, falling back to the alias. */
function readCustomEnv(env, key) {
    return env[CUSTOM_ENV[key]] ?? env[CUSTOM_ENV_ALIASES[key]];
}

/**
 * Check every allow-listed table and column exists in the database, read their
 * declared types, and compile (without running) every named query and check
 * SQL, so a typo fails at load. Returns the planner's schema text.
 *
 * Compiling proves the SQL is valid against this database; it does not prove
 * the SQL stays inside the allow-list. The guard enforces that when the query
 * runs, and at server start (see custom-run.js).
 *
 * @param {string} dbPath
 * @param {Record<string,string[]>} tables
 * @param {string[]} notes
 * @param {object} [queries]
 * @returns {string}
 * @throws {CustomWarehouseInvalid}
 */
function describeAgainstDatabase(dbPath, tables, notes, queries = {}) {
    const db = openReadOnly(dbPath);
    try {
        const missing = [];
        const lines = [];
        for (const [table, columns] of Object.entries(tables)) {
            const info = db.prepare(`PRAGMA table_info(${table})`).all();
            if (info.length === 0) {
                missing.push(`table ${table}`);
                continue;
            }
            const types = new Map(info.map((c) => [c.name, c.type || 'ANY']));
            for (const column of columns) {
                if (!types.has(column)) missing.push(`column ${table}.${column}`);
            }
            lines.push(`${table}(${columns.map((c) => `${c} ${types.get(c) ?? ''}`.trim()).join(', ')})`);
        }
        if (missing.length > 0) {
            throw new CustomWarehouseInvalid(
                `The allow-list names objects that are not in ${dbPath}: ${missing.join('; ')}.`,
            );
        }
        const broken = [];
        for (const def of Object.values(queries)) {
            const sqls = [['sql', def.sql], ...def.checks.filter((c) => c.sql).map((c) => [`check "${c.id}"`, c.sql])];
            for (const [label, sql] of sqls) {
                try {
                    db.prepare(sql);
                } catch (error) {
                    broken.push(`query "${def.name}" ${label}: ${error.message}`);
                }
            }
        }
        if (broken.length > 0) {
            throw new CustomWarehouseInvalid(`Named queries do not compile against ${dbPath}: ${broken.join('; ')}.`);
        }
        const notesText = notes.length > 0 ? `\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
        return lines.join('\n') + notesText;
    } finally {
        db.close();
    }
}

/**
 * Load the custom warehouse described by the environment, or null when none is
 * configured. Throws when the configuration is present but wrong: a half-set
 * pair of variables, a missing file, malformed JSON, or an allow-list that
 * names something the database does not contain.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {null | {
 *   name: string, description: string, dbPath: string, logPath: string,
 *   allowedTables: readonly string[], allowedColumns: Record<string, readonly string[]>,
 *   freeText: true, metrics: [], custom: true, queries: Record<string, object>,
 *   planSchema: { domain: string, schemaDescription: string, allowedTables: readonly string[], columnRestricted: true }
 * }}
 * @throws {CustomWarehouseInvalid}
 */
export function loadCustomWarehouse({ env = process.env } = {}) {
    const dbVar = readCustomEnv(env, 'db');
    const allowVar = readCustomEnv(env, 'allowlist');
    if (!dbVar && !allowVar) return null;
    if (!dbVar || !allowVar) {
        throw new CustomWarehouseInvalid(
            `A custom warehouse needs both ${CUSTOM_ENV.db} and ${CUSTOM_ENV.allowlist}; only ` +
                `${dbVar ? CUSTOM_ENV.db : CUSTOM_ENV.allowlist} is set.`,
        );
    }

    const dbPath = resolve(dbVar);
    const allowlistPath = resolve(allowVar);
    if (!existsSync(dbPath)) throw new CustomWarehouseInvalid(`${CUSTOM_ENV.db} points at ${dbPath}, which does not exist.`);
    if (!existsSync(allowlistPath)) {
        throw new CustomWarehouseInvalid(`${CUSTOM_ENV.allowlist} points at ${allowlistPath}, which does not exist.`);
    }

    let doc;
    try {
        doc = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    } catch (error) {
        throw new CustomWarehouseInvalid(`Could not parse ${allowlistPath} as JSON: ${error.message}`);
    }
    const allowlist = parseAllowlist(doc);

    // S9: queries come from the Civic-Chain ruleset when one is configured,
    // otherwise from the allow-list (the legacy, buyer-defined path). A ruleset
    // carries a version and a signature status that every result then reports.
    let queries = allowlist.queries;
    let ruleset = null;
    const rulesetVar = env[CUSTOM_ENV.ruleset];
    if (rulesetVar) {
        const rulesetPath = resolve(rulesetVar);
        if (!existsSync(rulesetPath)) {
            throw new CustomWarehouseInvalid(`${CUSTOM_ENV.ruleset} points at ${rulesetPath}, which does not exist.`);
        }
        const loaded = loadRuleset(rulesetPath);
        queries = loaded.queries;
        ruleset = {
            name: loaded.name,
            version: loaded.version,
            contentHash: loaded.contentHash,
            status: loaded.signature.status,
            signedBy: loaded.signature.signedBy,
        };
    }

    const schemaDescription = describeAgainstDatabase(dbPath, allowlist.tables, allowlist.notes, queries);

    const allowedTables = Object.freeze(Object.keys(allowlist.tables));
    const allowedColumns = Object.freeze(
        Object.fromEntries(Object.entries(allowlist.tables).map(([t, cols]) => [t, Object.freeze(cols)])),
    );
    const logVar = readCustomEnv(env, 'log');
    const logPath = logVar
        ? resolve(logVar)
        : join(dirname(dbPath), `${allowlist.name}-audit.jsonl`);

    return {
        name: allowlist.name,
        description: allowlist.description || `Custom warehouse loaded from ${dbPath}.`,
        dbPath,
        logPath,
        allowedTables,
        allowedColumns,
        freeText: true,
        metrics: [],
        custom: true,
        queries,
        ruleset,
        dataHash: env[CUSTOM_ENV.dataHash] ?? null,
        planSchema: {
            domain: allowlist.domain,
            schemaDescription,
            allowedTables,
            columnRestricted: true,
        },
    };
}
