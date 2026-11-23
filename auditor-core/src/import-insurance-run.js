/**
 * `cc-auditor import --pack insurance`: bring an insurance agency's own
 * premium-trust and policy export into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * insurance spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the insurance
 * public API (`runInsuranceImport`/`formatInsuranceImport`) and the
 * insurance-named companion params (policies / commissionReceipts / binders /
 * bankSnapshots) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Insured PII never enters: the canonical insurance schema
 * has no column that could hold a name, SSN or health condition.
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { INSURANCE_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical insurance schema. */
export const INSURANCE_RULESET_PATH = INSURANCE_SPEC.rulesetPath;

/** The three named queries the insurance import gate re-runs. */
export const INSURANCE_GATE_QUERIES = Object.freeze([...INSURANCE_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const INSURANCE_COMPANION_KEYS = Object.freeze(INSURANCE_SPEC.companions.map((c) => c.resultKey));

/**
 * Run an insurance import, or propose mappings when none is confirmed yet. Up to
 * four companion files may be imported alongside the premium-trust ledger: the
 * policies (so commission-variance-audit can derive the expected commission; must
 * precede the receipts and binders, which reference it), the commission receipts
 * (so the variance audit has a paid figure), the binders (so eo-unbound-exposure
 * can tell whether premium is held for bound coverage), and the trust bank
 * snapshots (so trust-account-solvency has an actual balance). Each records its
 * own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   premium-trust ledger CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed ledger mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.policies]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.commissionReceipts]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.binders]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.bankSnapshots]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the three named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatInsuranceImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runInsuranceImport({ file, mapping = null, policies = null, commissionReceipts = null, binders = null, bankSnapshots = null, env = process.env, runGate = true, signer = null }) {
    return runPackImport(INSURANCE_SPEC, {
        file,
        mapping,
        companions: [policies, commissionReceipts, binders, bankSnapshots],
        env,
        runGate,
        signer,
    });
}

/** Format any insurance import result for the terminal. */
export function formatInsuranceImport(r) {
    return formatPackImport(INSURANCE_SPEC, r);
}

export { ImportError };
