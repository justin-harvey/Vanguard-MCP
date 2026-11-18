/**
 * Shared fixture: the IOLTA demo shipped with the civic-chain-auditor skill's
 * Law Firm Trust pack, built into a fresh temp database per call. Using the
 * shipped assets means a change that breaks them fails the core suite. No tests
 * live here.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');
export const IOLTA_SQL = join(ASSETS, 'sample_iolta_trust.sql');
export const IOLTA_ALLOWLIST = join(ASSETS, 'sample_iolta_allowlist.json');

/**
 * Build the IOLTA demo database in a fresh temp directory; returns its path.
 * If `mutate` is given it is called with an open, writable handle before close,
 * so a test can break one control's data to exercise the flag path.
 *
 * @param {(db: DatabaseSync) => void} [mutate]
 */
export function freshIoltaDb(mutate) {
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-iolta-')), 'iolta.sqlite');
    const db = new DatabaseSync(path);
    db.exec(readFileSync(IOLTA_SQL, 'utf8'));
    if (mutate) mutate(db);
    db.close();
    return path;
}
