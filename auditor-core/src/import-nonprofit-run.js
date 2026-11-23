/**
 * `cc-auditor import --pack nonprofit`: bring a nonprofit's own fund-accounting
 * export into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * nonprofit spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the nonprofit
 * public API (`runNonprofitImport`/`formatNonprofitImport`) and the
 * nonprofit-named companion params (expenses / releases / accountBalances /
 * netAssets / federalAwards) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Donor PII never enters: the canonical nonprofit schema has
 * no column that could hold a donor name, address or gift history.
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { NONPROFIT_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical nonprofit schema. */
export const NONPROFIT_RULESET_PATH = NONPROFIT_SPEC.rulesetPath;

/** The five named queries the nonprofit import gate re-runs. */
export const NONPROFIT_GATE_QUERIES = Object.freeze([...NONPROFIT_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const NONPROFIT_COMPANION_KEYS = Object.freeze(NONPROFIT_SPEC.companions.map((c) => c.resultKey));

/**
 * Run a nonprofit import, or propose mappings when none is confirmed yet. Up to
 * five companion files may be imported alongside the fund register: the expenses
 * / general ledger (so restricted-spending and the functional-expense grid read
 * real figures), the restriction releases (so releases-vs-spending can tie),
 * the balance-sheet account balances and the net assets (so
 * restricted-cash-coverage can compare liquid assets to restricted net assets),
 * and the federal awards (so single-audit-threshold can test the trigger). Each
 * records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   fund-register CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed fund mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.expenses]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.releases]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.accountBalances]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.netAssets]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.federalAwards]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the five named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatNonprofitImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runNonprofitImport({ file, mapping = null, expenses = null, releases = null, accountBalances = null, netAssets = null, federalAwards = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(NONPROFIT_SPEC, {
        file,
        mapping,
        companions: [expenses, releases, accountBalances, netAssets, federalAwards],
        env,
        runGate,
        signer,
    });
}

/** Format any nonprofit import result for the terminal. */
export function formatNonprofitImport(r) {
    return formatPackImport(NONPROFIT_SPEC, r);
}

export { ImportError };
