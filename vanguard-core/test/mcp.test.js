/**
 * MCP handler tests, the tool and resource surface, exercised offline with no
 * SDK and no running server (the transport in mcp-server.js is the only thing
 * that needs the dependency). Covers a schema-resource read, the control tools,
 * a canonical query, audit verification, and the free-text tool's warehouse gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedEnron } from '../src/enron.js';
import { listTools, callTool, listResources, readResource } from '../src/mcp.js';
import { warehouseSchema, getWarehouse } from '../src/warehouses.js';
import { parseCsv, proposeMapping, CANONICAL_GRANT_FIELDS, CANONICAL_DRAWDOWN_FIELDS } from '../src/import-csv.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

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
    assert.ok(uris.includes('civic-chain://warehouses'));
    assert.ok(uris.includes('civic-chain://controls'));
    for (const w of ['saas', 'markets', 'enron']) {
        assert.ok(uris.includes(`civic-chain://schema/${w}`), `missing schema resource for ${w}`);
    }
});

test('the warehouses resource marks which support free text', () => {
    const warehouses = readResource('civic-chain://warehouses');
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

// ── CSV import tools, with the grant-register second file (MCP surface) ──────
//
// The import tools only advertise when an import folder is configured. These
// drive the same multi-file path the CLI's --grants/--grants-map flags use,
// over the MCP surface, so the agent loop can turn an empty grant-status into a
// meaningful one. env is set per test and restored, because the import folder's
// presence changes the advertised tool list.

/** Run `fn` with CIVIC_IMPORT_DIR/CIVIC_DATA_DIR set, restoring both after. */
async function withImportFolder(fn) {
    const prev = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = FIXTURE_DIR;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'vanguard-mcp-import-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', prev.imp], ['CIVIC_DATA_DIR', prev.data]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

/** The confirmed mapping proposeMapping suggests for a fixture CSV. */
function mappingFor(file, fields) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, fields).mapping;
}

test('the import tools are advertised only when an import folder is configured', async () => {
    assert.ok(!listTools().some((t) => t.name === 'import_csv'), 'no import folder: import tools must be hidden');
    await withImportFolder(() => {
        const names = listTools().map((t) => t.name);
        assert.ok(names.includes('propose_csv_mapping') && names.includes('import_csv'));
        // The grant and drawdown extra files are part of the advertised contract.
        const importTool = listTools().find((t) => t.name === 'import_csv');
        assert.ok(importTool.inputSchema.properties.grantFile);
        assert.ok(importTool.inputSchema.properties.grantMapping);
        assert.ok(importTool.inputSchema.properties.drawdownFile);
        assert.ok(importTool.inputSchema.properties.drawdownMapping);
    });
});

test('propose_csv_mapping proposes the grant-register mapping when grantFile is given', async () => {
    await withImportFolder(async () => {
        const out = await callTool('propose_csv_mapping', {
            file: 'riverton_grant_expenditures.csv',
            grantFile: 'riverton_grant_register.csv',
        });
        assert.equal(out.missingRequired.length, 0);
        assert.ok(out.grantRegister, 'expected a grant-register proposal');
        assert.equal(out.grantRegister.file, 'riverton_grant_register.csv');
        assert.deepEqual(out.grantRegister.missingRequired, []);
        assert.equal(out.grantRegister.mapping.grant_id, 'Grant ID');
        assert.equal(out.grantRegister.mapping.award_amount, 'Award');
    });
});

test('import_csv applies a grant register so grant-status measures real awards', async () => {
    await withImportFolder(async () => {
        const out = await callTool('import_csv', {
            file: 'riverton_grant_expenditures.csv',
            mapping: mappingFor('riverton_grant_expenditures.csv'),
            grantFile: 'riverton_grant_register.csv',
            grantMapping: mappingFor('riverton_grant_register.csv', CANONICAL_GRANT_FIELDS),
        });
        // The register was applied and recorded as its own source-hash entry.
        assert.ok(out.grantRegister, 'expected a grant-register result');
        assert.equal(out.grantRegister.counts.updated, 2);
        assert.equal(out.grantRegister.counts.inserted, 1);
        assert.notEqual(out.grantRegister.sourceFileSha256, out.sourceFileSha256);
        assert.equal(out.grantRegister.audit.seq, 1); // #0 import, #1 import-grants
        // grant-status is now meaningful: three grants, clean integrity.
        const grantStatus = out.gate.queries.find((q) => q.name === 'grant-status');
        assert.equal(grantStatus.rowCount, 3);
        assert.equal(grantStatus.integrity, 'pass');
        assert.equal(grantStatus.findings, 0);
    });
});

test('import_csv refuses a grant file without a confirmed grant mapping', async () => {
    await withImportFolder(async () => {
        await assert.rejects(
            () => callTool('import_csv', {
                file: 'riverton_grant_expenditures.csv',
                mapping: mappingFor('riverton_grant_expenditures.csv'),
                grantFile: 'riverton_grant_register.csv',
            }),
            /grants-map/,
        );
    });
});

test('propose_csv_mapping proposes the grant-drawdowns mapping when drawdownFile is given', async () => {
    await withImportFolder(async () => {
        const out = await callTool('propose_csv_mapping', {
            file: 'riverton_grant_expenditures.csv',
            drawdownFile: 'riverton_grant_drawdowns.csv',
        });
        assert.ok(out.grantDrawdowns, 'expected a grant-drawdowns proposal');
        assert.equal(out.grantDrawdowns.file, 'riverton_grant_drawdowns.csv');
        assert.deepEqual(out.grantDrawdowns.missingRequired, []);
        assert.equal(out.grantDrawdowns.mapping.grant_id, 'Grant');
        assert.equal(out.grantDrawdowns.mapping.amount, 'Amount');
    });
});

test('import_csv applies grant drawdowns so grant-status measures drawn vs spent', async () => {
    await withImportFolder(async () => {
        const out = await callTool('import_csv', {
            file: 'riverton_grant_expenditures.csv',
            mapping: mappingFor('riverton_grant_expenditures.csv'),
            grantFile: 'riverton_grant_register.csv',
            grantMapping: mappingFor('riverton_grant_register.csv', CANONICAL_GRANT_FIELDS),
            drawdownFile: 'riverton_grant_drawdowns.csv',
            drawdownMapping: mappingFor('riverton_grant_drawdowns.csv', CANONICAL_DRAWDOWN_FIELDS),
        });
        // The drawdowns were applied and recorded as their own source-hash entry.
        assert.ok(out.grantDrawdowns, 'expected a grant-drawdowns result');
        assert.equal(out.grantDrawdowns.counts.drawdowns, 6);
        assert.notEqual(out.grantDrawdowns.sourceFileSha256, out.grantRegister.sourceFileSha256);
        assert.equal(out.grantDrawdowns.audit.seq, 2); // #0 import, #1 import-grants, #2 import-drawdowns
        // grant-status stays clean: real awards, drawn cash within paid spending.
        const grantStatus = out.gate.queries.find((q) => q.name === 'grant-status');
        assert.equal(grantStatus.rowCount, 3);
        assert.equal(grantStatus.integrity, 'pass');
        assert.equal(grantStatus.findings, 0);
    });
});

test('import_csv refuses a drawdown file without a confirmed drawdown mapping', async () => {
    await withImportFolder(async () => {
        await assert.rejects(
            () => callTool('import_csv', {
                file: 'riverton_grant_expenditures.csv',
                mapping: mappingFor('riverton_grant_expenditures.csv'),
                drawdownFile: 'riverton_grant_drawdowns.csv',
            }),
            /drawdowns-map/,
        );
    });
});
