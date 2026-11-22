/**
 * Allow-list parsing and validation, pure.
 *
 * This is the part of a custom warehouse's configuration that needs no database
 * and no filesystem: given a parsed JSON document, validate its shape and return
 * a normalised copy. `custom.js` layers the file reading and the live-database
 * checks on top (and re-exports everything here, so existing importers are
 * unaffected); the browser build inlines the allow-list at build time and calls
 * `parseAllowlist` directly, which is why this carries no `node:` imports.
 */

import { parseQueries, NamedQueryError } from './named-queries.js';

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
