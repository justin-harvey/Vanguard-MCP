/**
 * `cc-auditor import` (municipal): bring a buyer's expenditure CSV into the engine.
 *
 * This is now a thin adapter over the config-driven engine (import-run.js) and the
 * municipal spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the municipal public
 * API (`runImport`/`formatImport`) and the municipal-named companion params
 * (`grantRegister`/`grantDrawdowns`) that callers already use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened (paths.js, resolveImportPath).
 */

import { importDir } from './paths.js';
import { runPackImport, formatPackImport, runGateQueries, GATE_QUERIES, ImportError } from './import-run.js';
import { MUNICIPAL_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical municipal schema (S9). */
export const MUNICIPAL_RULESET_PATH = MUNICIPAL_SPEC.rulesetPath;

/**
 * Run a municipal import, or propose a mapping when none is confirmed yet. Up to
 * two companion files may be imported alongside the expenditures: a grant register
 * fills `grants` with real award amounts, and a drawdown register fills
 * `grant_drawdowns` with cash requested from each grantor. Each records its own
 * source-SHA-256 audit entry on the ledger's chain.
 *
 * @param {object} params
 * @param {string} params.file   expenditure CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.grantRegister]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.grantDrawdowns]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the three named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runImport({ file, mapping = null, grantRegister = null, grantDrawdowns = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(MUNICIPAL_SPEC, { file, mapping, companions: [grantRegister, grantDrawdowns], env, runGate, signer });
}

/** Format any municipal import result for the terminal. */
export function formatImport(r) {
    return formatPackImport(MUNICIPAL_SPEC, r);
}

export { runGateQueries, GATE_QUERIES, ImportError, importDir };
