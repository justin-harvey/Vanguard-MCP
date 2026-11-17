/**
 * The bundled municipal demo: the Town of Sampleton grant-and-budget ledger.
 *
 * This is the warehouse a buyer's MCP client points at out of the box, so the
 * pasted config answers "how much of grant G-402 has been spent, by vendor?"
 * with no setup and no credential. The SQL seed and allow-list ship read-only
 * inside the package (assets/municipal); the SQLite database is built from them
 * into the writable per-user data directory on demand.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { MUNICIPAL_SQL_PATH, MUNICIPAL_ALLOWLIST_PATH, municipalDbPath, dataPath, ensureParent } from './paths.js';

/** The materialized allow-list path in the data directory (a stable copy of the bundled asset). */
export function municipalAllowlistPath(opts) {
    return dataPath('municipal-allowlist.json', opts);
}

/**
 * Build the municipal demo into the writable data directory from its bundled,
 * read-only seed: the SQLite database from the SQL seed, plus a stable copy of
 * the allow-list. Both land in the data directory so the MCP config can point at
 * them regardless of where npm or npx placed the package (which may be read-only
 * or wiped on reinstall).
 *
 * The database build is atomic: it writes a temp file and renames, so an aborted
 * build never leaves a half-written database behind.
 *
 * @param {object} [options]
 * @param {string} [options.sqlPath]        the bundled SQL seed (defaults to the package asset)
 * @param {string} [options.allowlistPath]  the bundled allow-list (defaults to the package asset)
 * @param {string} [options.dbPath]         where to build the db (defaults to the data dir)
 * @param {string} [options.allowlistOut]   where to copy the allow-list (defaults to the data dir)
 * @param {boolean} [options.rebuild]       rebuild even if the database exists
 * @returns {{ dbPath: string, allowlistPath: string, built: boolean }}
 */
export function buildMunicipalDemo({
    sqlPath = MUNICIPAL_SQL_PATH,
    allowlistPath = MUNICIPAL_ALLOWLIST_PATH,
    dbPath = municipalDbPath(),
    allowlistOut = municipalAllowlistPath(),
    rebuild = false,
} = {}) {
    if (!existsSync(sqlPath)) throw new Error(`municipal demo seed is missing: ${sqlPath}`);
    if (!existsSync(allowlistPath)) throw new Error(`municipal demo allow-list is missing: ${allowlistPath}`);

    // Always refresh the allow-list copy: it is small and keeps the stable copy in
    // step with the bundled asset across upgrades.
    ensureParent(allowlistOut);
    writeFileSync(allowlistOut, readFileSync(allowlistPath));

    if (existsSync(dbPath) && !rebuild) return { dbPath, allowlistPath: allowlistOut, built: false };

    ensureParent(dbPath);
    const tmp = `${dbPath}.building-${process.pid}`;
    try {
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(tmp);
        db.exec(readFileSync(sqlPath, 'utf8'));
        db.close();
        renameSync(tmp, dbPath);
        return { dbPath, allowlistPath: allowlistOut, built: true };
    } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
}
