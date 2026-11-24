/**
 * The in-browser CSV import, assembled from the same pure core the Node package
 * runs (import-canonical.js). Runtime-agnostic: no DOM, no sql.js import of its
 * own. It takes CSV text, proposes a column mapping, and — once the mapping is
 * confirmed — builds a Canonical Municipal Schema v1 ledger entirely in memory
 * and wraps it in the real engine (guard, named queries, lineage, audit chain)
 * via createDemoEngine.
 *
 * Because the ledger is built from canonicalTables()/seedSqlFromTables() — the
 * exact rows the Node importer inserts — a visitor's browser runs byte-for-byte
 * what a buyer's import produces, and the result hashes match. The acceptance
 * gate is test/import-browser-parity.test.js.
 *
 * The file never leaves the machine: the bytes are parsed here and dropped into
 * an in-memory WASM database. Nothing is uploaded and there is no network call.
 */

import { createDemoEngine } from './engine.js';
import { sqljsAdapter } from './sqlite-adapter.js';
import {
    parseCsv,
    proposeMapping,
    buildCanonicalRecordsFromCsv,
    canonicalTables,
    seedSqlFromTables,
    CANONICAL_IMPORT_FIELDS,
    ImportError,
} from '../import-canonical.js';

export { CANONICAL_IMPORT_FIELDS, ImportError };

/**
 * Propose a column mapping from CSV text. Parses the file, samples rows to break
 * type ties, and returns the proposal for the visitor to confirm or edit. Reads
 * only; writes nothing. Throws ImportError on a parse error or an empty file.
 *
 * @param {string} csvText
 * @param {number} [sampleSize] rows sampled to confirm money/date columns
 * @returns {{ headers: string[], rowCount: number, mapping: Record<string,string>, fields: object[], unmappedHeaders: string[], missingRequired: string[] }}
 */
export function proposeImport(csvText, sampleSize = 50) {
    const { headers, rows } = parseCsv(csvText);
    const proposal = proposeMapping(headers, rows.slice(0, sampleSize));
    return { headers, rowCount: rows.length, ...proposal };
}

/**
 * Build an in-browser engine over a canonical ledger imported from CSV text and
 * a confirmed mapping. `makeDb` returns a fresh sql.js Database (the caller owns
 * sql.js loading, so this module stays runtime-agnostic and testable in Node).
 *
 * @param {object} params
 * @param {() => object} params.makeDb  returns a fresh sql.js Database
 * @param {string} params.csvText
 * @param {Record<string,string>} params.mapping confirmed field -> column
 * @param {object} params.allowlist  the municipal allow-list document (unparsed JSON)
 * @param {{ load(): object[], save(entries: object[]): void }} params.store audit-chain storage
 * @returns {{ engine: ReturnType<typeof createDemoEngine>, counts: object }}
 * @throws {ImportError}
 */
export function buildImportEngine({ makeDb, csvText, mapping, allowlist, store }) {
    const { records } = buildCanonicalRecordsFromCsv(csvText, mapping);
    const tables = canonicalTables(records);
    const seedSql = seedSqlFromTables(tables);
    const sqlite = sqljsAdapter(makeDb());
    const engine = createDemoEngine({ sqlite, seedSql, allowlist, store });
    return { engine, counts: tables.counts };
}
