/**
 * `cc-auditor import --pack excise`: bring a brewer's (or other excise filer's)
 * own filings export into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * excise spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the excise public
 * API (`runExciseImport`/`formatExciseImport`) and the excise-named companion
 * params (rates / operationsReports / returns) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Wholesale-customer data never enters: the canonical excise
 * schema has no column that could hold a name, address or license number.
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { EXCISE_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical excise schema. */
export const EXCISE_RULESET_PATH = EXCISE_SPEC.rulesetPath;

/** The five named queries the excise import gate re-runs. */
export const EXCISE_GATE_QUERIES = Object.freeze([...EXCISE_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const EXCISE_COMPANION_KEYS = Object.freeze(EXCISE_SPEC.companions.map((c) => c.resultKey));

/**
 * Run an excise import, or propose mappings when none is confirmed yet. Up to
 * three companion files may be imported alongside the removals: the rate schedule
 * (so liability-vs-remitted can read the per-barrel rate in force for each
 * period), the operations reports (so inventory-rollforward, report-vs-return and
 * loss-variance have each period's production rollforward) and the excise returns
 * (so liability-vs-remitted, report-vs-return and missing-or-late-filings have the
 * barrels reported and tax paid). Each records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   removals CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed removals mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.rates]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.operationsReports]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.returns]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the five named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatExciseImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runExciseImport({ file, mapping = null, rates = null, operationsReports = null, returns = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(EXCISE_SPEC, {
        file,
        mapping,
        companions: [rates, operationsReports, returns],
        env,
        runGate,
        signer,
    });
}

/** Format any excise import result for the terminal. */
export function formatExciseImport(r) {
    return formatPackImport(EXCISE_SPEC, r);
}

export { ImportError };
