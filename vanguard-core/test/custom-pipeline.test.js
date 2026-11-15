/**
 * A custom warehouse end to end: free-text questions over the municipal demo go
 * through the same guard (now with that warehouse's table *and* column
 * allow-list), the read-only connection, lineage and the warehouse's own audit
 * log. The planner is stubbed, as in pipeline.test.js, so no credential is
 * needed and hostile SQL can be supplied on demand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/ask.js';
import { verify } from '../src/audit.js';
import { callTool, listTools, listResources, readResource } from '../src/mcp.js';
import { buildSystemPrompt } from '../src/planner.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';
import { guard } from '../src/guard.js';
import { validateNamedQueries } from '../src/named-run.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function stubClient(sql) {
    return {
        messages: {
            parse: async () => ({ stop_reason: 'end_turn', parsed_output: { sql, interpretation: 'stubbed' } }),
            create: async () => ({
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Here is the shape of the result.' }],
            }),
        },
    };
}

/** Run fn with the custom-warehouse variables set, restoring them afterwards. */
async function withCustomEnv(dbPath, fn) {
    const saved = { db: process.env[CUSTOM_ENV.db], allow: process.env[CUSTOM_ENV.allowlist] };
    process.env[CUSTOM_ENV.db] = dbPath;
    process.env[CUSTOM_ENV.allowlist] = MUNICIPAL_ALLOWLIST;
    try {
        return await fn();
    } finally {
        if (saved.db === undefined) delete process.env[CUSTOM_ENV.db];
        else process.env[CUSTOM_ENV.db] = saved.db;
        if (saved.allow === undefined) delete process.env[CUSTOM_ENV.allowlist];
        else process.env[CUSTOM_ENV.allowlist] = saved.allow;
    }
}

function askMunicipal(sql) {
    const w = loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
    return ask('stubbed question', {
        client: stubClient(sql),
        dbPath: w.dbPath,
        logPath: w.logPath,
        allowedTables: w.allowedTables,
        allowedColumns: w.allowedColumns,
        planSchema: w.planSchema,
    }).then((result) => ({ result, w }));
}

test('an allow-listed aggregate runs, records lineage and appends to the warehouse log', async () => {
    const { result, w } = await askMunicipal(
        "SELECT grant_id, SUM(amount_cents) AS paid_cents FROM expenditures WHERE status = 'paid' " +
            "AND grant_id = 'G-402' GROUP BY grant_id",
    );
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].paid_cents, 93_165_000);
    assert.deepEqual(result.lineage.tables, ['expenditures']);
    assert.match(result.lineage.resultHash, /^[0-9a-f]{64}$/);
    const integrity = verify(w.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 1);
});

test('a table outside the allow-list is refused, even one that exists', async () => {
    const { result } = await askMunicipal('SELECT position_title, gross_pay_cents FROM payroll');
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'guard');
    assert.equal(result.reason, 'table_not_allowed');
});

test('a JOIN to a table outside the allow-list is refused', async () => {
    const { result } = await askMunicipal(
        'SELECT d.dept_name, SUM(p.gross_pay_cents) AS pay FROM departments d JOIN payroll p ON p.dept_id = d.dept_id GROUP BY d.dept_name',
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'table_not_allowed');
});

test('a sensitive column outside the allow-list is refused', async () => {
    const { result } = await askMunicipal('SELECT vendor_name, tax_id FROM vendors');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'column_not_allowed');
});

test('SELECT * is refused because a column allow-list is in force', async () => {
    const { result } = await askMunicipal('SELECT * FROM grants');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wildcard_not_allowed');
});

test('a missing LIMIT is not a refusal; the guard injects one', async () => {
    const { result } = await askMunicipal('SELECT grant_id, award_cents FROM grants ORDER BY grant_id');
    assert.equal(result.ok, true);
    assert.equal(result.limitInjected, true);
    assert.equal(result.rows.length, 6);
});

test('the planner prompt for a custom warehouse names its tables and the column rule', () => {
    const w = loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
    const prompt = buildSystemPrompt(w.planSchema);
    assert.match(prompt, /questions about municipal budget, grant and spending data/);
    assert.match(prompt, /Read only from: funds, departments, vendors, grants, budget_lines, expenditures, grant_drawdowns\./);
    assert.match(prompt, /SELECT \* is refused/);
    // The SaaS prompt does not carry the column rule.
    assert.doesNotMatch(buildSystemPrompt(), /SELECT \* is refused/);
});

test('over MCP: the custom warehouse is advertised, routable for free text, and verifiable by name', async () => {
    const dbPath = freshMunicipalDb();
    await withCustomEnv(dbPath, async () => {
        const uris = listResources().map((r) => r.uri);
        assert.ok(uris.includes('civic-chain://schema/municipal'));

        const warehouses = readResource('civic-chain://warehouses');
        assert.equal(warehouses.find((x) => x.name === 'municipal').freeText, true);

        const schema = readResource('civic-chain://schema/municipal');
        const vendorCols = schema.tables.find((t) => t.table === 'vendors').columns.map((c) => c.name);
        assert.deepEqual(vendorCols, ['vendor_id', 'vendor_name', 'category']);

        const tool = listTools().find((t) => t.name === 'execute_financial_query');
        assert.match(tool.description, /municipal/);

        const result = await callTool(
            'execute_financial_query',
            { question: 'How much has grant 402 spent?', warehouse: 'municipal' },
            {
                client: stubClient(
                    "SELECT SUM(amount_cents) AS paid_cents FROM expenditures WHERE status = 'paid' AND grant_id = 'G-402'",
                ),
            },
        );
        assert.equal(result.ok, true);
        assert.equal(result.rows[0].paid_cents, 93_165_000);

        const integrity = await callTool('verify_audit', { warehouse: 'municipal' });
        assert.equal(integrity.ok, true);
        assert.equal(integrity.entries, 1);
        assert.match(integrity.logPath, /municipal-audit\.jsonl$/);
    });
});

test('over MCP: an unknown warehouse is refused at the route stage', async () => {
    const out = await callTool('execute_financial_query', { question: 'anything', warehouse: 'nowhere' });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'route');
    assert.equal(out.reason, 'warehouse_not_supported');
    assert.match(out.message, /Unknown warehouse/);
});

// ── named queries under the real guard ───────────────────────────────────

test('every demo named query and check passes the real guard', () => {
    const w = loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
    assert.equal(validateNamedQueries(w, guard), 6); // 3 queries + 3 total_matches checks
});

test('a named query that reads a withheld column is refused at startup', () => {
    const doc = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));
    doc.queries['vendor-tax-ids'] = { description: 'Should never be allowed.', sql: 'SELECT vendor_id, tax_id FROM vendors' };
    const path = join(mkdtempSync(join(tmpdir(), 'vanguard-allow-')), 'allowlist.json');
    writeFileSync(path, JSON.stringify(doc));
    const w = loadCustomWarehouse({ env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: path } });
    assert.throws(() => validateNamedQueries(w, guard), /vendor-tax-ids sql: column_not_allowed/);
});

test('over MCP: run_canonical runs a named query with checks and provenance, no credential', async () => {
    await withCustomEnv(freshMunicipalDb(), async () => {
        const tool = listTools().find((t) => t.name === 'run_canonical');
        assert.match(tool.description, /municipal\/grant-status/);
        const listed = readResource('civic-chain://warehouses').find((x) => x.name === 'municipal');
        assert.deepEqual(listed.queries.map((q) => q.name), [
            'municipal/grant-status',
            'municipal/spending-by-vendor',
            'municipal/budget-variance',
        ]);

        const out = await callTool('run_canonical', { name: 'municipal/grant-status', args: { grant_id: 'G-402' } });
        assert.equal(out.rows[0].paid_cents, 93_165_000);
        assert.equal(out.integrity, 'pass');
        assert.equal(out.findings, 1);
        assert.match(out.provenance.resultHash, /^[0-9a-f]{64}$/);

        const integrity = await callTool('verify_audit', { warehouse: 'municipal' });
        assert.equal(integrity.ok, true);
        assert.equal(integrity.entries, 1);
    });
});

test('over MCP: built-in canonical queries are unaffected by custom routing', async () => {
    await assert.rejects(() => callTool('run_canonical', { name: 'nowhere/thing' }), /Unknown canonical query/);
});
