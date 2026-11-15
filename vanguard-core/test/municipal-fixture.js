/**
 * Shared fixture: the municipal demo shipped with the civic-chain-auditor
 * skill, built into a fresh temp database per call. Using the shipped assets
 * means a change that breaks them fails the core suite. No tests live here.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');
export const MUNICIPAL_SQL = join(ASSETS, 'sample_municipal_budget.sql');
export const MUNICIPAL_ALLOWLIST = join(ASSETS, 'sample_allowlist.json');

/** Build the municipal demo database in a fresh temp directory; returns its path. */
export function freshMunicipalDb() {
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-municipal-')), 'municipal.sqlite');
    const db = new DatabaseSync(path);
    db.exec(readFileSync(MUNICIPAL_SQL, 'utf8'));
    db.close();
    return path;
}
