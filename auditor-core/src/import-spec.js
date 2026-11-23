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
import {
    buildConstructionLedgerFromCsv,
    applyGlRevenueToLedger,
    applyBalancesToLedger,
    applyWipSnapshotsToLedger,
    applyRetainageToLedger,
    applySubPaymentsToLedger,
    CONSTRUCTION_SCHEMA_VERSION,
    CANONICAL_CONSTRUCTION_JOB_FIELDS,
    CANONICAL_CONSTRUCTION_GL_FIELDS,
    CANONICAL_CONSTRUCTION_BALANCE_FIELDS,
    CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS,
    CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS,
    CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS,
} from './import-construction.js';
import {
    buildNonprofitLedgerFromCsv,
    applyExpensesToLedger,
    applyReleasesToLedger,
    applyAccountBalancesToLedger,
    applyNetAssetsToLedger,
    applyFederalAwardsToLedger,
    NONPROFIT_SCHEMA_VERSION,
    CANONICAL_NONPROFIT_FUND_FIELDS,
    CANONICAL_NONPROFIT_EXPENSE_FIELDS,
    CANONICAL_NONPROFIT_RELEASE_FIELDS,
    CANONICAL_NONPROFIT_BALANCE_FIELDS,
    CANONICAL_NONPROFIT_NET_ASSET_FIELDS,
    CANONICAL_NONPROFIT_FEDERAL_FIELDS,
} from './import-nonprofit.js';

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

/** @type {ImportSpec} */
export const CONSTRUCTION_SPEC = Object.freeze({
    pack: 'construction',
    emitPackField: true,
    schemaVersion: CONSTRUCTION_SCHEMA_VERSION,
    rulesetPath: assetPath('construction', 'ruleset.construction-v1.json'),
    gateQueries: ['wip-schedule', 'billings-tie-out', 'loss-jobs', 'margin-fade', 'retainage-reconciles', 'payments-without-lien-waiver'],
    primary: {
        fields: CANONICAL_CONSTRUCTION_JOB_FIELDS,
        build: buildConstructionLedgerFromCsv,
        tables: ['jobs'],
        proposeTitle: (file) => `Proposed construction jobs / WIP-schedule mapping for ${file} (nothing written yet)`,
        importQuestion: (counts, file) => `Imported ${counts.rowCount} job(s) from ${file}`,
        headerNoun: () => 'job(s)',
        derived: null,
    },
    companions: [
        {
            resultKey: 'glRevenue',
            fields: CANONICAL_CONSTRUCTION_GL_FIELDS,
            apply: applyGlRevenueToLedger,
            mapFlag: '--gl-map',
            kind: 'import-gl-revenue',
            tables: ['gl_revenue'],
            missingMapError: (file) => `a general-ledger revenue file (${file}) was given without a confirmed --gl-map; run without --map to see a proposed GL mapping.`,
            proposeTitle: (file) => `Proposed general-ledger revenue mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.entries} general-ledger revenue posting(s) from ${file}`,
            rowCount: (counts) => counts.entries,
            summaryLine: (counts, file) => `General-ledger revenue ${file}: ${counts.entries} posting(s)`,
        },
        {
            resultKey: 'balances',
            fields: CANONICAL_CONSTRUCTION_BALANCE_FIELDS,
            apply: applyBalancesToLedger,
            mapFlag: '--balances-map',
            kind: 'import-balances',
            tables: ['balance_sheet_balances'],
            missingMapError: (file) => `a balance-sheet balances file (${file}) was given without a confirmed --balances-map; run without --map to see a proposed balances mapping.`,
            proposeTitle: (file) => `Proposed balance-sheet balances mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.balances} balance-sheet balance(s) from ${file}`,
            rowCount: (counts) => counts.balances,
            summaryLine: (counts, file) => `Balance-sheet balances ${file}: ${counts.balances} balance(s)`,
        },
        {
            resultKey: 'wipSnapshots',
            fields: CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS,
            apply: applyWipSnapshotsToLedger,
            mapFlag: '--snapshots-map',
            kind: 'import-wip-snapshots',
            tables: ['wip_snapshots'],
            missingMapError: (file) => `a WIP snapshots file (${file}) was given without a confirmed --snapshots-map; run without --map to see a proposed snapshots mapping.`,
            proposeTitle: (file) => `Proposed prior-WIP-snapshots mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.snapshots} prior WIP snapshot(s) from ${file}`,
            rowCount: (counts) => counts.snapshots,
            summaryLine: (counts, file) => `Prior WIP snapshots ${file}: ${counts.snapshots} snapshot(s)`,
        },
        {
            resultKey: 'retainage',
            fields: CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS,
            apply: applyRetainageToLedger,
            mapFlag: '--retainage-map',
            kind: 'import-retainage',
            tables: ['retainage'],
            missingMapError: (file) => `a retainage file (${file}) was given without a confirmed --retainage-map; run without --map to see a proposed retainage mapping.`,
            proposeTitle: (file) => `Proposed retainage mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied retainage for ${counts.jobs} job(s) from ${file}`,
            rowCount: (counts) => counts.jobs,
            summaryLine: (counts, file) => `Retainage ${file}: ${counts.jobs} job(s)`,
        },
        {
            resultKey: 'subPayments',
            fields: CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS,
            apply: applySubPaymentsToLedger,
            mapFlag: '--subpayments-map',
            kind: 'import-sub-payments',
            tables: ['sub_payments'],
            missingMapError: (file) => `a subcontractor payments file (${file}) was given without a confirmed --subpayments-map; run without --map to see a proposed payments mapping.`,
            proposeTitle: (file) => `Proposed subcontractor-payments mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.payments} subcontractor payment(s) from ${file}`,
            rowCount: (counts) => counts.payments,
            summaryLine: (counts, file) => `Subcontractor payments ${file}: ${counts.payments} payment(s)`,
        },
    ],
});

/** @type {ImportSpec} */
export const NONPROFIT_SPEC = Object.freeze({
    pack: 'nonprofit',
    emitPackField: true,
    schemaVersion: NONPROFIT_SCHEMA_VERSION,
    rulesetPath: assetPath('nonprofit', 'ruleset.nonprofit-v1.json'),
    gateQueries: ['restricted-spending', 'releases-vs-spending', 'functional-expense-tie', 'restricted-cash-coverage', 'single-audit-threshold'],
    primary: {
        fields: CANONICAL_NONPROFIT_FUND_FIELDS,
        build: buildNonprofitLedgerFromCsv,
        tables: ['funds'],
        proposeTitle: (file) => `Proposed fund-register mapping for ${file} (nothing written yet)`,
        importQuestion: (counts, file) => `Imported ${counts.rowCount} fund(s) from ${file}`,
        headerNoun: () => 'fund(s)',
        derived: null,
    },
    companions: [
        {
            resultKey: 'expenses',
            fields: CANONICAL_NONPROFIT_EXPENSE_FIELDS,
            apply: applyExpensesToLedger,
            mapFlag: '--expenses-map',
            kind: 'import-expenses',
            tables: ['expenses'],
            missingMapError: (file) => `an expenses file (${file}) was given without a confirmed --expenses-map; run without --map to see a proposed expenses mapping.`,
            proposeTitle: (file) => `Proposed expenses / general-ledger mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.expenses} expense(s) from ${file}`,
            rowCount: (counts) => counts.expenses,
            summaryLine: (counts, file) => `Expenses ${file}: ${counts.expenses} expense(s)`,
        },
        {
            resultKey: 'releases',
            fields: CANONICAL_NONPROFIT_RELEASE_FIELDS,
            apply: applyReleasesToLedger,
            mapFlag: '--releases-map',
            kind: 'import-releases',
            tables: ['restriction_releases'],
            missingMapError: (file) => `a restriction-releases file (${file}) was given without a confirmed --releases-map; run without --map to see a proposed releases mapping.`,
            proposeTitle: (file) => `Proposed restriction-releases mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.releases} restriction release(s) from ${file}`,
            rowCount: (counts) => counts.releases,
            summaryLine: (counts, file) => `Restriction releases ${file}: ${counts.releases} release(s)`,
        },
        {
            resultKey: 'accountBalances',
            fields: CANONICAL_NONPROFIT_BALANCE_FIELDS,
            apply: applyAccountBalancesToLedger,
            mapFlag: '--balances-map',
            kind: 'import-account-balances',
            tables: ['account_balances'],
            missingMapError: (file) => `an account-balances file (${file}) was given without a confirmed --balances-map; run without --map to see a proposed balances mapping.`,
            proposeTitle: (file) => `Proposed balance-sheet account-balances mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.balances} account balance(s) from ${file}`,
            rowCount: (counts) => counts.balances,
            summaryLine: (counts, file) => `Account balances ${file}: ${counts.balances} balance(s)`,
        },
        {
            resultKey: 'netAssets',
            fields: CANONICAL_NONPROFIT_NET_ASSET_FIELDS,
            apply: applyNetAssetsToLedger,
            mapFlag: '--net-assets-map',
            kind: 'import-net-assets',
            tables: ['net_assets'],
            missingMapError: (file) => `a net-assets file (${file}) was given without a confirmed --net-assets-map; run without --map to see a proposed net-assets mapping.`,
            proposeTitle: (file) => `Proposed net-assets mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.netAssets} net-asset balance(s) from ${file}`,
            rowCount: (counts) => counts.netAssets,
            summaryLine: (counts, file) => `Net assets ${file}: ${counts.netAssets} balance(s)`,
        },
        {
            resultKey: 'federalAwards',
            fields: CANONICAL_NONPROFIT_FEDERAL_FIELDS,
            apply: applyFederalAwardsToLedger,
            mapFlag: '--federal-awards-map',
            kind: 'import-federal-awards',
            tables: ['federal_awards'],
            missingMapError: (file) => `a federal-awards file (${file}) was given without a confirmed --federal-awards-map; run without --map to see a proposed federal-awards mapping.`,
            proposeTitle: (file) => `Proposed federal-awards mapping for ${file} (nothing written yet)`,
            question: (counts, file) => `Applied ${counts.awards} federal award(s) from ${file}`,
            rowCount: (counts) => counts.awards,
            summaryLine: (counts, file) => `Federal awards ${file}: ${counts.awards} award(s)`,
        },
    ],
});

/** All packs that support `cc-auditor import --pack <name>`, keyed by pack id. */
export const IMPORT_SPECS = Object.freeze({
    municipal: MUNICIPAL_SPEC,
    iolta: IOLTA_SPEC,
    construction: CONSTRUCTION_SPEC,
    nonprofit: NONPROFIT_SPEC,
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
