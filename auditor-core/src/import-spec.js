/**
 * Pack import specs: the per-pack *data* the generic import engine (import-run.js)
 * runs on. Each spec names the pack's canonical schema version, its signed
 * Civic-Chain ruleset, the gate queries a clean import must answer with 'pass',
 * the primary file's build fn + field spec + the display/audit wording, and an
 * ordered list of optional companion files (each with its own apply fn, field
 * spec, confirm flag, audit kind/tables and wording).
 *
 * Adding a pack's M4 import = one entry here + the pack's irreducible schema/DDL
 * and build/apply fns in import-<pack>.js. No new runner or formatter.
 *
 * @typedef {object} ImportSpec
 * @property {string}   pack           pack id (e.g. 'municipal', 'iolta')
 * @property {boolean}  emitPackField  whether results carry a top-level `pack` key
 * @property {string}   schemaVersion  canonical schema version recorded on entries
 * @property {string}   rulesetPath    path to the signed ruleset in force
 * @property {string[]} gateQueries    named queries the import gate re-runs
 * @property {object}   primary        primary-file spec (fields, build, wording, tables)
 * @property {object[]} companions     ordered optional companion-file specs
 */

import { assetPath } from './paths.js';
import {
    buildLedgerFromCsv,
    applyGrantRegisterToLedger,
    applyGrantDrawdownsToLedger,
    CANONICAL_IMPORT_FIELDS,
    CANONICAL_GRANT_FIELDS,
    CANONICAL_DRAWDOWN_FIELDS,
    CANONICAL_SCHEMA_VERSION,
} from './import-csv.js';
import {
    buildIoltaLedgerFromCsv,
    applyBankSnapshotsToLedger,
    applyFeeInvoicesToLedger,
    IOLTA_SCHEMA_VERSION,
    CANONICAL_IOLTA_JOURNAL_FIELDS,
    CANONICAL_IOLTA_BANK_FIELDS,
    CANONICAL_IOLTA_INVOICE_FIELDS,
} from './import-iolta.js';

/** @type {ImportSpec} */
export const MUNICIPAL_SPEC = Object.freeze({
    pack: 'municipal',
    emitPackField: false, // byte-identical with the original municipal runner (no `pack` key)
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    rulesetPath: assetPath('municipal', 'ruleset.municipal-v1.json'),
    gateQueries: ['grant-status', 'spending-by-vendor', 'budget-variance'],
    primary: {
        fields: CANONICAL_IMPORT_FIELDS,
        build: buildLedgerFromCsv,
        tables: ['expenditures', 'vendors', 'departments', 'funds', 'budget_lines', 'grants'],
        proposeTitle: (file) => `Proposed mapping for ${file} (nothing written yet)`,
        importQuestion: (counts, file) => `Imported ${counts.rowCount} expenditure row(s) from ${file}`,
        headerNoun: () => 'expenditure row(s)',
        derived: (c) => `${c.vendors} vendor(s), ${c.departments} department(s), ${c.funds} fund(s), ${c.budgetLines} budget line(s), ${c.grants} grant(s)`,
    },
    companions: [
        {
            resultKey: 'grantRegister',
            fields: CANONICAL_GRANT_FIELDS,
            apply: applyGrantRegisterToLedger,
            mapFlag: '--grants-map',
            kind: 'import-grants',
            tables: ['grants'],
            missingMapError: (file) => `a grant register (${file}) was given without a confirmed --grants-map; run without --map to see a proposed grant mapping.`,
            proposeTitle: (file) => `Proposed grant-register mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied a grant register of ${counts.grants} grant(s) from ${file} (${counts.updated} updated, ${counts.inserted} inserted)`,
            rowCount: (counts) => counts.grants,
            summaryLine: (counts, file) => `Grant register ${file}: ${counts.grants} grant(s) (${counts.updated} updated, ${counts.inserted} inserted)`,
        },
        {
            resultKey: 'grantDrawdowns',
            fields: CANONICAL_DRAWDOWN_FIELDS,
            apply: applyGrantDrawdownsToLedger,
            mapFlag: '--drawdowns-map',
            kind: 'import-drawdowns',
            tables: ['grant_drawdowns'],
            missingMapError: (file) => `a grant drawdowns file (${file}) was given without a confirmed --drawdowns-map; run without --map to see a proposed drawdowns mapping.`,
            proposeTitle: (file) => `Proposed grant-drawdowns mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.drawdowns} grant drawdown(s) from ${file} across ${counts.grants} grant(s)`,
            rowCount: (counts) => counts.drawdowns,
            summaryLine: (counts, file) => `Grant drawdowns ${file}: ${counts.drawdowns} drawdown(s) across ${counts.grants} grant(s)`,
        },
    ],
});

/** @type {ImportSpec} */
export const IOLTA_SPEC = Object.freeze({
    pack: 'iolta',
    emitPackField: true,
    schemaVersion: IOLTA_SCHEMA_VERSION,
    rulesetPath: assetPath('iolta', 'ruleset.iolta-v1.json'),
    gateQueries: ['three-way-reconciliation', 'negative-client-balances', 'unsupported-fee-transfers', 'firm-funds-in-trust', 'dormant-balances'],
    primary: {
        fields: CANONICAL_IOLTA_JOURNAL_FIELDS,
        build: buildIoltaLedgerFromCsv,
        tables: ['trust_journal'],
        proposeTitle: (file) => `Proposed IOLTA trust-journal mapping for ${file} (nothing written yet)`,
        importQuestion: (counts, file) => `Imported ${counts.rowCount} trust-journal entr(y/ies) from ${file}`,
        headerNoun: (c) => `trust-journal entr(y/ies) across ${c.clients} client ledger(s)`,
        derived: null,
    },
    companions: [
        {
            resultKey: 'bankSnapshots',
            fields: CANONICAL_IOLTA_BANK_FIELDS,
            apply: applyBankSnapshotsToLedger,
            mapFlag: '--bank-map',
            kind: 'import-bank-snapshots',
            tables: ['trust_bank_snapshots'],
            missingMapError: (file) => `a bank-snapshots file (${file}) was given without a confirmed --bank-map; run without --map to see a proposed bank mapping.`,
            proposeTitle: (file) => `Proposed bank-snapshots mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.snapshots} bank snapshot(s) from ${file}`,
            rowCount: (counts) => counts.snapshots,
            summaryLine: (counts, file) => `Bank snapshots ${file}: ${counts.snapshots} snapshot(s)`,
        },
        {
            resultKey: 'feeInvoices',
            fields: CANONICAL_IOLTA_INVOICE_FIELDS,
            apply: applyFeeInvoicesToLedger,
            mapFlag: '--invoices-map',
            kind: 'import-fee-invoices',
            tables: ['fee_invoices'],
            missingMapError: (file) => `a fee-invoices file (${file}) was given without a confirmed --invoices-map; run without --map to see a proposed invoices mapping.`,
            proposeTitle: (file) => `Proposed fee-invoices mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.invoices} fee invoice(s) from ${file}`,
            rowCount: (counts) => counts.invoices,
            summaryLine: (counts, file) => `Fee invoices ${file}: ${counts.invoices} invoice(s)`,
        },
    ],
});

/** All packs that support `cc-auditor import --pack <name>`, keyed by pack id. */
export const IMPORT_SPECS = Object.freeze({
    municipal: MUNICIPAL_SPEC,
    iolta: IOLTA_SPEC,
});

/** The pack ids that support CSV import, for help text and the `--pack` guard. */
export const IMPORT_PACKS = Object.freeze(Object.keys(IMPORT_SPECS));

/**
 * Look up a pack's import spec.
 * @param {string} pack
 * @returns {ImportSpec}
 * @throws {Error} on an unknown pack
 */
export function getImportSpec(pack) {
    const spec = IMPORT_SPECS[pack];
    if (!spec) throw new Error(`unknown import pack "${pack}" (known: ${IMPORT_PACKS.join(', ')})`);
    return spec;
}
