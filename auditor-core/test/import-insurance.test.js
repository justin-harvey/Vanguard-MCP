/**
 * M4 (insurance): an insurance agency's own premium-trust and policy export
 * imports into the canonical insurance schema and runs the three insurance-v1
 * controls with clean integrity, the same way the municipal, IOLTA, construction
 * and nonprofit importers do for their exports.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/coastline_*.csv) are an anonymized, fictional agency's
 * ("Coastline Insurance Partners") premium-trust ledger plus its four companion
 * exports (policies, commission receipts, binders, trust bank snapshots) in a
 * realistic agency-management shape. They mirror the clean demo seed, so all three
 * controls read pass: the latest bank balance ($700.00) covers the net trust
 * liability ($675.00), every active/bound policy was paid exactly its contracted
 * commission, and every policy holding client premium has a carrier-confirmed
 * binder. The fixtures also carry a PENDING premium the solvency control excludes
 * and a CANCELLED policy the variance audit excludes.
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
    coerceEntryType,
    coerceReconciledStatus,
    coercePolicyStatus,
    coerceCommissionBps,
    coerceCarrierConfirmed,
    CANONICAL_INSURANCE_LEDGER_FIELDS,
    CANONICAL_INSURANCE_POLICY_FIELDS,
    CANONICAL_INSURANCE_RECEIPT_FIELDS,
    CANONICAL_INSURANCE_BINDER_FIELDS,
    CANONICAL_INSURANCE_SNAPSHOT_FIELDS,
    ImportError,
} from '../src/import-insurance.js';
import { runInsuranceImport } from '../src/import-insurance-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');

const LEDGER = 'coastline_trust_ledger.csv';
const POLICIES = 'coastline_policies.csv';
const RECEIPTS = 'coastline_commission_receipts.csv';
const BINDERS = 'coastline_binders.csv';
const BANK = 'coastline_bank_snapshots.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-insurance-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** The four confirmed companion imports, each mapped from its fixture. */
function allCompanions() {
    return {
        policies: { file: POLICIES, mapping: mappingFor(POLICIES, CANONICAL_INSURANCE_POLICY_FIELDS).mapping },
        commissionReceipts: { file: RECEIPTS, mapping: mappingFor(RECEIPTS, CANONICAL_INSURANCE_RECEIPT_FIELDS).mapping },
        binders: { file: BINDERS, mapping: mappingFor(BINDERS, CANONICAL_INSURANCE_BINDER_FIELDS).mapping },
        bankSnapshots: { file: BANK, mapping: mappingFor(BANK, CANONICAL_INSURANCE_SNAPSHOT_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('entry type coerces to the three canonical trust movements', () => {
    assert.equal(coerceEntryType('Client Premium In'), 'CLIENT_PREMIUM_IN');
    assert.equal(coerceEntryType('premium'), 'CLIENT_PREMIUM_IN');
    assert.equal(coerceEntryType('Carrier Remit Out'), 'CARRIER_REMIT_OUT');
    assert.equal(coerceEntryType('remittance'), 'CARRIER_REMIT_OUT');
    assert.equal(coerceEntryType('Agency Commission Draw'), 'AGENCY_COMMISSION_DRAW');
    assert.equal(coerceEntryType('draw'), 'AGENCY_COMMISSION_DRAW');
    assert.throws(() => coerceEntryType('refund'), ImportError);
});

test('reconciled status coerces to POSTED / PENDING', () => {
    assert.equal(coerceReconciledStatus('Posted'), 'POSTED');
    assert.equal(coerceReconciledStatus('cleared'), 'POSTED');
    assert.equal(coerceReconciledStatus('Pending'), 'PENDING');
    assert.equal(coerceReconciledStatus('in transit'), 'PENDING');
    assert.throws(() => coerceReconciledStatus('maybe'), ImportError);
});

test('policy status coerces to ACTIVE / BOUND / CANCELLED', () => {
    assert.equal(coercePolicyStatus('Active'), 'ACTIVE');
    assert.equal(coercePolicyStatus('in force'), 'ACTIVE');
    assert.equal(coercePolicyStatus('Bound'), 'BOUND');
    assert.equal(coercePolicyStatus('Cancelled'), 'CANCELLED');
    assert.equal(coercePolicyStatus('lapsed'), 'CANCELLED');
    assert.throws(() => coercePolicyStatus('quoted'), ImportError);
});

test('commission rate coerces basis points and percentages to bps', () => {
    assert.equal(coerceCommissionBps('1500'), 1500);
    assert.equal(coerceCommissionBps('15%'), 1500);
    assert.equal(coerceCommissionBps('12.5%'), 1250);
    assert.equal(coerceCommissionBps('17.5%'), 1750);
    assert.throws(() => coerceCommissionBps(''), ImportError);
    assert.throws(() => coerceCommissionBps('0.15'), ImportError); // bare decimal is ambiguous
    assert.throws(() => coerceCommissionBps('fifteen'), ImportError);
});

test('carrier-confirmed status coerces to 1/0 and reads blank as not confirmed (0)', () => {
    assert.equal(coerceCarrierConfirmed('Yes'), 1);
    assert.equal(coerceCarrierConfirmed('Confirmed'), 1);
    assert.equal(coerceCarrierConfirmed('Bound'), 1);
    assert.equal(coerceCarrierConfirmed('No'), 0);
    assert.equal(coerceCarrierConfirmed('pending'), 0);
    assert.equal(coerceCarrierConfirmed(''), 0);
    assert.throws(() => coerceCarrierConfirmed('perhaps'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all five insurance files', () => {
    assert.deepEqual(mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(POLICIES, CANONICAL_INSURANCE_POLICY_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(RECEIPTS, CANONICAL_INSURANCE_RECEIPT_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BINDERS, CANONICAL_INSURANCE_BINDER_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BANK, CANONICAL_INSURANCE_SNAPSHOT_FIELDS).missingRequired, []);
    const l = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    assert.equal(l.entry_type, 'Entry Type');
    assert.equal(l.reconciled_status, 'Reconciled Status');
    assert.equal(l.policy_id, 'Policy');
    const p = mappingFor(POLICIES, CANONICAL_INSURANCE_POLICY_FIELDS).mapping;
    assert.equal(p.contracted_comm_bps, 'Commission Rate');
    assert.equal(p.written_premium, 'Written Premium');
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runInsuranceImport({ file: LEDGER, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'insurance');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the three controls with clean integrity ───────

test('a real agency export imports and all three controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    const result = await runInsuranceImport({ file: LEDGER, mapping, ...allCompanions(), env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'insurance');
    assert.deepEqual(result.counts, { rowCount: 10 });
    assert.equal(result.policies.counts.policies, 5);
    assert.equal(result.commissionReceipts.counts.receipts, 7);
    assert.equal(result.binders.counts.binders, 4);
    assert.equal(result.bankSnapshots.counts.snapshots, 2);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, LEDGER))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all three, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of ['trust-account-solvency', 'commission-variance-audit', 'eo-unbound-exposure']) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + four companions + three attested queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 8);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed insurance ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'insurance-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the insurance schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'insurance-canonical-v1');
});

// ── the numbers are exact, the exclusions hold, and no insured PII enters ──────

test('money is exact, PENDING and CANCELLED rows are excluded, and no insured-PII table exists', async () => {
    const e = env();
    const mapping = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    const result = await runInsuranceImport({ file: LEDGER, mapping, ...allCompanions(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Net trust liability (POSTED only) = collected - remitted - drawn = $675.00,
        // and the latest bank snapshot by date ($700.00) covers it.
        const posted = db.prepare(
            "SELECT SUM(CASE WHEN entry_type='CLIENT_PREMIUM_IN' THEN amount_cents ELSE 0 END) AS coll, "
            + "SUM(CASE WHEN entry_type='CARRIER_REMIT_OUT' THEN amount_cents ELSE 0 END) AS remit, "
            + "SUM(CASE WHEN entry_type='AGENCY_COMMISSION_DRAW' THEN amount_cents ELSE 0 END) AS draw "
            + "FROM trust_ledger WHERE reconciled_status='POSTED'",
        ).get();
        assert.equal(posted.coll - posted.remit - posted.draw, 67_500);
        const latest = db.prepare('SELECT actual_bank_balance_cents AS b FROM trust_bank_snapshots ORDER BY snapshot_date DESC LIMIT 1').get();
        assert.equal(latest.b, 70_000);
        assert.ok(latest.b >= posted.coll - posted.remit - posted.draw);

        // The PENDING premium (T-0030, $9,999.99) is in the ledger but excluded from
        // the POSTED solvency figure: all-status premium in is larger than POSTED.
        const allIn = db.prepare("SELECT SUM(amount_cents) AS t FROM trust_ledger WHERE entry_type='CLIENT_PREMIUM_IN'").get();
        assert.equal(posted.coll, 4_500_000);
        assert.equal(allIn.t, 5_499_999);

        // The latest snapshot by date ($700) is smaller than the earlier one
        // ($25,000): the solvency query takes the most recent by date, not the max.
        const snaps = db.prepare('SELECT snapshot_date FROM trust_bank_snapshots ORDER BY snapshot_date').all();
        assert.deepEqual(snaps.map((r) => r.snapshot_date), ['2026-01-31', '2026-02-28']);

        // A percentage commission rate coerced to basis points (12.5% -> 1250).
        assert.equal(db.prepare("SELECT contracted_comm_bps AS b FROM policies WHERE policy_id='P-1002'").get().b, 1250);
        assert.equal(db.prepare("SELECT contracted_comm_bps AS b FROM policies WHERE policy_id='P-1004'").get().b, 1750);

        // The CANCELLED policy (P-1009) is imported but the variance audit excludes it.
        assert.equal(db.prepare("SELECT status FROM policies WHERE policy_id='P-1009'").get().status, 'CANCELLED');

        // No insured-PII table exists in an imported ledger: the import has no
        // column that could hold a name, SSN or health condition.
        const hasPii = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='insured_pii'").get();
        assert.equal(hasPii, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['binders', 'commission_receipts', 'policies', 'trust_bank_snapshots', 'trust_ledger']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the five non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(
        Object.keys(allow.tables).sort(),
        ['binders', 'commission_receipts', 'policies', 'trust_bank_snapshots', 'trust_ledger'],
    );
});

// ── an agency commission draw carries no policy or carrier ─────────────────────

test('an agency commission draw imports with null policy and carrier', async () => {
    const e = env();
    const mapping = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    const result = await runInsuranceImport({ file: LEDGER, mapping, ...allCompanions(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        const draw = db.prepare("SELECT policy_id, carrier_code FROM trust_ledger WHERE entry_type='AGENCY_COMMISSION_DRAW'").get();
        assert.equal(draw.policy_id, null);
        assert.equal(draw.carrier_code, null);
    } finally {
        db.close();
    }
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a bad entry type aborts the ledger import, naming the row, writing nothing', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-insurance-bad-')) });
    const bad = 'Entry ID,Policy,Carrier,Entry Type,Amount,Reconciled Status,Entry Date\nT-9,P-1,CARR-X,refund,"$100.00",Posted,2026-03-01\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = {
        entry_id: 'Entry ID', policy_id: 'Policy', carrier_code: 'Carrier', entry_type: 'Entry Type',
        amount: 'Amount', reconciled_status: 'Reconciled Status', entry_date: 'Entry Date',
    };
    await assert.rejects(
        () => runInsuranceImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Entry Type.*unrecognised entry type/.test(err.message),
    );
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

test('a bad policy status aborts the policies companion, leaving the ledger untouched', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-insurance-badpol-')) });
    writeFileSync(join(e.CIVIC_IMPORT_DIR, LEDGER), readFileSync(join(FIXTURE_DIR, LEDGER)));
    const badPol = 'Policy,Carrier,Line of Business,Written Premium,Commission Rate,Status\nP-1,CARR-X,PROPERTY,"$1,000.00",1500,quoted\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad_pol.csv'), badPol);
    const mapping = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    const polMapping = {
        policy_id: 'Policy', carrier_code: 'Carrier', line_of_business: 'Line of Business',
        written_premium: 'Written Premium', contracted_comm_bps: 'Commission Rate', status: 'Status',
    };
    await assert.rejects(
        () => runInsuranceImport({ file: LEDGER, mapping, policies: { file: 'bad_pol.csv', mapping: polMapping }, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Status.*unrecognised policy status/.test(err.message),
    );
    const dbPath = join(e.CIVIC_DATA_DIR, 'imported', 'coastline-trust-ledger', 'ledger.db');
    assert.ok(existsSync(dbPath));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trust_ledger').get().n, 10);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies').get().n, 0);
    } finally {
        db.close();
    }
});

test('a commission receipt for a policy not in the ledger aborts (foreign key), leaving it empty', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-insurance-fk-')) });
    writeFileSync(join(e.CIVIC_IMPORT_DIR, LEDGER), readFileSync(join(FIXTURE_DIR, LEDGER)));
    // No policies companion, so any receipt references a policy not in the ledger.
    const orphanReceipts = 'Receipt ID,Policy,Paid Commission\nR-1,P-9999,"$500.00"\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'orphan_receipts.csv'), orphanReceipts);
    const mapping = mappingFor(LEDGER, CANONICAL_INSURANCE_LEDGER_FIELDS).mapping;
    const recMapping = { receipt_id: 'Receipt ID', policy_id: 'Policy', paid_comm: 'Paid Commission' };
    await assert.rejects(
        () => runInsuranceImport({ file: LEDGER, mapping, commissionReceipts: { file: 'orphan_receipts.csv', mapping: recMapping }, env: e }),
        (err) => err instanceof ImportError && /references a policy that is not in the ledger/.test(err.message),
    );
    const dbPath = join(e.CIVIC_DATA_DIR, 'imported', 'coastline-trust-ledger', 'ledger.db');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trust_ledger').get().n, 10);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commission_receipts').get().n, 0);
    } finally {
        db.close();
    }
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-insurance-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=insurance proposes then imports the trust ledger with a clean gate', async () => {
    await withImportEnv(async () => {
        const companionFiles = {
            policies: { file: POLICIES }, commissionReceipts: { file: RECEIPTS },
            binders: { file: BINDERS }, bankSnapshots: { file: BANK },
        };
        const proposal = await callTool('propose_csv_mapping', { file: LEDGER, pack: 'insurance', companions: companionFiles });
        assert.equal(proposal.pack, 'insurance');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.entry_type, 'Entry Type');
        for (const key of ['policies', 'commissionReceipts', 'binders', 'bankSnapshots']) {
            assert.deepEqual(proposal[key].missingRequired, [], `${key} maps cleanly`);
        }

        const companions = {};
        for (const key of Object.keys(companionFiles)) {
            companions[key] = { file: companionFiles[key].file, mapping: proposal[key].mapping };
        }
        const out = await callTool('import_csv', { file: LEDGER, pack: 'insurance', mapping: proposal.mapping, companions });
        assert.equal(out.pack, 'insurance');
        assert.equal(out.counts.rowCount, 10);
        assert.equal(out.gate.ok, true);
        assert.equal(out.gate.queries.length, 3);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
