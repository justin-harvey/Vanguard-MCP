/**
 * R1 tests: the audit report.
 *
 * The report is a renderer over what the audit chain already records, so the
 * unit tests feed it hand-made entries (the exact shape append() writes) and
 * assert the Markdown/HTML carry the ruleset, the data hash, the chain status
 * and the disclaimers. One integration test runs a real agent query, reads the
 * log back, and renders it, proving the real entry shape flows through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/db.js';
import { readLog, verify } from '../src/audit.js';
import { guard } from '../src/guard.js';
import { runAgentQuery } from '../src/query-run.js';
import {
    buildAuditReport,
    renderReportMarkdown,
    renderReportHtml,
    CPA_DISCLAIMER,
    SYNTHETIC_NOTICE,
} from '../src/report.js';

/** A named-query audit entry with a signed ruleset and a source data hash. */
function realishEntries() {
    return [
        {
            seq: 0,
            at: '2026-11-17T00:00:00.000Z',
            namedQuery: 'municipal/grant-status',
            question: 'municipal/grant-status {}',
            rowCount: 3,
            resultHash: 'a'.repeat(64),
            integrity: 'pass',
            findings: 1,
            tables: ['grants', 'grant_drawdowns'],
            complianceTags: ['named-query', 'checked', 'reproducible'],
            signature: 'sig',
            signingKeyId: 'keyabc',
            rulesetHash: 'b'.repeat(64),
            dataHash: 'c'.repeat(64),
            ruleset: { name: 'municipal', version: '1', status: 'signed', contentHash: 'b'.repeat(64) },
            hash: 'h0',
            prevHash: '0'.repeat(64),
        },
        {
            seq: 1,
            at: '2026-11-17T00:01:00.000Z',
            agentSql: true,
            question: 'SELECT vendor, SUM(amount) FROM spend | GROUP BY vendor',
            rowCount: 12,
            resultHash: 'd'.repeat(64),
            tables: ['spend'],
            complianceTags: ['agent-sql', 'guarded', 'reproducible'],
            rulesetHash: 'b'.repeat(64),
            dataHash: 'c'.repeat(64),
            ruleset: { name: 'municipal', version: '1', status: 'signed', contentHash: 'b'.repeat(64) },
            hash: 'h1',
            prevHash: 'h0',
        },
    ];
}

const INTACT = { ok: true, entries: 2, brokenAt: null, reason: null };

test('buildAuditReport summarises the chain, ruleset, data and findings', () => {
    const report = buildAuditReport({ entries: realishEntries(), integrity: INTACT, warehouse: 'municipal' });

    assert.equal(report.warehouse, 'municipal');
    assert.equal(report.synthetic, false, 'a recorded data hash means imported, not synthetic');
    assert.equal(report.chain.ok, true);
    assert.equal(report.chain.signedEntries, 1);
    assert.equal(report.summary.attestations, 2);
    assert.equal(report.summary.findings, 1);
    assert.equal(report.summary.integrityFlags, 0);

    // The two entries share one ruleset and one data hash, deduped.
    assert.equal(report.rulesets.length, 1);
    assert.deepEqual(report.rulesets[0], { name: 'municipal', version: '1', status: 'signed', rulesetHash: 'b'.repeat(64) });
    assert.deepEqual(report.dataHashes, ['c'.repeat(64)]);
});

test('an integrity flag is counted and the chain-broken state carries through', () => {
    const entries = realishEntries();
    entries[0].integrity = 'flag';
    const broken = { ok: false, entries: 2, brokenAt: 1, reason: 'entry 1 has been modified' };
    const report = buildAuditReport({ entries, integrity: broken, warehouse: 'municipal' });

    assert.equal(report.summary.integrityFlags, 1);
    assert.equal(report.chain.ok, false);
    assert.equal(report.chain.brokenAt, 1);

    const md = renderReportMarkdown(report);
    assert.match(md, /BROKEN at entry 1/);
    assert.match(md, /unverified/);
});

test('the Markdown report carries ruleset, data hash and the CPA disclaimer', () => {
    const md = renderReportMarkdown(buildAuditReport({ entries: realishEntries(), integrity: INTACT, warehouse: 'municipal' }));

    assert.match(md, /# Audit report · municipal/);
    assert.match(md, /INTACT \(2 entries, 1\/2 signed\)/);
    assert.match(md, /municipal v1 — signed/);
    assert.ok(md.includes('c'.repeat(64)), 'the data hash should be printed');
    assert.ok(md.includes(CPA_DISCLAIMER));
    // No synthetic notice when real data is present.
    assert.ok(!md.includes(SYNTHETIC_NOTICE));
    // A pipe inside a cell is escaped so the table does not break.
    assert.match(md, /GROUP BY vendor/);
    assert.ok(!/SUM\(amount\) FROM spend \| GROUP/.test(md), 'the pipe in the label must be escaped');
});

test('a report over the bundled demo ledger shows the synthetic-data notice', () => {
    // No entry records a data hash, so the ledger is the synthetic demo.
    const entries = realishEntries().map(({ dataHash, ...rest }) => rest);
    const report = buildAuditReport({ entries, integrity: INTACT, warehouse: 'saas' });
    assert.equal(report.synthetic, true);
    assert.deepEqual(report.dataHashes, []);

    const md = renderReportMarkdown(report);
    assert.ok(md.includes(SYNTHETIC_NOTICE));
    const html = renderReportHtml(report);
    assert.ok(html.includes('notice'));
});

test('the HTML report is a self-contained document with the disclaimer and no external assets', () => {
    const html = renderReportHtml(buildAuditReport({ entries: realishEntries(), integrity: INTACT, warehouse: 'municipal' }));

    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Audit report · municipal<\/title>/);
    assert.ok(html.includes(CPA_DISCLAIMER));
    assert.match(html, /INTACT/);
    // PDF-ready: inline styles only, nothing fetched from the network.
    assert.ok(!/https?:\/\//.test(html.replace(/lang="en"/, '')), 'no external URLs');
    assert.ok(!/<script/i.test(html), 'no scripts');
});

test('a report renders real entries produced by run_query end to end', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'vanguard-report-')), 'saas.db');
    seed(dbPath);
    const logPath = join(mkdtempSync(join(tmpdir(), 'vanguard-reportlog-')), 'audit.jsonl');
    const descriptor = {
        name: 'saas',
        dbPath,
        logPath,
        allowedTables: ['customers'],
        allowedColumns: null,
    };

    const out = runAgentQuery(descriptor, 'SELECT COUNT(*) AS n FROM customers', { guard });
    assert.equal(out.ok, true);

    const report = buildAuditReport({
        entries: readLog(logPath),
        integrity: verify(logPath, { verifier: null }),
        warehouse: 'saas',
    });
    assert.equal(report.summary.attestations, 1);
    assert.equal(report.synthetic, true, 'no CSV imported, so the ledger is synthetic');
    assert.equal(report.entries[0].kind, 'agent SQL');
    assert.equal(report.entries[0].resultHash, out.entry.resultHash);

    const md = renderReportMarkdown(report);
    assert.match(md, /agent SQL/);
    assert.ok(md.includes(out.entry.resultHash.slice(0, 16)));
});
