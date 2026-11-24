/**
 * `cc-auditor import --pack schools`: bring a school district's own activity-fund,
 * federal-program and budget exports into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * schools spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the schools public
 * API (`runSchoolsImport`/`formatSchoolsImport`) and the schools-named companion
 * params (accounts / disbursements / programs / costs / budgetLines / expenditures)
 * that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Student-level data never enters: the canonical schools
 * schema has no column that could hold a student name, grade level or
 * meal-eligibility status (student_records is never created).
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { SCHOOLS_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical schools schema. */
export const SCHOOLS_RULESET_PATH = SCHOOLS_SPEC.rulesetPath;

/** The five named queries the schools import gate re-runs. */
export const SCHOOLS_GATE_QUERIES = Object.freeze([...SCHOOLS_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const SCHOOLS_COMPANION_KEYS = Object.freeze(SCHOOLS_SPEC.companions.map((c) => c.resultKey));

/**
 * Run a schools import, or propose mappings when none is confirmed yet. Up to six
 * companion files may be imported alongside the activity collections: the activity
 * accounts (so activity-negative-balances has an account to iterate), the activity
 * disbursements (so negative-balances and unapproved-disbursements can read
 * payments and approvals), the federal programs and federal costs (so
 * federal-outside-period can test each charge against its award period), and the
 * budget lines and expenditures (so budget-variance can tot up paid spending per
 * line). Each records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   activity-collections CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed collections mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.accounts]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.disbursements]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.programs]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.costs]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.budgetLines]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.expenditures]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the five named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatSchoolsImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runSchoolsImport({
    file, mapping = null,
    accounts = null, disbursements = null, programs = null, costs = null, budgetLines = null, expenditures = null,
    env = process.env, runGate = true, signer = null,
}) {
    return runPackImport(SCHOOLS_SPEC, {
        file,
        mapping,
        companions: [accounts, disbursements, programs, costs, budgetLines, expenditures],
        env,
        runGate,
        signer,
    });
}

/** Format any schools import result for the terminal. */
export function formatSchoolsImport(r) {
    return formatPackImport(SCHOOLS_SPEC, r);
}

export { ImportError };
