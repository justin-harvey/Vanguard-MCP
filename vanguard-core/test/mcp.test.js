/**
 * MCP handler tests, the tool and resource surface, exercised offline with no
 * SDK and no running server (the transport in mcp-server.js is the only thing
 * that needs the dependency). Covers a schema-resource read, the control tools,
 * a canonical query, audit verification, and the free-text tool's warehouse gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEnron } from '../src/enron.js';
import { listTools, callTool, listResources, readResource } from '../src/mcp.js';
import { warehouseSchema, getWarehouse } from '../src/warehouses.js';

function freshDb(tag) {
    return join(mkdtempSync(join(tmpdir(), `vanguard-mcp-${tag}-`)), 'enron.db');
}
function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'vanguard-mcplog-')), 'audit.jsonl');
}

test('listTools advertises the engine surface', () => {
    const names = listTools().map((t) => t.name);
    for (const expected of ['list_controls', 'run_control', 'run_canonical', 'verify_audit', 'execute_financial_query']) {
        assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    // Every tool must carry an input schema an MCP client can validate against.
    for (const tool of listTools()) assert.equal(tool.inputSchema.type, 'object');
});

test('listResources exposes warehouses, controls, and a schema resource per warehouse', () => {
    const uris = listResources().map((r) => r.uri);
    assert.ok(uris.includes('vanguard://warehouses'));
    assert.ok(uris.includes('vanguard://controls'));
    for (const w of ['saas', 'markets', 'enron']) {
        assert.ok(uris.includes(`vanguard://schema/${w}`), `missing schema resource for ${w}`);
    }
});

test('the warehouses resource marks which support free text', () => {
    const warehouses = readResource('vanguard://warehouses');
    const saas = warehouses.find((w) => w.name === 'saas');
    const enron = warehouses.find((w) => w.name === 'enron');
    assert.equal(saas.freeText, true);
    assert.equal(enron.freeText, false);
});

test('a schema resource reflects the live, allow-listed table shape', () => {
    const db = freshDb('schema');
    seedEnron(db);
    const schema = warehouseSchema('enron', { dbPath: db });
    const tableNames = schema.tables.map((t) => t.table);
    assert.ok(tableNames.includes('debt_instruments'));
    assert.ok(tableNames.includes('reported_financials'));
    const debtCols = schema.tables.find((t) => t.table === 'debt_instruments').columns.map((c) => c.name);
    assert.ok(debtCols.includes('principal_usd_millions'));
    assert.ok(debtCols.includes('on_balance_sheet'));
});

test('list_controls returns the catalog and run_control asserts a status', async () => {
    const controls = await callTool('list_controls');
    assert.ok(controls.length >= 3);

    const db = freshDb('run');
    seedEnron(db);
    // dbPath/logPath are trusted infrastructure: they travel in ctx.overrides,
    // never in the caller's arguments.
    const result = await callTool(
        'run_control',
        { id: 'PI1.2-enron-debt-reconciliation' },
        { overrides: { dbPath: db, logPath: freshLog() } },
    );
    assert.equal(result.control.status, 'PASS');
    assert.match(result.provenance.resultHash, /^[0-9a-f]{64}$/);
    assert.equal(result.exportable, true);
});

test('run_canonical runs a credential-free query, and verify_audit checks its log', async () => {
    const db = freshDb('canon');
    const logPath = freshLog();
    seedEnron(db);
    const result = await callTool('run_canonical', { name: 'enron/debt' }, { overrides: { dbPath: db, logPath } });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].reported_debt_usd_millions, 10_229);

    // logPath is trusted infrastructure, so it travels in ctx.overrides, never
    // in the caller's arguments (which cannot name a file to read).
    const integrity = await callTool('verify_audit', {}, { overrides: { logPath } });
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 1);
});

test('verify_audit refuses a caller-supplied file path', async () => {
    // A caller must not be able to aim verify_audit at an arbitrary file on a
    // shared drive its OS user can read; the only documented argument is a
    // warehouse name, which resolves to a server-known log.
    for (const key of ['logPath', 'dbPath', 'path']) {
        await assert.rejects(
            () => callTool('verify_audit', { [key]: '/etc/passwd' }),
            /is not accepted/,
            `expected verify_audit to refuse "${key}"`,
        );
    }
});

test('verify_audit resolves a warehouse name to its own server-known log', async () => {
    // The caller names the warehouse; the engine, not the caller, chooses the
    // file. The resolved path is the warehouse's configured log, so a caller
    // cannot substitute one, even via a stray override.
    const integrity = await callTool('verify_audit', { warehouse: 'enron' }, { overrides: { logPath: '/tmp/ignored' } });
    assert.equal(integrity.logPath, getWarehouse('enron').logPath);
    assert.equal(integrity.ok, true);
});

test('a read-only control neither writes nor creates a database file', async () => {
    // Control C1.1 reads the LSEG warehouse to report retention. Pointed at a
    // path that does not exist, it must fail cleanly on a read-only open rather
    // than create an empty database there (gap: a tool call creating files).
    const missing = join(mkdtempSync(join(tmpdir(), 'vanguard-noexist-')), 'absent.db');
    await assert.rejects(
        () => callTool('run_control', { id: 'C1.1-lseg-data-retention' }, { overrides: { dbPath: missing } }),
    );
    assert.equal(existsSync(missing), false, 'the tool call must not have created a database file');
});

test('run_canonical rejects an unknown query name', async () => {
    await assert.rejects(() => callTool('run_canonical', { name: 'enron/nonsense' }));
});

test('run_canonical refuses caller-supplied infrastructure arguments', async () => {
    // A caller must not be able to redirect the query or its audit log by
    // passing dbPath, logPath or warehouse as query arguments.
    for (const key of ['dbPath', 'logPath', 'warehouse', 'signer', 'principal']) {
        await assert.rejects(
            () => callTool('run_canonical', { name: 'enron/debt', args: { [key]: '/tmp/evil' } }),
            /is not accepted/,
            `expected "${key}" to be refused`,
        );
    }
});

test('run_canonical still accepts a whitelisted query parameter', async () => {
    const db = freshDb('param');
    seedEnron(db);
    // fiscalYear is a legitimate query parameter, so it is accepted; the query
    // runs against the trusted database and produces a verifiable result.
    const result = await callTool(
        'run_canonical',
        { name: 'enron/debt', args: { fiscalYear: 2000 } },
        { overrides: { dbPath: db, logPath: freshLog() } },
    );
    assert.match(result.provenance.resultHash, /^[0-9a-f]{64}$/);
});

test('execute_financial_query refuses a non-SaaS warehouse without calling a model', async () => {
    const out = await callTool('execute_financial_query', { question: 'net position?', warehouse: 'markets' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'warehouse_not_supported');
});
