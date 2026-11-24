/**
 * `cc-auditor import --pack property`: bring a broker's or property manager's own
 * trust-account exports into the engine.
 *
 * This is a thin adapter over the config-driven engine (import-run.js) and the
 * property spec (import-spec.js). The flow, audit chain, gate and multi-file
 * companion pattern all live in the engine; this module keeps the property public
 * API (`runPropertyImport`/`formatPropertyImport`) and the property-named
 * companion params (bankSnapshots / leases) that callers use.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened. Resident-level data never enters: the canonical property
 * schema has no column that could hold a tenant or owner name, SSN or bank
 * account (resident_pii is never created).
 */

import { runPackImport, formatPackImport, ImportError } from './import-run.js';
import { PROPERTY_SPEC } from './import-spec.js';

/** The bundled Civic-Chain ruleset for the canonical property-trust schema. */
export const PROPERTY_RULESET_PATH = PROPERTY_SPEC.rulesetPath;

/** The four named queries the property import gate re-runs. */
export const PROPERTY_GATE_QUERIES = Object.freeze([...PROPERTY_SPEC.gateQueries]);

/** The companion result keys, in the order the engine applies them. */
export const PROPERTY_COMPANION_KEYS = Object.freeze(PROPERTY_SPEC.companions.map((c) => c.resultKey));

/**
 * Run a property import, or propose mappings when none is confirmed yet. Up to two
 * companion files may be imported alongside the trust ledger: the bank snapshots
 * (so trust-vs-liability has a reconciled bank balance to compare against the
 * liability) and the leases (so deposits-held-vs-owed and deposit-return-overdue
 * have the managed leases). Each records its own source-SHA-256 audit entry.
 *
 * @param {object} params
 * @param {string} params.file   trust-ledger CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed ledger mapping; null = propose only
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.bankSnapshots]
 * @param {{file: string, mapping: (Record<string,string>|null)}|null} [params.leases]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the four named queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatPropertyImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runPropertyImport({
    file, mapping = null,
    bankSnapshots = null, leases = null,
    env = process.env, runGate = true, signer = null,
}) {
    return runPackImport(PROPERTY_SPEC, {
        file,
        mapping,
        companions: [bankSnapshots, leases],
        env,
        runGate,
        signer,
    });
}

/** Format any property import result for the terminal. */
export function formatPropertyImport(r) {
    return formatPackImport(PROPERTY_SPEC, r);
}

export { ImportError };
