/**
 * Drift guard for the Canonical Municipal Schema.
 *
 * The schema is declared once, in src/schema.js, and the importer builds from
 * it. Two other artifacts describe the same shape and used to be able to drift
 * from it independently:
 *   - the demo seed (assets/municipal/sample_municipal_budget.sql) re-declares
 *     the seven canonical tables inline, with its sample data;
 *   - the municipal allow-list (sample_allowlist.json) lists the tables and
 *     columns a query may touch.
 *
 * This test pins both back to schema.js. It builds the canonical DDL and the
 * demo seed into separate in-memory databases, introspects their real shape
 * with PRAGMA, and asserts the seven canonical tables are column-for-column
 * identical. It then asserts every allow-listed table and column exists in the
 * canonical schema (the allow-list is a subset — it deliberately omits the
 * sensitive vendor columns and the payroll table). A column added to the seed
 * or the importer but not the other, or an allow-list entry with no backing
 * column, fails here instead of silently at a buyer's first import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { CANONICAL_SCHEMA_VERSION, CANONICAL_SCHEMA_DDL, CANONICAL_SCHEMA_TABLES } from '../src/schema.js';
import { MUNICIPAL_SQL_PATH, MUNICIPAL_ALLOWLIST_PATH, assetPath } from '../src/paths.js';

/** The column names of each table in a database, in declared order, via PRAGMA. */
function tableColumns(db) {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
    const shape = {};
    for (const t of tables) {
        shape[t] = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    }
    return shape;
}

/** Build SQL into a throwaway in-memory database and return its table shape. */
function shapeOf(sql) {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(sql);
        return tableColumns(db);
    } finally {
        db.close();
    }
}

test('the canonical DDL declares exactly the tables schema.js names', () => {
    const shape = shapeOf(CANONICAL_SCHEMA_DDL);
    assert.deepEqual(Object.keys(shape).sort(), [...CANONICAL_SCHEMA_TABLES].sort());
});

test('the demo seed declares the canonical tables column-for-column', () => {
    const canonical = shapeOf(CANONICAL_SCHEMA_DDL);
    const seed = shapeOf(readFileSync(MUNICIPAL_SQL_PATH, 'utf8'));
    for (const table of CANONICAL_SCHEMA_TABLES) {
        assert.ok(seed[table], `the demo seed is missing canonical table "${table}"`);
        assert.deepEqual(
            seed[table],
            canonical[table],
            `demo seed table "${table}" has drifted from the canonical schema`,
        );
    }
});

test('every allow-listed table and column exists in the canonical schema', () => {
    const canonical = shapeOf(CANONICAL_SCHEMA_DDL);
    const allow = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST_PATH, 'utf8'));
    for (const [table, columns] of Object.entries(allow.tables)) {
        assert.ok(canonical[table], `allow-list names table "${table}", which the canonical schema has no`);
        for (const column of columns) {
            assert.ok(
                canonical[table].includes(column),
                `allow-list names ${table}.${column}, which the canonical schema has no`,
            );
        }
    }
});

test('the bundled ruleset is pinned to the canonical schema version', () => {
    const ruleset = JSON.parse(readFileSync(assetPath('municipal', 'ruleset.municipal-v1.json'), 'utf8'));
    assert.equal(ruleset.version, CANONICAL_SCHEMA_VERSION);
});
