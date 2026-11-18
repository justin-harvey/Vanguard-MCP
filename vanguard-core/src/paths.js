/**
 * Where the engine keeps the files it writes: the seeded demo warehouses and
 * their audit logs.
 *
 * The package ships read-only sources (schemas, the municipal sample, the
 * allow-list) inside its own directory, but it must never write there: once the
 * engine is installed from npm it lives under `node_modules`, which is often
 * read-only and is wiped on reinstall. Everything the engine *writes* therefore
 * goes to a per-user data directory outside the install.
 *
 * Resolution order:
 *   1. CIVIC_DATA_DIR, if set (operator override; also what the tests use).
 *   2. The platform's conventional per-user data location, plus "civic-chain-auditor":
 *        Windows  %APPDATA%\civic-chain-auditor
 *        macOS    ~/Library/Application Support/civic-chain-auditor
 *        Linux    $XDG_DATA_HOME/civic-chain-auditor, else ~/.local/share/civic-chain-auditor
 *
 * dataPath() only resolves a path; it does not touch the filesystem. The write
 * paths (seed, append) call ensureDir() on the parent first, so both the default
 * data directory and any caller-supplied path are created on demand.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'civic-chain-auditor';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve a shipped, read-only asset inside the package (e.g. the municipal demo). */
export function assetPath(...parts) {
    return join(packageRoot, 'assets', ...parts);
}

/** The bundled municipal demo: its SQL seed, allow-list, and the data-dir database built from them. */
export const MUNICIPAL_SQL_PATH = assetPath('municipal', 'sample_municipal_budget.sql');
export const MUNICIPAL_ALLOWLIST_PATH = assetPath('municipal', 'sample_allowlist.json');

/** The bundled insurance demo (the Insurance & Fiduciary pack's seed and allow-list). */
export const INSURANCE_SQL_PATH = assetPath('insurance', 'sample_insurance_trust.sql');
export const INSURANCE_ALLOWLIST_PATH = assetPath('insurance', 'sample_insurance_allowlist.json');

/** The bundled IOLTA demo (the Law Firm Trust pack's seed and allow-list). */
export const IOLTA_SQL_PATH = assetPath('iolta', 'sample_iolta_trust.sql');
export const IOLTA_ALLOWLIST_PATH = assetPath('iolta', 'sample_iolta_allowlist.json');

/** The bundled excise demo (the Excise Tax pack's seed and allow-list). */
export const EXCISE_SQL_PATH = assetPath('excise', 'sample_excise_filings.sql');
export const EXCISE_ALLOWLIST_PATH = assetPath('excise', 'sample_excise_allowlist.json');

/** The bundled broker-trust demo (the Property Management & HOA pack's property-trust seed and allow-list). */
export const PROPERTY_SQL_PATH = assetPath('property', 'sample_property_trust.sql');
export const PROPERTY_ALLOWLIST_PATH = assetPath('property', 'sample_property_allowlist.json');

/** The bundled HOA demo (the Property Management & HOA pack's hoa seed and allow-list). */
export const HOA_SQL_PATH = assetPath('hoa', 'sample_hoa_ledger.sql');
export const HOA_ALLOWLIST_PATH = assetPath('hoa', 'sample_hoa_allowlist.json');

/** The per-user directory the engine writes seeded warehouses and logs into. */
export function dataDir({ env = process.env, platform = process.platform } = {}) {
    if (env.CIVIC_DATA_DIR) return env.CIVIC_DATA_DIR;
    const home = homedir();
    if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP);
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP);
    return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), APP);
}

/** Resolve a file name inside the data directory. Does not create anything. */
export function dataPath(name, opts) {
    return join(dataDir(opts), name);
}

/** The municipal demo database, built from the bundled SQL into the data directory. */
export function municipalDbPath(opts) {
    return dataPath('municipal.db', opts);
}

/** Create a directory (and parents) if missing. Returns the directory. */
export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Create the parent directory of a file path if missing. Returns the path. */
export function ensureParent(filePath) {
    ensureDir(dirname(filePath));
    return filePath;
}

// ── CSV import (S8) ─────────────────────────────────────────────────────────
//
// A buyer's CSV is read by name from a folder they name at startup, never from
// an arbitrary path and never as pasted content. CIVIC_IMPORT_DIR is that
// folder. resolveImportPath confines a caller-supplied name to it, so a name
// like "../../etc/passwd" or an absolute path is refused before anything opens
// the file. The imported warehouse (its SQLite db, allow-list copy, audit log
// and the confirmed mapping) is engine output, so it lives under the writable
// data directory in an `imported/` subtree, exactly like the municipal demo.

export class ImportPathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ImportPathError';
    }
}

/** The folder the operator named for CSVs, or null when none is configured. */
export function importDir({ env = process.env } = {}) {
    return env.CIVIC_IMPORT_DIR || null;
}

/**
 * Resolve a CSV file *name* to an absolute path inside the import folder,
 * refusing anything that escapes it. The caller supplies only a name relative
 * to the folder (never an absolute path, never a `..` escape); the folder comes
 * from trusted configuration, not the wire.
 *
 * @param {string} name a file name relative to the import folder
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string} absolute path within the import folder
 * @throws {ImportPathError}
 */
export function resolveImportPath(name, { env = process.env } = {}) {
    const dir = importDir({ env });
    if (!dir) {
        throw new ImportPathError(
            'No import folder is configured. Set CIVIC_IMPORT_DIR to the folder your CSV files live in.',
        );
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new ImportPathError('An import needs a CSV file name within the import folder.');
    }
    if (isAbsolute(name)) {
        throw new ImportPathError(`"${name}" is an absolute path; name the file by its name within the import folder only.`);
    }
    const base = resolve(dir);
    const full = resolve(base, name);
    const rel = relative(base, full);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new ImportPathError(`"${name}" is outside the import folder (${base}); files are read by name from that folder only.`);
    }
    return full;
}

/**
 * Where an imported ledger's artefacts live in the data directory. The label is
 * sanitised to a safe slug so it cannot escape the `imported/` subtree.
 *
 * @param {string} label a human name for this import (e.g. the CSV file name)
 * @param {object} [opts] passed to dataPath (env/platform)
 * @returns {{ slug: string, dir: string, dbPath: string, allowlistPath: string, logPath: string, mappingPath: string }}
 */
export function importedLedgerPaths(label, opts) {
    const slug = String(label)
        .replace(/\.csv$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'import';
    const dir = dataPath(join('imported', slug), opts);
    return {
        slug,
        dir,
        dbPath: join(dir, 'ledger.db'),
        allowlistPath: join(dir, 'allowlist.json'),
        logPath: join(dir, 'audit.jsonl'),
        mappingPath: join(dir, 'mapping.json'),
    };
}
