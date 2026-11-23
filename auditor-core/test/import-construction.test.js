/**
 * M4 (construction): a contractor's own job-cost export imports into the canonical
 * construction schema and runs the six construction-v1 controls with clean
 * integrity, the same way the municipal and IOLTA importers do for their exports.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/summitridge_*.csv) are an anonymized, fictional
 * contractor's jobs / WIP schedule plus its five companion exports (general-ledger
 * revenue, balance-sheet contract balances, prior WIP snapshots, retainage and
 * subcontractor payments) in a realistic job-cost export shape. They mirror the
 * clean demo seed, so all six controls read pass: earned revenue ties the GL
 * ($1,700,000.00), over/underbillings tie the balance sheet ($100,000 / $40,000),
 * no job is underwater, no margin fades past 300 bps, retainage reconciles, and
 * every subcontractor payment carries a waiver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    proposeMapping,
    coerceJobStatus,
    coerceBalanceAccount,
    coerceLienWaiver,
    CANONICAL_CONSTRUCTION_JOB_FIELDS,
    CANONICAL_CONSTRUCTION_GL_FIELDS,
    CANONICAL_CONSTRUCTION_BALANCE_FIELDS,
    CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS,
    CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS,
    CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS,
    ImportError,
} from '../src/import-construction.js';
import { runConstructionImport } from '../src/import-construction-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');

const JOBS = 'summitridge_jobs.csv';
const GL = 'summitridge_gl_revenue.csv';
const BALANCES = 'summitridge_balances.csv';
const SNAPSHOTS = 'summitridge_wip_snapshots.csv';
const RETAINAGE = 'summitridge_retainage.csv';
const SUBPAYMENTS = 'summitridge_sub_payments.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-construction-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** The five confirmed companion imports, each mapped from its fixture. */
function allCompanions() {
    return {
        glRevenue: { file: GL, mapping: mappingFor(GL, CANONICAL_CONSTRUCTION_GL_FIELDS).mapping },
        balances: { file: BALANCES, mapping: mappingFor(BALANCES, CANONICAL_CONSTRUCTION_BALANCE_FIELDS).mapping },
        wipSnapshots: { file: SNAPSHOTS, mapping: mappingFor(SNAPSHOTS, CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS).mapping },
        retainage: { file: RETAINAGE, mapping: mappingFor(RETAINAGE, CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS).mapping },
        subPayments: { file: SUBPAYMENTS, mapping: mappingFor(SUBPAYMENTS, CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('job status coerces to OPEN / CLOSED and defaults to OPEN when blank', () => {
    assert.equal(coerceJobStatus('Open'), 'OPEN');
    assert.equal(coerceJobStatus('active'), 'OPEN');
    assert.equal(coerceJobStatus('Closed'), 'CLOSED');
    assert.equal(coerceJobStatus('completed'), 'CLOSED');
    assert.equal(coerceJobStatus(''), 'OPEN');
    assert.throws(() => coerceJobStatus('on hold'), ImportError);
});

test('balance-sheet accounts coerce to the two contract balances', () => {
    assert.equal(coerceBalanceAccount('Contract Liability'), 'CONTRACT_LIABILITY');
    assert.equal(coerceBalanceAccount('billings in excess'), 'CONTRACT_LIABILITY');
    assert.equal(coerceBalanceAccount('Contract Asset'), 'CONTRACT_ASSET');
    assert.equal(coerceBalanceAccount('costs in excess'), 'CONTRACT_ASSET');
    assert.throws(() => coerceBalanceAccount('cash'), ImportError);
});

test('lien-waiver status coerces to 1/0 and reads blank as missing (0)', () => {
    assert.equal(coerceLienWaiver('Yes'), 1);
    assert.equal(coerceLienWaiver('on file'), 1);
    assert.equal(coerceLienWaiver('No'), 0);
    assert.equal(coerceLienWaiver('missing'), 0);
    assert.equal(coerceLienWaiver(''), 0);
    assert.throws(() => coerceLienWaiver('maybe'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all six construction files', () => {
    assert.deepEqual(mappingFor(JOBS, CANONICAL_CONSTRUCTION_JOB_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(GL, CANONICAL_CONSTRUCTION_GL_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BALANCES, CANONICAL_CONSTRUCTION_BALANCE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(SNAPSHOTS, CANONICAL_CONSTRUCTION_SNAPSHOT_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(RETAINAGE, CANONICAL_CONSTRUCTION_RETAINAGE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(SUBPAYMENTS, CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS).missingRequired, []);
    const j = mappingFor(JOBS, CANONICAL_CONSTRUCTION_JOB_FIELDS).mapping;
    assert.equal(j.job_id, 'Job Number');
    assert.equal(j.contract_value, 'Contract Value');
    assert.equal(j.estimated_cost, 'Estimated Cost at Completion');
    const s = mappingFor(SUBPAYMENTS, CANONICAL_CONSTRUCTION_SUBPAYMENT_FIELDS).mapping;
    assert.equal(s.lien_waiver_received, 'Lien Waiver Received');
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runConstructionImport({ file: JOBS, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'construction');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the six controls with clean integrity ─────────

test('a real contractor export imports and all six controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(JOBS, CANONICAL_CONSTRUCTION_JOB_FIELDS).mapping;
    const result = await runConstructionImport({ file: JOBS, mapping, ...allCompanions(), env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'construction');
    assert.deepEqual(result.counts, { rowCount: 3 });
    assert.equal(result.glRevenue.counts.entries, 4);
    assert.equal(result.balances.counts.balances, 2);
    assert.equal(result.wipSnapshots.counts.snapshots, 4);
    assert.equal(result.retainage.counts.jobs, 3);
    assert.equal(result.subPayments.counts.payments, 4);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, JOBS))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all six, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of [
        'wip-schedule', 'billings-tie-out', 'loss-jobs',
        'margin-fade', 'retainage-reconciles', 'payments-without-lien-waiver',
    ]) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
    }
    assert.equal(byName['loss-jobs'].findings, 0);
    assert.equal(byName['margin-fade'].findings, 0);
    assert.equal(byName['payments-without-lien-waiver'].findings, 0);

    // The audit chain is intact: import + five companions + six attested queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 12);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed construction ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'construction-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the construction schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'construction-canonical-v1');
});

// ── the numbers are exact, the trap holds, and no payroll PII enters ───────────

test('money is exact, margin-fade picks the latest snapshot, and no payroll table exists', async () => {
    const e = env();
    const mapping = mappingFor(JOBS, CANONICAL_CONSTRUCTION_JOB_FIELDS).mapping;
    const result = await runConstructionImport({ file: JOBS, mapping, ...allCompanions(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Earned revenue (cost-to-cost) ties to the general ledger: $1,700,000.00.
        const earned = db.prepare(
            'SELECT SUM(contract_value_cents * cost_to_date_cents / estimated_cost_cents) AS t FROM jobs',
        ).get();
        const gl = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM gl_revenue').get();
        assert.equal(earned.t, 170_000_000);
        assert.equal(gl.t, earned.t);

        // Over/underbillings tie the balance sheet: $100,000 liability, $40,000 asset.
        const liability = db.prepare("SELECT balance_cents FROM balance_sheet_balances WHERE account='CONTRACT_LIABILITY'").get();
        const asset = db.prepare("SELECT balance_cents FROM balance_sheet_balances WHERE account='CONTRACT_ASSET'").get();
        assert.equal(liability.balance_cents, 10_000_000);
        assert.equal(asset.balance_cents, 4_000_000);

        // Both J-100 snapshots imported; margin-fade must compare against the LATEST
        // (2026-06-30), not the older, higher-margin 2026-03-31 row — the gate's
        // clean margin-fade above proves the MAX(snapshot_date) selection holds.
        const j100 = db.prepare("SELECT snapshot_date FROM wip_snapshots WHERE job_id='J-100' ORDER BY snapshot_date").all();
        assert.deepEqual(j100.map((r) => r.snapshot_date), ['2026-03-31', '2026-06-30']);

        // Every subcontractor payment carries a waiver.
        const unwaived = db.prepare('SELECT COUNT(*) AS n FROM sub_payments WHERE lien_waiver_received = 0').get();
        assert.equal(unwaived.n, 0);

        // No payroll-PII table exists in an imported ledger: the import has no
        // column that could hold a name, SSN or pay rate.
        const hasPayroll = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_pii'").get();
        assert.equal(hasPayroll, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['balance_sheet_balances', 'gl_revenue', 'jobs', 'retainage', 'sub_payments', 'wip_snapshots']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the six non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(
        Object.keys(allow.tables).sort(),
        ['balance_sheet_balances', 'gl_revenue', 'jobs', 'retainage', 'sub_payments', 'wip_snapshots'],
    );
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a non-money contract value aborts the jobs import, naming the row, writing nothing', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-construction-bad-')) });
    const bad = 'Job Number,Project Name,Contract Value,Estimated Cost at Completion,Cost to Date,Billed to Date\nJ-9,Mystery Job,TBD,"$1,000,000.00","$500,000.00","$600,000.00"\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = {
        job_id: 'Job Number', job_name: 'Project Name', contract_value: 'Contract Value',
        estimated_cost: 'Estimated Cost at Completion', cost_to_date: 'Cost to Date', billed_to_date: 'Billed to Date',
    };
    await assert.rejects(
        () => runConstructionImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Contract Value.*not a money amount/.test(err.message),
    );
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

test('a bad lien-waiver value aborts the subcontractor-payments companion, leaving the ledger untouched', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-construction-badsub-')) });
    // A clean jobs file so the ledger builds, then a bad sub-payments companion.
    writeFileSync(join(e.CIVIC_IMPORT_DIR, JOBS), readFileSync(join(FIXTURE_DIR, JOBS)));
    const badSub = 'Payment ID,Job Number,Subcontractor,Amount,Payment Date,Lien Waiver Received\nSP-9,J-100,SUB-X,"$10,000.00",2026-07-01,Perhaps\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad_sub.csv'), badSub);
    const mapping = mappingFor(JOBS, CANONICAL_CONSTRUCTION_JOB_FIELDS).mapping;
    const subMapping = {
        payment_id: 'Payment ID', job_id: 'Job Number', subcontractor_id: 'Subcontractor',
        amount: 'Amount', payment_date: 'Payment Date', lien_waiver_received: 'Lien Waiver Received',
    };
    await assert.rejects(
        () => runConstructionImport({ file: JOBS, mapping, subPayments: { file: 'bad_sub.csv', mapping: subMapping }, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Lien Waiver Received.*unrecognised lien-waiver status/.test(err.message),
    );
    // The jobs ledger built, but the aborted companion left sub_payments empty.
    const dbPath = join(e.CIVIC_DATA_DIR, 'imported', 'summitridge-jobs', 'ledger.db');
    assert.ok(existsSync(dbPath));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 3);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sub_payments').get().n, 0);
    } finally {
        db.close();
    }
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-construction-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=construction proposes then imports the WIP schedule with a clean gate', async () => {
    await withImportEnv(async () => {
        const companionFiles = {
            glRevenue: { file: GL }, balances: { file: BALANCES }, wipSnapshots: { file: SNAPSHOTS },
            retainage: { file: RETAINAGE }, subPayments: { file: SUBPAYMENTS },
        };
        const proposal = await callTool('propose_csv_mapping', { file: JOBS, pack: 'construction', companions: companionFiles });
        assert.equal(proposal.pack, 'construction');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.job_id, 'Job Number');
        for (const key of ['glRevenue', 'balances', 'wipSnapshots', 'retainage', 'subPayments']) {
            assert.deepEqual(proposal[key].missingRequired, [], `${key} maps cleanly`);
        }

        const companions = {};
        for (const key of Object.keys(companionFiles)) {
            companions[key] = { file: companionFiles[key].file, mapping: proposal[key].mapping };
        }
        const out = await callTool('import_csv', { file: JOBS, pack: 'construction', mapping: proposal.mapping, companions });
        assert.equal(out.pack, 'construction');
        assert.equal(out.counts.rowCount, 3);
        assert.equal(out.gate.ok, true);
        assert.equal(out.gate.queries.length, 6);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
