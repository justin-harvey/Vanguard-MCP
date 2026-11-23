/**
 * `cc-auditor import --pack iolta`: bring a law firm's own client-trust (IOLTA)
 * export into the engine.
 *
 * This is now a thin adapter over the config-driven engine (import-run.js) and the
 * IOLTA spec (import-spec.js). The flow, audit chain, gate and multi-file companion
 * pattern all live in the engine; this module keeps the IOLTA public API
 * (`runIoltaImport`/`formatIoltaImport`) and the IOLTA-named companion params
 * (`bankSnapshots`/`feeInvoices`) that callers already use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Client PII never enters: the canonical IOLTA schema has no
 * column that could hold a name, email or address.
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { IOLTA_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical IOLTA schema. */
export const IOLTA_RULESET_PATH = IOLTA_SPEC.rulesetPath;

/** The five named queries the IOLTA import gate re-runs. */
export const IOLTA_GATE_QUERIES = Object.freeze([...IOLTA_SPEC.gateQueries]);

/**
 * Run an IOLTA import, or propose mappings when none is confirmed yet. Two
 * companion files may be imported alongside the trust journal: bank snapshots
 * (so three-way-reconciliation has an adjusted bank balance to tie to) and fee
 * invoices (so unsupported-fee-transfers can confirm each earned-fee transfer).
 * Each records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   trust-journal CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed journal mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.bankSnapshots]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.feeInvoices]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the five named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatIoltaImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runIoltaImport({ file, mapping = null, bankSnapshots = null, feeInvoices = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(IOLTA_SPEC, { file, mapping, companions: [bankSnapshots, feeInvoices], env, runGate, signer });
}

/** Format any IOLTA import result for the terminal. */
export function formatIoltaImport(r) {
    return formatPackImport(IOLTA_SPEC, r);
}

export { ImportError };
