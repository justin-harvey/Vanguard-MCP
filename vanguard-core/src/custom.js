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
 *   VANGUARD_DB_PATH          the SQLite file (opened read-only, always)
 *   VANGUARD_ALLOWLIST_PATH   JSON naming the warehouse, its tables and columns
 *   VANGUARD_AUDIT_LOG        optional; defaults to <name>-audit.jsonl beside the db
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
import { parseQueries, NamedQueryError } from './named-queries.js';

export const CUSTOM_ENV = Object.freeze({
    db: 'VANGUARD_DB_PATH',
    allowlist: 'VANGUARD_ALLOWLIST_PATH',
    log: 'VANGUARD_AUDIT_LOG',
});

/** Warehouse names a custom warehouse may not take. */
export const RESERVED_NAMES = Object.freeze(['saas', 'markets', 'enron', 'lseg', 'audit']);

const NAME = /^[a-z][a-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CustomWarehouseInvalid extends Error {
    constructor(message) {
        super(message);
        this.name = 'CustomWarehouseInvalid';
    }
}

/**
 * Validate a parsed allow-list document and return a normalised copy.
 *
 * @param {unknown} doc
 * @returns {{ name: string, description: string, domain: string, tables: Record<string,string[]>, notes: string[], queries: object }}
 * @throws {CustomWarehouseInvalid}
 */
export function parseAllowlist(doc) {
    const fail = (msg) => {
        throw new CustomWarehouseInvalid(`Invalid allow-list: ${msg}`);
    };
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('expected a JSON object.');

    const { name, description = '', domain, tables, notes = [] } = doc;
    if (typeof name !== 'string' || !NAME.test(name)) {
        fail('"name" must be lowercase letters, digits or underscores, starting with a letter.');
    }
    if (RESERVED_NAMES.includes(name)) {
        fail(`"name" may not be a built-in warehouse (${RESERVED_NAMES.join(', ')}).`);
    }
    if (typeof description !== 'string') fail('"description" must be a string.');
    if (domain !== undefined && typeof domain !== 'string') fail('"domain" must be a string.');
    if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string')) fail('"notes" must be an array of strings.');

    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
        fail('"tables" must be an object mapping each table to its permitted columns.');
    }
    const entries = Object.entries(tables);
    if (entries.length === 0) fail('"tables" must name at least one table.');

    const normalised = {};
    for (const [table, columns] of entries) {
        if (!IDENTIFIER.test(table)) fail(`table name "${table}" is not a plain SQL identifier.`);
        if (table.toLowerCase().startsWith('sqlite_')) fail(`table "${table}" is an SQLite internal table.`);
        if (!Array.isArray(columns) || columns.length === 0) {
            fail(`table "${table}" must list at least one permitted column.`);
        }
        for (const column of columns) {
            if (typeof column !== 'string' || !IDENTIFIER.test(column)) {
                fail(`column ${JSON.stringify(column)} in "${table}" is not a plain SQL identifier.`);
            }
        }
        normalised[table] = [...new Set(columns)];
    }

    let queries;
    try {
        queries = parseQueries(doc.queries);
    } catch (error) {
        if (error instanceof NamedQueryError) fail(error.message);
        throw error;
    }

    return {
        name,
        description,
        domain: domain ?? `${name} data`,
        tables: normalised,
        notes: [...notes],
        queries,
    };
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
    const dbVar = env[CUSTOM_ENV.db];
    const allowVar = env[CUSTOM_ENV.allowlist];
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
    const schemaDescription = describeAgainstDatabase(dbPath, allowlist.tables, allowlist.notes, allowlist.queries);

    const allowedTables = Object.freeze(Object.keys(allowlist.tables));
    const allowedColumns = Object.freeze(
        Object.fromEntries(Object.entries(allowlist.tables).map(([t, cols]) => [t, Object.freeze(cols)])),
    );
    const logPath = env[CUSTOM_ENV.log]
        ? resolve(env[CUSTOM_ENV.log])
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
        queries: allowlist.queries,
        planSchema: {
            domain: allowlist.domain,
            schemaDescription,
            allowedTables,
            columnRestricted: true,
        },
    };
}
