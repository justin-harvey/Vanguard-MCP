/**
 * `cc-auditor import --pack hoa`: bring a community association's own board-review
 * exports into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the HOA
 * spec (import-spec.js). The flow, audit chain, gate and multi-file companion
 * pattern all live in the engine; this module keeps the HOA public API
 * (`runHoaImport`/`formatHoaImport`) and the HOA-named companion params
 * (budgetLines / operatingExpenses / assessments) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Unit-owner data never enters: the canonical HOA schema has
 * no column that could hold an owner name, email or phone (resident_pii is never
 * created).
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { HOA_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical HOA schema. */
export const HOA_RULESET_PATH = HOA_SPEC.rulesetPath;

/** The three named queries the HOA import gate re-runs. */
export const HOA_GATE_QUERIES = Object.freeze([...HOA_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const HOA_COMPANION_KEYS = Object.freeze(HOA_SPEC.companions.map((c) => c.resultKey));

/**
 * Run an HOA import, or propose mappings when none is confirmed yet. Up to three
 * companion files may be imported alongside the reserve transfers: the budget
 * lines and the operating expenses (so budget-variance can tot up spending per
 * line against the adopted budget) and the assessments (so delinquent-assessments
 * can age the unpaid ones). Each records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   reserve-transfers CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed transfers mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.budgetLines]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.operatingExpenses]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.assessments]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the three named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatHoaImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runHoaImport({
    file, mapping = null,
    budgetLines = null, operatingExpenses = null, assessments = null,
    env = process.env, runGate = true, signer = null,
}) {
    return runPackImport(HOA_SPEC, {
        file,
        mapping,
        companions: [budgetLines, operatingExpenses, assessments],
        env,
        runGate,
        signer,
    });
}

/** Format any HOA import result for the terminal. */
export function formatHoaImport(r) {
    return formatPackImport(HOA_SPEC, r);
}

export { ImportError };
