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
import { dirname, join } from 'node:path';
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
