/**
 * S4 tests: the key-free open-ended path, run_query and verify_answer.
 *
 * The claim is that a buyer with no Anthropic key can still ask an ad-hoc
 * question: the host AI writes the SQL, run_query runs it through the same guard
 * and hash-chained audit as every other path, and verify_answer re-runs it to
 * confirm a figure without trusting any narration. These exercise the MCP
 * surface offline (no SDK, no server) and the pure core directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/db.js';
import { callTool } from '../src/mcp.js';
import { readLog } from '../src/audit.js';
import { executeAgentQuery, verifyAgentAnswer, AGENT_QUERY_TAGS } from '../src/query-core.js';

/** A freshly seeded SaaS database and an isolated audit log. */
function freshSaas() {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'vanguard-saas-')), 'saas.db');
    seed(dbPath);
    const logPath = join(mkdtempSync(join(tmpdir(), 'vanguard-saaslog-')), 'audit.jsonl');
    return { dbPath, logPath, overrides: { dbPath, logPath } };
}

test('run_query runs the host AI\'s SELECT with no key and records lineage', async () => {
    const { overrides, logPath } = freshSaas();
    const out = await callTool('run_query', { sql: 'SELECT COUNT(*) AS n FROM customers' }, { overrides });

    assert.equal(out.ok, true);
    assert.equal(out.rows.length, 1);
    assert.ok(out.rows[0].n > 0);
    assert.match(out.provenance.resultHash, /^[0-9a-f]{64}$/);
    // The guard injects a LIMIT when the model omits one.
    assert.equal(out.limitInjected, true);

    // The run was appended to the hash-chained audit log, tagged as agent SQL.
    const log = readLog(logPath);
    assert.equal(log.length, 1);
    assert.equal(log[0].agentSql, true);
    assert.deepEqual(log[0].complianceTags, [...AGENT_QUERY_TAGS]);
    assert.equal(log[0].resultHash, out.provenance.resultHash);
});

test('run_query refuses what the guard refuses, with the guard\'s reason', async () => {
    const { overrides } = freshSaas();

    const write = await callTool('run_query', { sql: 'DELETE FROM customers' }, { overrides });
    assert.equal(write.ok, false);
    assert.equal(write.stage, 'guard');
    assert.equal(write.reason, 'not_a_select');

    const offLimits = await callTool('run_query', { sql: 'SELECT * FROM payroll' }, { overrides });
    assert.equal(offLimits.ok, false);
    assert.equal(offLimits.reason, 'table_not_allowed');

    const injection = await callTool(
        'run_query',
        { sql: 'SELECT id FROM customers; DROP TABLE customers' },
        { overrides },
    );
    assert.equal(injection.ok, false);
    assert.equal(injection.reason, 'multiple_statements');
});

test('run_query and verify_answer route only to a free-text warehouse', async () => {
    for (const tool of ['run_query', 'verify_answer']) {
        const out = await callTool(tool, { sql: 'SELECT 1 AS n FROM customers', warehouse: 'markets' });
        assert.equal(out.ok, false, `${tool} should refuse a canonical-only warehouse`);
        assert.equal(out.reason, 'warehouse_not_supported');
    }
});

test('verify_answer confirms a matching result hash and flips on a tampered one', async () => {
    const { overrides } = freshSaas();
    const sql = 'SELECT COUNT(*) AS n FROM customers';
    const run = await callTool('run_query', { sql }, { overrides });

    const good = await callTool(
        'verify_answer',
        { sql, claimedResultHash: run.provenance.resultHash },
        { overrides },
    );
    assert.equal(good.ok, true);
    assert.equal(good.hashMatch, true);
    assert.equal(good.match, true);
    assert.equal(good.resultHash, run.provenance.resultHash);

    const tampered = await callTool(
        'verify_answer',
        { sql, claimedResultHash: 'f'.repeat(64) },
        { overrides },
    );
    assert.equal(tampered.hashMatch, false);
    assert.equal(tampered.match, false);
});

test('verify_answer grounds a true figure and flips on a fabricated one', async () => {
    const { overrides } = freshSaas();
    const sql = 'SELECT COUNT(*) AS n FROM customers';
    const run = await callTool('run_query', { sql }, { overrides });
    const trueCount = run.rows[0].n;

    const grounded = await callTool('verify_answer', { sql, claimedFigure: trueCount }, { overrides });
    assert.equal(grounded.figureGrounded, true);
    assert.equal(grounded.match, true);

    const fabricated = await callTool('verify_answer', { sql, claimedFigure: trueCount + 999_999 }, { overrides });
    assert.equal(fabricated.figureGrounded, false);
    assert.equal(fabricated.match, false);
});

test('verify_answer needs a claim to verify against', async () => {
    const { overrides } = freshSaas();
    const out = await callTool('verify_answer', { sql: 'SELECT COUNT(*) AS n FROM customers' }, { overrides });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_claim');
});

test('the agent-SQL path records the ruleset and data hashes it ran under', () => {
    // A hand-made descriptor with a ruleset and a data hash, exercised through
    // the pure core with injected collaborators: both must thread onto the audit
    // entry (run) and the verification result, exactly as the named-query path
    // records them. This is the "every figure ties to its ruleset and data" claim.
    const descriptor = {
        allowedTables: ['t'],
        allowedColumns: null,
        ruleset: { contentHash: 'ruleset-hash-abc' },
        dataHash: 'data-hash-def',
    };
    const rows = [{ n: 7 }];
    const guard = (sql) => ({ sql, params: [], tables: ['t'], columns: [], limitInjected: false });
    const warehouse = { query: () => rows };
    const appended = [];
    const appendAudit = (record) => {
        const entry = { ...record, seq: appended.length, hash: 'h' };
        appended.push(entry);
        return entry;
    };

    const run = executeAgentQuery(descriptor, 'SELECT n FROM t', { guard, warehouse, appendAudit });
    assert.equal(run.ok, true);
    assert.equal(run.entry.rulesetHash, 'ruleset-hash-abc');
    assert.equal(run.entry.dataHash, 'data-hash-def');
    assert.deepEqual(run.entry.ruleset, { contentHash: 'ruleset-hash-abc' });

    const verified = verifyAgentAnswer(descriptor, { sql: 'SELECT n FROM t', claimedFigure: 7 }, { guard, warehouse });
    assert.equal(verified.rulesetHash, 'ruleset-hash-abc');
    assert.equal(verified.dataHash, 'data-hash-def');
    assert.equal(verified.figureGrounded, true);
    assert.equal(verified.match, true);
});
