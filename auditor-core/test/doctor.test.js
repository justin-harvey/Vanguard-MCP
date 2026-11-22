/**
 * `cc-auditor doctor`: a fresh install checks clean and prints a usable config.
 * Offline, and writes only to a temp data directory supplied via CIVIC_DATA_DIR.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctor } from '../src/doctor.js';

function freshEnv() {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-doctor-')) };
}

test('doctor reports a clean install and a config pointing at files that exist', async () => {
    const env = freshEnv();
    const report = await runDoctor({ env });

    assert.equal(report.failures, 0);
    assert.ok(report.checks.every((c) => c.level !== 'fail'));

    const server = report.config.mcpServers['civic-chain-auditor'];
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['-y', '@civic-chain/auditor', 'mcp']);
    assert.ok(existsSync(server.env.CIVIC_DB_PATH));
    assert.ok(existsSync(server.env.CIVIC_ALLOWLIST_PATH));
    assert.equal(server.env.CIVIC_DB_PATH, join(env.CIVIC_DATA_DIR, 'municipal.db'));
});

test('doctor is idempotent across runs on the same data dir', async () => {
    const env = freshEnv();
    const first = await runDoctor({ env });
    const second = await runDoctor({ env });
    assert.equal(first.failures, 0);
    assert.equal(second.failures, 0);
    // The second run finds the demo already present rather than building it again.
    assert.ok(second.checks.some((c) => c.msg.includes('present')));
});

test('formatDoctor renders the checks, the config and a ready result', async () => {
    const report = await runDoctor({ env: freshEnv() });
    const text = formatDoctor(report);
    assert.match(text, /node:sqlite is available/);
    assert.match(text, /"civic-chain-auditor"/);
    assert.match(text, /Result: ready/);
});
