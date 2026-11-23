/**
 * `cc-auditor import --pack construction`: bring a contractor's own job-cost
 * export into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * construction spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the construction
 * public API (`runConstructionImport`/`formatConstructionImport`) and the
 * construction-named companion params (glRevenue / balances / wipSnapshots /
 * retainage / subPayments) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Employee pay and certified-payroll detail never enter: the
 * canonical construction schema has no column that could hold them.
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { CONSTRUCTION_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical construction schema. */
export const CONSTRUCTION_RULESET_PATH = CONSTRUCTION_SPEC.rulesetPath;

/** The six named queries the construction import gate re-runs. */
export const CONSTRUCTION_GATE_QUERIES = Object.freeze([...CONSTRUCTION_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const CONSTRUCTION_COMPANION_KEYS = Object.freeze(CONSTRUCTION_SPEC.companions.map((c) => c.resultKey));

/**
 * Run a construction import, or propose mappings when none is confirmed yet. Up
 * to five companion files may be imported alongside the jobs / WIP schedule:
 * general-ledger revenue (so wip-schedule's earned total ties to the income
 * statement), balance-sheet balances (so billings-tie-out can tie), prior WIP
 * snapshots (so margin-fade has a last margin to measure against), retainage (so
 * retainage-reconciles can confirm the receivable) and subcontractor payments (so
 * payments-without-lien-waiver can flag an unwaived release). Each records its own
 * source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   jobs / WIP-schedule CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed jobs mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.glRevenue]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.balances]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.wipSnapshots]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.retainage]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.subPayments]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the six named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatConstructionImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runConstructionImport({ file, mapping = null, glRevenue = null, balances = null, wipSnapshots = null, retainage = null, subPayments = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(CONSTRUCTION_SPEC, {
        file,
        mapping,
        companions: [glRevenue, balances, wipSnapshots, retainage, subPayments],
        env,
        runGate,
        signer,
    });
}

/** Format any construction import result for the terminal. */
export function formatConstructionImport(r) {
    return formatPackImport(CONSTRUCTION_SPEC, r);
}

export { ImportError };
