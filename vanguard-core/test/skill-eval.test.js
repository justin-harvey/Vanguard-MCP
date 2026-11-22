/**
 * Behavioural eval: replay the shipped skill's worked examples through the real
 * engine and assert they still reproduce.
 *
 * The drift guard (skill-drift.test.js) proves every *name* the skill documents
 * exists in code. This goes a step further: it proves the skill's 11
 * `examples/` transcripts still *behave* as written — the concrete figures,
 * findings, check statuses and, above all, the reproducible **result hash** a
 * buyer sees in the docs. A silent engine change that made a documented
 * transcript wrong would fail here.
 *
 * How it works, per example:
 *   1. Parse the transcript's own tool-call line and its "Tool result" JSON
 *      block — the expectations come from the shipped doc, not from this file.
 *   2. Recreate the example's scenario: build the pack's shipped demo ledger and
 *      apply the one mutation that trips the control the example demonstrates
 *      (the scenario the transcript narrates; most examples show an EXCEPTION).
 *   3. Run the exact tool the transcript calls, through the same MCP entrypoint
 *      (callTool) the skill prescribes, against a fresh isolated audit log.
 *   4. Assert the engine reproduces the transcript: integrity, findings, every
 *      check's status, every row figure, and the result hash.
 *
 * Only the result hash is asserted, never the audit-entry hash: the audit entry
 * carries a wall-clock timestamp, so its chain hash is a one-time capture, while
 * the result hash is the reproducibility guarantee the product actually makes
 * ("re-running the same query against the same snapshot reproduces the result
 * hash"). Example 03 therefore verifies the chain is intact rather than matching
 * a specific entry hash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callTool } from '../src/mcp.js';
import { guard, SqlRejected } from '../src/guard.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { guardOptionsFor } from '../src/named-core.js';

import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';
import { freshInsuranceDb, INSURANCE_ALLOWLIST } from './insurance-fixture.js';
import { freshIoltaDb, IOLTA_ALLOWLIST } from './iolta-fixture.js';
import { freshExciseDb, EXCISE_ALLOWLIST } from './excise-fixture.js';
import { freshPropertyDb, PROPERTY_ALLOWLIST } from './property-fixture.js';
import { freshHoaDb, HOA_ALLOWLIST } from './hoa-fixture.js';
import { freshNonprofitDb, NONPROFIT_ALLOWLIST } from './nonprofit-fixture.js';
import { freshSchoolsDb, SCHOOLS_ALLOWLIST } from './schools-fixture.js';
import { freshConstructionDb, CONSTRUCTION_ALLOWLIST } from './construction-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'examples');
const ASSETS = join(here, '..', 'assets');
const rulesetPath = (pack, version) => join(ASSETS, pack, `ruleset.${version}.json`);

/** Read an example transcript. */
const transcript = (file) => readFileSync(join(EXAMPLES, file), 'utf8');

/** The first tool-call line in a transcript: `tool { ...json args... }`. */
function parseCall(text) {
    const m = text.match(
        /^(run_canonical|execute_financial_query|verify_audit|run_control|run_query|verify_answer)\s+(\{.*\})\s*$/m,
    );
    if (!m) throw new Error('no tool call found in transcript');
    return { tool: m[1], args: JSON.parse(m[2]) };
}

/** The ```json block immediately under the transcript's "Tool result" marker. */
function parseExpected(text) {
    // The marker is bold "Tool result", with the colon sometimes inside the
    // bold (`**Tool result:**`) and sometimes after it (`**Tool result** (…):`).
    const m = text.match(/\*\*Tool result:?\*\*[^\n]*\n+```json\n([\s\S]*?)\n```/);
    if (!m) throw new Error('no "Tool result" json block found in transcript');
    return JSON.parse(m[1]);
}

/** The result hash a transcript or engine result reports, wherever it lives. */
const resultHashOf = (r) => r.provenance?.resultHash ?? r.lineage?.resultHash ?? null;

/**
 * Configure the engine for a pack and run its tool against a fresh audit log,
 * restoring the environment afterward so examples do not leak into each other.
 */
async function runConfigured({ db, allowlist, ruleset }, tool, args) {
    const saved = {};
    for (const key of [CUSTOM_ENV.db, CUSTOM_ENV.allowlist, CUSTOM_ENV.ruleset]) saved[key] = process.env[key];
    const logPath = join(mkdtempSync(join(tmpdir(), 'skill-eval-')), 'audit.jsonl');
    try {
        process.env[CUSTOM_ENV.db] = db;
        process.env[CUSTOM_ENV.allowlist] = allowlist;
        if (ruleset) process.env[CUSTOM_ENV.ruleset] = ruleset;
        else delete process.env[CUSTOM_ENV.ruleset];
        return { result: await callTool(tool, args, { overrides: { logPath } }), logPath };
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

// Each run_canonical example and the scenario it narrates. The mutation trips
// the single control the example demonstrates; it mirrors that control's flag
// test in the pack's ruleset suite, and reproducing the transcript's result
// hash is what proves the scenario is the right one.
const CANONICAL = [
    {
        file: '01-grant-status-finding.md',
        config: { db: () => freshMunicipalDb(), allowlist: MUNICIPAL_ALLOWLIST, ruleset: null },
    },
    {
        file: '04-insurance-trust-shortfall.md',
        config: {
            db: () => freshInsuranceDb((d) => d.exec("UPDATE trust_bank_snapshots SET actual_bank_balance_cents = 40000 WHERE snapshot_id = 'S-02'")),
            allowlist: INSURANCE_ALLOWLIST,
            ruleset: rulesetPath('insurance', 'insurance-v1'),
        },
    },
    {
        file: '05-iolta-overdrawn-client-ledger.md',
        config: {
            db: () => freshIoltaDb((d) => d.exec("UPDATE trust_journal SET amount_cents = 600000 WHERE entry_id = 'T-0002'")),
            allowlist: IOLTA_ALLOWLIST,
            ruleset: rulesetPath('iolta', 'iolta-v1'),
        },
    },
    {
        file: '06-excise-underpaid-return.md',
        config: {
            db: () => freshExciseDb((d) => d.exec("UPDATE tax_returns SET tax_paid_cents = 100000 WHERE return_id = 'TR-2026-01'")),
            allowlist: EXCISE_ALLOWLIST,
            ruleset: rulesetPath('excise', 'excise-v1'),
        },
    },
    {
        file: '07-property-trust-shortfall.md',
        config: {
            db: () => freshPropertyDb((d) => d.exec("UPDATE trust_bank_snapshots SET bank_statement_balance_cents = 300000 WHERE snapshot_id = 'S-02'")),
            allowlist: PROPERTY_ALLOWLIST,
            ruleset: rulesetPath('property', 'property-trust-v1'),
        },
    },
    {
        file: '08-hoa-reserve-unapproved.md',
        config: {
            db: () => freshHoaDb((d) => d.exec("UPDATE reserve_transfers SET board_approval_id = NULL WHERE transfer_id = 'RT-1'")),
            allowlist: HOA_ALLOWLIST,
            ruleset: rulesetPath('hoa', 'hoa-v1'),
        },
    },
    {
        file: '09-nonprofit-restricted-spending.md',
        config: {
            db: () => freshNonprofitDb((d) => d.exec("UPDATE expenses SET program_code = 'TRAVEL' WHERE expense_id = 'EXP-1'")),
            allowlist: NONPROFIT_ALLOWLIST,
            ruleset: rulesetPath('nonprofit', 'nonprofit-v1'),
        },
    },
    {
        file: '10-schools-activity-unapproved-disbursement.md',
        config: {
            db: () => freshSchoolsDb((d) => d.exec("UPDATE activity_disbursements SET principal_approved = 0 WHERE disbursement_id = 'DIS-1'")),
            allowlist: SCHOOLS_ALLOWLIST,
            ruleset: rulesetPath('schools', 'schools-v1'),
        },
    },
    {
        file: '11-construction-loss-job.md',
        config: {
            db: () => freshConstructionDb((d) => d.exec("UPDATE jobs SET estimated_cost_cents = 250000000 WHERE job_id = 'J-100'")),
            allowlist: CONSTRUCTION_ALLOWLIST,
            ruleset: rulesetPath('construction', 'construction-v1'),
        },
    },
];

for (const { file, config } of CANONICAL) {
    test(`example ${file} reproduces its transcript`, async () => {
        const text = transcript(file);
        const { tool, args } = parseCall(text);
        const expected = parseExpected(text);
        assert.equal(tool, 'run_canonical', `${file} is set up as a run_canonical example`);

        const { result } = await runConfigured({ ...config, db: config.db() }, tool, args);

        assert.equal(result.integrity, expected.integrity, `${file}: integrity`);
        assert.equal(result.findings, expected.findings, `${file}: findings`);
        assert.equal(resultHashOf(result), resultHashOf(expected), `${file}: result hash drifted from the transcript`);

        // Every documented check must report the documented status.
        for (const check of expected.checks ?? []) {
            const got = result.checks.find((c) => c.id === check.id);
            assert.ok(got, `${file}: engine did not return documented check "${check.id}"`);
            assert.equal(got.status, check.status, `${file}: check "${check.id}" status`);
        }

        // Every figure the transcript shows in a row must match the engine's.
        (expected.rows ?? []).forEach((row, i) => {
            for (const [key, value] of Object.entries(row)) {
                assert.deepEqual(result.rows[i]?.[key], value, `${file}: rows[${i}].${key}`);
            }
        });
    });
}

test('example 02-refused-tax-id.md is refused by the guard with the documented reason', () => {
    const text = transcript('02-refused-tax-id.md');
    const expected = parseExpected(text);
    assert.equal(expected.ok, false, 'the transcript documents a refusal');

    // The example narrates a free-text request whose generated SQL reaches a
    // withheld column; replay the guarantee at the guard, on the exact SQL the
    // transcript shows, against the municipal allow-list. No planner key needed.
    const descriptor = loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
    const options = guardOptionsFor(descriptor);

    assert.throws(
        () => guard(expected.proposedSql, options),
        (err) => {
            assert.ok(err instanceof SqlRejected, 'a policy refusal, not a crash');
            assert.equal(err.reason, expected.reason, 'the documented refusal reason');
            return true;
        },
        `${expected.proposedSql} should be refused as ${expected.reason}`,
    );
});

test('example 03-audit-verification.md verifies the chain intact after one query', async () => {
    const text = transcript('03-audit-verification.md');
    const expected = parseExpected(text);

    // Example 03 continues 01: one municipal/grant-status query has been run, so
    // the log holds a single entry. Recreate that, then verify its chain. A
    // custom warehouse's named query logs to its own configured log (not the
    // overrides channel), so pin that log with CIVIC_AUDIT_LOG and verify the
    // same file.
    const keys = [CUSTOM_ENV.db, CUSTOM_ENV.allowlist, CUSTOM_ENV.ruleset, CUSTOM_ENV.log];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const logPath = join(mkdtempSync(join(tmpdir(), 'skill-eval-')), 'municipal-audit.jsonl');
    try {
        process.env[CUSTOM_ENV.db] = freshMunicipalDb();
        process.env[CUSTOM_ENV.allowlist] = MUNICIPAL_ALLOWLIST;
        process.env[CUSTOM_ENV.log] = logPath;
        delete process.env[CUSTOM_ENV.ruleset];
        await callTool('run_canonical', { name: 'municipal/grant-status', args: { grant_id: 'G-402' } });
        const integrity = await callTool('verify_audit', {}, { overrides: { logPath } });
        assert.equal(integrity.ok, expected.ok, 'chain intact');
        assert.equal(integrity.entries, expected.entries, 'one entry, as the transcript documents');
        assert.equal(integrity.brokenAt, expected.brokenAt, 'no break');
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
