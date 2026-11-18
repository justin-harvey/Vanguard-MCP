/**
 * Shared fixture: the broker-trust demo shipped with the civic-chain-auditor
 * skill's Property Management & HOA pack (property-trust-v1), built into a fresh
 * temp database per call. Using the shipped assets means a change that breaks
 * them fails the core suite. No tests live here.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');
export const PROPERTY_SQL = join(ASSETS, 'sample_property_trust.sql');
export const PROPERTY_ALLOWLIST = join(ASSETS, 'sample_property_allowlist.json');

/**
 * Build the broker-trust demo database in a fresh temp directory; returns its
 * path. If `mutate` is given it is called with an open, writable handle before
 * close, so a test can break one control's data to exercise the flag path.
 *
 * @param {(db: DatabaseSync) => void} [mutate]
 */
export function freshPropertyDb(mutate) {
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-property-')), 'property.sqlite');
    const db = new DatabaseSync(path);
    db.exec(readFileSync(PROPERTY_SQL, 'utf8'));
    if (mutate) mutate(db);
    db.close();
    return path;
}
