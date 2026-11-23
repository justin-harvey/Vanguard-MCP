/**
 * MCP handlers, pure and transport-free.
 *
 * These are the tools and resources the Civic-Chain Auditor engine exposes to a host
 * AI. Every one routes through the same guard, grounding, lineage and audit
 * chain as the CLI: the MCP surface adds no new path to the data, and the guard
 * stays the trust boundary. The stdio transport lives in mcp-server.js and is
 * the only thing that needs the MCP SDK, keeping the logic here means the whole
 * surface is testable offline, with no SDK and no running server.
 *
 * Two families of tool, deliberately:
 *   - credential-free: list_controls, run_control, run_canonical, verify_audit,
 *     run_query and verify_answer, canonical queries and the control catalog, no
 *     model call. run_query runs SQL the host AI already wrote (S4), so an
 *     open-ended question needs no key; verify_answer re-runs it to confirm a
 *     figure without trusting the narration;
 *   - credentialed: execute_financial_query, the planner writes SQL, so it needs
 *     an API key. Free text is supported over the SaaS warehouse and over a
 *     custom warehouse configured from the environment (see custom.js).
 */

import { controlCatalog, getControl } from './controls.js';
import { importDir } from './paths.js';
import { verify, DEFAULT_LOG_PATH } from './audit.js';
import { provenanceOf } from './audit-core.js';
import { loadSigner } from './signing.js';
import { warehouseDescriptors, warehouseSchema, getWarehouse } from './warehouses.js';
import { guard } from './guard.js';
import { runNamedQuery } from './named-run.js';
import { runAgentQuery, verifyAgentQuery } from './query-run.js';
import { describeQuery } from './named-queries.js';
import { revenueByBasis, debtWithHiddenLeverage } from './enron.js';
import { netPositionAtClose, surveillanceRapidCancels } from './markets.js';
import { reconcileMrr } from './saas.js';

export const SERVER_INFO = { name: 'civic-chain-auditor', version: '1.0.0' };

/**
 * Canonical, credential-free query dispatch. Each entry is the query function
 * and the *only* arguments a caller may set: the query parameters. Everything
 * else a canonical function accepts (dbPath, logPath, warehouse, signer,
 * principal) is infrastructure and must never be settable from an MCP caller,
 * or the caller could redirect the query or the audit log. See callTool's
 * run_canonical case and pickCallerArgs.
 */
const CANONICAL = {
    'enron/revenue': { run: (o) => revenueByBasis(o), args: ['fiscalYear'] },
    'enron/debt': { run: (o) => debtWithHiddenLeverage(o), args: ['fiscalYear'] },
    'markets/net-position': {
        run: (o) => netPositionAtClose({ ...o, ticker: String(o.ticker ?? 'ACME').toUpperCase() }),
        args: ['ticker', 'asOfMs'],
    },
    'markets/surveillance': { run: (o) => surveillanceRapidCancels(o), args: ['windowMs', 'minCancels'] },
    'saas/mrr': { run: (o) => reconcileMrr(o), args: [] },
};

/**
 * Keep only the arguments a caller is allowed to set, and refuse any other,
 * mirroring how a named query rejects an unknown parameter. This is the trust
 * boundary for caller-supplied arguments: infrastructure keys (dbPath, logPath,
 * warehouse, signer, principal) are never on an allow-list, so a caller cannot
 * use them to redirect a query or its audit log.
 *
 * @param {string} name   the query name, for the error message
 * @param {string[]} allowed  the caller-settable argument names
 * @param {object} provided   the caller's `args`
 */
function pickCallerArgs(name, allowed, provided = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(provided)) {
        if (!allowed.includes(key)) {
            throw new Error(
                `Argument "${key}" is not accepted for "${name}". Allowed: ${allowed.join(', ') || '(none)'}.`,
            );
        }
        safe[key] = value;
    }
    return safe;
}

// provenanceOf (the shape run_canonical returns) lives in audit-core.js so the
// browser demo returns provenance identically; imported above.

/** Canonical names of every custom warehouse's named queries, e.g. "municipal/grant-status". */
function namedQueryNames() {
    return Object.values(warehouseDescriptors())
        .filter((d) => d.custom)
        .flatMap((d) => Object.keys(d.queries ?? {}).map((q) => `${d.name}/${q}`));
}

/** Every name run_canonical accepts: built-in canonical queries plus every
 *  custom warehouse's named queries. Exported so a drift test can confirm the
 *  skill documents only names the engine really serves. */
export function canonicalNames() {
    return [...Object.keys(CANONICAL), ...namedQueryNames()];
}

/** Names of the warehouses that accept free-text questions. */
function freeTextWarehouses() {
    return Object.values(warehouseDescriptors())
        .filter((d) => d.freeText)
        .map((d) => d.name);
}

/**
 * Resolve a free-text warehouse for run_query/verify_answer, applying trusted
 * infra overrides (dbPath/logPath) so a test or a trusted embedding can isolate
 * the database and log, exactly as run_control/run_canonical honour them. A
 * named-query-only warehouse is refused with the same shape execute_financial_query
 * uses, so the three open-ended tools reject a bad warehouse identically.
 *
 * @param {string|undefined} name caller-supplied warehouse, untrusted
 * @param {{ dbPath?: string, logPath?: string }} infra trusted ctx overrides
 * @returns {{ ok: true, descriptor: object } | { ok: false, refusal: object }}
 */
function resolveFreeText(name, infra) {
    const warehouse = name ?? 'saas';
    const descriptor = warehouseDescriptors()[warehouse];
    if (!descriptor || !descriptor.freeText) {
        const freeText = freeTextWarehouses().map((w) => `"${w}"`).join(', ');
        return {
            ok: false,
            refusal: {
                ok: false,
                stage: 'route',
                reason: 'warehouse_not_supported',
                message: descriptor
                    ? `Ad-hoc SQL is supported over ${freeText}. The "${warehouse}" warehouse ` +
                      `exposes canonical queries via run_canonical and controls via run_control.`
                    : `Unknown warehouse "${warehouse}". Ad-hoc SQL is supported over ${freeText}.`,
            },
        };
    }
    return {
        ok: true,
        descriptor: {
            ...descriptor,
            ...(infra.dbPath !== undefined ? { dbPath: infra.dbPath } : {}),
            ...(infra.logPath !== undefined ? { logPath: infra.logPath } : {}),
        },
    };
}

/**
 * The CSV-import tools, advertised only when an import folder is configured
 * (CIVIC_IMPORT_DIR). They are local-only and write to the data directory; a
 * static browser demo sets no such folder, so they never appear there. The file
 * is named relative to the import folder; the import never accepts pasted data
 * and never an absolute path (paths.js confines it).
 */
function importTools() {
    if (!importDir()) return [];
    return [
        {
            name: 'propose_csv_mapping',
            description:
                'Read the headers (and a sample of rows) of a CSV in the import folder and propose a column mapping ' +
                'onto a pack\'s canonical schema. Reads only; writes nothing. The human confirms the mapping before import_csv. ' +
                'pack selects the warehouse (default "municipal"). For municipal: pass grantFile to also propose a grant-register ' +
                'mapping (returned under grantRegister) and drawdownFile for a grant-drawdowns mapping (returned under grantDrawdowns). ' +
                'For iolta (law firm client trust): the main file is the trust journal; pass bankFile to also propose a bank-snapshots ' +
                'mapping (returned under bankSnapshots) and invoicesFile for a fee-invoices mapping (returned under feeInvoices). ' +
                'For construction: the main file is the jobs / WIP schedule; pass a companions object naming any of glRevenue, balances, ' +
                'wipSnapshots, retainage, subPayments ({ file }) to propose their mappings too (returned under the same keys). ' +
                'For nonprofit (restricted funds): the main file is the fund register; pass a companions object naming any of expenses, ' +
                'releases, accountBalances, netAssets, federalAwards ({ file }) to propose their mappings too (returned under the same keys). ' +
                'For insurance (agency premium trust): the main file is the premium-trust ledger; pass a companions object naming any of ' +
                'policies, commissionReceipts, binders, bankSnapshots ({ file }) to propose their mappings too (returned under the same keys). ' +
                'For excise (beer/excise tax filings): the main file is the taxable removals; pass a companions object naming any of ' +
                'rates, operationsReports, returns ({ file }) to propose their mappings too (returned under the same keys).',
            inputSchema: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'main CSV file name within the import folder (expenditures for municipal, trust journal for iolta, jobs/WIP schedule for construction, fund register for nonprofit, premium-trust ledger for insurance, taxable removals for excise)' },
                    pack: { type: 'string', description: 'warehouse to map onto: "municipal" (default), "iolta", "construction", "nonprofit", "insurance" or "excise"' },
                    grantFile: { type: 'string', description: 'municipal: optional grant-register CSV file name, to propose its mapping too' },
                    drawdownFile: { type: 'string', description: 'municipal: optional grant-drawdowns CSV file name, to propose its mapping too' },
                    bankFile: { type: 'string', description: 'iolta: optional bank-snapshots CSV file name, to propose its mapping too' },
                    invoicesFile: { type: 'string', description: 'iolta: optional fee-invoices CSV file name, to propose its mapping too' },
                    companions: {
                        type: 'object',
                        description: 'construction: companion files keyed by glRevenue / balances / wipSnapshots / retainage / subPayments; nonprofit: expenses / releases / accountBalances / netAssets / federalAwards; insurance: policies / commissionReceipts / binders / bankSnapshots; excise: rates / operationsReports / returns. Each { file }, to propose their mappings too',
                        additionalProperties: false,
                        properties: {
                            glRevenue: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            balances: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            wipSnapshots: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            retainage: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            subPayments: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            expenses: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            releases: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            accountBalances: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            netAssets: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            federalAwards: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            policies: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            commissionReceipts: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            binders: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            bankSnapshots: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            rates: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            operationsReports: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                            returns: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
                        },
                    },
                },
                required: ['file'],
                additionalProperties: false,
            },
        },
        {
            name: 'import_csv',
            description:
                'Import a CSV from the import folder with a confirmed column mapping: builds a pack\'s canonical ledger, records the ' +
                "source file's SHA-256 as an audit entry, and runs that pack's named-query gate. Local only. The file is read by name " +
                'from the configured import folder; pasted data and absolute paths are refused. pack selects the warehouse (default "municipal"). ' +
                'municipal: pass grantFile + grantMapping to apply a grant register (so municipal/grant-status measures spending against real ' +
                'awards) and drawdownFile + drawdownMapping for grant drawdowns (so grant-status measures cash drawn vs spent). ' +
                'iolta: the main file is the trust journal; pass bankFile + bankMapping for bank-reconciliation snapshots (so three-way-reconciliation ' +
                'can tie) and invoicesFile + invoicesMapping for fee invoices (so unsupported-fee-transfers can check each transfer). ' +
                'construction: the main file is the jobs / WIP schedule; pass a companions object keyed by glRevenue / balances / wipSnapshots / ' +
                'retainage / subPayments, each { file, mapping }, to fill the tables the other five controls tie to. ' +
                'nonprofit: the main file is the fund register; pass a companions object keyed by expenses / releases / accountBalances / netAssets / ' +
                'federalAwards, each { file, mapping }, to fill the tables the five controls read. ' +
                'insurance: the main file is the premium-trust ledger; pass a companions object keyed by policies / commissionReceipts / binders / ' +
                'bankSnapshots, each { file, mapping }, to fill the tables the three controls read (import policies before commissionReceipts / binders). ' +
                'excise: the main file is the taxable removals; pass a companions object keyed by rates / operationsReports / returns, each ' +
                '{ file, mapping }, to fill the tables the five controls read. ' +
                'Each companion file records its own source-SHA-256 audit entry.',
            inputSchema: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'main CSV file name within the import folder (expenditures for municipal, trust journal for iolta, jobs/WIP schedule for construction, fund register for nonprofit, premium-trust ledger for insurance, taxable removals for excise)' },
                    mapping: { type: 'object', description: 'confirmed mapping, canonical field -> CSV column (from propose_csv_mapping)' },
                    pack: { type: 'string', description: 'warehouse to import into: "municipal" (default), "iolta", "construction", "nonprofit", "insurance" or "excise"' },
                    grantFile: { type: 'string', description: 'municipal: optional grant-register CSV file name within the import folder' },
                    grantMapping: { type: 'object', description: 'municipal: confirmed grant-register mapping; required when grantFile is given' },
                    drawdownFile: { type: 'string', description: 'municipal: optional grant-drawdowns CSV file name within the import folder' },
                    drawdownMapping: { type: 'object', description: 'municipal: confirmed grant-drawdowns mapping; required when drawdownFile is given' },
                    bankFile: { type: 'string', description: 'iolta: optional bank-snapshots CSV file name within the import folder' },
                    bankMapping: { type: 'object', description: 'iolta: confirmed bank-snapshots mapping; required when bankFile is given' },
                    invoicesFile: { type: 'string', description: 'iolta: optional fee-invoices CSV file name within the import folder' },
                    invoicesMapping: { type: 'object', description: 'iolta: confirmed fee-invoices mapping; required when invoicesFile is given' },
                    companions: {
                        type: 'object',
                        description: 'construction: companion files keyed by glRevenue / balances / wipSnapshots / retainage / subPayments; nonprofit: expenses / releases / accountBalances / netAssets / federalAwards; insurance: policies / commissionReceipts / binders / bankSnapshots; excise: rates / operationsReports / returns. Each { file, mapping }',
                        additionalProperties: false,
                        properties: {
                            glRevenue: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            balances: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            wipSnapshots: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            retainage: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            subPayments: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            expenses: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            releases: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            accountBalances: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            netAssets: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            federalAwards: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            policies: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            commissionReceipts: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            binders: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            bankSnapshots: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            rates: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            operationsReports: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                            returns: { type: 'object', properties: { file: { type: 'string' }, mapping: { type: 'object' } }, additionalProperties: false },
                        },
                    },
                },
                required: ['file', 'mapping'],
                additionalProperties: false,
            },
        },
    ];
}

/** The tool definitions advertised to a host AI. */
export function listTools() {
    const freeText = freeTextWarehouses();
    const known = Object.keys(warehouseDescriptors());
    return [
        ...importTools(),
        {
            name: 'list_controls',
            description: 'List the SOC 2 control catalog (id, criterion, warehouse, description).',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
            name: 'run_control',
            description:
                'Run a SOC 2 control by id. Returns a control result (PASS/EXCEPTION, figures) with its provenance; the result is exportable as an evidence packet.',
            inputSchema: {
                type: 'object',
                properties: { id: { type: 'string', description: 'a control id from list_controls' } },
                required: ['id'],
            },
        },
        {
            name: 'run_canonical',
            description:
                `Run a canonical, credential-free query. name is one of: ${[...Object.keys(CANONICAL), ...namedQueryNames()].join(', ')}. ` +
                'Named queries on a custom warehouse also return automatic checks: integrity (pass/flag; a flag means ' +
                'do not present the result as fact) and findings (data conditions worth reporting). Their parameters ' +
                'are listed in civic-chain://warehouses.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    args: { type: 'object', description: 'query arguments, e.g. { "grant_id": "G-402" }' },
                },
                required: ['name'],
            },
        },
        {
            name: 'verify_audit',
            description:
                'Verify a hash-chained audit log; reports INTACT or the first entry where the chain breaks. ' +
                'Pass warehouse to check that warehouse\'s log; with no warehouse, checks the free-text SaaS log. ' +
                'A warehouse name resolves to a server-known log path; the caller cannot name a file to read. ' +
                'Checks the hash chain only, not signatures.',
            inputSchema: {
                type: 'object',
                properties: {
                    warehouse: { type: 'string', description: `one of: ${known.join(', ')}` },
                },
                additionalProperties: false,
            },
        },
        {
            name: 'execute_financial_query',
            description:
                'Answer a free-text financial question: the model writes SQL, the guard checks it, the database produces the numbers, every figure is verified, and the answer is attested. Requires an API credential. ' +
                `Warehouses that accept free text: ${freeText.join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    question: { type: 'string' },
                    warehouse: { type: 'string', description: 'defaults to "saas"' },
                },
                required: ['question'],
            },
        },
        {
            name: 'run_query',
            description:
                'Run SQL you (the host AI) wrote, with no API credential: the guard parses it, holds it to the ' +
                'warehouse allow-list and SELECT-only, runs it read-only, records lineage and a hash-chained audit entry, ' +
                'and returns the rows with their provenance (result hash, ruleset and data hashes). Use this for an ' +
                'open-ended question when no planner key is configured; the result is reproducible and verify_answer can confirm it. ' +
                `Warehouses that accept ad-hoc SQL: ${freeText.join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    sql: { type: 'string', description: 'a single SELECT statement' },
                    warehouse: { type: 'string', description: 'defaults to "saas"' },
                    question: { type: 'string', description: 'optional: what the SQL is meant to answer, recorded in lineage' },
                },
                required: ['sql'],
            },
        },
        {
            name: 'verify_answer',
            description:
                'Re-run the SQL behind a claimed answer and confirm it reproduces, with no API credential. Given the SQL and ' +
                'either a prior result hash or a claimed figure, it recomputes from the live data and reports whether the ' +
                'hash matches and whether the figure is grounded in the result. This is how a figure is checked without ' +
                'trusting the narration. Read-only; it records nothing. ' +
                `Warehouses: ${freeText.join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    sql: { type: 'string', description: 'the SELECT to re-run' },
                    warehouse: { type: 'string', description: 'defaults to "saas"' },
                    claimedResultHash: { type: 'string', description: 'a prior lineage result hash to match' },
                    claimedFigure: { type: ['string', 'number'], description: 'a figure that should appear in the result' },
                },
                required: ['sql'],
            },
        },
    ];
}

/**
 * Invoke a tool by name. `client` (an Anthropic instance) is only used by
 * execute_financial_query; the rest run with no credential.
 *
 * `ctx` is trusted server context, never populated from the MCP wire (the
 * stdio transport calls callTool with only the tool name and the caller's
 * arguments). `ctx.overrides` therefore carries infrastructure a caller must
 * not control, dbPath and logPath, used by tests and by trusted embeddings to
 * point a canonical query or control at an isolated database and log.
 *
 * @param {string} name
 * @param {object} [args]       caller-supplied arguments, untrusted
 * @param {object} [ctx]
 * @param {object} [ctx.client]
 * @param {{dbPath?: string, logPath?: string}} [ctx.overrides]
 */
export async function callTool(name, args = {}, { client, overrides = {} } = {}) {
    // Only the two infrastructure keys, and only from trusted ctx, never args.
    const infra = {};
    if (overrides.dbPath !== undefined) infra.dbPath = overrides.dbPath;
    if (overrides.logPath !== undefined) infra.logPath = overrides.logPath;
    switch (name) {
        case 'list_controls':
            return controlCatalog().map((c) => ({
                id: c.id,
                criterion: c.criterion,
                warehouse: c.warehouse,
                description: c.description,
            }));

        case 'run_control': {
            // A control runs a fixed, blessed query; the caller chooses only
            // which control. dbPath/logPath come from trusted ctx, never args,
            // so a caller cannot redirect the control's query or its log.
            const { control, entry, verification } = getControl(args.id).run({ signer: loadSigner(), ...infra });
            return {
                control,
                provenance: entry ? provenanceOf(entry) : null,
                verification: verification ?? null,
                exportable: Boolean(entry),
            };
        }

        case 'run_canonical': {
            // "<custom warehouse>/<query>" runs that warehouse's named query.
            const [prefix, ...rest] = String(args.name ?? '').split('/');
            const custom = warehouseDescriptors()[prefix];
            if (custom?.custom && rest.length === 1) {
                const out = runNamedQuery(custom, rest[0], args.args ?? {}, { guard, signer: loadSigner() });
                return {
                    query: out.query,
                    params: out.params,
                    rows: out.rows,
                    integrity: out.integrity,
                    findings: out.findings,
                    checks: out.checks,
                    provenance: provenanceOf(out.entry),
                };
            }
            const spec = CANONICAL[args.name];
            if (!spec) {
                throw new Error(
                    `Unknown canonical query "${args.name}". Known: ${[...Object.keys(CANONICAL), ...namedQueryNames()].join(', ')}.`,
                );
            }
            const callerArgs = pickCallerArgs(args.name, spec.args, args.args ?? {});
            const { rows, entry } = spec.run({ ...callerArgs, ...infra, signer: loadSigner() });
            return { rows, provenance: provenanceOf(entry) };
        }

        case 'verify_audit': {
            // The caller may name only a warehouse, never a file path: a
            // warehouse name resolves to that warehouse's server-known log, so a
            // caller cannot aim verify_audit at an arbitrary file its OS user can
            // read. pickCallerArgs refuses logPath (and any other key) from the
            // wire; the trusted logPath channel is ctx.overrides, used by tests
            // and trusted embeddings, never populated from an MCP caller. Note
            // the SaaS descriptor's log is the canonical/control log; free-text
            // SaaS answers go to DEFAULT_LOG_PATH, which is also the default.
            pickCallerArgs('verify_audit', ['warehouse'], args);
            const logPath = args.warehouse
                ? getWarehouse(args.warehouse).logPath
                : (infra.logPath ?? DEFAULT_LOG_PATH);
            return { logPath, ...verify(logPath, { verifier: null }) };
        }

        case 'propose_csv_mapping': {
            // Read-only: headers in, a proposed mapping out, nothing written. The
            // file name is confined to the import folder inside runImport. A
            // grantFile proposes the grant-register mapping in the same pass.
            if (!importDir()) throw new Error('No import folder is configured (set CIVIC_IMPORT_DIR).');
            if (args.pack === 'iolta') {
                const { runIoltaImport } = await import('./import-iolta-run.js');
                const r = await runIoltaImport({
                    file: args.file,
                    mapping: null,
                    bankSnapshots: args.bankFile ? { file: args.bankFile, mapping: null } : null,
                    feeInvoices: args.invoicesFile ? { file: args.invoicesFile, mapping: null } : null,
                });
                const out = { pack: 'iolta', file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
                if (r.bankSnapshots) {
                    const b = r.bankSnapshots;
                    out.bankSnapshots = { file: b.file, mapping: b.mapping, fields: b.fields, unmappedHeaders: b.unmappedHeaders, missingRequired: b.missingRequired };
                }
                if (r.feeInvoices) {
                    const i = r.feeInvoices;
                    out.feeInvoices = { file: i.file, mapping: i.mapping, fields: i.fields, unmappedHeaders: i.unmappedHeaders, missingRequired: i.missingRequired };
                }
                return out;
            }
            if (args.pack === 'construction') {
                const { runConstructionImport, CONSTRUCTION_COMPANION_KEYS } = await import('./import-construction-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of CONSTRUCTION_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: null } : null;
                }
                const r = await runConstructionImport({ file: args.file, mapping: null, ...companionArgs });
                const out = { pack: 'construction', file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
                for (const key of CONSTRUCTION_COMPANION_KEYS) {
                    const b = r[key];
                    if (b) out[key] = { file: b.file, mapping: b.mapping, fields: b.fields, unmappedHeaders: b.unmappedHeaders, missingRequired: b.missingRequired };
                }
                return out;
            }
            if (args.pack === 'nonprofit') {
                const { runNonprofitImport, NONPROFIT_COMPANION_KEYS } = await import('./import-nonprofit-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of NONPROFIT_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: null } : null;
                }
                const r = await runNonprofitImport({ file: args.file, mapping: null, ...companionArgs });
                const out = { pack: 'nonprofit', file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
                for (const key of NONPROFIT_COMPANION_KEYS) {
                    const b = r[key];
                    if (b) out[key] = { file: b.file, mapping: b.mapping, fields: b.fields, unmappedHeaders: b.unmappedHeaders, missingRequired: b.missingRequired };
                }
                return out;
            }
            if (args.pack === 'insurance') {
                const { runInsuranceImport, INSURANCE_COMPANION_KEYS } = await import('./import-insurance-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of INSURANCE_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: null } : null;
                }
                const r = await runInsuranceImport({ file: args.file, mapping: null, ...companionArgs });
                const out = { pack: 'insurance', file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
                for (const key of INSURANCE_COMPANION_KEYS) {
                    const b = r[key];
                    if (b) out[key] = { file: b.file, mapping: b.mapping, fields: b.fields, unmappedHeaders: b.unmappedHeaders, missingRequired: b.missingRequired };
                }
                return out;
            }
            if (args.pack === 'excise') {
                const { runExciseImport, EXCISE_COMPANION_KEYS } = await import('./import-excise-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of EXCISE_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: null } : null;
                }
                const r = await runExciseImport({ file: args.file, mapping: null, ...companionArgs });
                const out = { pack: 'excise', file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
                for (const key of EXCISE_COMPANION_KEYS) {
                    const b = r[key];
                    if (b) out[key] = { file: b.file, mapping: b.mapping, fields: b.fields, unmappedHeaders: b.unmappedHeaders, missingRequired: b.missingRequired };
                }
                return out;
            }
            const { runImport } = await import('./import.js');
            const r = await runImport({
                file: args.file,
                mapping: null,
                grantRegister: args.grantFile ? { file: args.grantFile, mapping: null } : null,
                grantDrawdowns: args.drawdownFile ? { file: args.drawdownFile, mapping: null } : null,
            });
            const out = { file: r.file, mapping: r.mapping, fields: r.fields, unmappedHeaders: r.unmappedHeaders, missingRequired: r.missingRequired };
            if (r.grantRegister) {
                const g = r.grantRegister;
                out.grantRegister = { file: g.file, mapping: g.mapping, fields: g.fields, unmappedHeaders: g.unmappedHeaders, missingRequired: g.missingRequired };
            }
            if (r.grantDrawdowns) {
                const d = r.grantDrawdowns;
                out.grantDrawdowns = { file: d.file, mapping: d.mapping, fields: d.fields, unmappedHeaders: d.unmappedHeaders, missingRequired: d.missingRequired };
            }
            return out;
        }

        case 'import_csv': {
            // Perform a confirmed import. The caller names a file within the
            // import folder and supplies the confirmed mapping; the ledger, log
            // and mapping paths are server-derived (data dir), never from the wire.
            if (!importDir()) throw new Error('No import folder is configured (set CIVIC_IMPORT_DIR).');
            if (args.pack === 'iolta') {
                const { runIoltaImport } = await import('./import-iolta-run.js');
                const r = await runIoltaImport({
                    file: args.file,
                    mapping: args.mapping,
                    bankSnapshots: args.bankFile ? { file: args.bankFile, mapping: args.bankMapping ?? null } : null,
                    feeInvoices: args.invoicesFile ? { file: args.invoicesFile, mapping: args.invoicesMapping ?? null } : null,
                    signer: loadSigner(),
                });
                return {
                    pack: 'iolta',
                    file: r.file,
                    counts: r.counts,
                    sourceFileSha256: r.sourceFileSha256,
                    byteLength: r.byteLength,
                    canonicalSchemaVersion: r.canonicalSchemaVersion,
                    mapping: r.mapping,
                    audit: r.audit,
                    bankSnapshots: r.bankSnapshots,
                    feeInvoices: r.feeInvoices,
                    gate: r.gate,
                    dbPath: r.paths.dbPath,
                    allowlistPath: r.paths.allowlistPath,
                };
            }
            if (args.pack === 'construction') {
                const { runConstructionImport, CONSTRUCTION_COMPANION_KEYS } = await import('./import-construction-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of CONSTRUCTION_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: given[key].mapping ?? null } : null;
                }
                const r = await runConstructionImport({ file: args.file, mapping: args.mapping, ...companionArgs, signer: loadSigner() });
                const out = {
                    pack: 'construction',
                    file: r.file,
                    counts: r.counts,
                    sourceFileSha256: r.sourceFileSha256,
                    byteLength: r.byteLength,
                    canonicalSchemaVersion: r.canonicalSchemaVersion,
                    mapping: r.mapping,
                    audit: r.audit,
                    gate: r.gate,
                    dbPath: r.paths.dbPath,
                    allowlistPath: r.paths.allowlistPath,
                };
                for (const key of CONSTRUCTION_COMPANION_KEYS) out[key] = r[key];
                return out;
            }
            if (args.pack === 'nonprofit') {
                const { runNonprofitImport, NONPROFIT_COMPANION_KEYS } = await import('./import-nonprofit-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of NONPROFIT_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: given[key].mapping ?? null } : null;
                }
                const r = await runNonprofitImport({ file: args.file, mapping: args.mapping, ...companionArgs, signer: loadSigner() });
                const out = {
                    pack: 'nonprofit',
                    file: r.file,
                    counts: r.counts,
                    sourceFileSha256: r.sourceFileSha256,
                    byteLength: r.byteLength,
                    canonicalSchemaVersion: r.canonicalSchemaVersion,
                    mapping: r.mapping,
                    audit: r.audit,
                    gate: r.gate,
                    dbPath: r.paths.dbPath,
                    allowlistPath: r.paths.allowlistPath,
                };
                for (const key of NONPROFIT_COMPANION_KEYS) out[key] = r[key];
                return out;
            }
            if (args.pack === 'insurance') {
                const { runInsuranceImport, INSURANCE_COMPANION_KEYS } = await import('./import-insurance-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of INSURANCE_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: given[key].mapping ?? null } : null;
                }
                const r = await runInsuranceImport({ file: args.file, mapping: args.mapping, ...companionArgs, signer: loadSigner() });
                const out = {
                    pack: 'insurance',
                    file: r.file,
                    counts: r.counts,
                    sourceFileSha256: r.sourceFileSha256,
                    byteLength: r.byteLength,
                    canonicalSchemaVersion: r.canonicalSchemaVersion,
                    mapping: r.mapping,
                    audit: r.audit,
                    gate: r.gate,
                    dbPath: r.paths.dbPath,
                    allowlistPath: r.paths.allowlistPath,
                };
                for (const key of INSURANCE_COMPANION_KEYS) out[key] = r[key];
                return out;
            }
            if (args.pack === 'excise') {
                const { runExciseImport, EXCISE_COMPANION_KEYS } = await import('./import-excise-run.js');
                const given = args.companions ?? {};
                const companionArgs = {};
                for (const key of EXCISE_COMPANION_KEYS) {
                    companionArgs[key] = given[key]?.file ? { file: given[key].file, mapping: given[key].mapping ?? null } : null;
                }
                const r = await runExciseImport({ file: args.file, mapping: args.mapping, ...companionArgs, signer: loadSigner() });
                const out = {
                    pack: 'excise',
                    file: r.file,
                    counts: r.counts,
                    sourceFileSha256: r.sourceFileSha256,
                    byteLength: r.byteLength,
                    canonicalSchemaVersion: r.canonicalSchemaVersion,
                    mapping: r.mapping,
                    audit: r.audit,
                    gate: r.gate,
                    dbPath: r.paths.dbPath,
                    allowlistPath: r.paths.allowlistPath,
                };
                for (const key of EXCISE_COMPANION_KEYS) out[key] = r[key];
                return out;
            }
            const { runImport } = await import('./import.js');
            const r = await runImport({
                file: args.file,
                mapping: args.mapping,
                grantRegister: args.grantFile ? { file: args.grantFile, mapping: args.grantMapping ?? null } : null,
                grantDrawdowns: args.drawdownFile ? { file: args.drawdownFile, mapping: args.drawdownMapping ?? null } : null,
                signer: loadSigner(),
            });
            return {
                file: r.file,
                counts: r.counts,
                sourceFileSha256: r.sourceFileSha256,
                byteLength: r.byteLength,
                canonicalSchemaVersion: r.canonicalSchemaVersion,
                mapping: r.mapping,
                audit: r.audit,
                grantRegister: r.grantRegister,
                grantDrawdowns: r.grantDrawdowns,
                gate: r.gate,
                dbPath: r.paths.dbPath,
                allowlistPath: r.paths.allowlistPath,
            };
        }

        case 'run_query': {
            // The host AI's own SQL, no key. Route only to a free-text warehouse
            // (saas or a custom ledger); the named-query-only warehouses expose
            // just their blessed queries by design. The guard is the trust
            // boundary; infra paths come from trusted ctx, never the wire.
            const resolved = resolveFreeText(args.warehouse, infra);
            if (!resolved.ok) return resolved.refusal;
            const out = runAgentQuery(resolved.descriptor, args.sql, {
                guard,
                signer: loadSigner(),
                question: args.question ?? null,
            });
            if (!out.ok) return out;
            return {
                ok: true,
                sql: out.sql,
                rows: out.rows,
                limitInjected: out.limitInjected,
                provenance: provenanceOf(out.entry),
                rulesetHash: out.entry.rulesetHash ?? null,
                dataHash: out.entry.dataHash ?? null,
            };
        }

        case 'verify_answer': {
            const resolved = resolveFreeText(args.warehouse, infra);
            if (!resolved.ok) return resolved.refusal;
            if (args.claimedResultHash == null && args.claimedFigure == null) {
                return {
                    ok: false,
                    stage: 'verify',
                    reason: 'no_claim',
                    message: 'Provide claimedResultHash or claimedFigure to verify against the SQL.',
                };
            }
            return verifyAgentQuery(
                resolved.descriptor,
                {
                    sql: args.sql,
                    claimedResultHash: args.claimedResultHash ?? null,
                    claimedFigure: args.claimedFigure ?? null,
                },
                { guard },
            );
        }

        case 'execute_financial_query': {
            const warehouse = args.warehouse ?? 'saas';
            const descriptor = warehouseDescriptors()[warehouse];
            if (!descriptor || !descriptor.freeText) {
                const freeText = freeTextWarehouses().map((w) => `"${w}"`).join(', ');
                return {
                    ok: false,
                    stage: 'route',
                    reason: 'warehouse_not_supported',
                    message: descriptor
                        ? `Free-text questions are supported over ${freeText}. The "${warehouse}" warehouse ` +
                          `exposes canonical queries via run_canonical and controls via run_control.`
                        : `Unknown warehouse "${warehouse}". Free-text questions are supported over ${freeText}.`,
                };
            }
            const { ask } = await import('./ask.js');
            const withClient = client ? { client } : {};
            if (!descriptor.custom) return ask(args.question, withClient);
            return ask(args.question, {
                ...withClient,
                dbPath: descriptor.dbPath,
                logPath: descriptor.logPath,
                allowedTables: descriptor.allowedTables,
                allowedColumns: descriptor.allowedColumns,
                planSchema: descriptor.planSchema,
            });
        }

        default:
            throw new Error(`Unknown tool "${name}".`);
    }
}

/** The resource definitions advertised to a host AI. */
export function listResources() {
    const warehouses = Object.keys(warehouseDescriptors());
    return [
        {
            uri: 'civic-chain://warehouses',
            name: 'Warehouses',
            description: 'The warehouses this engine serves, and which support free-text questions.',
            mimeType: 'application/json',
        },
        {
            uri: 'civic-chain://controls',
            name: 'Control catalog',
            description: 'The SOC 2 control catalog.',
            mimeType: 'application/json',
        },
        ...warehouses.map((w) => ({
            uri: `civic-chain://schema/${w}`,
            name: `Schema: ${w}`,
            description: `Live, allow-listed table/column schema for the ${w} warehouse.`,
            mimeType: 'application/json',
        })),
    ];
}

/**
 * Read a resource by uri. Schema resources reflect the live database shape,
 * filtered to the guard's allow-list.
 *
 * @param {string} uri
 */
export function readResource(uri) {
    if (uri === 'civic-chain://warehouses') {
        return Object.values(warehouseDescriptors()).map((d) => ({
            name: d.name,
            description: d.description,
            freeText: d.freeText,
            tables: [...d.allowedTables],
            ...(d.custom ? { queries: Object.values(d.queries ?? {}).map((q) => ({ ...describeQuery(q), name: `${d.name}/${q.name}` })) } : {}),
        }));
    }
    if (uri === 'civic-chain://controls') {
        return controlCatalog().map((c) => ({
            id: c.id,
            criterion: c.criterion,
            warehouse: c.warehouse,
            description: c.description,
        }));
    }
    const match = /^civic-chain:\/\/schema\/([a-z][a-z0-9_]*)$/.exec(uri);
    if (match) return warehouseSchema(match[1]);
    throw new Error(`Unknown resource uri "${uri}".`);
}
