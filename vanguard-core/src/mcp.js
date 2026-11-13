/**
 * MCP handlers, pure and transport-free.
 *
 * These are the tools and resources the Vanguard MCP engine exposes to a host
 * AI. Every one routes through the same guard, grounding, lineage and audit
 * chain as the CLI: the MCP surface adds no new path to the data, and the guard
 * stays the trust boundary. The stdio transport lives in mcp-server.js and is
 * the only thing that needs the MCP SDK, keeping the logic here means the whole
 * surface is testable offline, with no SDK and no running server.
 *
 * Two families of tool, deliberately:
 *   - credential-free: list_controls, run_control, run_canonical, verify_audit,
 *     canonical queries and the control catalog, no model call;
 *   - credentialed: execute_financial_query, the planner writes SQL, so it needs
 *     an API key. Free text is supported over the SaaS warehouse and over a
 *     custom warehouse configured from the environment (see custom.js).
 */

import { controlCatalog, getControl } from './controls.js';
import { verify, DEFAULT_LOG_PATH } from './audit.js';
import { loadSigner } from './signing.js';
import { warehouseDescriptors, warehouseSchema, getWarehouse } from './warehouses.js';
import { guard } from './guard.js';
import { runNamedQuery } from './named-run.js';
import { describeQuery } from './named-queries.js';
import { revenueByBasis, debtWithHiddenLeverage } from './enron.js';
import { netPositionAtClose, surveillanceRapidCancels } from './markets.js';
import { reconcileMrr } from './saas.js';

export const SERVER_INFO = { name: 'vanguard', version: '0.1.0' };

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

/** Reduce an audit entry to the provenance a caller should carry. */
function provenanceOf(entry) {
    return {
        resultHash: entry.resultHash,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        signature: entry.signature ?? null,
        signingKeyId: entry.signingKeyId ?? null,
        complianceTags: entry.complianceTags ?? [],
    };
}

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

/** The tool definitions advertised to a host AI. */
export function listTools() {
    const freeText = freeTextWarehouses();
    const known = Object.keys(warehouseDescriptors());
    return [
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
                'are listed in vanguard://warehouses.',
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
            uri: 'vanguard://warehouses',
            name: 'Warehouses',
            description: 'The warehouses this engine serves, and which support free-text questions.',
            mimeType: 'application/json',
        },
        {
            uri: 'vanguard://controls',
            name: 'Control catalog',
            description: 'The SOC 2 control catalog.',
            mimeType: 'application/json',
        },
        ...warehouses.map((w) => ({
            uri: `vanguard://schema/${w}`,
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
    if (uri === 'vanguard://warehouses') {
        return Object.values(warehouseDescriptors()).map((d) => ({
            name: d.name,
            description: d.description,
            freeText: d.freeText,
            tables: [...d.allowedTables],
            ...(d.custom ? { queries: Object.values(d.queries ?? {}).map((q) => ({ ...describeQuery(q), name: `${d.name}/${q.name}` })) } : {}),
        }));
    }
    if (uri === 'vanguard://controls') {
        return controlCatalog().map((c) => ({
            id: c.id,
            criterion: c.criterion,
            warehouse: c.warehouse,
            description: c.description,
        }));
    }
    const match = /^vanguard:\/\/schema\/([a-z][a-z0-9_]*)$/.exec(uri);
    if (match) return warehouseSchema(match[1]);
    throw new Error(`Unknown resource uri "${uri}".`);
}
